//! Contract test for the shell's IPC surface.
//!
//! `generate_handler!` (which commands can be called) and the capability ACL
//! (which commands each window may call) are two hand-maintained lists, and the
//! shell defines an app ACL manifest — so Tauri rejects any command that is
//! registered but not granted, and silently keeps any privilege that is granted
//! but no longer registered. Drift in either direction is invisible at compile
//! time and only shows up as a broken feature or a stale privilege.
//!
//! The same contract is asserted from the JavaScript lane in
//! `scripts/desktop-ipc-boundary.test.ts`; both read the same four files, so a
//! change to any one of them cannot pass unnoticed in either lane.

use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::PathBuf,
};

/// A permission file's declared identifier and the commands it grants.
#[derive(Debug)]
struct PermissionGrant {
    identifier: String,
    commands: BTreeSet<String>,
}

/// Path to the shell crate, independent of the test runner's working directory.
fn crate_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// Command names registered in `generate_handler!`.
fn registered_commands() -> BTreeSet<String> {
    let source = fs::read_to_string(crate_root().join("src/main.rs")).expect("read main.rs");
    let start = source
        .find("generate_handler![")
        .expect("main.rs registers commands with generate_handler!");
    let body = &source[start..];
    let end = body
        .find(']')
        .expect("generate_handler! list is terminated");

    body[..end]
        .lines()
        .map(str::trim)
        .filter(|line| {
            !line.is_empty() && !line.starts_with('#') && !line.contains("generate_handler")
        })
        .map(|line| {
            line.trim_end_matches(',')
                .rsplit("::")
                .next()
                .expect("command path has a final segment")
                .to_string()
        })
        .collect()
}

/// Every `permissions/*.toml` grant, keyed by identifier.
fn permission_grants() -> BTreeMap<String, PermissionGrant> {
    let directory = crate_root().join("permissions");
    let mut paths: Vec<PathBuf> = fs::read_dir(&directory)
        .expect("read the permissions directory")
        .map(|entry| entry.expect("permissions entry").path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "toml")
        })
        .collect();
    paths.sort();
    assert!(
        !paths.is_empty(),
        "the shell must declare its permissions in {directory:?}"
    );

    let mut grants = BTreeMap::new();
    for path in paths {
        let raw = fs::read_to_string(&path).expect("read permission file");
        let document: toml::Value = toml::from_str(&raw).expect("parse permission file");
        let permissions = document
            .get("permission")
            .and_then(toml::Value::as_array)
            .unwrap_or_else(|| panic!("{} declares [[permission]] entries", path.display()));
        for permission in permissions {
            let identifier = permission
                .get("identifier")
                .and_then(toml::Value::as_str)
                .unwrap_or_else(|| panic!("{} declares an identifier", path.display()))
                .to_string();
            let commands: BTreeSet<String> = permission
                .get("commands")
                .and_then(|commands| commands.get("allow"))
                .and_then(toml::Value::as_array)
                .unwrap_or_else(|| panic!("{identifier} allows commands"))
                .iter()
                .map(|command| {
                    command
                        .as_str()
                        .unwrap_or_else(|| panic!("{identifier} lists command names"))
                        .to_string()
                })
                .collect();
            assert!(
                !commands.is_empty(),
                "{identifier} must name the commands it grants"
            );
            assert!(
                grants
                    .insert(
                        identifier.clone(),
                        PermissionGrant {
                            identifier,
                            commands
                        }
                    )
                    .is_none(),
                "permission identifiers are unique"
            );
        }
    }
    grants
}

/// Permission identifiers the capabilities file references.
fn capability_permissions() -> Vec<String> {
    let path = crate_root().join("capabilities/default.json");
    let raw = fs::read_to_string(&path).expect("read the capabilities file");
    let document: serde_json::Value = serde_json::from_str(&raw).expect("parse capabilities");
    document
        .get("permissions")
        .and_then(serde_json::Value::as_array)
        .unwrap_or_else(|| panic!("{} lists permissions", path.display()))
        .iter()
        .map(|permission| {
            permission
                .as_str()
                .unwrap_or_else(|| panic!("{} lists permission names", path.display()))
                .to_string()
        })
        .collect()
}

fn describe(commands: &BTreeSet<String>) -> String {
    commands.iter().cloned().collect::<Vec<_>>().join(", ")
}

#[test]
fn every_registered_command_is_granted_exactly_once() {
    let registered = registered_commands();
    let grants = permission_grants();

    let mut granted: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for grant in grants.values() {
        for command in &grant.commands {
            granted
                .entry(command.clone())
                .or_default()
                .push(grant.identifier.clone());
        }
    }

    let unregistered: BTreeSet<String> = registered
        .iter()
        .filter(|command| !granted.contains_key(*command))
        .cloned()
        .collect();
    let ungranted: BTreeSet<String> = granted
        .keys()
        .filter(|command| !registered.contains(*command))
        .cloned()
        .collect();
    assert!(
        unregistered.is_empty(),
        "registered but not granted by any permission: {}",
        describe(&unregistered)
    );
    assert!(
        ungranted.is_empty(),
        "granted but not registered in generate_handler!: {}",
        describe(&ungranted)
    );

    let duplicated: BTreeMap<String, Vec<String>> = granted
        .into_iter()
        .filter(|(_, permissions)| permissions.len() > 1)
        .collect();
    assert!(
        duplicated.is_empty(),
        "every command must be granted by exactly one permission, but these are granted by several: {duplicated:?}"
    );
}

#[test]
fn the_capability_references_every_permission_file_and_only_real_ones() {
    let grants = permission_grants();
    let referenced: BTreeSet<String> = capability_permissions()
        .into_iter()
        .filter(|permission| !permission.contains(':'))
        .collect();

    let unknown: BTreeSet<String> = referenced
        .iter()
        .filter(|permission| !grants.contains_key(*permission))
        .cloned()
        .collect();
    assert!(
        unknown.is_empty(),
        "the capability references permissions that no permission file declares: {}",
        describe(&unknown)
    );

    let unreferenced: BTreeSet<String> = grants
        .keys()
        .filter(|permission| !referenced.contains(*permission))
        .cloned()
        .collect();
    assert!(
        unreferenced.is_empty(),
        "these permission files grant nothing to any window: {}",
        describe(&unreferenced)
    );
}

#[test]
fn the_contract_files_exist_where_the_test_expects_them() {
    for relative in [
        "src/main.rs",
        "capabilities/default.json",
        "permissions/desktop-auth.toml",
    ] {
        assert!(
            crate_root().join(relative).is_file(),
            "{relative} is part of the IPC contract"
        );
    }
}
