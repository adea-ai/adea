//! Window geometry persistence.
//!
//! Size, position, and maximized state live as a group inside the versioned
//! preferences document, so they survive upgrades and client saves like any
//! other setting. The geometry is restored *before* the window is shown, which
//! is what avoids a visible resize flash on launch.
//!
//! Geometry is stored in logical pixels — the unit the window builder takes —
//! and a stored position is clamped onto a connected display, so a window last
//! seen on a monitor that is now unplugged comes back on screen instead of
//! off-screen.

use std::{
    sync::Mutex,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value as JsonValue};
use tauri::{Runtime, WebviewWindow};

use crate::preferences::PreferencesStore;

/// The preferences group the geometry lives in.
pub const WINDOW_GROUP: &str = "window";

/// Hardcoded floor, restored geometry or not: a window smaller than this cannot
/// show the workspace.
const MIN_WIDTH: f64 = 960.0;
const MIN_HEIGHT: f64 = 640.0;
/// Sizes outside this range are not geometry we wrote; treat them as corrupt.
const MAX_RESTORED_EDGE: f64 = 20_000.0;

/// What the launch falls back to when nothing usable is stored.
const DEFAULT_WIDTH: f64 = 1440.0;
const DEFAULT_HEIGHT: f64 = 960.0;

/// How much of the window must land on a display for a stored position to be
/// usable. The title bar is what the user needs to grab.
const VISIBLE_SLIVER: f64 = 120.0;

/// How often geometry may be written while the user drags or resizes.
const SAVE_INTERVAL: Duration = Duration::from_secs(1);

/// A display rectangle in logical pixels, so the clamping rule is testable
/// without a windowing system.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MonitorBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl MonitorBounds {
    fn right(self) -> f64 {
        self.x + self.width
    }

    fn bottom(self) -> f64 {
        self.y + self.height
    }

    /// How much of the window's title-bar strip lies inside this display.
    fn title_bar_overlap(self, x: f64, y: f64, width: f64) -> f64 {
        let left = x.max(self.x);
        let right = (x + width).min(self.right());
        let top = y.max(self.y);
        let bottom = (y + VISIBLE_SLIVER).min(self.bottom());
        (right - left).max(0.0) * (bottom - top).max(0.0)
    }

    fn center(self) -> (f64, f64) {
        (self.x + self.width / 2.0, self.y + self.height / 2.0)
    }

    /// The nearest on-screen position for a window of this size, keeping its
    /// title bar inside the display.
    fn clamp(self, x: f64, y: f64, width: f64) -> (f64, f64) {
        let max_x = (self.right() - VISIBLE_SLIVER).max(self.x);
        let min_x = (self.x - width + VISIBLE_SLIVER).min(max_x);
        let min_y = self.y;
        let max_y = (self.bottom() - VISIBLE_SLIVER).max(self.y);
        (x.clamp(min_x, max_x), y.clamp(min_y, max_y))
    }
}

/// The window's last known geometry.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowGeometry {
    pub width: f64,
    pub height: f64,
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub maximized: bool,
}

impl Default for WindowGeometry {
    fn default() -> Self {
        Self {
            width: DEFAULT_WIDTH,
            height: DEFAULT_HEIGHT,
            x: None,
            y: None,
            maximized: false,
        }
    }
}

impl WindowGeometry {
    /// Read a stored group back, rejecting values this build cannot have
    /// written. A size below the floor is raised to it rather than discarded,
    /// because the rest of the group may still be good.
    fn from_value(value: &JsonValue) -> Option<Self> {
        let width = value.get("width").and_then(JsonValue::as_f64)?;
        let height = value.get("height").and_then(JsonValue::as_f64)?;
        if !width.is_finite() || !height.is_finite() {
            return None;
        }
        if !(0.0..=MAX_RESTORED_EDGE).contains(&width)
            || !(0.0..=MAX_RESTORED_EDGE).contains(&height)
        {
            return None;
        }

        let coordinate = |key: &str| {
            value
                .get(key)
                .and_then(JsonValue::as_f64)
                .filter(|coordinate| coordinate.is_finite())
        };
        Some(Self {
            width: width.max(MIN_WIDTH),
            height: height.max(MIN_HEIGHT),
            x: coordinate("x"),
            y: coordinate("y"),
            maximized: value
                .get("maximized")
                .and_then(JsonValue::as_bool)
                .unwrap_or(false),
        })
    }

    fn to_value(self) -> JsonValue {
        json!({
            "width": self.width,
            "height": self.height,
            "x": self.x,
            "y": self.y,
            "maximized": self.maximized,
        })
    }

    /// The launch geometry: the stored group, with its position clamped onto a
    /// connected display. A stored position from a monitor that is gone is
    /// clamped to the nearest one instead of restored off-screen.
    pub fn restore_onto(self, monitors: &[MonitorBounds]) -> Self {
        let (Some(x), Some(y)) = (self.x, self.y) else {
            return Self {
                x: None,
                y: None,
                ..self
            };
        };
        if monitors.is_empty() {
            // No monitor information: let the platform place the window rather
            // than restoring a position that may be off-screen.
            return Self {
                x: None,
                y: None,
                ..self
            };
        }

        let visible = monitors
            .iter()
            .any(|monitor| monitor.title_bar_overlap(x, y, self.width) > 0.0);
        if visible {
            return self;
        }

        let nearest = monitors
            .iter()
            .min_by(|left, right| {
                let distance = |monitor: &MonitorBounds| {
                    let (center_x, center_y) = monitor.center();
                    (center_x - x).powi(2) + (center_y - y).powi(2)
                };
                distance(left)
                    .partial_cmp(&distance(right))
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .expect("monitors is not empty");
        let (x, y) = nearest.clamp(x, y, self.width);
        Self {
            x: Some(x),
            y: Some(y),
            ..self
        }
    }

    /// Geometry read from a live window, in logical pixels. A maximized window
    /// keeps the geometry it was restored from, so un-maximizing returns the
    /// user to the size they had.
    fn from_window<R: Runtime>(window: &WebviewWindow<R>) -> Option<Self> {
        let scale_factor = window.scale_factor().ok()?;
        let size = window.inner_size().ok()?.to_logical::<f64>(scale_factor);
        let position = window
            .outer_position()
            .ok()
            .map(|position| position.to_logical::<f64>(scale_factor));
        Some(Self {
            width: size.width.max(MIN_WIDTH),
            height: size.height.max(MIN_HEIGHT),
            x: position.map(|position| position.x),
            y: position.map(|position| position.y),
            maximized: window.is_maximized().unwrap_or(false),
        })
    }
}

/// Read the stored geometry, if the group is present and usable.
pub fn stored_geometry(preferences: &PreferencesStore) -> WindowGeometry {
    preferences
        .group(WINDOW_GROUP)
        .and_then(|value| WindowGeometry::from_value(&value))
        .unwrap_or_default()
}

/// The geometry a launch should use, clamped onto the connected displays.
pub fn restore_geometry(
    preferences: &PreferencesStore,
    monitors: &[MonitorBounds],
) -> WindowGeometry {
    stored_geometry(preferences).restore_onto(monitors)
}

/// The logical-pixel display rectangles the shell can see. Asked of the app,
/// not of a window, because geometry is restored before the window exists.
pub fn monitor_bounds<R: Runtime>(app: &tauri::AppHandle<R>) -> Vec<MonitorBounds> {
    let scale_factor = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|monitor| monitor.scale_factor())
        .unwrap_or(1.0);
    app.available_monitors()
        .map(|monitors| {
            monitors
                .into_iter()
                .map(|monitor| {
                    let position = monitor.position().to_logical::<f64>(scale_factor);
                    let size = monitor.size().to_logical::<f64>(scale_factor);
                    MonitorBounds {
                        x: position.x,
                        y: position.y,
                        width: size.width,
                        height: size.height,
                    }
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Persist geometry between launches, at most once per interval while the user
/// drags or resizes, and always for a state the next launch must not lose
/// (maximized, or the final geometry on close).
pub struct WindowGeometryTracker {
    preferences: PreferencesStore,
    last_write: Mutex<Option<Instant>>,
}

impl WindowGeometryTracker {
    pub fn new(preferences: PreferencesStore) -> Self {
        Self {
            preferences,
            last_write: Mutex::new(None),
        }
    }

    /// Record the window's current geometry. `force` bypasses the write
    /// interval for the events that end a session.
    pub fn record<R: Runtime>(&self, window: &WebviewWindow<R>, force: bool) {
        if window.is_minimized().unwrap_or(false) {
            return;
        }
        // Throttle before reading the stored group: a drag fires these events
        // continuously, and the store is on disk.
        if !force && !self.write_is_due() {
            return;
        }
        let Some(geometry) = WindowGeometry::from_window(window) else {
            return;
        };
        let stored = stored_geometry(&self.preferences);
        let desired = if geometry.maximized {
            // Keep the restored size and position for the un-maximize case, and
            // only change the maximized flag.
            WindowGeometry {
                maximized: true,
                ..stored
            }
        } else {
            geometry
        };
        if desired == stored {
            return;
        }

        if self
            .preferences
            .set_group(WINDOW_GROUP, desired.to_value())
            .is_ok()
        {
            *self
                .last_write
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(Instant::now());
        }
    }

    fn write_is_due(&self) -> bool {
        let last_write = self
            .last_write
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match *last_write {
            None => true,
            Some(instant) => instant.elapsed() >= SAVE_INTERVAL,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn display(x: f64, y: f64, width: f64, height: f64) -> MonitorBounds {
        MonitorBounds {
            x,
            y,
            width,
            height,
        }
    }

    fn preferences() -> (tempfile::TempDir, PreferencesStore) {
        let directory = tempfile::tempdir().expect("temporary preferences directory");
        let store = PreferencesStore::new(directory.path().join("workspace-preferences.json"));
        (directory, store)
    }

    #[test]
    fn defaults_are_the_shipped_launch_size_without_a_position() {
        let geometry = WindowGeometry::default();
        assert_eq!(geometry.width, DEFAULT_WIDTH);
        assert_eq!(geometry.height, DEFAULT_HEIGHT);
        assert_eq!(geometry.x, None);
        assert!(!geometry.maximized);
    }

    #[test]
    fn a_stored_group_round_trips() {
        let (_directory, store) = preferences();
        let geometry = WindowGeometry {
            width: 1200.0,
            height: 800.0,
            x: Some(120.0),
            y: Some(80.0),
            maximized: false,
        };
        store
            .set_group(WINDOW_GROUP, geometry.to_value())
            .expect("write geometry");

        assert_eq!(stored_geometry(&store), geometry);
    }

    #[test]
    fn corrupt_or_absurd_stored_geometry_falls_back_to_defaults() {
        let (_directory, store) = preferences();
        for value in [
            json!({ "width": "wide", "height": 800.0 }),
            json!({ "width": 500_000.0, "height": 800.0 }),
            json!({ "width": f64::NAN, "height": 800.0 }),
            json!({ "height": 800.0 }),
        ] {
            store.set_group(WINDOW_GROUP, value).expect("write group");
            assert_eq!(stored_geometry(&store), WindowGeometry::default());
        }
    }

    #[test]
    fn a_size_below_the_floor_is_raised_not_discarded() {
        let geometry = WindowGeometry::from_value(&json!({
            "width": 200.0,
            "height": 100.0,
            "x": 10.0,
            "y": 20.0,
            "maximized": true,
        }))
        .expect("geometry parses");

        assert_eq!(geometry.width, MIN_WIDTH);
        assert_eq!(geometry.height, MIN_HEIGHT);
        assert_eq!(geometry.x, Some(10.0));
        assert!(geometry.maximized);
    }

    #[test]
    fn a_position_on_a_connected_display_is_restored_unchanged() {
        let geometry = WindowGeometry {
            width: 1440.0,
            height: 960.0,
            x: Some(1800.0),
            y: Some(240.0),
            maximized: false,
        };
        let monitors = [
            display(0.0, 0.0, 1728.0, 1117.0),
            display(1728.0, 0.0, 1920.0, 1080.0),
        ];

        assert_eq!(geometry.restore_onto(&monitors), geometry);
    }

    #[test]
    fn a_position_on_a_display_that_is_gone_is_clamped_onto_the_nearest_one() {
        // Last seen on a second display at x=1728 that is now unplugged.
        let geometry = WindowGeometry {
            width: 1440.0,
            height: 960.0,
            x: Some(1800.0),
            y: Some(240.0),
            maximized: false,
        };
        let monitors = [display(0.0, 0.0, 1728.0, 1117.0)];
        let restored = geometry.restore_onto(&monitors);

        assert_eq!(restored.width, geometry.width);
        assert_eq!(restored.height, geometry.height);
        let x = restored.x.expect("a clamped position");
        let y = restored.y.expect("a clamped position");
        // The title bar is reachable inside the remaining display.
        assert!(monitors[0].title_bar_overlap(x, y, restored.width) > 0.0);
        assert!(x >= monitors[0].x - restored.width + VISIBLE_SLIVER);
        assert!(x + VISIBLE_SLIVER <= monitors[0].right());
    }

    #[test]
    fn without_monitor_information_the_platform_places_the_window() {
        let geometry = WindowGeometry {
            width: 1440.0,
            height: 960.0,
            x: Some(1800.0),
            y: Some(240.0),
            maximized: true,
        };
        let restored = geometry.restore_onto(&[]);

        assert_eq!(restored.x, None);
        assert_eq!(restored.y, None);
        assert!(restored.maximized, "the maximized flag is still restored");
        assert_eq!(restored.width, 1440.0);
    }

    #[test]
    fn a_window_with_no_stored_position_keeps_no_position() {
        let geometry = WindowGeometry {
            width: 1200.0,
            height: 700.0,
            x: None,
            y: None,
            maximized: false,
        };
        assert_eq!(
            geometry.restore_onto(&[display(0.0, 0.0, 1440.0, 900.0)]),
            geometry
        );
    }

    #[test]
    fn restored_geometry_comes_from_the_store_and_is_clamped() {
        let (_directory, store) = preferences();
        store
            .set_group(
                WINDOW_GROUP,
                json!({
                    "width": 1300.0,
                    "height": 900.0,
                    "x": 5000.0,
                    "y": 20.0,
                    "maximized": true,
                }),
            )
            .expect("write geometry");

        let restored = restore_geometry(&store, &[display(0.0, 0.0, 1440.0, 900.0)]);
        assert_eq!(restored.width, 1300.0);
        assert!(restored.maximized);
        assert!(restored.x.expect("clamped x") < 1440.0);
        assert_eq!(restored.y, Some(20.0));
    }
}
