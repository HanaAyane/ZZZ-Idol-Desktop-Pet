use std::{collections::HashMap, sync::Mutex};

use tauri::WebviewWindow;

#[derive(Clone, Copy, Debug)]
struct WindowRect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

impl WindowRect {
    fn right(self) -> f64 {
        self.x + self.width
    }

    fn bottom(self) -> f64 {
        self.y + self.height
    }
}

#[derive(Clone, Copy, Debug)]
struct NativeTarget {
    id: u64,
    owner_pid: u32,
    rect: WindowRect,
}

#[derive(Clone, Copy, Debug)]
struct LiftProbe {
    hand_x: f64,
    hand_y: f64,
    max_gap: f64,
    work_area: WindowRect,
    automatic: bool,
}

#[derive(Clone, Copy, Debug)]
struct Binding {
    target: NativeTarget,
    anchor_ratio_x: f64,
    automatic: bool,
}

#[derive(Clone, Copy, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowLiftRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl WindowLiftRect {
    pub fn valid(&self) -> bool {
        [self.x, self.y, self.width, self.height]
            .iter()
            .all(|v| v.is_finite())
            && self.width > 0.0
            && self.height > 0.0
    }

    pub fn fits_at(&self, x: f64, y: f64, scale: f64, area: Self) -> bool {
        self.valid()
            && scale.is_finite()
            && scale > 0.0
            && x + self.x * scale >= area.x - 1.0
            && y + self.y * scale >= area.y - 1.0
            && x + (self.x + self.width) * scale <= area.x + area.width + 1.0
            && y + (self.y + self.height) * scale <= area.y + area.height + 1.0
    }
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowLiftSnapshot {
    rect: WindowLiftRect,
    anchor_ratio_x: f64,
}

impl WindowLiftSnapshot {
    fn from_binding(binding: Binding) -> Self {
        Self {
            rect: WindowLiftRect {
                x: binding.target.rect.x,
                y: binding.target.rect.y,
                width: binding.target.rect.width,
                height: binding.target.rect.height,
            },
            anchor_ratio_x: binding.anchor_ratio_x,
        }
    }
}

#[derive(Default)]
pub struct WindowLiftManager {
    bindings: Mutex<HashMap<String, Binding>>,
}

impl WindowLiftManager {
    pub fn attach(
        &self,
        window: &WebviewWindow,
        pet_id: &str,
        hand_x_css: f64,
        hand_y_css: f64,
        max_gap_css: f64,
        automatic: bool,
    ) -> Result<Option<WindowLiftSnapshot>, String> {
        let scale_factor = window.scale_factor().map_err(|error| error.to_string())?;
        let position = window.outer_position().map_err(|error| error.to_string())?;
        if ![hand_x_css, hand_y_css, max_gap_css]
            .iter()
            .all(|v| v.is_finite())
        {
            return Err("托举检测坐标无效".into());
        }
        let monitor = window
            .current_monitor()
            .map_err(|error| error.to_string())?
            .or(window
                .primary_monitor()
                .map_err(|error| error.to_string())?)
            .ok_or_else(|| "未找到桌宠所在显示器".to_string())?;
        let area = monitor.work_area();
        let hand_x_in_pet = hand_x_css * scale_factor;
        let hand_y_in_pet = hand_y_css * scale_factor;
        let probe = LiftProbe {
            automatic,
            hand_x: position.x as f64 + hand_x_in_pet,
            hand_y: position.y as f64 + hand_y_in_pet,
            max_gap: max_gap_css.clamp(8.0, 160.0) * scale_factor,
            work_area: WindowRect {
                x: area.position.x as f64,
                y: area.position.y as f64,
                width: area.size.width as f64,
                height: area.size.height as f64,
            },
        };
        let Some(target) = platform::find_target(probe, scale_factor)? else {
            self.detach(pet_id);
            if !automatic {
                log::info!(target: "desktop_pet::window_lift", "{pet_id}: no_nearby_window");
            }
            return Ok(None);
        };
        let anchor_ratio_x = ((probe.hand_x - target.rect.x) / target.rect.width).clamp(0.0, 1.0);
        let binding = Binding {
            target,
            anchor_ratio_x,
            automatic,
        };
        self.bindings
            .lock()
            .map_err(|_| "窗口托举绑定锁不可用".to_string())?
            .insert(pet_id.to_string(), binding);
        Ok(Some(WindowLiftSnapshot::from_binding(binding)))
    }

    pub fn is_bound(&self, pet_id: &str) -> bool {
        self.bindings
            .lock()
            .map(|bindings| bindings.contains_key(pet_id))
            .unwrap_or(false)
    }

    pub fn snapshot(
        &self,
        window: &WebviewWindow,
        pet_id: &str,
    ) -> Result<Option<WindowLiftSnapshot>, String> {
        let scale_factor = window.scale_factor().map_err(|error| error.to_string())?;
        let binding = self
            .bindings
            .lock()
            .map_err(|_| "窗口托举绑定锁不可用".to_string())?
            .get(pet_id)
            .copied();
        let Some(mut binding) = binding else {
            return Ok(None);
        };
        let Some(target) = platform::query_target(binding.target, scale_factor)? else {
            self.detach(pet_id);
            return Ok(None);
        };
        binding.target = target;
        self.bindings
            .lock()
            .map_err(|_| "窗口托举绑定锁不可用".to_string())?
            .insert(pet_id.to_string(), binding);
        Ok(Some(WindowLiftSnapshot::from_binding(binding)))
    }

    pub fn detach(&self, pet_id: &str) {
        if let Ok(mut bindings) = self.bindings.lock() {
            bindings.remove(pet_id);
        }
    }

    pub fn retain_enabled(&self, manual: bool, automatic: bool) {
        if let Ok(mut bindings) = self.bindings.lock() {
            bindings.retain(|_, binding| if binding.automatic { automatic } else { manual });
        }
    }
}

fn is_candidate_geometry(rect: WindowRect, probe: LiftProbe) -> bool {
    if rect.width < 160.0 || rect.height < 100.0 {
        return false;
    }
    let covers_work_area =
        rect.width >= probe.work_area.width * 0.94 && rect.height >= probe.work_area.height * 0.90;
    if covers_work_area {
        return false;
    }
    // Automatic acquisition requires horizontal overlap. A walking character's
    // head may slightly overlap the bottom edge while the body is already below
    // it, so use the snap band on BOTH sides of the edge, just like manual drops.
    let horizontal_margin = if probe.automatic {
        0.0
    } else {
        probe.max_gap * 0.75
    };
    if probe.hand_x < rect.x - horizontal_margin || probe.hand_x > rect.right() + horizontal_margin
    {
        return false;
    }
    if (probe.hand_y - rect.bottom()).abs() > probe.max_gap {
        return false;
    }
    // Space is checked after the lift rig is loaded, against its visible animation
    // envelope. The main rig's transparent native window is not collision geometry.
    true
}

fn candidate_score(rect: WindowRect, probe: LiftProbe) -> f64 {
    let vertical = (probe.hand_y - rect.bottom()).abs();
    let horizontal = if probe.hand_x < rect.x {
        rect.x - probe.hand_x
    } else if probe.hand_x > rect.right() {
        probe.hand_x - rect.right()
    } else {
        0.0
    };
    vertical + horizontal * 1.5
}

#[cfg(target_os = "macos")]
mod platform {
    use core_foundation::{
        array::CFArray,
        base::{CFType, TCFType},
        boolean::CFBoolean,
        dictionary::CFDictionary,
        number::CFNumber,
        string::{CFString, CFStringRef},
    };
    use core_graphics::{
        geometry::CGRect,
        window::{
            copy_window_info, create_description_from_array, create_window_list, kCGNullWindowID,
            kCGWindowAlpha, kCGWindowBounds, kCGWindowIsOnscreen, kCGWindowLayer,
            kCGWindowListExcludeDesktopElements, kCGWindowListOptionIncludingWindow,
            kCGWindowListOptionOnScreenOnly, kCGWindowNumber, kCGWindowOwnerPID, CGWindowID,
        },
    };

    use super::{candidate_score, is_candidate_geometry, LiftProbe, NativeTarget, WindowRect};

    type WindowDictionary = CFDictionary<CFString, CFType>;

    fn key(reference: CFStringRef) -> CFString {
        unsafe { CFString::wrap_under_get_rule(reference) }
    }

    fn number(dictionary: &WindowDictionary, reference: CFStringRef) -> Option<f64> {
        dictionary
            .find(&key(reference))?
            .downcast::<CFNumber>()?
            .to_f64()
    }

    fn boolean(dictionary: &WindowDictionary, reference: CFStringRef) -> Option<bool> {
        Some(bool::from(
            dictionary.find(&key(reference))?.downcast::<CFBoolean>()?,
        ))
    }

    fn bounds(dictionary: &WindowDictionary, scale_factor: f64) -> Option<WindowRect> {
        let value = dictionary.find(&key(unsafe { kCGWindowBounds }))?;
        let dictionary = value.downcast::<CFDictionary>()?;
        let rect = CGRect::from_dict_representation(&dictionary)?;
        Some(WindowRect {
            x: rect.origin.x * scale_factor,
            y: rect.origin.y * scale_factor,
            width: rect.size.width * scale_factor,
            height: rect.size.height * scale_factor,
        })
    }

    fn target_from_dictionary(
        dictionary: &WindowDictionary,
        scale_factor: f64,
    ) -> Option<NativeTarget> {
        let id = number(dictionary, unsafe { kCGWindowNumber })? as u64;
        let owner_pid = number(dictionary, unsafe { kCGWindowOwnerPID })? as u32;
        let layer = number(dictionary, unsafe { kCGWindowLayer })? as i32;
        let alpha = number(dictionary, unsafe { kCGWindowAlpha }).unwrap_or(1.0);
        let on_screen = boolean(dictionary, unsafe { kCGWindowIsOnscreen }).unwrap_or(true);
        if id == 0 || owner_pid == std::process::id() || layer != 0 || alpha <= 0.01 || !on_screen {
            return None;
        }
        Some(NativeTarget {
            id,
            owner_pid,
            rect: bounds(dictionary, scale_factor)?,
        })
    }

    fn typed_windows(array: &CFArray) -> CFArray<WindowDictionary> {
        unsafe { CFArray::wrap_under_get_rule(array.as_concrete_TypeRef()) }
    }

    pub fn find_target(
        probe: LiftProbe,
        scale_factor: f64,
    ) -> Result<Option<NativeTarget>, String> {
        let options = kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements;
        let array = copy_window_info(options, kCGNullWindowID)
            .ok_or_else(|| "无法读取当前桌面窗口列表".to_string())?;
        let windows = typed_windows(&array);
        let mut best: Option<(f64, NativeTarget)> = None;
        for dictionary in &windows {
            let Some(target) = target_from_dictionary(&dictionary, scale_factor) else {
                continue;
            };
            if !is_candidate_geometry(target.rect, probe) {
                continue;
            }
            let score = candidate_score(target.rect, probe);
            if best
                .map(|(best_score, _)| score < best_score)
                .unwrap_or(true)
            {
                best = Some((score, target));
            }
        }
        Ok(best.map(|(_, target)| target))
    }

    pub fn query_target(
        target: NativeTarget,
        scale_factor: f64,
    ) -> Result<Option<NativeTarget>, String> {
        let Some(ids) =
            create_window_list(kCGWindowListOptionIncludingWindow, target.id as CGWindowID)
        else {
            return Ok(None);
        };
        let Some(array) = create_description_from_array(ids) else {
            return Ok(None);
        };
        for dictionary in &array {
            let Some(candidate) = target_from_dictionary(&dictionary, scale_factor) else {
                continue;
            };
            if candidate.id == target.id && candidate.owner_pid == target.owner_pid {
                return Ok(Some(candidate));
            }
        }
        Ok(None)
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use std::mem::size_of;

    use windows_sys::Win32::{
        Foundation::{HWND, LPARAM, RECT},
        Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED},
        UI::WindowsAndMessaging::{
            EnumWindows, GetWindow, GetWindowRect, GetWindowThreadProcessId, IsIconic, IsWindow,
            IsWindowVisible, IsZoomed, GW_OWNER,
        },
    };

    use super::{candidate_score, is_candidate_geometry, LiftProbe, NativeTarget, WindowRect};

    unsafe fn target_from_hwnd(hwnd: HWND) -> Option<NativeTarget> {
        if hwnd.is_null()
            || IsWindow(hwnd) == 0
            || IsWindowVisible(hwnd) == 0
            || IsIconic(hwnd) != 0
            || IsZoomed(hwnd) != 0
            || !GetWindow(hwnd, GW_OWNER).is_null()
        {
            return None;
        }
        let mut owner_pid = 0u32;
        GetWindowThreadProcessId(hwnd, &mut owner_pid);
        if owner_pid == 0 || owner_pid == std::process::id() {
            return None;
        }
        let mut cloaked = 0u32;
        if DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED as u32,
            (&mut cloaked as *mut u32).cast(),
            size_of::<u32>() as u32,
        ) >= 0
            && cloaked != 0
        {
            return None;
        }
        let mut rect = RECT::default();
        if GetWindowRect(hwnd, &mut rect) == 0 {
            return None;
        }
        let width = (rect.right - rect.left) as f64;
        let height = (rect.bottom - rect.top) as f64;
        if width <= 0.0 || height <= 0.0 {
            return None;
        }
        Some(NativeTarget {
            id: hwnd as usize as u64,
            owner_pid,
            rect: WindowRect {
                x: rect.left as f64,
                y: rect.top as f64,
                width,
                height,
            },
        })
    }

    struct Enumeration {
        probe: LiftProbe,
        best: Option<(f64, NativeTarget)>,
    }

    unsafe extern "system" fn visit(hwnd: HWND, parameter: LPARAM) -> i32 {
        let enumeration = &mut *(parameter as *mut Enumeration);
        let Some(target) = target_from_hwnd(hwnd) else {
            return 1;
        };
        if !is_candidate_geometry(target.rect, enumeration.probe) {
            return 1;
        }
        let score = candidate_score(target.rect, enumeration.probe);
        if enumeration
            .best
            .map(|(best_score, _)| score < best_score)
            .unwrap_or(true)
        {
            enumeration.best = Some((score, target));
        }
        1
    }

    pub fn find_target(
        probe: LiftProbe,
        _scale_factor: f64,
    ) -> Result<Option<NativeTarget>, String> {
        let mut enumeration = Enumeration { probe, best: None };
        let ok = unsafe {
            EnumWindows(
                Some(visit),
                (&mut enumeration as *mut Enumeration) as LPARAM,
            )
        };
        if ok == 0 {
            return Err("无法枚举当前桌面窗口".into());
        }
        Ok(enumeration.best.map(|(_, target)| target))
    }

    pub fn query_target(
        target: NativeTarget,
        _scale_factor: f64,
    ) -> Result<Option<NativeTarget>, String> {
        let hwnd = target.id as usize as HWND;
        let candidate = unsafe { target_from_hwnd(hwnd) };
        Ok(candidate.filter(|candidate| candidate.owner_pid == target.owner_pid))
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod platform {
    use super::{LiftProbe, NativeTarget};

    pub fn find_target(
        _probe: LiftProbe,
        _scale_factor: f64,
    ) -> Result<Option<NativeTarget>, String> {
        Ok(None)
    }

    pub fn query_target(
        _target: NativeTarget,
        _scale_factor: f64,
    ) -> Result<Option<NativeTarget>, String> {
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn probe() -> LiftProbe {
        LiftProbe {
            automatic: false,
            hand_x: 600.0,
            hand_y: 420.0,
            max_gap: 48.0,
            work_area: WindowRect {
                x: 0.0,
                y: 0.0,
                width: 1440.0,
                height: 900.0,
            },
        }
    }

    #[test]
    fn accepts_a_normal_window_whose_bottom_edge_meets_the_hands() {
        assert!(is_candidate_geometry(
            WindowRect {
                x: 280.0,
                y: 100.0,
                width: 640.0,
                height: 320.0,
            },
            probe(),
        ));
    }

    #[test]
    fn rejects_full_work_area_but_does_not_use_transparent_canvas_as_space_filter() {
        assert!(!is_candidate_geometry(
            WindowRect {
                x: 0.0,
                y: 0.0,
                width: 1440.0,
                height: 900.0,
            },
            probe(),
        ));
        assert!(is_candidate_geometry(
            WindowRect {
                x: 280.0,
                y: 520.0,
                width: 640.0,
                height: 320.0,
            },
            LiftProbe {
                hand_y: 840.0,
                ..probe()
            },
        ));
    }

    #[test]
    fn visible_bounds_allow_transparent_overflow_but_not_clipped_character() {
        let area = WindowLiftRect {
            x: 0.0,
            y: 0.0,
            width: 1440.0,
            height: 900.0,
        };
        let visible = WindowLiftRect {
            x: 160.0,
            y: 180.0,
            width: 200.0,
            height: 240.0,
        };
        // 600px native window ends at 1050, but the visible character ends at 870.
        assert!(visible.fits_at(-100.0, 450.0, 1.0, area));
        assert!(!visible.fits_at(-100.0, 500.0, 1.0, area));
        assert!(!visible.fits_at(-200.0, 450.0, 1.0, area));
        assert!(!WindowLiftRect {
            width: f64::NAN,
            ..visible
        }
        .valid());
    }

    #[test]
    fn keeps_three_pet_bindings_for_the_same_target() {
        let manager = WindowLiftManager::default();
        let target = NativeTarget {
            id: 42,
            owner_pid: 7,
            rect: WindowRect {
                x: 280.0,
                y: 100.0,
                width: 640.0,
                height: 320.0,
            },
        };
        let mut bindings = manager.bindings.lock().expect("binding lock");
        for (pet_id, anchor_ratio_x) in [("airui", 0.25), ("nangong", 0.5), ("qianxia", 0.75)] {
            bindings.insert(
                pet_id.to_string(),
                Binding {
                    target,
                    anchor_ratio_x,
                    automatic: false,
                },
            );
        }

        assert_eq!(bindings.len(), 3);
        assert!(bindings
            .values()
            .all(|binding| binding.target.id == target.id));
        assert_eq!(bindings["airui"].anchor_ratio_x, 0.25);
        assert_eq!(bindings["nangong"].anchor_ratio_x, 0.5);
        assert_eq!(bindings["qianxia"].anchor_ratio_x, 0.75);
        bindings.get_mut("airui").unwrap().automatic = true;
        drop(bindings);
        manager.retain_enabled(true, false);
        assert!(!manager.is_bound("airui"));
        assert!(manager.is_bound("nangong"));
        assert!(manager.is_bound("qianxia"));
        manager.retain_enabled(false, true);
        assert!(!manager.is_bound("nangong"));
        assert!(!manager.is_bound("qianxia"));
    }

    #[test]
    fn automatic_probe_requires_being_directly_under_nearby_bottom_edge() {
        let rect = WindowRect {
            x: 280.0,
            y: 100.0,
            width: 640.0,
            height: 320.0,
        };
        let auto = LiftProbe {
            automatic: true,
            ..probe()
        };
        assert!(is_candidate_geometry(rect, auto));
        assert!(is_candidate_geometry(
            rect,
            LiftProbe {
                hand_y: 460.0,
                ..auto
            }
        ));
        assert!(!is_candidate_geometry(
            rect,
            LiftProbe {
                hand_y: 500.0,
                ..auto
            }
        ));
        assert!(is_candidate_geometry(
            rect,
            LiftProbe {
                hand_y: 415.0,
                ..auto
            }
        ));
        assert!(!is_candidate_geometry(
            rect,
            LiftProbe {
                hand_x: 275.0,
                ..auto
            }
        ));
        assert!(is_candidate_geometry(
            rect,
            LiftProbe {
                hand_x: 275.0,
                ..probe()
            }
        ));
    }

    #[test]
    fn automatic_probe_accepts_head_overlap_at_observed_retina_window_bottom() {
        // Finder at y=86, h=570 CSS; a pet at y=424 with a head near y=196
        // has its head 36 CSS px above the edge despite its body being below it.
        for scale in [1.0, 1.5, 2.0] {
            let rect = WindowRect {
                x: 80.0 * scale,
                y: 86.0 * scale,
                width: 918.0 * scale,
                height: 570.0 * scale,
            };
            let probe = LiftProbe {
                automatic: true,
                hand_x: 700.0 * scale,
                hand_y: 620.0 * scale,
                max_gap: 72.0 * scale,
                work_area: WindowRect {
                    x: 0.0,
                    y: 34.0 * scale,
                    width: 1710.0 * scale,
                    height: 994.0 * scale,
                },
            };
            assert!(is_candidate_geometry(rect, probe));
            assert!(!is_candidate_geometry(
                rect,
                LiftProbe {
                    hand_y: 580.0 * scale,
                    ..probe
                }
            ));
            assert!(!is_candidate_geometry(
                rect,
                LiftProbe {
                    hand_y: 730.0 * scale,
                    ..probe
                }
            ));
        }
    }
}
