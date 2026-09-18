//! System window dragging keeps the invisible top of a pet window on screen.
//! Track the pointer directly so transparent margins can leave it.
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, OnceLock,
};
use tauri::PhysicalPosition;
#[cfg(target_os = "windows")]
use tauri::WebviewWindow;

use super::PetDragResult;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub use macos::{configure_pet_window, drag};

fn sessions() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static SESSIONS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    SESSIONS.get_or_init(Mutex::default)
}

pub fn cancel(label: &str) {
    if let Some(active) = sessions().lock().unwrap().get(label) {
        active.store(false, Ordering::Relaxed);
    }
}

struct Session {
    label: String,
}

impl Drop for Session {
    fn drop(&mut self) {
        sessions().lock().unwrap().remove(&self.label);
    }
}

struct DragMotion {
    start: PhysicalPosition<i32>,
    grab_x_css: f64,
    grab_y_css: f64,
    start_scale: f64,
    dragged: bool,
}

impl DragMotion {
    fn position(&mut self, cursor: PhysicalPosition<i32>, scale: f64) -> PhysicalPosition<i32> {
        let target = PhysicalPosition::new(
            cursor.x - (self.grab_x_css * scale).round() as i32,
            cursor.y - (self.grab_y_css * scale).round() as i32,
        );
        if !self.dragged {
            let distance =
                ((target.x - self.start.x) as f64).hypot((target.y - self.start.y) as f64);
            self.dragged = distance >= 4.0 * self.start_scale;
        }
        if self.dragged {
            target
        } else {
            self.start
        }
    }
}

pub use super::window_geometry::pet_center_is_visible;

#[cfg(target_os = "macos")]
pub fn preserve_dragged_height(
    current: PhysicalPosition<i32>,
    requested: PhysicalPosition<i32>,
    clamped: PhysicalPosition<i32>,
    size: tauri::PhysicalSize<u32>,
    area: &tauri::PhysicalRect<i32, u32>,
) -> PhysicalPosition<i32> {
    // A horizontal walk after a top-edge drag must keep the same height. Keep
    // normal bounds for vertical/group movement and unreachable placements.
    let target = PhysicalPosition::new(clamped.x, requested.y);
    if requested.y == current.y
        && current.y < area.position.y
        && pet_center_is_visible(target, size, area)
    {
        target
    } else {
        clamped
    }
}


#[cfg(target_os = "windows")]
pub fn drag(
    window: WebviewWindow,
    grab_x_css: f64,
    grab_y_css: f64,
) -> Result<PetDragResult, String> {
    use windows_sys::Win32::{
        Foundation::POINT,
        UI::{
            Input::KeyboardAndMouse::{GetAsyncKeyState, VK_ESCAPE},
            WindowsAndMessaging::{
                GetCursorPos, IsWindow, IsWindowVisible, SetWindowPos, SWP_NOACTIVATE, SWP_NOSIZE,
                SWP_NOZORDER,
            },
        },
    };

    if !grab_x_css.is_finite() || !grab_y_css.is_finite() {
        return Err("拖拽坐标无效".into());
    }
    let label = window.label().to_string();
    let active = Arc::new(AtomicBool::new(true));
    {
        let mut sessions = sessions().lock().unwrap();
        if sessions.contains_key(&label) {
            return Err("角色正在拖拽中".into());
        }
        sessions.insert(label.clone(), active.clone());
    }
    let _session = Session { label };
    let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as _;
    let start = window.outer_position().map_err(|e| e.to_string())?;
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let mut motion = DragMotion {
        start,
        grab_x_css,
        grab_y_css,
        start_scale: scale,
        dragged: false,
    };
    let mut last = start;
    if !super::primary_mouse_button_down() {
        return Ok(PetDragResult {
            start,
            dragged: false,
            cancelled: false,
        });
    }
    let cancelled = loop {
        if !active.load(Ordering::Relaxed)
            || unsafe { IsWindow(hwnd) == 0 || IsWindowVisible(hwnd) == 0 }
        {
            break true;
        }
        let escape = unsafe { (GetAsyncKeyState(VK_ESCAPE as i32) as u16 & 0x8000) != 0 };
        let pressed = super::primary_mouse_button_down();
        let mut cursor = POINT::default();
        if unsafe { GetCursorPos(&mut cursor) } == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        // Account for DPI changes while crossing monitors. Keep the same visual
        // grab point, including on the final sample after the button is released.
        let scale = window.scale_factor().map_err(|e| e.to_string())?;
        let target = if escape {
            start
        } else {
            motion.position(PhysicalPosition::new(cursor.x, cursor.y), scale)
        };
        if target != last {
            // Synchronous on this worker: completion and position persistence
            // must happen after the final native move, without blocking the UI.
            if unsafe {
                SetWindowPos(
                    hwnd,
                    std::ptr::null_mut(),
                    target.x,
                    target.y,
                    0,
                    0,
                    SWP_NOACTIVATE | SWP_NOSIZE | SWP_NOZORDER,
                )
            } == 0
            {
                return Err(std::io::Error::last_os_error().to_string());
            }
            last = target;
        }
        if escape || !pressed {
            break escape;
        }
        std::thread::sleep(std::time::Duration::from_millis(8));
    };
    log::info!(target: "desktop_pet::drag", "{}: start=({}, {}) end=({}, {}) dragged={} cancelled={}",
        window.label(), start.x, start.y, last.x, last.y, motion.dragged, cancelled);
    Ok(PetDragResult {
        start,
        dragged: motion.dragged,
        cancelled,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn motion() -> DragMotion {
        DragMotion {
            start: PhysicalPosition::new(700, 0),
            grab_x_css: 200.0,
            grab_y_css: 250.0,
            start_scale: 1.25,
            dragged: false,
        }
    }

    #[test]
    fn transparent_top_margin_can_leave_the_screen() {
        let mut drag = motion();
        let target = drag.position(PhysicalPosition::new(950, 80), 1.25);
        assert_eq!(target, PhysicalPosition::new(700, -233));
        assert!(drag.dragged);
        assert_eq!(target.y + (drag.grab_y_css * 1.25).round() as i32, 80);
    }

    #[test]
    fn click_jitter_does_not_move_the_window() {
        let mut drag = motion();
        assert_eq!(
            drag.position(PhysicalPosition::new(953, 313), 1.25),
            drag.start
        );
        assert!(!drag.dragged);
        assert_eq!(drag.position(PhysicalPosition::new(955, 313), 1.25).x, 705);
        assert!(drag.dragged);
    }

    #[test]
    fn crossing_dpi_boundaries_preserves_the_css_grab_point() {
        let mut drag = motion();
        let cursor = PhysicalPosition::new(-300, -200);
        let target = drag.position(cursor, 1.5);
        assert_eq!(target, PhysicalPosition::new(-600, -575));
    }

    #[test]
    fn restart_keeps_reachable_negative_placements_but_recovers_lost_monitors() {
        let area = tauri::PhysicalRect {
            position: PhysicalPosition::new(0, 30),
            size: tauri::PhysicalSize::new(2560, 1410),
        };
        let size = tauri::PhysicalSize::new(650, 750);
        assert!(pet_center_is_visible(
            PhysicalPosition::new(700, -233),
            size,
            &area
        ));
        assert!(!pet_center_is_visible(
            PhysicalPosition::new(700, -800),
            size,
            &area
        ));
        assert!(!pet_center_is_visible(
            PhysicalPosition::new(-1800, 0),
            size,
            &area
        ));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn roaming_keeps_a_dragged_top_edge_height_without_relaxing_vertical_targets() {
        let area = tauri::PhysicalRect {
            position: PhysicalPosition::new(0, 68),
            size: tauri::PhysicalSize::new(3396, 2020),
        };
        let size = tauri::PhysicalSize::new(1040, 1200);
        let current = PhysicalPosition::new(1000, -320);
        let clamped = PhysicalPosition::new(1008, 68);
        assert_eq!(
            preserve_dragged_height(
                current,
                PhysicalPosition::new(1008, -320),
                clamped,
                size,
                &area
            ),
            PhysicalPosition::new(1008, -320)
        );
        assert_eq!(
            preserve_dragged_height(
                current,
                PhysicalPosition::new(1008, -300),
                clamped,
                size,
                &area
            ),
            clamped
        );
        let lost = PhysicalPosition::new(1000, -1400);
        assert_eq!(
            preserve_dragged_height(
                lost,
                PhysicalPosition::new(1008, -1400),
                clamped,
                size,
                &area
            ),
            clamped
        );
    }
}
