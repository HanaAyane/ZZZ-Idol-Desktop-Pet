use std::sync::{atomic::Ordering, mpsc, Arc, OnceLock};

use core_graphics::display::CGDisplay;
use objc2::{
    ffi,
    runtime::{AnyClass, AnyObject, Imp, Sel},
    sel,
};
use objc2_app_kit::{NSEvent, NSWindow};
use objc2_foundation::{NSPoint, NSRect};
use tauri::{PhysicalPosition, WebviewWindow};

use super::{sessions, AtomicBool, DragMotion, PetDragResult, Session};

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventSourceKeyState(state_id: i32, key: u16) -> bool;
}

type ConstrainFrame =
    unsafe extern "C-unwind" fn(&AnyObject, Sel, NSRect, *mut AnyObject) -> NSRect;
struct FrameConstraintHook {
    class: &'static AnyClass,
    original: ConstrainFrame,
}
static FRAME_HOOK: OnceLock<Result<FrameConstraintHook, String>> = OnceLock::new();
static PET_WINDOW_MARKER: u8 = 0;

unsafe extern "C-unwind" fn constrain_pet_frame(
    object: &AnyObject,
    selector: Sel,
    frame: NSRect,
    screen: *mut AnyObject,
) -> NSRect {
    let key = (&PET_WINDOW_MARKER as *const u8).cast();
    if !ffi::objc_getAssociatedObject(object, key).is_null() {
        return frame;
    }
    // Settings and every other unmarked window retain AppKit's original
    // behavior, including any implementation inherited by Tao's window class.
    let hook = FRAME_HOOK
        .get()
        .and_then(|result| result.as_ref().ok())
        .expect("frame constraint hook must be installed before use");
    (hook.original)(object, selector, frame, screen)
}

pub fn configure_pet_window(window: &WebviewWindow) -> Result<(), String> {
    super::super::require_pet_window(window)?;
    on_window(window, |native| mark_pet_window(native.as_ref()))??;
    log::info!(target: "desktop_pet::drag", "{}: transparent frame overflow enabled", window.label());
    Ok(())
}

fn mark_pet_window(object: &AnyObject) -> Result<(), String> {
    let class = object.class();
    let hook = FRAME_HOOK
        .get_or_init(|| {
            let selector = sel!(constrainFrameRect:toScreen:);
            let method = class
                .instance_method(selector)
                .ok_or_else(|| "未找到 macOS 窗口边界方法".to_string())?;
            // Override the inherited method on Tao's class, preserving its
            // original IMP for unmarked instances. Changing an instance's
            // class instead would break Tao's dynamic super(sendEvent:) call.
            let original =
                unsafe { std::mem::transmute::<Imp, ConstrainFrame>(method.implementation()) };
            let replacement =
                unsafe { std::mem::transmute::<ConstrainFrame, Imp>(constrain_pet_frame) };
            let added = unsafe {
                ffi::class_addMethod(
                    class as *const AnyClass as *mut AnyClass,
                    selector,
                    replacement,
                    ffi::method_getTypeEncoding(method),
                )
            };
            if !added.as_bool() {
                return Err("macOS 窗口边界方法已被覆盖，无法安全配置桌宠".into());
            }
            Ok(FrameConstraintHook { class, original })
        })
        .as_ref()
        .map_err(Clone::clone)?;
    if !std::ptr::eq(class, hook.class) {
        return Err("桌宠使用了不同的 macOS 窗口类型".into());
    }
    // A non-retaining self association marks just this live window. The
    // runtime clears it at deallocation, so there is no pointer registry
    // that could accidentally mark a later settings window at that address.
    let pointer = object as *const AnyObject as *mut AnyObject;
    unsafe {
        ffi::objc_setAssociatedObject(
            pointer,
            (&PET_WINDOW_MARKER as *const u8).cast(),
            pointer,
            ffi::OBJC_ASSOCIATION_ASSIGN,
        )
    };
    Ok(())
}

// Access AppKit only on the main thread, and acknowledge the actual native
// move before the worker completes. Tauri's set_position queues another async
// AppKit move, which can otherwise run after release/position persistence.
fn on_window<T: Send + 'static>(
    window: &WebviewWindow,
    action: impl FnOnce(&NSWindow) -> T + Send + 'static,
) -> Result<T, String> {
    let (sender, receiver) = mpsc::sync_channel(1);
    let target = window.clone();
    window
        .run_on_main_thread(move || {
            let result = target
                .ns_window()
                .map_err(|error| error.to_string())
                .map(|pointer| {
                    // Tauri owns this live NSWindow; it is borrowed only inside its
                    // main-thread callback and never retained on the drag worker.
                    let native = unsafe { &*pointer.cast::<NSWindow>() };
                    action(native)
                });
            let _ = sender.send(result);
        })
        .map_err(|error| error.to_string())?;
    receiver.recv().map_err(|error| error.to_string())?
}

pub fn drag(
    window: WebviewWindow,
    grab_x_css: f64,
    grab_y_css: f64,
) -> Result<PetDragResult, String> {
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
    let start = window.outer_position().map_err(|error| error.to_string())?;
    let (logical_start, screen_height) = on_window(&window, |native| {
        let frame = native.frame();
        let height = CGDisplay::main().pixels_high() as f64;
        (
            PhysicalPosition::new(
                frame.origin.x.round() as i32,
                (height - frame.origin.y - frame.size.height).round() as i32,
            ),
            height,
        )
    })?;
    // Cocoa's global coordinates and the WebView grab point are both logical
    // points. Stay in that space across Retina/non-Retina screens; multiplying
    // a global cursor by the primary display's scale causes jumps across DPI.
    let mut motion = DragMotion {
        start: logical_start,
        grab_x_css,
        grab_y_css,
        start_scale: 1.0,
        dragged: false,
    };
    let mut last = logical_start;
    if !super::super::primary_mouse_button_down() {
        return Ok(PetDragResult {
            start,
            dragged: false,
            cancelled: false,
        });
    }
    let cancelled = loop {
        if !active.load(Ordering::Relaxed) {
            break true;
        }
        let flag = active.clone();
        let step = on_window(&window, move |native| {
            if !flag.load(Ordering::Relaxed) || !native.isVisible() || native.isMiniaturized() {
                return (motion, last, true, true);
            }
            // Combined session state, Escape virtual key. Read-only polling
            // requires neither an event tap nor Accessibility permission.
            let escape = unsafe { CGEventSourceKeyState(0, 53) };
            let pressed = NSEvent::pressedMouseButtons() & 1 != 0;
            let cursor = NSEvent::mouseLocation();
            let target = if escape {
                logical_start
            } else {
                motion.position(
                    PhysicalPosition::new(
                        cursor.x.round() as i32,
                        (screen_height - cursor.y).round() as i32,
                    ),
                    1.0,
                )
            };
            if target != last {
                native.setFrameTopLeftPoint(NSPoint::new(
                    target.x as f64,
                    screen_height - target.y as f64,
                ));
            }
            (motion, target, escape || !pressed, escape)
        })?;
        (motion, last) = (step.0, step.1);
        if step.2 {
            break step.3;
        }
        std::thread::sleep(std::time::Duration::from_millis(8));
    };
    let end = window.outer_position().map_err(|error| error.to_string())?;
    log::info!(target: "desktop_pet::drag", "{}: start=({}, {}) end=({}, {}) targetLogical=({}, {}) dragged={} cancelled={}",
        window.label(), start.x, start.y, end.x, end.y, last.x, last.y, motion.dragged, cancelled);
    Ok(PetDragResult {
        start,
        dragged: motion.dragged,
        cancelled,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use objc2::{
        msg_send,
        rc::Retained,
        runtime::{ClassBuilder, NSObject},
        ClassType,
    };
    use objc2_foundation::NSSize;

    unsafe extern "C-unwind" fn original_constraint(
        _object: &AnyObject,
        _selector: Sel,
        mut frame: NSRect,
        _screen: *mut AnyObject,
    ) -> NSRect {
        frame.origin.y = frame.origin.y.max(34.0);
        frame
    }

    #[test]
    fn constraint_override_only_applies_to_marked_pet_instances() {
        // Exercise actual Objective-C dispatch/inheritance without opening any
        // windows. The unmarked instance represents the ordinary settings UI.
        let selector = sel!(constrainFrameRect:toScreen:);
        let mut parent = ClassBuilder::new(c"ZZZConstraintTestParent", NSObject::class()).unwrap();
        unsafe {
            parent.add_method(
                selector,
                original_constraint as unsafe extern "C-unwind" fn(_, _, _, _) -> _,
            );
        }
        let parent = parent.register();
        let child = ClassBuilder::new(c"ZZZConstraintTestWindow", parent)
            .unwrap()
            .register();
        let pet: Retained<NSObject> = unsafe { msg_send![child, new] };
        let settings: Retained<NSObject> = unsafe { msg_send![child, new] };
        mark_pet_window(pet.as_ref()).unwrap();
        let frame = NSRect::new(NSPoint::new(200.0, -160.0), NSSize::new(520.0, 600.0));
        let screen: *mut AnyObject = std::ptr::null_mut();
        let pet_frame: NSRect =
            unsafe { msg_send![&*pet, constrainFrameRect: frame, toScreen: screen] };
        let settings_frame: NSRect =
            unsafe { msg_send![&*settings, constrainFrameRect: frame, toScreen: screen] };
        assert_eq!(pet_frame, frame);
        assert_eq!(settings_frame.origin.y, 34.0);
        assert_eq!(settings_frame.size, frame.size);
        // Reconfiguration must preserve the original implementation.
        mark_pet_window(pet.as_ref()).unwrap();
        let next: Retained<NSObject> = unsafe { msg_send![child, new] };
        let next_frame: NSRect =
            unsafe { msg_send![&*next, constrainFrameRect: frame, toScreen: screen] };
        assert_eq!(next_frame.origin.y, 34.0);
    }
}
