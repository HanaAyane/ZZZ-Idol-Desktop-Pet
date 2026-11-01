//! Session-owned room membership. Desktop windows remain the source of user settings.
use crate::{
    coordination::{pet_id_from_window_label, pet_window_label, PET_IDS},
    read_settings,
};
use std::sync::Mutex;
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Member {
    id: String,
    x: f64,
    y: f64,
}
#[derive(Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    revision: u64,
    visible: bool,
    members: Vec<Member>,
}
#[derive(Default)]
pub struct RoomManager(Mutex<Snapshot>);
impl RoomManager {
    pub fn contains(&self, id: &str) -> bool {
        self.0
            .lock()
            .map(|s| s.members.iter().any(|m| m.id == id))
            .unwrap_or(false)
    }
}
fn authorized(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "room"
        || window.label() == "settings"
        || pet_id_from_window_label(window.label()).is_some()
    {
        Ok(())
    } else {
        Err("此窗口不能操作活动室".into())
    }
}
fn snapshot(app: &tauri::AppHandle) -> Result<Snapshot, String> {
    Ok(app
        .state::<RoomManager>()
        .0
        .lock()
        .map_err(|_| "活动室状态不可用")?
        .clone())
}
fn emit(app: &tauri::AppHandle) -> Result<Snapshot, String> {
    let s = snapshot(app)?;
    app.emit("room-state", &s).map_err(|e| e.to_string())?;
    Ok(s)
}
fn enter(app: &tauri::AppHandle, id: &str, x: f64, y: f64) -> Result<Snapshot, String> {
    if !PET_IDS.contains(&id) {
        return Err("未知角色".into());
    }
    if !read_settings(app)?
        .pets
        .get(id)
        .map(|p| p.visible)
        .unwrap_or(false)
    {
        return Err("请先在设置中显示该角色".into());
    }
    let manager = app.state::<RoomManager>();
    let mut s = manager.0.lock().map_err(|_| "活动室状态不可用")?;
    if !s.visible {
        return Err("请先打开活动室".into());
    }
    if s.members.iter().any(|m| m.id == id) {
        return Ok(s.clone());
    }
    let pet = app
        .get_webview_window(&pet_window_label(id))
        .ok_or("角色窗口未就绪")?;
    pet.hide().map_err(|e| e.to_string())?;
    s.members.push(Member {
        id: id.into(),
        x: x.clamp(0.0, 1.0),
        y: y.clamp(0.0, 1.0),
    });
    s.revision += 1;
    drop(s);
    crate::cancel_active_coordination(app, "entered_room");
    // Every hidden desktop controller receives membership before it can resume walking.
    emit(app)
}
#[tauri::command]
pub fn get_room_state(window: WebviewWindow) -> Result<Snapshot, String> {
    authorized(&window)?;
    snapshot(window.app_handle())
}
#[tauri::command]
pub async fn show_room_window(window: WebviewWindow) -> Result<Snapshot, String> {
    authorized(&window)?;
    show_window(window.app_handle().clone()).await
}

pub fn request_show_window(app: tauri::AppHandle) {
    // 菜单回调只提交异步任务，避免在 Windows GUI 线程上阻塞创建 WebView。
    tauri::async_runtime::spawn(async move {
        if let Err(error) = show_window(app).await {
            log::error!(target: "desktop_pet::room", "活动室打开失败：{error}");
        }
    });
}

async fn show_window(app: tauri::AppHandle) -> Result<Snapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // 复用已有窗口；清空入住角色时会释放其 WebGL 渲染器。
        let creation = app.state::<crate::SettingsWindowLock>();
        let _guard = creation.0.lock().map_err(|_| "窗口创建锁不可用")?;
        let w = if let Some(w) = app.get_webview_window("room") {
            w
        } else {
            let w = WebviewWindowBuilder::new(
                &app,
                "room",
                WebviewUrl::App("index.html?window=room".into()),
            )
            .title("妄想天使活动室")
            .inner_size(1024., 620.)
            .min_inner_size(205., 124.)
            .decorations(false)
            // Border handles resize explicitly; macOS intercepts native borderless
            // corner gestures without implementing drag_resize_window.
            .resizable(false)
            .transparent(true)
            .shadow(false)
            .visible(false)
            .always_on_top(read_settings(&app)?.always_on_top)
            .build()
            .map_err(|e| e.to_string())?;
            let handle = app.clone();
            w.on_window_event(move |e| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = e {
                    api.prevent_close();
                    if let Err(e) = close(&handle) {
                        log::error!("活动室关闭失败：{e}");
                    }
                }
            });
            w
        };
        w.show().map_err(|e| e.to_string())?;
        w.set_focus().map_err(|e| e.to_string())?;
        {
            let manager = app.state::<RoomManager>();
            let mut s = manager.0.lock().map_err(|_| "活动室状态不可用")?;
            s.visible = true;
            s.revision += 1;
        }
        emit(&app)
    })
    .await
    .map_err(|e| e.to_string())?
}
fn close(app: &tauri::AppHandle) -> Result<Snapshot, String> {
    // Restore first: failure leaves membership intact and retryable.
    for member in snapshot(app)?.members {
        restore(app, &member.id, false)?;
    }
    if let Some(w) = app.get_webview_window("room") {
        w.hide().map_err(|e| e.to_string())?;
    }
    {
        let manager = app.state::<RoomManager>();
        let mut s = manager.0.lock().map_err(|_| "活动室状态不可用")?;
        s.visible = false;
        s.revision += 1;
    }
    emit(app)
}
#[tauri::command]
pub fn close_room_window(window: WebviewWindow) -> Result<Snapshot, String> {
    authorized(&window)?;
    close(window.app_handle())
}
#[tauri::command]
pub fn invite_to_room(window: WebviewWindow, id: String) -> Result<Snapshot, String> {
    authorized(&window)?;
    if window.label() != "room" && window.label() != "settings" {
        return Err("请从活动室邀请角色".into());
    }
    let index = PET_IDS.iter().position(|p| *p == id).ok_or("未知角色")?;
    enter(window.app_handle(), &id, 0.4 + index as f64 * 0.17, 0.9)
}
#[tauri::command]
pub fn try_enter_room(window: WebviewWindow) -> Result<bool, String> {
    let id = pet_id_from_window_label(window.label()).ok_or("仅桌宠可以拖入活动室")?;
    let app = window.app_handle();
    if !snapshot(app)?.visible {
        return Ok(false);
    }
    let Some(room) = app.get_webview_window("room") else {
        return Ok(false);
    };
    let cursor = window.cursor_position().map_err(|e| e.to_string())?;
    let origin = room.inner_position().map_err(|e| e.to_string())?;
    let size = room.inner_size().map_err(|e| e.to_string())?;
    let scale = room.scale_factor().map_err(|e| e.to_string())?;
    let local_x = (cursor.x - origin.x as f64) / scale;
    let local_y = (cursor.y - origin.y as f64) / scale;
    let Some((x, y)) = room_point(
        size.width as f64 / scale,
        size.height as f64 / scale,
        local_x,
        local_y,
    ) else {
        return Ok(false);
    };
    enter(app, id, x, y)?;
    Ok(true)
}
fn restore(app: &tauri::AppHandle, id: &str, at_cursor: bool) -> Result<(), String> {
    if !PET_IDS.contains(&id) {
        return Err("未知角色".into());
    }
    let window = app
        .get_webview_window(&pet_window_label(id))
        .ok_or("角色窗口未就绪")?;
    if at_cursor {
        let cursor = window.cursor_position().map_err(|e| e.to_string())?;
        let size = window.outer_size().map_err(|e| e.to_string())?;
        let target = crate::clamped_position(
            &window,
            (cursor.x - size.width as f64 / 2.) as i32,
            (cursor.y - size.height as f64 / 2.) as i32,
        )?;
        window.set_position(target).map_err(|e| e.to_string())?;
    }
    if read_settings(app)?
        .pets
        .get(id)
        .map(|p| p.visible)
        .unwrap_or(false)
    {
        window.show().map_err(|e| e.to_string())?;
    }
    let manager = app.state::<RoomManager>();
    let mut s = manager.0.lock().map_err(|_| "活动室状态不可用")?;
    s.members.retain(|m| m.id != id);
    s.revision += 1;
    Ok(())
}
#[tauri::command]
pub fn leave_room(window: WebviewWindow, id: String, at_cursor: bool) -> Result<Snapshot, String> {
    authorized(&window)?;
    if window.label() != "room" && window.label() != "settings" {
        return Err("请从活动室送回角色".into());
    }
    restore(window.app_handle(), &id, at_cursor)?;
    emit(window.app_handle())
}

// Match roomFrameBounds/ROOM_FRAME_INSETS in roomGeometry.ts. Frame and image
// both scale uniformly, including at 20%; transparent margins are not drop targets.
fn room_point(width: f64, height: f64, local_x: f64, local_y: f64) -> Option<(f64, f64)> {
    if width <= 0.0 || height <= 0.0 { return None; }
    let aspect = (2048.0 / 1080.0) * 0.824 / 0.945;
    let frame_width = width.min(height * aspect);
    let frame_height = frame_width / aspect;
    let scene_width = frame_width * 0.945;
    let scene_height = frame_height * 0.824;
    let left = (width - frame_width) / 2.0 + frame_width * 0.046;
    let top = (height - frame_height) / 2.0 + frame_height * 0.164;
    let x = (local_x - left) / scene_width;
    let y = (local_y - top) / scene_height;
    if (0.0..=1.0).contains(&x) && (0.0..=1.0).contains(&y) { Some((x, y)) } else { None }
}
#[cfg(test)]
mod tests {
    use super::room_point;
    #[test]
    fn framed_room_drop_maps_after_dpi_and_rejects_logo_edges_and_letterboxing() {
        let aspect = (2048.0 / 1080.0) * 0.824 / 0.945;
        for room_scale in [0.2, 0.65, 1.0, 1.5] {
            let width = 1024.0 * room_scale;
            let height = width / aspect;
            for dpi in [1.0, 1.5, 2.0] {
                let origin = (-1920.0, -420.0);
                let cursor = (origin.0 + (width * (0.046 + 0.945 * 0.943)) * dpi,
                    origin.1 + (height * (0.164 + 0.824 * 0.685)) * dpi);
                let (x, y) = room_point(width, height,
                    (cursor.0 - origin.0) / dpi, (cursor.1 - origin.1) / dpi).unwrap();
                assert!((x - 0.943).abs() < 1e-10 && (y - 0.685).abs() < 1e-10);
            }
            assert!(room_point(width, height, width * 0.5, height * 0.1).is_none());
            assert!(room_point(width, height, width * 0.02, height * 0.5).is_none());
            assert!(room_point(width, height, width * 0.5, height * 0.995).is_none());
        }
        assert!(room_point(640.0, 900.0, 300.0, 80.0).is_none());
        assert!(room_point(1400.0, 470.0, 20.0, 200.0).is_none());
        assert_eq!(room_point(0.0, 0.0, 0.0, 0.0), None);
    }
}
