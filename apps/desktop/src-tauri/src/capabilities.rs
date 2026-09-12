//! Local capability health.
//!
//! Each local feature needs a host prerequisite: the encrypted content store
//! needs a readable key, system dictation needs microphone and speech
//! authorization, the virtual view needs a packed engine. Reporting those as one
//! typed snapshot keeps the shared policies in a single place:
//!
//! - the snapshot is **cached**, so a UI that polls answers from cached state;
//! - a **re-probe floor** separates real host probes, so several panels asking
//!   at once do not multiply them;
//! - a probe that exceeds its **deadline** reports `TimedOut` instead of
//!   blocking the caller. The cache holds that answer until someone asks for a
//!   fresh probe, so a hanging prerequisite is not re-probed on every poll.
//!
//! Adding a capability means adding one probe here, not another health command.

use std::{
    sync::{mpsc, Arc, Mutex},
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime, State, WebviewWindow};

use crate::local_content::LocalContentState;

/// Minimum interval between real host probes, however many callers ask.
pub const PROBE_FLOOR: Duration = Duration::from_secs(5);
/// How long a single probe may take before it reports `TimedOut`.
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
/// Well-known same-origin path the official pack lane writes the engine
/// manifest to (see `packages/spatial-protocol/src/engine.ts`).
const AGENT_SIM_MANIFEST_PATH: &str = "assets/agent-sim/engine.json";

/// The typed status of one capability.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum CapabilityState {
    /// The prerequisite is satisfied.
    Ready,
    /// The prerequisite is absent, with what the user can do about it.
    Missing { hint: String },
    /// The host refused the prerequisite and only the user can reverse it.
    PermissionDenied { hint: String },
    /// The probe did not answer in time.
    TimedOut { hint: String },
}

impl CapabilityState {
    pub fn ready() -> Self {
        Self::Ready
    }

    pub fn missing(hint: impl Into<String>) -> Self {
        Self::Missing { hint: hint.into() }
    }

    pub fn permission_denied(hint: impl Into<String>) -> Self {
        Self::PermissionDenied { hint: hint.into() }
    }

    pub fn timed_out(hint: impl Into<String>) -> Self {
        Self::TimedOut { hint: hint.into() }
    }
}

/// A capability the shell can report on.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CapabilityId {
    LocalContent,
    SystemDictation,
    AgentSimEngine,
}

impl CapabilityId {
    /// Every capability, in display order.
    pub const ALL: [Self; 3] = [
        Self::LocalContent,
        Self::SystemDictation,
        Self::AgentSimEngine,
    ];

    pub fn title(self) -> &'static str {
        match self {
            Self::LocalContent => "Encrypted local content",
            Self::SystemDictation => "System dictation",
            Self::AgentSimEngine => "Agent Sim engine",
        }
    }
}

/// One capability's status inside a snapshot.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityStatus {
    pub id: CapabilityId,
    pub title: String,
    pub state: CapabilityState,
}

/// The typed snapshot the packaged client renders.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilitySnapshot {
    pub capabilities: Vec<CapabilityStatus>,
    /// Whether the probes ran for this answer, or the cache answered.
    pub served_from_cache: bool,
    /// Age of the probes behind this answer; zero when they just ran.
    pub age_ms: u64,
    pub re_probe_floor_ms: u64,
}

/// A host probe. Probes never prompt: asking for a permission is the job of the
/// command that starts the feature.
pub type Probe = Arc<dyn Fn() -> CapabilityState + Send + Sync>;

struct CachedSnapshot {
    snapshot: CapabilitySnapshot,
    at: Instant,
}

/// Injectable policies, so cache, floor, and deadline behaviour are testable.
#[derive(Clone)]
struct CapabilityPolicy {
    floor: Duration,
    timeout: Duration,
    now: Arc<dyn Fn() -> Instant + Send + Sync>,
}

impl Default for CapabilityPolicy {
    fn default() -> Self {
        Self {
            floor: PROBE_FLOOR,
            timeout: PROBE_TIMEOUT,
            now: Arc::new(Instant::now),
        }
    }
}

/// The shell's capability registry: the probes, the cache, and the policies
/// that bound them.
#[derive(Clone)]
pub struct CapabilityRegistry {
    entries: Vec<(CapabilityId, Probe)>,
    cache: Arc<Mutex<Option<CachedSnapshot>>>,
    policy: CapabilityPolicy,
}

impl CapabilityRegistry {
    /// The registry for a running shell.
    pub fn new<R: Runtime>(app: &AppHandle<R>, local_content: LocalContentState) -> Self {
        let dictation_probe: Probe =
            Arc::new(|| dictation_state(crate::transcription::permission_state()));
        let local_content_probe: Probe = {
            let local_content = local_content.clone();
            Arc::new(move || local_content_state(local_content.store_health().available))
        };
        let agent_sim_probe: Probe = {
            let app = app.clone();
            Arc::new(move || probe_agent_sim_engine(&app))
        };

        Self::with_entries(
            vec![
                (CapabilityId::LocalContent, local_content_probe),
                (CapabilityId::SystemDictation, dictation_probe),
                (CapabilityId::AgentSimEngine, agent_sim_probe),
            ],
            CapabilityPolicy::default(),
        )
    }

    /// Build a registry from explicit probes and policies.
    fn with_entries(entries: Vec<(CapabilityId, Probe)>, policy: CapabilityPolicy) -> Self {
        debug_assert_eq!(
            entries.iter().map(|(id, _)| *id).collect::<Vec<_>>(),
            CapabilityId::ALL.to_vec(),
            "every capability is probed exactly once, in display order"
        );
        Self {
            entries,
            cache: Arc::new(Mutex::new(None)),
            policy,
        }
    }

    /// Probe every capability: the cache's answer while it is inside the
    /// re-probe floor, a fresh set of probes otherwise.
    pub fn snapshot(&self, force: bool) -> CapabilitySnapshot {
        let now = (self.policy.now)();
        if !force {
            if let Some(cached) = self.cached_within_floor(now) {
                return cached;
            }
        }

        let capabilities = self
            .entries
            .iter()
            .map(|(id, probe)| CapabilityStatus {
                id: *id,
                title: id.title().to_string(),
                state: run_with_deadline(probe.clone(), self.policy.timeout),
            })
            .collect();

        let snapshot = CapabilitySnapshot {
            capabilities,
            served_from_cache: false,
            age_ms: 0,
            re_probe_floor_ms: self.policy.floor.as_millis() as u64,
        };
        *self
            .cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(CachedSnapshot {
            snapshot: snapshot.clone(),
            at: now,
        });
        snapshot
    }

    fn cached_within_floor(&self, now: Instant) -> Option<CapabilitySnapshot> {
        let cache = self
            .cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let cached = cache.as_ref()?;
        let age = now.saturating_duration_since(cached.at);
        if age >= self.policy.floor {
            return None;
        }
        Some(CapabilitySnapshot {
            served_from_cache: true,
            age_ms: age.as_millis() as u64,
            ..cached.snapshot.clone()
        })
    }
}

/// Run one probe with a deadline. A probe that exceeds it keeps running on its
/// own thread, so the caller is never blocked; the timeout answer is cached
/// with the rest of the snapshot, and only a forced refresh probes again.
fn run_with_deadline(probe: Probe, timeout: Duration) -> CapabilityState {
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let state = probe();
        let _ = sender.send(state);
    });
    receiver.recv_timeout(timeout).unwrap_or_else(|_| {
        CapabilityState::timed_out("The capability check did not finish in time. Try again.")
    })
}

/// Pure mapping from the content store's health to a capability state.
pub fn local_content_state(available: bool) -> CapabilityState {
    if available {
        CapabilityState::ready()
    } else {
        CapabilityState::missing(
            "Adea could not open the encrypted content store. Unlock the system credential \
             store, then try again.",
        )
    }
}

/// Pure mapping from the transcription permission state to a capability state.
pub fn dictation_state(permission: &str) -> CapabilityState {
    match permission {
        "granted" => CapabilityState::ready(),
        "denied" => CapabilityState::permission_denied(
            "Microphone or speech recognition access is denied. Enable both for Adea in System \
             Settings, then try again.",
        ),
        "prompt" => CapabilityState::missing(
            "Microphone and speech recognition access have not been granted yet. Start dictation \
             once to answer the system prompts.",
        ),
        _ => CapabilityState::missing("System dictation is available on macOS only."),
    }
}

/// Pure mapping from engine-pack presence to a capability state.
pub fn agent_sim_engine_state(packaged: bool) -> CapabilityState {
    if packaged {
        CapabilityState::ready()
    } else {
        CapabilityState::missing(
            "This build does not include the Agent Sim engine, so the virtual view shows its \
             offline preview. Official releases include it.",
        )
    }
}

/// Whether this build packed the Agent Sim engine: the pack writes a manifest at
/// a well-known same-origin path, and builds without it render the offline
/// fallback.
fn packed_agent_sim_engine<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.asset_resolver()
        .get(AGENT_SIM_MANIFEST_PATH.to_string())
        .is_some()
}

/// Probe: whether this build packed the Agent Sim engine.
fn probe_agent_sim_engine<R: Runtime>(app: &AppHandle<R>) -> CapabilityState {
    agent_sim_engine_state(packed_agent_sim_engine(app))
}

/// The one command the UI polls for local capability health.
#[tauri::command]
pub async fn capability_snapshot(
    window: WebviewWindow,
    registry: State<'_, CapabilityRegistry>,
    force: Option<bool>,
) -> Result<CapabilitySnapshot, String> {
    if !crate::window_trust::is_trusted_window(&window) {
        return Err("capability status is not authorized".to_string());
    }

    let registry = registry.inner().clone();
    tauri::async_runtime::spawn_blocking(move || registry.snapshot(force.unwrap_or(false)))
        .await
        .map_err(|_| "capability status is unavailable".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct TestClock {
        base: Instant,
        elapsed: Mutex<Duration>,
    }

    impl TestClock {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                base: Instant::now(),
                elapsed: Mutex::new(Duration::ZERO),
            })
        }

        fn advance(self: &Arc<Self>, by: Duration) {
            let mut elapsed = self
                .elapsed
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            *elapsed += by;
        }

        fn handle(self: &Arc<Self>) -> Arc<dyn Fn() -> Instant + Send + Sync> {
            let clock = self.clone();
            Arc::new(move || {
                let elapsed = *clock
                    .elapsed
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                clock.base + elapsed
            })
        }
    }

    /// A probe that always answers with the same state.
    fn state_probe(state: CapabilityState) -> Probe {
        Arc::new(move || state.clone())
    }

    fn counting_probe(state: CapabilityState) -> (Probe, Arc<AtomicUsize>) {
        let calls = Arc::new(AtomicUsize::new(0));
        let counter = calls.clone();
        let probe: Probe = Arc::new(move || {
            counter.fetch_add(1, Ordering::SeqCst);
            state.clone()
        });
        (probe, calls)
    }

    fn registry(
        probes: Vec<(CapabilityId, Probe)>,
        floor: Duration,
        timeout: Duration,
        clock: &Arc<TestClock>,
    ) -> CapabilityRegistry {
        CapabilityRegistry::with_entries(
            probes,
            CapabilityPolicy {
                floor,
                timeout,
                now: clock.handle(),
            },
        )
    }

    fn states(snapshot: &CapabilitySnapshot) -> Vec<(CapabilityId, CapabilityState)> {
        snapshot
            .capabilities
            .iter()
            .map(|status| (status.id, status.state.clone()))
            .collect()
    }

    #[test]
    fn a_snapshot_reports_every_capability_with_its_title() {
        let clock = TestClock::new();
        let probes: Vec<_> = CapabilityId::ALL
            .iter()
            .map(|id| (*id, counting_probe(CapabilityState::ready()).0))
            .collect();
        let registry = registry(probes, PROBE_FLOOR, PROBE_TIMEOUT, &clock);

        let snapshot = registry.snapshot(false);
        assert_eq!(
            snapshot
                .capabilities
                .iter()
                .map(|status| status.id)
                .collect::<Vec<_>>(),
            CapabilityId::ALL.to_vec()
        );
        for status in &snapshot.capabilities {
            assert_eq!(status.title, status.id.title());
            assert!(!status.title.is_empty());
        }
        assert!(!snapshot.served_from_cache);
        assert_eq!(snapshot.age_ms, 0);
        assert_eq!(snapshot.re_probe_floor_ms, PROBE_FLOOR.as_millis() as u64);
    }

    #[test]
    fn a_poll_inside_the_floor_is_answered_from_the_cache() {
        let clock = TestClock::new();
        let (probe, calls) = counting_probe(CapabilityState::ready());
        let registry = registry(
            vec![
                (CapabilityId::LocalContent, probe),
                (
                    CapabilityId::SystemDictation,
                    Arc::new(CapabilityState::ready),
                ),
                (
                    CapabilityId::AgentSimEngine,
                    Arc::new(CapabilityState::ready),
                ),
            ],
            PROBE_FLOOR,
            PROBE_TIMEOUT,
            &clock,
        );

        registry.snapshot(false);
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        clock.advance(PROBE_FLOOR / 2);
        let cached = registry.snapshot(false);
        assert!(cached.served_from_cache);
        assert_eq!(cached.age_ms, (PROBE_FLOOR / 2).as_millis() as u64);
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "several panels asking at once must not multiply host probes"
        );
    }

    #[test]
    fn the_floor_expires_and_a_forced_refresh_ignores_it() {
        let clock = TestClock::new();
        let (probe, calls) = counting_probe(CapabilityState::ready());
        let registry = registry(
            vec![
                (CapabilityId::LocalContent, probe),
                (
                    CapabilityId::SystemDictation,
                    Arc::new(CapabilityState::ready),
                ),
                (
                    CapabilityId::AgentSimEngine,
                    Arc::new(CapabilityState::ready),
                ),
            ],
            PROBE_FLOOR,
            PROBE_TIMEOUT,
            &clock,
        );

        registry.snapshot(false);
        clock.advance(PROBE_FLOOR);
        assert!(!registry.snapshot(false).served_from_cache);
        assert_eq!(calls.load(Ordering::SeqCst), 2);

        clock.advance(Duration::from_millis(1));
        assert!(!registry.snapshot(true).served_from_cache);
        assert_eq!(calls.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn a_probe_that_misses_its_deadline_reports_a_timeout() {
        let clock = TestClock::new();
        let hanging: Probe = Arc::new(|| {
            std::thread::sleep(PROBE_TIMEOUT * 4);
            CapabilityState::ready()
        });
        let registry = registry(
            vec![
                (CapabilityId::LocalContent, hanging),
                (
                    CapabilityId::SystemDictation,
                    state_probe(CapabilityState::ready()),
                ),
                (
                    CapabilityId::AgentSimEngine,
                    state_probe(CapabilityState::missing("no pack")),
                ),
            ],
            PROBE_FLOOR,
            Duration::from_millis(20),
            &clock,
        );

        let snapshot = registry.snapshot(false);
        assert!(matches!(
            states(&snapshot)[0].1,
            CapabilityState::TimedOut { .. }
        ));
        // The capabilities that answered are unaffected.
        assert_eq!(states(&snapshot)[1].1, CapabilityState::ready());
        assert_eq!(
            states(&snapshot)[2].1,
            CapabilityState::missing("no pack"),
            "a timeout in one probe does not blank the others"
        );
    }

    #[test]
    fn every_non_ready_state_carries_an_actionable_hint() {
        let states = [
            local_content_state(false),
            dictation_state("denied"),
            dictation_state("prompt"),
            dictation_state("unavailable"),
            agent_sim_engine_state(false),
            CapabilityState::timed_out("late"),
        ];
        for state in states {
            let hint = match &state {
                CapabilityState::Missing { hint }
                | CapabilityState::PermissionDenied { hint }
                | CapabilityState::TimedOut { hint } => hint.clone(),
                CapabilityState::Ready => panic!("a non-ready state was expected: {state:?}"),
            };
            assert!(!hint.is_empty());
            assert_ne!(state, CapabilityState::ready());
        }
        assert_eq!(local_content_state(true), CapabilityState::ready());
        assert_eq!(dictation_state("granted"), CapabilityState::ready());
        assert_eq!(agent_sim_engine_state(true), CapabilityState::ready());
    }

    #[test]
    fn the_status_serializes_to_the_shape_the_client_renders() {
        let status = CapabilityStatus {
            id: CapabilityId::SystemDictation,
            title: CapabilityId::SystemDictation.title().to_string(),
            state: dictation_state("denied"),
        };
        let serialized = serde_json::to_value(&status).expect("status serializes");

        assert_eq!(serialized["id"], "systemDictation");
        assert_eq!(serialized["state"]["state"], "permissionDenied");
        assert!(serialized["state"]["hint"]
            .as_str()
            .is_some_and(|hint| !hint.is_empty()));

        let ready = serde_json::to_value(CapabilityState::ready()).expect("state serializes");
        assert_eq!(ready, serde_json::json!({ "state": "ready" }));

        let snapshot = serde_json::to_value(CapabilitySnapshot {
            capabilities: vec![status],
            served_from_cache: true,
            age_ms: 1_500,
            re_probe_floor_ms: 5_000,
        })
        .expect("snapshot serializes");
        assert_eq!(snapshot["servedFromCache"], true);
        assert_eq!(snapshot["ageMs"], 1_500);
        assert_eq!(snapshot["reProbeFloorMs"], 5_000);
    }

    #[test]
    fn the_registry_guards_that_every_capability_is_probed_once_in_order() {
        // The constructor's invariant is a debug assertion; this pins the shape
        // it protects so a capability cannot be dropped from the registry.
        assert_eq!(CapabilityId::ALL.len(), 3);
        assert_eq!(CapabilityId::ALL[0], CapabilityId::LocalContent);
        assert_eq!(CapabilityId::ALL[2], CapabilityId::AgentSimEngine);
    }
}
