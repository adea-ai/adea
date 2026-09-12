use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD_NO_PAD, Engine as _};
use keyring::{Entry, Error as KeyringError};
use rand_core::{OsRng, RngCore};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{Runtime, State, Url, WebviewWindow};
use uuid::Uuid;
use zeroize::Zeroizing;

const DATABASE_FILENAME: &str = "local-content.sqlite3";
const KEYCHAIN_SERVICE: &str = "com.adea.desktop.local-content";
const SCHEMA_VERSION: u32 = 1;
const NONCE_LENGTH: usize = 12;
const MAX_CONTENT_BYTES: usize = 2 * 1024 * 1024;
const MAX_ROTATION_BATCH: usize = 500;

const MIGRATION: &str = r#"
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS local_content_metadata (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS local_content_records (
  content_id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  content_type TEXT NOT NULL,
  task_id TEXT,
  message_id TEXT,
  revision INTEGER NOT NULL,
  digest_sha256 TEXT NOT NULL,
  sensitivity TEXT NOT NULL,
  storage_policy TEXT NOT NULL,
  synchronization_policy TEXT NOT NULL,
  availability TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  key_version INTEGER NOT NULL,
  nonce BLOB NOT NULL,
  ciphertext BLOB NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS local_content_workspace_idx
  ON local_content_records(workspace_id, updated_at);
CREATE TABLE IF NOT EXISTS local_content_rotation (
  singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
  from_version INTEGER NOT NULL,
  to_version INTEGER NOT NULL,
  last_content_id TEXT,
  started_at TEXT NOT NULL
);
"#;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ContentType {
    MessageBody,
    TaskObjective,
    TaskInput,
    PrivateField,
}

impl ContentType {
    fn as_str(&self) -> &'static str {
        match self {
            Self::MessageBody => "message_body",
            Self::TaskObjective => "task_objective",
            Self::TaskInput => "task_input",
            Self::PrivateField => "private_field",
        }
    }

    fn parse(value: &str) -> Result<Self, LocalContentError> {
        match value {
            "message_body" => Ok(Self::MessageBody),
            "task_objective" => Ok(Self::TaskObjective),
            "task_input" => Ok(Self::TaskInput),
            "private_field" => Ok(Self::PrivateField),
            _ => Err(LocalContentError::Corrupt),
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateContentInput {
    pub content_id: Option<String>,
    pub workspace_id: String,
    pub content_type: ContentType,
    pub task_id: Option<String>,
    pub message_id: Option<String>,
    pub plaintext: String,
    pub sensitivity: String,
    pub storage_policy: String,
    pub synchronization_policy: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadContentInput {
    pub content_id: String,
    pub workspace_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateContentInput {
    pub content_id: String,
    pub workspace_id: String,
    pub expected_revision: u64,
    pub plaintext: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteContentInput {
    pub content_id: String,
    pub workspace_id: String,
    pub expected_revision: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchContentInput {
    pub workspace_id: String,
    pub query: String,
    pub limit: Option<usize>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ContentRef {
    pub id: String,
    pub workspace_id: String,
    pub content_type: ContentType,
    pub task_id: Option<String>,
    pub message_id: Option<String>,
    pub revision: u64,
    pub digest_sha256: String,
    pub sensitivity: String,
    pub storage_policy: String,
    pub synchronization_policy: String,
    pub availability: String,
    pub schema_version: u32,
    pub key_version: u32,
    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedContent {
    pub content_ref: ContentRef,
    pub plaintext: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalSearchResult {
    pub content_id: String,
    pub content_type: ContentType,
    pub message_id: Option<String>,
    pub task_id: Option<String>,
    pub snippet: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentHealth {
    pub available: bool,
    pub current_key_version: u32,
    pub rotation_in_progress: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RotationStatus {
    pub complete: bool,
    pub current_key_version: u32,
    pub migrated_records: usize,
}

#[derive(Debug, PartialEq, Eq)]
enum LocalContentError {
    Conflict,
    Corrupt,
    Invalid,
    KeyUnavailable,
    NotFound,
    Storage,
    Unauthorized,
}

impl LocalContentError {
    fn public_message(&self) -> String {
        match self {
            Self::Conflict => "local content changed; reload and retry",
            Self::Invalid => "invalid local content request",
            Self::KeyUnavailable => "local content key is unavailable",
            Self::NotFound => "local content is unavailable",
            Self::Unauthorized => "local content access is not authorized",
            Self::Corrupt | Self::Storage => "local content operation failed",
        }
        .to_string()
    }
}

trait KeyStore: Send + Sync {
    fn get(&self, version: u32) -> Result<Option<Zeroizing<Vec<u8>>>, LocalContentError>;
    fn set(&self, version: u32, key: &[u8]) -> Result<(), LocalContentError>;
    fn delete(&self, version: u32) -> Result<(), LocalContentError>;
}

struct KeyringStore;

impl KeyringStore {
    fn entry(version: u32) -> Result<Entry, LocalContentError> {
        Entry::new(KEYCHAIN_SERVICE, &format!("master-key-v{version}"))
            .map_err(|_| LocalContentError::KeyUnavailable)
    }
}

impl KeyStore for KeyringStore {
    fn get(&self, version: u32) -> Result<Option<Zeroizing<Vec<u8>>>, LocalContentError> {
        match Self::entry(version)?.get_password() {
            Ok(encoded) => {
                let key = STANDARD_NO_PAD
                    .decode(encoded)
                    .map_err(|_| LocalContentError::KeyUnavailable)?;
                if key.len() != 32 {
                    return Err(LocalContentError::KeyUnavailable);
                }
                Ok(Some(Zeroizing::new(key)))
            }
            Err(KeyringError::NoEntry) => Ok(None),
            Err(_) => Err(LocalContentError::KeyUnavailable),
        }
    }

    fn set(&self, version: u32, key: &[u8]) -> Result<(), LocalContentError> {
        Self::entry(version)?
            .set_password(&STANDARD_NO_PAD.encode(key))
            .map_err(|_| LocalContentError::KeyUnavailable)
    }

    fn delete(&self, version: u32) -> Result<(), LocalContentError> {
        match Self::entry(version)?.delete_credential() {
            Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
            Err(_) => Err(LocalContentError::KeyUnavailable),
        }
    }
}

struct Repository {
    path: PathBuf,
    keys: Arc<dyn KeyStore>,
}

impl Repository {
    fn open(path: PathBuf, keys: Arc<dyn KeyStore>) -> Result<Self, LocalContentError> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|_| LocalContentError::Storage)?;
        }
        let repository = Self { path, keys };
        let connection = repository.connection()?;
        connection
            .execute_batch(MIGRATION)
            .map_err(|_| LocalContentError::Storage)?;
        repository.ensure_current_key(&connection)?;
        Ok(repository)
    }

    fn connection(&self) -> Result<Connection, LocalContentError> {
        let connection = Connection::open(&self.path).map_err(|_| LocalContentError::Storage)?;
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .map_err(|_| LocalContentError::Storage)?;
        connection
            .busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|_| LocalContentError::Storage)?;
        Ok(connection)
    }

    fn ensure_current_key(&self, connection: &Connection) -> Result<u32, LocalContentError> {
        if let Some(version) = metadata_u32(connection, "current_key_version")? {
            self.key(version)?;
            return Ok(version);
        }
        let key = random_key();
        self.keys.set(1, &key)?;
        set_metadata(connection, "current_key_version", "1")?;
        Ok(1)
    }

    fn write_key_version(&self, connection: &Connection) -> Result<u32, LocalContentError> {
        if let Some(state) = rotation(connection)? {
            self.key(state.to_version)?;
            return Ok(state.to_version);
        }
        self.ensure_current_key(connection)
    }

    fn key(&self, version: u32) -> Result<Zeroizing<Vec<u8>>, LocalContentError> {
        self.keys
            .get(version)?
            .ok_or(LocalContentError::KeyUnavailable)
    }

    fn create(&self, input: CreateContentInput) -> Result<ContentRef, LocalContentError> {
        validate_create(&input)?;
        let content_id = match input.content_id {
            Some(id) => validated_uuid(&id)?,
            None => Uuid::new_v4().to_string(),
        };
        let connection = self.connection()?;
        if let Some(existing) = select_ref(&connection, &content_id)? {
            if existing.workspace_id != input.workspace_id {
                return Err(LocalContentError::Unauthorized);
            }
            let resolved = self.read(&input.workspace_id, &content_id)?;
            if resolved.plaintext == input.plaintext
                && existing.content_type == input.content_type
                && existing.sensitivity == input.sensitivity
                && existing.storage_policy == input.storage_policy
                && existing.synchronization_policy == input.synchronization_policy
                && (input.task_id.is_none()
                    || existing.task_id == input.task_id
                    || existing.task_id.is_none())
                && (input.message_id.is_none()
                    || existing.message_id == input.message_id
                    || existing.message_id.is_none())
            {
                connection
                    .execute(
                        "UPDATE local_content_records SET task_id = coalesce(task_id, ?1), message_id = coalesce(message_id, ?2), updated_at = ?3 WHERE content_id = ?4",
                        params![input.task_id, input.message_id, timestamp(), content_id],
                    )
                    .map_err(|_| LocalContentError::Storage)?;
                return select_ref(&connection, &content_id)?.ok_or(LocalContentError::Storage);
            }
            return Err(LocalContentError::Conflict);
        }
        let key_version = self.write_key_version(&connection)?;
        let now = timestamp();
        let revision = 1;
        let digest = digest(&input.plaintext);
        let (nonce, ciphertext) = encrypt(
            &self.key(key_version)?,
            &aad(
                &content_id,
                &input.workspace_id,
                &input.content_type,
                key_version,
            ),
            input.plaintext.as_bytes(),
        )?;
        connection
            .execute(
                "INSERT INTO local_content_records (content_id, workspace_id, content_type, task_id, message_id, revision, digest_sha256, sensitivity, storage_policy, synchronization_policy, availability, schema_version, key_version, nonce, ciphertext, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'available', ?11, ?12, ?13, ?14, ?15, ?15)",
                params![content_id, input.workspace_id, input.content_type.as_str(), input.task_id, input.message_id, revision, digest, input.sensitivity, input.storage_policy, input.synchronization_policy, SCHEMA_VERSION, key_version, nonce, ciphertext, now],
            )
            .map_err(|_| LocalContentError::Storage)?;
        select_ref(&connection, &content_id)?.ok_or(LocalContentError::Storage)
    }

    fn read(
        &self,
        workspace_id: &str,
        content_id: &str,
    ) -> Result<ResolvedContent, LocalContentError> {
        validated_uuid(workspace_id)?;
        validated_uuid(content_id)?;
        let connection = self.connection()?;
        let row = select_encrypted(&connection, content_id)?.ok_or(LocalContentError::NotFound)?;
        if row.content_ref.workspace_id != workspace_id {
            return Err(LocalContentError::Unauthorized);
        }
        if row.content_ref.deleted_at.is_some() || row.content_ref.availability != "available" {
            return Err(LocalContentError::NotFound);
        }
        let plaintext = decrypt(
            &self.key(row.content_ref.key_version)?,
            &aad(
                content_id,
                workspace_id,
                &row.content_ref.content_type,
                row.content_ref.key_version,
            ),
            &row.nonce,
            &row.ciphertext,
        )?;
        let plaintext = String::from_utf8(plaintext).map_err(|_| LocalContentError::Corrupt)?;
        if digest(&plaintext) != row.content_ref.digest_sha256 {
            return Err(LocalContentError::Corrupt);
        }
        Ok(ResolvedContent {
            content_ref: row.content_ref,
            plaintext,
        })
    }

    fn search(
        &self,
        input: SearchContentInput,
    ) -> Result<Vec<LocalSearchResult>, LocalContentError> {
        validated_uuid(&input.workspace_id)?;
        let query = input.query.trim();
        if !(2..=120).contains(&query.chars().count()) {
            return Err(LocalContentError::Invalid);
        }
        let limit = input.limit.unwrap_or(30);
        if !(1..=50).contains(&limit) {
            return Err(LocalContentError::Invalid);
        }
        let connection = self.connection()?;
        let mut statement = connection
            .prepare("SELECT content_id FROM local_content_records WHERE workspace_id = ?1 AND deleted_at IS NULL AND availability = 'available' ORDER BY updated_at DESC")
            .map_err(|_| LocalContentError::Storage)?;
        let ids = statement
            .query_map(params![input.workspace_id], |row| row.get::<_, String>(0))
            .map_err(|_| LocalContentError::Storage)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| LocalContentError::Storage)?;
        drop(statement);
        drop(connection);

        let normalized = query.to_lowercase();
        let mut results = Vec::new();
        for content_id in ids {
            let resolved = self.read(&input.workspace_id, &content_id)?;
            if !resolved.plaintext.to_lowercase().contains(&normalized) {
                continue;
            }
            results.push(LocalSearchResult {
                content_id,
                content_type: resolved.content_ref.content_type,
                message_id: resolved.content_ref.message_id,
                task_id: resolved.content_ref.task_id,
                snippet: bounded_snippet(&resolved.plaintext, query),
            });
            if results.len() == limit {
                break;
            }
        }
        Ok(results)
    }

    fn update(&self, input: UpdateContentInput) -> Result<ContentRef, LocalContentError> {
        validate_plaintext(&input.plaintext)?;
        validated_uuid(&input.workspace_id)?;
        validated_uuid(&input.content_id)?;
        let connection = self.connection()?;
        let existing =
            select_ref(&connection, &input.content_id)?.ok_or(LocalContentError::NotFound)?;
        if existing.workspace_id != input.workspace_id {
            return Err(LocalContentError::Unauthorized);
        }
        if existing.deleted_at.is_some() {
            return Err(LocalContentError::NotFound);
        }
        if existing.revision != input.expected_revision {
            return Err(LocalContentError::Conflict);
        }
        let expected_revision =
            i64::try_from(input.expected_revision).map_err(|_| LocalContentError::Invalid)?;
        let key_version = self.write_key_version(&connection)?;
        let revision = existing.revision + 1;
        let now = timestamp();
        let digest = digest(&input.plaintext);
        let (nonce, ciphertext) = encrypt(
            &self.key(key_version)?,
            &aad(
                &input.content_id,
                &input.workspace_id,
                &existing.content_type,
                key_version,
            ),
            input.plaintext.as_bytes(),
        )?;
        let changed = connection
            .execute(
                "UPDATE local_content_records SET revision = ?1, digest_sha256 = ?2, key_version = ?3, nonce = ?4, ciphertext = ?5, availability = 'available', updated_at = ?6 WHERE content_id = ?7 AND workspace_id = ?8 AND revision = ?9 AND deleted_at IS NULL",
                params![revision as i64, digest, key_version, nonce, ciphertext, now, input.content_id, input.workspace_id, expected_revision],
            )
            .map_err(|_| LocalContentError::Storage)?;
        if changed != 1 {
            return Err(LocalContentError::Conflict);
        }
        select_ref(&connection, &input.content_id)?.ok_or(LocalContentError::Storage)
    }

    fn delete(&self, input: DeleteContentInput) -> Result<ContentRef, LocalContentError> {
        validated_uuid(&input.workspace_id)?;
        validated_uuid(&input.content_id)?;
        let connection = self.connection()?;
        let existing =
            select_ref(&connection, &input.content_id)?.ok_or(LocalContentError::NotFound)?;
        if existing.workspace_id != input.workspace_id {
            return Err(LocalContentError::Unauthorized);
        }
        if existing.deleted_at.is_some() {
            return Ok(existing);
        }
        if existing.revision != input.expected_revision {
            return Err(LocalContentError::Conflict);
        }
        let expected_revision =
            i64::try_from(input.expected_revision).map_err(|_| LocalContentError::Invalid)?;
        let now = timestamp();
        let revision = existing.revision + 1;
        let changed = connection.execute(
            "UPDATE local_content_records SET revision = ?1, availability = 'deleted', ciphertext = x'', nonce = x'', deleted_at = ?2, updated_at = ?2 WHERE content_id = ?3 AND workspace_id = ?4 AND revision = ?5",
            params![revision as i64, now, input.content_id, input.workspace_id, expected_revision],
        ).map_err(|_| LocalContentError::Storage)?;
        if changed != 1 {
            return Err(LocalContentError::Conflict);
        }
        select_ref(&connection, &input.content_id)?.ok_or(LocalContentError::Storage)
    }

    fn health(&self) -> Result<ContentHealth, LocalContentError> {
        let connection = self.connection()?;
        let current_key_version = self.ensure_current_key(&connection)?;
        let rotation_in_progress = rotation(&connection)?.is_some();
        Ok(ContentHealth {
            available: true,
            current_key_version,
            rotation_in_progress,
        })
    }

    fn rotate(&self, requested_batch: usize) -> Result<RotationStatus, LocalContentError> {
        let batch = requested_batch.clamp(1, MAX_ROTATION_BATCH);
        let mut connection = self.connection()?;
        let current = self.ensure_current_key(&connection)?;
        let state = match rotation(&connection)? {
            Some(state) => state,
            None => {
                let to_version = current.checked_add(1).ok_or(LocalContentError::Storage)?;
                let key = random_key();
                self.keys.set(to_version, &key)?;
                connection.execute(
                    "INSERT INTO local_content_rotation (singleton, from_version, to_version, started_at) VALUES (1, ?1, ?2, ?3)",
                    params![current, to_version, timestamp()],
                ).map_err(|_| LocalContentError::Storage)?;
                RotationState {
                    from_version: current,
                    to_version,
                }
            }
        };
        self.key(state.to_version)?;
        let tx = connection
            .transaction()
            .map_err(|_| LocalContentError::Storage)?;
        let rows = rotation_rows(&tx, &state, batch)?;
        let migrated = rows.len();
        for row in rows {
            let plaintext = decrypt(
                &self.key(row.content_ref.key_version)?,
                &aad(
                    &row.content_ref.id,
                    &row.content_ref.workspace_id,
                    &row.content_ref.content_type,
                    row.content_ref.key_version,
                ),
                &row.nonce,
                &row.ciphertext,
            )?;
            let (nonce, ciphertext) = encrypt(
                &self.key(state.to_version)?,
                &aad(
                    &row.content_ref.id,
                    &row.content_ref.workspace_id,
                    &row.content_ref.content_type,
                    state.to_version,
                ),
                &plaintext,
            )?;
            tx.execute(
                "UPDATE local_content_records SET key_version = ?1, nonce = ?2, ciphertext = ?3 WHERE content_id = ?4 AND key_version = ?5",
                params![state.to_version, nonce, ciphertext, row.content_ref.id, row.content_ref.key_version],
            ).map_err(|_| LocalContentError::Storage)?;
            tx.execute(
                "UPDATE local_content_rotation SET last_content_id = ?1 WHERE singleton = 1",
                params![row.content_ref.id],
            )
            .map_err(|_| LocalContentError::Storage)?;
        }
        let remaining: i64 = tx.query_row(
            "SELECT COUNT(*) FROM local_content_records WHERE deleted_at IS NULL AND key_version != ?1",
            params![state.to_version], |row| row.get(0),
        ).map_err(|_| LocalContentError::Storage)?;
        if remaining == 0 {
            verify_rotated(&tx, self, state.to_version)?;
            set_metadata_tx(&tx, "current_key_version", &state.to_version.to_string())?;
            tx.commit().map_err(|_| LocalContentError::Storage)?;
            self.keys.delete(state.from_version)?;
            connection
                .execute("DELETE FROM local_content_rotation WHERE singleton = 1", [])
                .map_err(|_| LocalContentError::Storage)?;
            return Ok(RotationStatus {
                complete: true,
                current_key_version: state.to_version,
                migrated_records: migrated,
            });
        }
        tx.commit().map_err(|_| LocalContentError::Storage)?;
        Ok(RotationStatus {
            complete: false,
            current_key_version: current,
            migrated_records: migrated,
        })
    }
}

#[derive(Clone)]
pub struct LocalContentState {
    repository: Arc<Mutex<Option<Repository>>>,
    authorized_workspaces: Arc<Mutex<HashSet<String>>>,
}

impl LocalContentState {
    pub fn initialize(app_data_dir: &Path) -> Self {
        let repository =
            Repository::open(app_data_dir.join(DATABASE_FILENAME), Arc::new(KeyringStore)).ok();
        Self {
            repository: Arc::new(Mutex::new(repository)),
            authorized_workspaces: Arc::new(Mutex::new(HashSet::new())),
        }
    }

    fn authorize(&self, workspace_id: &str) -> Result<(), LocalContentError> {
        let workspace_id = validated_uuid(workspace_id)?;
        let mut authorized = self
            .authorized_workspaces
            .lock()
            .map_err(|_| LocalContentError::Storage)?;
        authorized.clear();
        authorized.insert(workspace_id);
        Ok(())
    }

    fn require_workspace(&self, workspace_id: &str) -> Result<(), LocalContentError> {
        let workspace_id = validated_uuid(workspace_id)?;
        let authorized = self
            .authorized_workspaces
            .lock()
            .map_err(|_| LocalContentError::Storage)?;
        if !authorized.contains(&workspace_id) {
            return Err(LocalContentError::Unauthorized);
        }
        Ok(())
    }
}

fn trusted_window<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), LocalContentError> {
    if window.label() != "main" {
        return Err(LocalContentError::Unauthorized);
    }
    let url = window.url().map_err(|_| LocalContentError::Unauthorized)?;
    if trusted_url(&url) {
        Ok(())
    } else {
        Err(LocalContentError::Unauthorized)
    }
}

fn trusted_url(url: &Url) -> bool {
    let packaged = (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (cfg!(target_os = "windows")
            && url.scheme() == "https"
            && url.host_str() == Some("tauri.localhost"));
    let development = cfg!(debug_assertions)
        && url.scheme() == "http"
        && matches!(url.host_str(), Some("127.0.0.1" | "localhost"))
        && url.port() == Some(1420);
    packaged || development
}

#[tauri::command]
pub fn local_content_authorize_workspace<R: Runtime>(
    window: WebviewWindow<R>,
    state: State<'_, LocalContentState>,
    workspace_id: String,
) -> Result<(), String> {
    trusted_window(&window)
        .and_then(|_| state.authorize(&workspace_id))
        .map_err(|error| error.public_message())
}

#[tauri::command]
pub async fn local_content_create<R: Runtime>(
    window: WebviewWindow<R>,
    state: State<'_, LocalContentState>,
    input: CreateContentInput,
) -> Result<ContentRef, String> {
    trusted_window(&window)
        .and_then(|_| state.require_workspace(&input.workspace_id))
        .map_err(|error| error.public_message())?;
    let repository = state.repository.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let repository = repository.lock().map_err(|_| LocalContentError::Storage)?;
        repository
            .as_ref()
            .ok_or(LocalContentError::KeyUnavailable)?
            .create(input)
    })
    .await
    .map_err(|_| LocalContentError::Storage.public_message())?
    .map_err(|error| error.public_message())
}

#[tauri::command]
pub async fn local_content_read<R: Runtime>(
    window: WebviewWindow<R>,
    state: State<'_, LocalContentState>,
    input: ReadContentInput,
) -> Result<ResolvedContent, String> {
    trusted_window(&window)
        .and_then(|_| state.require_workspace(&input.workspace_id))
        .map_err(|error| error.public_message())?;
    let repository = state.repository.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let repository = repository.lock().map_err(|_| LocalContentError::Storage)?;
        repository
            .as_ref()
            .ok_or(LocalContentError::KeyUnavailable)?
            .read(&input.workspace_id, &input.content_id)
    })
    .await
    .map_err(|_| LocalContentError::Storage.public_message())?
    .map_err(|error| error.public_message())
}

#[tauri::command]
pub async fn local_content_search<R: Runtime>(
    window: WebviewWindow<R>,
    state: State<'_, LocalContentState>,
    input: SearchContentInput,
) -> Result<Vec<LocalSearchResult>, String> {
    trusted_window(&window)
        .and_then(|_| state.require_workspace(&input.workspace_id))
        .map_err(|error| error.public_message())?;
    let repository = state.repository.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let repository = repository.lock().map_err(|_| LocalContentError::Storage)?;
        repository
            .as_ref()
            .ok_or(LocalContentError::KeyUnavailable)?
            .search(input)
    })
    .await
    .map_err(|_| LocalContentError::Storage.public_message())?
    .map_err(|error| error.public_message())
}

#[tauri::command]
pub async fn local_content_update<R: Runtime>(
    window: WebviewWindow<R>,
    state: State<'_, LocalContentState>,
    input: UpdateContentInput,
) -> Result<ContentRef, String> {
    trusted_window(&window)
        .and_then(|_| state.require_workspace(&input.workspace_id))
        .map_err(|error| error.public_message())?;
    let repository = state.repository.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let repository = repository.lock().map_err(|_| LocalContentError::Storage)?;
        repository
            .as_ref()
            .ok_or(LocalContentError::KeyUnavailable)?
            .update(input)
    })
    .await
    .map_err(|_| LocalContentError::Storage.public_message())?
    .map_err(|error| error.public_message())
}

#[tauri::command]
pub async fn local_content_delete<R: Runtime>(
    window: WebviewWindow<R>,
    state: State<'_, LocalContentState>,
    input: DeleteContentInput,
) -> Result<ContentRef, String> {
    trusted_window(&window)
        .and_then(|_| state.require_workspace(&input.workspace_id))
        .map_err(|error| error.public_message())?;
    let repository = state.repository.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let repository = repository.lock().map_err(|_| LocalContentError::Storage)?;
        repository
            .as_ref()
            .ok_or(LocalContentError::KeyUnavailable)?
            .delete(input)
    })
    .await
    .map_err(|_| LocalContentError::Storage.public_message())?
    .map_err(|error| error.public_message())
}

#[tauri::command]
pub async fn local_content_health<R: Runtime>(
    window: WebviewWindow<R>,
    state: State<'_, LocalContentState>,
    workspace_id: String,
) -> Result<ContentHealth, String> {
    trusted_window(&window)
        .and_then(|_| state.require_workspace(&workspace_id))
        .map_err(|error| error.public_message())?;
    let repository = state.repository.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let repository = repository.lock().map_err(|_| LocalContentError::Storage)?;
        match repository.as_ref() {
            Some(repository) => repository.health(),
            None => Ok(ContentHealth {
                available: false,
                current_key_version: 0,
                rotation_in_progress: false,
            }),
        }
    })
    .await
    .map_err(|_| LocalContentError::Storage.public_message())?
    .map_err(|error| error.public_message())
}

#[tauri::command]
pub async fn local_content_rotate_key<R: Runtime>(
    window: WebviewWindow<R>,
    state: State<'_, LocalContentState>,
    workspace_id: String,
    batch_size: usize,
) -> Result<RotationStatus, String> {
    trusted_window(&window)
        .and_then(|_| state.require_workspace(&workspace_id))
        .map_err(|error| error.public_message())?;
    let repository = state.repository.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let repository = repository.lock().map_err(|_| LocalContentError::Storage)?;
        repository
            .as_ref()
            .ok_or(LocalContentError::KeyUnavailable)?
            .rotate(batch_size)
    })
    .await
    .map_err(|_| LocalContentError::Storage.public_message())?
    .map_err(|error| error.public_message())
}

fn validate_create(input: &CreateContentInput) -> Result<(), LocalContentError> {
    validated_uuid(&input.workspace_id)?;
    if let Some(id) = &input.task_id {
        validated_uuid(id)?;
    }
    if let Some(id) = &input.message_id {
        validated_uuid(id)?;
    }
    if matches!(
        input.content_type,
        ContentType::TaskObjective | ContentType::TaskInput
    ) && input.message_id.is_some()
    {
        return Err(LocalContentError::Invalid);
    }
    if matches!(input.content_type, ContentType::MessageBody) && input.task_id.is_some() {
        return Err(LocalContentError::Invalid);
    }
    if !matches!(input.sensitivity.as_str(), "sensitive" | "restricted")
        || input.storage_policy != "local_authority"
        || !matches!(
            input.synchronization_policy.as_str(),
            "local_only" | "e2e_optional"
        )
    {
        return Err(LocalContentError::Invalid);
    }
    validate_plaintext(&input.plaintext)
}

fn bounded_snippet(plaintext: &str, query: &str) -> String {
    const MAX_CHARS: usize = 200;
    let normalized = plaintext.to_lowercase();
    let match_byte = normalized.find(&query.to_lowercase()).unwrap_or(0);
    let match_char = normalized[..match_byte].chars().count();
    let start = match_char.saturating_sub(60);
    let snippet: String = plaintext.chars().skip(start).take(MAX_CHARS).collect();
    format!(
        "{}{}{}",
        if start > 0 { "…" } else { "" },
        snippet,
        if plaintext.chars().count() > start + MAX_CHARS {
            "…"
        } else {
            ""
        }
    )
}

fn validate_plaintext(plaintext: &str) -> Result<(), LocalContentError> {
    if plaintext.trim().is_empty()
        || plaintext.len() > MAX_CONTENT_BYTES
        || plaintext.contains('\0')
    {
        Err(LocalContentError::Invalid)
    } else {
        Ok(())
    }
}

fn validated_uuid(value: &str) -> Result<String, LocalContentError> {
    Uuid::parse_str(value)
        .map(|id| id.hyphenated().to_string())
        .map_err(|_| LocalContentError::Invalid)
}

fn random_key() -> Zeroizing<Vec<u8>> {
    let mut key = Zeroizing::new(vec![0_u8; 32]);
    OsRng.fill_bytes(&mut key);
    key
}

fn timestamp() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        .to_string()
}

fn digest(plaintext: &str) -> String {
    hex::encode(Sha256::digest(plaintext.as_bytes()))
}

fn aad(
    content_id: &str,
    workspace_id: &str,
    content_type: &ContentType,
    key_version: u32,
) -> Vec<u8> {
    format!(
        "adea-content|{SCHEMA_VERSION}|{key_version}|{workspace_id}|{content_id}|{}",
        content_type.as_str()
    )
    .into_bytes()
}

fn encrypt(
    key: &[u8],
    aad: &[u8],
    plaintext: &[u8],
) -> Result<(Vec<u8>, Vec<u8>), LocalContentError> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| LocalContentError::KeyUnavailable)?;
    // A fixed-size array keeps the AES-GCM nonce length a compile-time
    // property of the cipher rather than a checked runtime convention.
    let mut nonce_bytes = [0_u8; NONCE_LENGTH];
    OsRng.fill_bytes(&mut nonce_bytes);
    let ciphertext = cipher
        .encrypt(
            &Nonce::from(nonce_bytes),
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| LocalContentError::Storage)?;
    Ok((nonce_bytes.to_vec(), ciphertext))
}

fn decrypt(
    key: &[u8],
    aad: &[u8],
    nonce: &[u8],
    ciphertext: &[u8],
) -> Result<Vec<u8>, LocalContentError> {
    let nonce: [u8; NONCE_LENGTH] = nonce.try_into().map_err(|_| LocalContentError::Corrupt)?;
    Aes256Gcm::new_from_slice(key)
        .map_err(|_| LocalContentError::KeyUnavailable)?
        .decrypt(
            &Nonce::from(nonce),
            Payload {
                msg: ciphertext,
                aad,
            },
        )
        .map_err(|_| LocalContentError::Corrupt)
}

fn metadata_u32(connection: &Connection, key: &str) -> Result<Option<u32>, LocalContentError> {
    connection
        .query_row(
            "SELECT value FROM local_content_metadata WHERE key = ?1",
            [key],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|_| LocalContentError::Storage)?
        .map(|value| value.parse().map_err(|_| LocalContentError::Corrupt))
        .transpose()
}

fn set_metadata(connection: &Connection, key: &str, value: &str) -> Result<(), LocalContentError> {
    connection.execute("INSERT INTO local_content_metadata (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value", params![key, value]).map_err(|_| LocalContentError::Storage)?;
    Ok(())
}

fn set_metadata_tx(
    transaction: &Transaction<'_>,
    key: &str,
    value: &str,
) -> Result<(), LocalContentError> {
    transaction.execute("INSERT INTO local_content_metadata (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value", params![key, value]).map_err(|_| LocalContentError::Storage)?;
    Ok(())
}

struct EncryptedRow {
    content_ref: ContentRef,
    nonce: Vec<u8>,
    ciphertext: Vec<u8>,
}

fn map_encrypted(row: &rusqlite::Row<'_>) -> rusqlite::Result<EncryptedRow> {
    let content_type: String = row.get(2)?;
    let content_type =
        ContentType::parse(&content_type).map_err(|_| rusqlite::Error::InvalidQuery)?;
    Ok(EncryptedRow {
        content_ref: ContentRef {
            id: row.get(0)?,
            workspace_id: row.get(1)?,
            content_type,
            task_id: row.get(3)?,
            message_id: row.get(4)?,
            revision: row.get::<_, i64>(5)? as u64,
            digest_sha256: row.get(6)?,
            sensitivity: row.get(7)?,
            storage_policy: row.get(8)?,
            synchronization_policy: row.get(9)?,
            availability: row.get(10)?,
            schema_version: row.get(11)?,
            key_version: row.get(12)?,
            created_at: row.get(13)?,
            updated_at: row.get(14)?,
            deleted_at: row.get(15)?,
        },
        nonce: row.get(16)?,
        ciphertext: row.get(17)?,
    })
}

const SELECT_ENCRYPTED: &str = "SELECT content_id, workspace_id, content_type, task_id, message_id, revision, digest_sha256, sensitivity, storage_policy, synchronization_policy, availability, schema_version, key_version, created_at, updated_at, deleted_at, nonce, ciphertext FROM local_content_records";

fn select_encrypted(
    connection: &Connection,
    content_id: &str,
) -> Result<Option<EncryptedRow>, LocalContentError> {
    connection
        .query_row(
            &format!("{SELECT_ENCRYPTED} WHERE content_id = ?1"),
            [content_id],
            map_encrypted,
        )
        .optional()
        .map_err(|_| LocalContentError::Storage)
}

fn select_ref(
    connection: &Connection,
    content_id: &str,
) -> Result<Option<ContentRef>, LocalContentError> {
    Ok(select_encrypted(connection, content_id)?.map(|row| row.content_ref))
}

struct RotationState {
    from_version: u32,
    to_version: u32,
}

fn rotation(connection: &Connection) -> Result<Option<RotationState>, LocalContentError> {
    connection
        .query_row(
            "SELECT from_version, to_version FROM local_content_rotation WHERE singleton = 1",
            [],
            |row| {
                Ok(RotationState {
                    from_version: row.get(0)?,
                    to_version: row.get(1)?,
                })
            },
        )
        .optional()
        .map_err(|_| LocalContentError::Storage)
}

fn rotation_rows(
    transaction: &Transaction<'_>,
    state: &RotationState,
    limit: usize,
) -> Result<Vec<EncryptedRow>, LocalContentError> {
    let mut statement = transaction.prepare(&format!("{SELECT_ENCRYPTED} WHERE deleted_at IS NULL AND key_version != ?1 ORDER BY content_id LIMIT ?2")).map_err(|_| LocalContentError::Storage)?;
    let rows = statement
        .query_map(params![state.to_version, limit as i64], map_encrypted)
        .map_err(|_| LocalContentError::Storage)?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|_| LocalContentError::Storage)
}

fn verify_rotated(
    transaction: &Transaction<'_>,
    repository: &Repository,
    version: u32,
) -> Result<(), LocalContentError> {
    let mut statement = transaction
        .prepare(&format!(
            "{SELECT_ENCRYPTED} WHERE deleted_at IS NULL ORDER BY content_id"
        ))
        .map_err(|_| LocalContentError::Storage)?;
    let rows = statement
        .query_map([], map_encrypted)
        .map_err(|_| LocalContentError::Storage)?;
    for row in rows {
        let row = row.map_err(|_| LocalContentError::Storage)?;
        if row.content_ref.key_version != version {
            return Err(LocalContentError::Corrupt);
        }
        let plaintext = decrypt(
            &repository.key(version)?,
            &aad(
                &row.content_ref.id,
                &row.content_ref.workspace_id,
                &row.content_ref.content_type,
                version,
            ),
            &row.nonce,
            &row.ciphertext,
        )?;
        if hex::encode(Sha256::digest(&plaintext)) != row.content_ref.digest_sha256 {
            return Err(LocalContentError::Corrupt);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use tempfile::TempDir;

    #[derive(Default)]
    struct MemoryKeys(Mutex<HashMap<u32, Vec<u8>>>);
    impl KeyStore for MemoryKeys {
        fn get(&self, version: u32) -> Result<Option<Zeroizing<Vec<u8>>>, LocalContentError> {
            Ok(self
                .0
                .lock()
                .unwrap()
                .get(&version)
                .cloned()
                .map(Zeroizing::new))
        }
        fn set(&self, version: u32, key: &[u8]) -> Result<(), LocalContentError> {
            self.0.lock().unwrap().insert(version, key.to_vec());
            Ok(())
        }
        fn delete(&self, version: u32) -> Result<(), LocalContentError> {
            self.0.lock().unwrap().remove(&version);
            Ok(())
        }
    }

    fn fixture() -> (TempDir, Arc<MemoryKeys>, Repository, String, String, String) {
        let directory = TempDir::new().unwrap();
        let keys = Arc::new(MemoryKeys::default());
        let repository =
            Repository::open(directory.path().join(DATABASE_FILENAME), keys.clone()).unwrap();
        (
            directory,
            keys,
            repository,
            Uuid::new_v4().to_string(),
            Uuid::new_v4().to_string(),
            Uuid::new_v4().to_string(),
        )
    }

    fn input(
        workspace_id: &str,
        message_id: &str,
        content_id: Option<String>,
        plaintext: &str,
    ) -> CreateContentInput {
        CreateContentInput {
            content_id,
            workspace_id: workspace_id.to_string(),
            content_type: ContentType::MessageBody,
            task_id: None,
            message_id: Some(message_id.to_string()),
            plaintext: plaintext.to_string(),
            sensitivity: "restricted".to_string(),
            storage_policy: "local_authority".to_string(),
            synchronization_policy: "local_only".to_string(),
        }
    }

    fn task_input(
        workspace_id: &str,
        task_id: Option<String>,
        content_id: Option<String>,
        plaintext: &str,
    ) -> CreateContentInput {
        CreateContentInput {
            content_id,
            workspace_id: workspace_id.to_string(),
            content_type: ContentType::TaskInput,
            task_id,
            message_id: None,
            plaintext: plaintext.to_string(),
            sensitivity: "restricted".to_string(),
            storage_policy: "local_authority".to_string(),
            synchronization_policy: "local_only".to_string(),
        }
    }

    #[test]
    fn ciphertext_at_rest_and_aad_prevent_plaintext_or_cross_workspace_resolution() {
        let (directory, _keys, repository, workspace, other_workspace, message) = fixture();
        let canary = "PRIVATE-CONTENT-LEAK-CANARY-48291";
        let reference = repository
            .create(input(&workspace, &message, None, canary))
            .unwrap();
        assert_eq!(
            repository
                .read(&workspace, &reference.id)
                .unwrap()
                .plaintext,
            canary
        );
        assert_eq!(
            repository.read(&other_workspace, &reference.id),
            Err(LocalContentError::Unauthorized)
        );
        assert!(!fs::read(directory.path().join(DATABASE_FILENAME))
            .unwrap()
            .windows(canary.len())
            .any(|window| window == canary.as_bytes()));

        let second = repository
            .create(input(&workspace, &message, None, canary))
            .unwrap();
        let connection = repository.connection().unwrap();
        let first_encrypted = select_encrypted(&connection, &reference.id)
            .unwrap()
            .unwrap();
        let second_encrypted = select_encrypted(&connection, &second.id).unwrap().unwrap();
        assert_ne!(first_encrypted.nonce, second_encrypted.nonce);

        let keyless = Repository {
            path: repository.path.clone(),
            keys: Arc::new(MemoryKeys::default()),
        };
        assert_eq!(
            keyless.read(&workspace, &reference.id),
            Err(LocalContentError::KeyUnavailable)
        );

        connection
            .execute(
                "UPDATE local_content_records SET workspace_id = ?1 WHERE content_id = ?2",
                params![other_workspace, reference.id],
            )
            .unwrap();
        assert_eq!(
            repository.read(&other_workspace, &reference.id),
            Err(LocalContentError::Corrupt)
        );
    }

    #[test]
    fn retries_are_idempotent_and_updates_and_tombstones_are_revision_checked() {
        let (_directory, _keys, repository, workspace, _other, message) = fixture();
        let content_id = Uuid::new_v4().to_string();
        let first = repository
            .create(input(
                &workspace,
                &message,
                Some(content_id.clone()),
                "first",
            ))
            .unwrap();
        let retried = repository
            .create(input(
                &workspace,
                &message,
                Some(content_id.clone()),
                "first",
            ))
            .unwrap();
        assert_eq!(first, retried);
        assert_eq!(
            repository.create(input(
                &workspace,
                &message,
                Some(content_id.clone()),
                "different"
            )),
            Err(LocalContentError::Conflict)
        );
        let updated = repository
            .update(UpdateContentInput {
                content_id: content_id.clone(),
                workspace_id: workspace.clone(),
                expected_revision: 1,
                plaintext: "second".to_string(),
            })
            .unwrap();
        assert_eq!(updated.revision, 2);
        assert_eq!(
            repository.update(UpdateContentInput {
                content_id: content_id.clone(),
                workspace_id: workspace.clone(),
                expected_revision: 1,
                plaintext: "stale".to_string()
            }),
            Err(LocalContentError::Conflict)
        );
        let deleted = repository
            .delete(DeleteContentInput {
                content_id: content_id.clone(),
                workspace_id: workspace.clone(),
                expected_revision: 2,
            })
            .unwrap();
        assert_eq!(deleted.availability, "deleted");
        assert_eq!(
            repository.read(&workspace, &content_id),
            Err(LocalContentError::NotFound)
        );
    }

    #[test]
    fn key_rotation_resumes_in_batches_and_retires_old_key_after_verification() {
        let (_directory, keys, repository, workspace, _other, message) = fixture();
        for (index, content_id) in [
            "80000000-0000-4000-8000-000000000001",
            "90000000-0000-4000-8000-000000000002",
            "a0000000-0000-4000-8000-000000000003",
        ]
        .into_iter()
        .enumerate()
        {
            repository
                .create(input(
                    &workspace,
                    &message,
                    Some(content_id.to_string()),
                    &format!("secret-{index}"),
                ))
                .unwrap();
        }
        let first = repository.rotate(1).unwrap();
        assert!(!first.complete);
        assert!(keys.0.lock().unwrap().contains_key(&1));

        let during_rotation = repository
            .create(input(
                &workspace,
                &message,
                Some("00000000-0000-4000-8000-000000000004".to_string()),
                "created-during-rotation",
            ))
            .unwrap();
        assert_eq!(during_rotation.key_version, 2);

        let reopened = Repository::open(repository.path.clone(), keys.clone()).unwrap();
        let second = reopened.rotate(1).unwrap();
        assert!(!second.complete);
        let final_status = reopened.rotate(1).unwrap();
        assert!(final_status.complete);
        assert_eq!(final_status.current_key_version, 2);
        assert!(!keys.0.lock().unwrap().contains_key(&1));
        assert!(keys.0.lock().unwrap().contains_key(&2));
    }

    #[test]
    fn missing_key_and_validation_errors_do_not_echo_plaintext() {
        let (_directory, keys, repository, workspace, _other, message) = fixture();
        let canary = "do-not-echo-private-body";
        let reference = repository
            .create(input(&workspace, &message, None, canary))
            .unwrap();
        keys.delete(1).unwrap();
        let error = repository
            .read(&workspace, &reference.id)
            .unwrap_err()
            .public_message();
        assert_eq!(error, "local content key is unavailable");
        assert!(!error.contains(canary));
        assert_eq!(validate_plaintext(""), Err(LocalContentError::Invalid));
        assert_eq!(
            validate_plaintext(&"x".repeat(MAX_CONTENT_BYTES + 1)),
            Err(LocalContentError::Invalid)
        );
    }

    #[test]
    fn private_task_fixture_reconciles_and_resolves_without_cloud_or_diagnostic_leaks() {
        let (directory, _keys, repository, workspace, other_workspace, _message) = fixture();
        let canary = "FUTURE-EXECUTION-PRIVATE-INPUT-73915";
        let content_id = Uuid::new_v4().to_string();
        let task_id = Uuid::new_v4().to_string();

        let pending = repository
            .create(task_input(
                &workspace,
                None,
                Some(content_id.clone()),
                canary,
            ))
            .unwrap();
        assert_eq!(pending.task_id, None);
        let attached = repository
            .create(task_input(
                &workspace,
                Some(task_id.clone()),
                Some(content_id.clone()),
                canary,
            ))
            .unwrap();
        assert_eq!(attached.id, pending.id);
        assert_eq!(attached.task_id.as_deref(), Some(task_id.as_str()));
        assert_eq!(
            repository
                .create(task_input(
                    &workspace,
                    None,
                    Some(content_id.clone()),
                    canary,
                ))
                .unwrap()
                .task_id
                .as_deref(),
            Some(task_id.as_str())
        );

        let neon_shaped_metadata = serde_json::json!({
            "contentRef": attached,
            "task": {
                "id": task_id,
                "objectiveContentRefId": content_id,
                "workspaceId": workspace,
            },
            "workspaceEvent": { "eventType": "task.created" },
        });
        let cloud_payload = neon_shaped_metadata.to_string();
        let logs = LocalContentError::Storage.public_message();
        let telemetry =
            serde_json::json!({ "operation": "local_content_read", "ok": false }).to_string();
        let export = serde_json::json!({ "contentRef": pending }).to_string();
        for fixture in [&cloud_payload, &logs, &telemetry, &export] {
            assert!(!fixture.contains(canary));
        }

        let future_execution_input = repository.read(&workspace, &content_id).unwrap().plaintext;
        assert_eq!(future_execution_input, canary);
        assert_eq!(
            repository.read(&other_workspace, &content_id),
            Err(LocalContentError::Unauthorized)
        );

        for entry in fs::read_dir(directory.path()).unwrap() {
            let bytes = fs::read(entry.unwrap().path()).unwrap();
            assert!(!bytes
                .windows(canary.len())
                .any(|window| window == canary.as_bytes()));
        }
    }

    #[test]
    fn search_is_workspace_scoped_bounded_and_leaves_no_plaintext_index() {
        let (directory, _keys, repository, workspace, other_workspace, message) = fixture();
        let canary = "LOCAL-PRIVATE-SEARCH-CANARY-91827";
        let reference = repository
            .create(input(
                &workspace,
                &message,
                None,
                &format!("A private planning note with {canary} inside."),
            ))
            .unwrap();
        let task_id = Uuid::new_v4().to_string();
        let task_reference = repository
            .create(task_input(
                &workspace,
                Some(task_id.clone()),
                None,
                &format!("Private task input also includes {canary}."),
            ))
            .unwrap();
        let results = repository
            .search(SearchContentInput {
                workspace_id: workspace.clone(),
                query: "search-canary".to_string(),
                limit: Some(10),
            })
            .unwrap();
        assert_eq!(results.len(), 2);
        assert!(results
            .iter()
            .any(|result| result.content_id == reference.id));
        assert!(results
            .iter()
            .any(|result| result.content_id == task_reference.id
                && result.task_id.as_deref() == Some(task_id.as_str())));
        assert!(results.iter().all(|result| result.snippet.contains(canary)));
        assert!(repository
            .search(SearchContentInput {
                workspace_id: other_workspace,
                query: "search-canary".to_string(),
                limit: Some(10),
            })
            .unwrap()
            .is_empty());
        assert_eq!(
            repository.search(SearchContentInput {
                workspace_id: workspace,
                query: "x".to_string(),
                limit: Some(10),
            }),
            Err(LocalContentError::Invalid)
        );

        for entry in fs::read_dir(directory.path()).unwrap() {
            let bytes = fs::read(entry.unwrap().path()).unwrap();
            assert!(!bytes
                .windows(canary.len())
                .any(|window| window == canary.as_bytes()));
            assert!(!bytes
                .windows("search-canary".len())
                .any(|window| window == b"search-canary"));
        }
        for payload in [
            serde_json::json!({ "operation": "local_content_search", "ok": true }).to_string(),
            LocalContentError::Storage.public_message(),
            serde_json::json!({ "contentRef": reference }).to_string(),
        ] {
            assert!(!payload.contains(canary));
        }
    }

    #[test]
    fn trusted_origin_check_rejects_navigated_or_lookalike_pages() {
        assert!(trusted_url(
            &Url::parse("tauri://localhost/index.html").unwrap()
        ));
        assert!(!trusted_url(
            &Url::parse("https://localhost/index.html").unwrap()
        ));
        assert!(!trusted_url(
            &Url::parse("tauri://localhost.attacker.example/index.html").unwrap()
        ));
        assert!(!trusted_url(&Url::parse("file:///tmp/index.html").unwrap()));
    }

    #[test]
    fn renderer_workspace_authorization_is_explicit_and_workspace_scoped() {
        let (_directory, _keys, repository, workspace, other_workspace, _message) = fixture();
        let state = LocalContentState {
            repository: Arc::new(Mutex::new(Some(repository))),
            authorized_workspaces: Arc::new(Mutex::new(HashSet::new())),
        };
        assert_eq!(
            state.require_workspace(&workspace),
            Err(LocalContentError::Unauthorized)
        );
        state.authorize(&workspace).unwrap();
        assert_eq!(state.require_workspace(&workspace), Ok(()));
        assert_eq!(
            state.require_workspace(&other_workspace),
            Err(LocalContentError::Unauthorized)
        );
        state.authorize(&other_workspace).unwrap();
        assert_eq!(
            state.require_workspace(&workspace),
            Err(LocalContentError::Unauthorized)
        );
    }
}
