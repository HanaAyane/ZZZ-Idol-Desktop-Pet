mod pomodoro;
mod pomodoro_audio;
use std::{io::Write, sync::Mutex};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, Submenu},
    tray::TrayIconBuilder,
    Emitter, Manager, PhysicalPosition, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

mod coordination;
mod diagnostics;
mod window_lift;
mod window_geometry;
#[cfg(any(target_os = "windows", target_os = "macos"))]
mod window_drag;

use coordination::{
    emit_cancelled, emit_dispatch, emit_snapshot, pet_id_from_window_label, pet_window_label,
    CoordinationManager, PET_IDS,
};
use diagnostics::{DiagnosticExportResult, DiagnosticSummary};
use window_lift::{WindowLiftManager, WindowLiftRect, WindowLiftSnapshot};

const SETTINGS_SCHEMA_VERSION: u32 = 6;

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedPlacement {
    x: i32,
    y: i32,
    monitor_name: Option<String>,
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct PetSettings {
    visible: bool,
    scale: f64,
    last_placement: Option<SavedPlacement>,
}

impl Default for PetSettings {
    fn default() -> Self {
        Self {
            visible: true,
            scale: 1.0,
            last_placement: None,
        }
    }
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct CoordinationSettings {
    enabled: bool,
    partner_gaze: bool,
    reaction_echo: bool,
    automatic_scenes: bool,
}

impl Default for CoordinationSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            partner_gaze: true,
            reaction_echo: true,
            automatic_scenes: false,
        }
    }
}

#[derive(Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct PetInstances {
    airui: PetSettings,
    nangong: PetSettings,
    qianxia: PetSettings,
}

impl PetInstances {
    fn get(&self, id: &str) -> Option<&PetSettings> {
        match id {
            "airui" => Some(&self.airui),
            "nangong" => Some(&self.nangong),
            "qianxia" => Some(&self.qianxia),
            _ => None,
        }
    }

    fn get_mut(&mut self, id: &str) -> Option<&mut PetSettings> {
        match id {
            "airui" => Some(&mut self.airui),
            "nangong" => Some(&mut self.nangong),
            "qianxia" => Some(&mut self.qianxia),
            _ => None,
        }
    }
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct AppSettings {
    schema_version: u32,
    pets: PetInstances,
    always_on_top: bool,
    auto_walk: bool,
    walk_frequency: f64,
    movement_speed: f64,
    click_enabled: bool,
    double_click_enabled: bool,
    hover_enabled: bool,
    gaze_tracking: bool,
    window_lift_enabled: bool,
    auto_window_lift_enabled: bool,
    performance_mode: String,
    frame_rate: String,
    debug_mode: bool,
    launch_at_login: bool,
    coordination: CoordinationSettings,
    #[serde(skip_serializing_if = "Option::is_none")]
    selected_character: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    scale: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_placement: Option<SavedPlacement>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            schema_version: SETTINGS_SCHEMA_VERSION,
            pets: PetInstances::default(),
            always_on_top: true,
            auto_walk: true,
            walk_frequency: 1.0,
            movement_speed: 1.0,
            click_enabled: true,
            double_click_enabled: true,
            hover_enabled: true,
            gaze_tracking: true,
            window_lift_enabled: false,
            auto_window_lift_enabled: false,
            performance_mode: "balanced".into(),
            frame_rate: "auto".into(),
            debug_mode: false,
            launch_at_login: false,
            coordination: CoordinationSettings::default(),
            selected_character: None,
            scale: None,
            last_placement: None,
        }
    }
}

impl AppSettings {
    fn normalize(mut self) -> Self {
        self.schema_version = SETTINGS_SCHEMA_VERSION;
        for id in PET_IDS {
            if let Some(pet) = self.pets.get_mut(id) {
                pet.scale = pet.scale.clamp(0.6, 1.25);
            }
        }
        self.walk_frequency = self.walk_frequency.clamp(0.5, 2.0);
        self.movement_speed = self.movement_speed.clamp(0.5, 2.0);
        if !matches!(
            self.performance_mode.as_str(),
            "quality" | "balanced" | "saving"
        ) {
            self.performance_mode = "balanced".into();
        }
        if !matches!(self.frame_rate.as_str(), "auto" | "60" | "30") {
            self.frame_rate = "auto".into();
        }
        self
    }
}

#[derive(Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppSettingsPatch {
    always_on_top: Option<bool>,
    auto_walk: Option<bool>,
    walk_frequency: Option<f64>,
    movement_speed: Option<f64>,
    click_enabled: Option<bool>,
    double_click_enabled: Option<bool>,
    hover_enabled: Option<bool>,
    gaze_tracking: Option<bool>,
    window_lift_enabled: Option<bool>,
    auto_window_lift_enabled: Option<bool>,
    performance_mode: Option<String>,
    frame_rate: Option<String>,
    debug_mode: Option<bool>,
    launch_at_login: Option<bool>,
    coordination: Option<CoordinationSettings>,
}

#[derive(Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PetSettingsPatch {
    visible: Option<bool>,
    scale: Option<f64>,
    last_placement: Option<Option<SavedPlacement>>,
}

struct TraySettingsItems {
    airui: CheckMenuItem<tauri::Wry>,
    nangong: CheckMenuItem<tauri::Wry>,
    qianxia: CheckMenuItem<tauri::Wry>,
    always_on_top: CheckMenuItem<tauri::Wry>,
    auto_walk: CheckMenuItem<tauri::Wry>,
    gaze_tracking: CheckMenuItem<tauri::Wry>,
    coordination: CheckMenuItem<tauri::Wry>,
}

struct PetContextMenu(Menu<tauri::Wry>);

struct SettingsWriteLock(Mutex<()>);

struct SettingsWindowLock(Mutex<()>);

struct LastActivePet(Mutex<Option<String>>);

impl AppSettingsPatch {
    fn apply(self, settings: &mut AppSettings) {
        if let Some(value) = self.always_on_top {
            settings.always_on_top = value;
        }
        if let Some(value) = self.auto_walk {
            settings.auto_walk = value;
        }
        if let Some(value) = self.walk_frequency {
            settings.walk_frequency = value;
        }
        if let Some(value) = self.movement_speed {
            settings.movement_speed = value;
        }
        if let Some(value) = self.click_enabled {
            settings.click_enabled = value;
        }
        if let Some(value) = self.double_click_enabled {
            settings.double_click_enabled = value;
        }
        if let Some(value) = self.hover_enabled {
            settings.hover_enabled = value;
        }
        if let Some(value) = self.gaze_tracking {
            settings.gaze_tracking = value;
        }
        if let Some(value) = self.window_lift_enabled {
            settings.window_lift_enabled = value;
        }
        if let Some(value) = self.auto_window_lift_enabled {
            settings.auto_window_lift_enabled = value;
        }
        if let Some(value) = self.performance_mode {
            settings.performance_mode = value;
        }
        if let Some(value) = self.frame_rate {
            settings.frame_rate = value;
        }
        if let Some(value) = self.debug_mode {
            settings.debug_mode = value;
        }
        if let Some(value) = self.launch_at_login {
            settings.launch_at_login = value;
        }
        if let Some(value) = self.coordination {
            settings.coordination = value;
        }
    }
}

fn settings_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir.join("settings.json"))
}

fn read_settings(app: &tauri::AppHandle) -> Result<AppSettings, String> {
    let path = settings_path(app)?;
    if !path.exists() {
        let settings = AppSettings::default();
        write_settings(app, &settings)?;
        return Ok(settings);
    }
    let bytes = std::fs::read(&path).map_err(|error| error.to_string())?;
    match serde_json::from_slice::<AppSettings>(&bytes) {
        Ok(settings) => Ok(migrate_settings(settings)),
        Err(error) => {
            let backup = path.with_extension(format!("corrupt-{}.json", chrono_timestamp()));
            let _ = std::fs::rename(&path, backup);
            log::error!(
                target: "desktop_pet::settings",
                "settings file was corrupt and defaults were restored: {error}"
            );
            let settings = AppSettings::default();
            write_settings(app, &settings)?;
            Ok(settings)
        }
    }
}

fn migrate_settings(mut settings: AppSettings) -> AppSettings {
    if settings.schema_version < 2 {
        settings.debug_mode = false;
    }
    if settings.schema_version < 3 {
        let legacy_scale = settings.scale.take().unwrap_or(1.0).clamp(0.6, 1.25);
        for id in PET_IDS {
            if let Some(pet) = settings.pets.get_mut(id) {
                pet.visible = true;
                pet.scale = legacy_scale;
            }
        }
        let legacy_id = settings
            .selected_character
            .take()
            .filter(|id| PET_IDS.contains(&id.as_str()))
            .unwrap_or_else(|| "airui".into());
        if let Some(placement) = settings.last_placement.take() {
            if let Some(pet) = settings.pets.get_mut(&legacy_id) {
                pet.last_placement = Some(placement);
            }
        }
    }
    if settings.schema_version < 4 {
        settings.coordination = CoordinationSettings::default();
    }
    if settings.schema_version < 5 {
        settings.window_lift_enabled = false;
    }
    if settings.schema_version < 6 {
        settings.auto_window_lift_enabled = false;
    }
    settings.selected_character = None;
    settings.scale = None;
    settings.last_placement = None;
    settings.schema_version = SETTINGS_SCHEMA_VERSION;
    settings.normalize()
}

fn chrono_timestamp() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default()
}

fn write_settings(app: &tauri::AppHandle, settings: &AppSettings) -> Result<(), String> {
    let path = settings_path(app)?;
    let bytes = serde_json::to_vec_pretty(settings).map_err(|error| error.to_string())?;
    let mut file =
        atomic_write_file::AtomicWriteFile::open(&path).map_err(|error| error.to_string())?;
    file.set_len(0).map_err(|error| error.to_string())?;
    file.write_all(&bytes).map_err(|error| error.to_string())?;
    file.commit().map_err(|error| error.to_string())
}

fn apply_system_settings(app: &tauri::AppHandle, settings: &AppSettings) -> Result<(), String> {
    let settings_was_focused = app
        .get_webview_window("settings")
        .map(|window| window.is_focused().unwrap_or(false))
        .unwrap_or(false);
    for id in PET_IDS {
        if let (Some(window), Some(pet)) = (
            app.get_webview_window(&pet_window_label(id)),
            settings.pets.get(id),
        ) {
            window
                .set_always_on_top(settings.always_on_top)
                .map_err(|error| error.to_string())?;
            let currently_visible = window.is_visible().map_err(|error| error.to_string())?;
            if pet.visible && !currently_visible {
                window.show().map_err(|error| error.to_string())?;
            } else if !pet.visible && currently_visible {
                window.hide().map_err(|error| error.to_string())?;
            }
        }
    }
    if settings_was_focused {
        if let Some(settings_window) = app.get_webview_window("settings") {
            settings_window
                .set_focus()
                .map_err(|error| error.to_string())?;
        }
    }
    let autostart = app.autolaunch();
    let enabled = autostart.is_enabled().map_err(|error| error.to_string())?;
    if settings.launch_at_login && !enabled {
        autostart.enable().map_err(|error| error.to_string())?;
    } else if !settings.launch_at_login && enabled {
        autostart.disable().map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn sync_tray_settings(app: &tauri::AppHandle, settings: &AppSettings) {
    if let Some(items) = app.try_state::<TraySettingsItems>() {
        let _ = items.airui.set_checked(settings.pets.airui.visible);
        let _ = items.nangong.set_checked(settings.pets.nangong.visible);
        let _ = items.qianxia.set_checked(settings.pets.qianxia.visible);
        let _ = items.always_on_top.set_checked(settings.always_on_top);
        let _ = items.auto_walk.set_checked(settings.auto_walk);
        let _ = items.gaze_tracking.set_checked(settings.gaze_tracking);
        let _ = items
            .coordination
            .set_checked(settings.coordination.enabled);
    }
}

fn cancel_active_coordination(app: &tauri::AppHandle, reason: &str) {
    if let Some(manager) = app.try_state::<CoordinationManager>() {
        if let Some(event) = manager.cancel_all(reason) {
            emit_cancelled(app, &event);
            emit_snapshot(app, &manager);
        }
    }
}

fn update_settings(app: &tauri::AppHandle, patch: AppSettingsPatch) -> Result<AppSettings, String> {
    let write_lock = app.state::<SettingsWriteLock>();
    let _guard = write_lock
        .0
        .lock()
        .map_err(|_| "设置写入锁不可用".to_string())?;
    let mut settings = read_settings(app)?;
    if patch.launch_at_login.is_none() {
        settings.launch_at_login = app
            .autolaunch()
            .is_enabled()
            .unwrap_or(settings.launch_at_login);
    }
    patch.apply(&mut settings);
    settings = settings.normalize();
    if !settings.coordination.enabled {
        cancel_active_coordination(app, "settings_disabled");
    }
    if let Some(manager) = app.try_state::<WindowLiftManager>() {
        manager.retain_enabled(
            settings.window_lift_enabled,
            settings.auto_window_lift_enabled,
        );
    }
    apply_system_settings(app, &settings)?;
    write_settings(app, &settings)?;
    sync_tray_settings(app, &settings);
    let _ = app.emit("app-settings-state", settings.clone());
    Ok(settings)
}

fn update_pet_instance(
    app: &tauri::AppHandle,
    id: &str,
    patch: PetSettingsPatch,
) -> Result<AppSettings, String> {
    let write_lock = app.state::<SettingsWriteLock>();
    let _guard = write_lock
        .0
        .lock()
        .map_err(|_| "设置写入锁不可用".to_string())?;
    let mut settings = read_settings(app)?;
    let pet = settings
        .pets
        .get_mut(id)
        .ok_or_else(|| format!("未知角色：{id}"))?;
    if let Some(value) = patch.visible {
        pet.visible = value;
    }
    if let Some(value) = patch.scale {
        pet.scale = value.clamp(0.6, 1.25);
    }
    if let Some(value) = patch.last_placement {
        pet.last_placement = value;
    }
    settings = settings.normalize();
    if !settings.coordination.enabled || patch.visible == Some(false) {
        cancel_active_coordination(
            app,
            if patch.visible == Some(false) {
                "participant_hidden"
            } else {
                "settings_disabled"
            },
        );
    }
    apply_system_settings(app, &settings)?;
    write_settings(app, &settings)?;
    sync_tray_settings(app, &settings);
    let _ = app.emit("app-settings-state", settings.clone());
    Ok(settings)
}

fn update_all_pet_visibility(app: &tauri::AppHandle, visible: bool) -> Result<AppSettings, String> {
    let write_lock = app.state::<SettingsWriteLock>();
    let _guard = write_lock
        .0
        .lock()
        .map_err(|_| "设置写入锁不可用".to_string())?;
    let mut settings = read_settings(app)?;
    for id in PET_IDS {
        if let Some(pet) = settings.pets.get_mut(id) {
            pet.visible = visible;
        }
    }
    if !visible {
        cancel_active_coordination(app, "participant_hidden");
    }
    apply_system_settings(app, &settings)?;
    write_settings(app, &settings)?;
    sync_tray_settings(app, &settings);
    let _ = app.emit("app-settings-state", settings.clone());
    Ok(settings)
}

#[tauri::command]
fn get_app_settings(app: tauri::AppHandle) -> Result<AppSettings, String> {
    let mut settings = read_settings(&app)?;
    settings.launch_at_login = app
        .autolaunch()
        .is_enabled()
        .unwrap_or(settings.launch_at_login);
    Ok(settings)
}

#[tauri::command]
fn update_app_settings(
    app: tauri::AppHandle,
    patch: AppSettingsPatch,
) -> Result<AppSettings, String> {
    update_settings(&app, patch)
}

#[tauri::command]
fn update_pet_settings(
    app: tauri::AppHandle,
    id: String,
    patch: PetSettingsPatch,
) -> Result<AppSettings, String> {
    update_pet_instance(&app, &id, patch)
}

fn coordination_snapshot_response(
    app: &tauri::AppHandle,
    dispatch: coordination::CoordinationDispatch,
) -> coordination::CoordinationSnapshot {
    let snapshot = dispatch.snapshot.clone();
    emit_dispatch(app, dispatch);
    snapshot
}

fn require_settings_or_pet_window(
    window: &WebviewWindow,
    allow_settings: bool,
) -> Result<Option<&'static str>, String> {
    if let Some(id) = pet_id_from_window_label(window.label()) {
        return Ok(Some(id));
    }
    if allow_settings && window.label() == "settings" {
        return Ok(None);
    }
    Err("该联动命令仅允许三个桌宠窗口或设置窗口调用".into())
}

#[tauri::command]
fn report_pet_runtime_state(
    window: WebviewWindow,
    snapshot: coordination::CoordinationRuntimeState,
    manager: State<'_, CoordinationManager>,
) -> Result<coordination::CoordinationSnapshot, String> {
    let id = pet_id_from_window_label(window.label())
        .ok_or_else(|| "该状态上报命令仅允许桌宠窗口调用".to_string())?;
    let dispatch = manager.report(id, snapshot);
    Ok(coordination_snapshot_response(
        &window.app_handle(),
        dispatch,
    ))
}

#[tauri::command]
fn get_coordination_snapshot(
    manager: State<'_, CoordinationManager>,
) -> coordination::CoordinationSnapshot {
    manager.snapshot()
}

#[tauri::command]
fn request_coordination_scene(
    window: WebviewWindow,
    kind: String,
    trigger_kind: Option<String>,
    manager: State<'_, CoordinationManager>,
) -> Result<coordination::CoordinationSnapshot, String> {
    let actor_id = pet_id_from_window_label(window.label())
        .ok_or_else(|| "该联动场景请求仅允许桌宠窗口调用".to_string())?;
    let settings = read_settings(&window.app_handle())?;
    if !settings.coordination.enabled || !settings.coordination.reaction_echo {
        return Ok(manager.snapshot());
    }
    if kind != "reactionEcho" {
        return Err("当前 MVP 只允许请求点击回应场景".into());
    }
    let trigger_kind = trigger_kind.ok_or_else(|| "点击回应缺少触发类型".to_string())?;
    let dispatch = manager.request_reaction(actor_id, &trigger_kind);
    Ok(coordination_snapshot_response(
        &window.app_handle(),
        dispatch,
    ))
}

#[tauri::command]
fn complete_coordination_scene(
    window: WebviewWindow,
    scene_id: u64,
    generation: u64,
    outcome: String,
    manager: State<'_, CoordinationManager>,
) -> Result<coordination::CoordinationSnapshot, String> {
    let caller_id = pet_id_from_window_label(window.label())
        .ok_or_else(|| "该联动完成回执仅允许桌宠窗口调用".to_string())?;
    let dispatch = manager.complete(caller_id, scene_id, generation, &outcome);
    Ok(coordination_snapshot_response(
        &window.app_handle(),
        dispatch,
    ))
}

#[tauri::command]
fn cancel_coordination_scene(
    window: WebviewWindow,
    scene_id: u64,
    generation: u64,
    reason: String,
    manager: State<'_, CoordinationManager>,
) -> Result<coordination::CoordinationSnapshot, String> {
    let caller_id = pet_id_from_window_label(window.label())
        .ok_or_else(|| "该联动取消回执仅允许桌宠窗口调用".to_string())?;
    let dispatch = manager.cancel(Some(caller_id), scene_id, generation, &reason);
    Ok(coordination_snapshot_response(
        &window.app_handle(),
        dispatch,
    ))
}

#[tauri::command]
fn arrange_pet_group(
    window: WebviewWindow,
    mode: String,
    anchor_character_id: Option<String>,
    manager: State<'_, CoordinationManager>,
) -> Result<coordination::CoordinationSnapshot, String> {
    if mode != "gather" && mode != "disperse" {
        return Err("未知的角色布局模式".into());
    }
    let requester = require_settings_or_pet_window(&window, true)?;
    let anchor = match requester {
        Some(id) => Some(id.to_string()),
        None => anchor_character_id.filter(|id| PET_IDS.contains(&id.as_str())),
    };
    let settings = read_settings(&window.app_handle())?;
    if !settings.coordination.enabled {
        return Ok(manager.snapshot());
    }
    let dispatch = manager.request_layout(&mode, anchor.as_deref());
    Ok(coordination_snapshot_response(
        &window.app_handle(),
        dispatch,
    ))
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PetWorkArea {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PetWindowContext {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    scale_factor: f64,
    monitor_name: Option<String>,
    work_area: PetWorkArea,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PetCursorSample {
    cursor_x: f64,
    cursor_y: f64,
    window_x: i32,
    window_y: i32,
    scale_factor: f64,
    primary_button_down: bool,
}

#[derive(serde::Serialize)]
struct PetDragResult {
    start: PhysicalPosition<i32>,
    dragged: bool,
    cancelled: bool,
}

#[cfg(target_os = "windows")]
fn primary_mouse_button_down() -> bool {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};

    unsafe { (GetAsyncKeyState(VK_LBUTTON as i32) as u16 & 0x8000) != 0 }
}

#[cfg(target_os = "macos")]
fn primary_mouse_button_down() -> bool {
    objc2_app_kit::NSEvent::pressedMouseButtons() & 1 != 0
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn primary_mouse_button_down() -> bool {
    false
}

fn require_pet_window(window: &WebviewWindow) -> Result<(), String> {
    if pet_id_from_window_label(window.label()).is_some() {
        Ok(())
    } else {
        Err("该命令仅允许主桌宠窗口调用".into())
    }
}

fn require_settings_window(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "settings" {
        Ok(())
    } else {
        Err("该命令仅允许设置窗口调用".into())
    }
}

#[tauri::command]
async fn drag_pet_window(
    window: WebviewWindow,
    grab_x_css: f64,
    grab_y_css: f64,
) -> Result<PetDragResult, String> {
    require_pet_window(&window)?;
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    {
        tauri::async_runtime::spawn_blocking(move || window_drag::drag(window, grab_x_css, grab_y_css))
            .await
            .map_err(|error| error.to_string())?
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = (grab_x_css, grab_y_css);
        Err("该拖拽方式仅用于 Windows 和 macOS".into())
    }
}

#[tauri::command]
fn cancel_pet_drag(window: WebviewWindow) -> Result<(), String> {
    require_pet_window(&window)?;
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    window_drag::cancel(window.label());
    Ok(())
}

#[tauri::command]
fn get_diagnostic_summary(window: WebviewWindow) -> Result<DiagnosticSummary, String> {
    require_settings_window(&window)?;
    diagnostics::get_summary(window.app_handle())
}

#[tauri::command]
fn export_diagnostic_report(window: WebviewWindow) -> Result<DiagnosticExportResult, String> {
    require_settings_window(&window)?;
    log::info!(target: "desktop_pet::diagnostics", "diagnostic report export requested");
    let result = diagnostics::export_report(window.app_handle());
    match &result {
        Ok(report) => log::info!(
            target: "desktop_pet::diagnostics",
            "diagnostic report written: {} bytes, {} log files",
            report.bytes_written,
            report.included_log_files,
        ),
        Err(error) => log::error!(
            target: "desktop_pet::diagnostics",
            "diagnostic report export failed: {error}"
        ),
    }
    result
}

#[tauri::command]
fn sample_pet_cursor(window: WebviewWindow) -> Result<PetCursorSample, String> {
    require_pet_window(&window)?;
    let cursor = window
        .cursor_position()
        .map_err(|error| error.to_string())?;
    let origin = window.inner_position().map_err(|error| error.to_string())?;
    let scale_factor = window.scale_factor().map_err(|error| error.to_string())?;
    Ok(PetCursorSample {
        cursor_x: cursor.x,
        cursor_y: cursor.y,
        window_x: origin.x,
        window_y: origin.y,
        scale_factor,
        primary_button_down: primary_mouse_button_down(),
    })
}

#[tauri::command]
fn set_pet_cursor_passthrough(window: WebviewWindow, enabled: bool) -> Result<(), String> {
    require_pet_window(&window)?;
    window
        .set_ignore_cursor_events(enabled)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn attach_window_lift(
    window: WebviewWindow,
    manager: State<'_, WindowLiftManager>,
    hand_x_css: f64,
    hand_y_css: f64,
    max_gap_css: f64,
    automatic: Option<bool>,
) -> Result<Option<WindowLiftSnapshot>, String> {
    let pet_id = pet_id_from_window_label(window.label())
        .ok_or_else(|| "该命令仅允许桌宠窗口调用".to_string())?;
    let automatic = automatic.unwrap_or(false);
    let settings = read_settings(window.app_handle())?;
    if !(if automatic {
        settings.auto_window_lift_enabled && settings.auto_walk
    } else {
        settings.window_lift_enabled
    }) {
        manager.detach(pet_id);
        return Ok(None);
    }
    manager.attach(
        &window,
        pet_id,
        hand_x_css,
        hand_y_css,
        max_gap_css,
        automatic,
    )
}

#[tauri::command]
fn get_window_lift_target(
    window: WebviewWindow,
    manager: State<'_, WindowLiftManager>,
) -> Result<Option<WindowLiftSnapshot>, String> {
    let pet_id = pet_id_from_window_label(window.label())
        .ok_or_else(|| "该命令仅允许桌宠窗口调用".to_string())?;
    manager.snapshot(&window, pet_id)
}

#[tauri::command]
fn detach_window_lift(
    window: WebviewWindow,
    manager: State<'_, WindowLiftManager>,
) -> Result<(), String> {
    let pet_id = pet_id_from_window_label(window.label())
        .ok_or_else(|| "该命令仅允许桌宠窗口调用".to_string())?;
    manager.detach(pet_id);
    Ok(())
}

fn create_or_show_settings_window(app: &tauri::AppHandle) -> Result<(), String> {
    let creation_lock = app.state::<SettingsWindowLock>();
    let _guard = creation_lock
        .0
        .lock()
        .map_err(|_| "设置窗口创建锁不可用".to_string())?;
    if let Some(window) = app.get_webview_window("settings") {
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        return Ok(());
    }
    WebviewWindowBuilder::new(
        app,
        "settings",
        WebviewUrl::App("index.html?window=settings".into()),
    )
    .title("妄想天使桌宠 · 设置")
    .inner_size(720.0, 760.0)
    .min_inner_size(640.0, 520.0)
    .center()
    .resizable(true)
    .focused(true)
    .build()
    .map(|_| ())
    .map_err(|error| error.to_string())
}

fn request_settings_window(app: tauri::AppHandle) {
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(error) = create_or_show_settings_window(&app) {
            log::error!(target: "desktop_pet::window", "settings window open failed: {error}");
        }
    });
}

#[tauri::command]
async fn show_settings_window(window: WebviewWindow) -> Result<(), String> {
    require_pet_window(&window)?;
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || create_or_show_settings_window(&app))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
fn show_pet_context_menu(
    window: WebviewWindow,
    menu: tauri::State<'_, PetContextMenu>,
    last_active: State<'_, LastActivePet>,
) -> Result<(), String> {
    require_pet_window(&window)?;
    if let Some(id) = pet_id_from_window_label(window.label()) {
        if let Ok(mut active) = last_active.0.lock() {
            *active = Some(id.to_string());
        }
    }
    window
        .popup_menu(&menu.0)
        .map_err(|error| error.to_string())
}

fn monitor_for_target(
    window: &WebviewWindow,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<tauri::Monitor, String> {
    let center_x = x as i64 + width as i64 / 2;
    let center_y = y as i64 + height as i64 / 2;
    let monitors = window
        .available_monitors()
        .map_err(|error| error.to_string())?;
    if let Some(monitor) = monitors.into_iter().find(|monitor| {
        let area = monitor.work_area();
        center_x >= area.position.x as i64
            && center_x < area.position.x as i64 + area.size.width as i64
            && center_y >= area.position.y as i64
            && center_y < area.position.y as i64 + area.size.height as i64
    }) {
        return Ok(monitor);
    }
    window
        .current_monitor()
        .map_err(|error| error.to_string())?
        .or(window
            .primary_monitor()
            .map_err(|error| error.to_string())?)
        .ok_or_else(|| "未找到可用显示器".into())
}

fn clamped_position(
    window: &WebviewWindow,
    x: i32,
    y: i32,
) -> Result<PhysicalPosition<i32>, String> {
    let size = window.outer_size().map_err(|error| error.to_string())?;
    let monitor = monitor_for_target(window, x, y, size.width, size.height)?;
    let area = monitor.work_area();
    let max_x = area.position.x + area.size.width.saturating_sub(size.width) as i32;
    let max_y = area.position.y + area.size.height.saturating_sub(size.height) as i32;
    Ok(PhysicalPosition::new(
        x.clamp(area.position.x, max_x.max(area.position.x)),
        y.clamp(area.position.y, max_y.max(area.position.y)),
    ))
}

fn pet_window_context_at(
    window: &WebviewWindow,
    position: PhysicalPosition<i32>,
) -> Result<PetWindowContext, String> {
    let size = window.outer_size().map_err(|error| error.to_string())?;
    let monitor = monitor_for_target(window, position.x, position.y, size.width, size.height)?;
    let area = monitor.work_area();
    Ok(PetWindowContext {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
        scale_factor: monitor.scale_factor(),
        monitor_name: monitor.name().cloned(),
        work_area: PetWorkArea {
            x: area.position.x,
            y: area.position.y,
            width: area.size.width,
            height: area.size.height,
        },
    })
}

#[tauri::command]
fn get_pet_window_context(window: WebviewWindow) -> Result<PetWindowContext, String> {
    require_pet_window(&window)?;
    let position = window.outer_position().map_err(|error| error.to_string())?;
    pet_window_context_at(&window, position)
}

#[tauri::command]
fn move_pet_window(
    window: WebviewWindow,
    x: i32,
    y: i32,
    roaming: Option<bool>,
) -> Result<PetWindowContext, String> {
    require_pet_window(&window)?;
    let position = clamped_position(&window, x, y)?;
    #[cfg(target_os = "macos")]
    let position = {
        let current = window.outer_position().map_err(|error| error.to_string())?;
        let size = window.outer_size().map_err(|error| error.to_string())?;
        let monitor = monitor_for_target(&window, x, y, size.width, size.height)?;
        window_drag::preserve_dragged_height(
            current,
            PhysicalPosition::new(x, y),
            position,
            size,
            monitor.work_area(),
        )
    };
    let position = if roaming.unwrap_or(false) {
        let current = window.outer_position().map_err(|error| error.to_string())?;
        let size = window.outer_size().map_err(|error| error.to_string())?;
        let monitor = monitor_for_target(&window, x, y, size.width, size.height)?;
        window_geometry::preserve_roaming_height(
            current,
            PhysicalPosition::new(x, y),
            position,
            size,
            monitor.work_area(),
        )
    } else {
        position
    };
    window
        .set_position(position)
        .map_err(|error| error.to_string())?;
    // On macOS Tao dispatches setFrameTopLeftPoint asynchronously to the main
    // queue. Reading outer_position here can therefore return the previous
    // frame and make the frontend rewind/requeue movement indefinitely.
    pet_window_context_at(&window, position)
}

/// Only a bound pet may let its transparent margins leave the work area.
/// No handle or mutation of the third-party target window is exposed here.
#[tauri::command]
fn move_lift_pet_window(
    window: WebviewWindow,
    manager: State<'_, WindowLiftManager>,
    x: i32,
    y: i32,
    visible_bounds_css: WindowLiftRect,
) -> Result<Option<PetWindowContext>, String> {
    let pet_id = pet_id_from_window_label(window.label())
        .ok_or_else(|| "该命令仅允许桌宠窗口调用".to_string())?;
    if !manager.is_bound(pet_id) {
        return Ok(None);
    }
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let size = window.outer_size().map_err(|e| e.to_string())?;
    let b = visible_bounds_css;
    if !b.valid()
        || b.x < -8.0
        || b.y < -8.0
        || b.x + b.width > size.width as f64 / scale + 8.0
        || b.y + b.height > size.height as f64 / scale + 8.0
    {
        return Err("托举可见范围无效".into());
    }
    let monitor = monitor_for_target(
        &window,
        x.saturating_add((b.x * scale).round() as i32),
        y.saturating_add((b.y * scale).round() as i32),
        (b.width * scale).ceil() as u32,
        (b.height * scale).ceil() as u32,
    )?;
    let area = monitor.work_area();
    if !b.fits_at(
        x as f64,
        y as f64,
        scale,
        WindowLiftRect {
            x: area.position.x as f64,
            y: area.position.y as f64,
            width: area.size.width as f64,
            height: area.size.height as f64,
        },
    ) {
        return Ok(None);
    }
    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
    Ok(Some(PetWindowContext {
        x,
        y,
        width: size.width,
        height: size.height,
        scale_factor: monitor.scale_factor(),
        monitor_name: monitor.name().cloned(),
        work_area: PetWorkArea {
            x: area.position.x,
            y: area.position.y,
            width: area.size.width,
            height: area.size.height,
        },
    }))
}

#[tauri::command]
fn restore_pet_window(window: WebviewWindow, x: i32, y: i32) -> Result<PetWindowContext, String> {
    require_pet_window(&window)?;
    let size = window.outer_size().map_err(|error| error.to_string())?;
    let monitors = window
        .available_monitors()
        .map_err(|error| error.to_string())?;
    let intersects_saved_monitor = monitors.iter().any(|monitor| {
        let area = monitor.work_area();
        x < area.position.x + area.size.width as i32
            && x + size.width as i32 > area.position.x
            && y < area.position.y + area.size.height as i32
            && y + size.height as i32 > area.position.y
    });
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    let keep_transparent_overflow = monitors.iter().any(|monitor| {
        window_drag::pet_center_is_visible(PhysicalPosition::new(x, y), size, monitor.work_area())
    });
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let keep_transparent_overflow = false;
    let target = if keep_transparent_overflow {
        PhysicalPosition::new(x, y)
    } else if intersects_saved_monitor {
        clamped_position(&window, x, y)?
    } else {
        let monitor = window
            .primary_monitor()
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "未找到主显示器".to_string())?;
        let area = monitor.work_area();
        PhysicalPosition::new(
            area.position.x + area.size.width.saturating_sub(size.width) as i32,
            area.position.y + area.size.height.saturating_sub(size.height) as i32,
        )
    };
    window
        .set_position(target)
        .map_err(|error| error.to_string())?;
    pet_window_context_at(&window, target)
}

#[tauri::command]
fn initialize_pet_window(window: WebviewWindow) -> Result<PetWindowContext, String> {
    let id = pet_id_from_window_label(window.label())
        .ok_or_else(|| "该命令仅允许桌宠窗口调用".to_string())?;
    let slot = PET_IDS
        .iter()
        .position(|candidate| *candidate == id)
        .unwrap_or_default() as i32;
    let size = window.outer_size().map_err(|error| error.to_string())?;
    let monitor = window
        .primary_monitor()
        .map_err(|error| error.to_string())?
        .or(window
            .current_monitor()
            .map_err(|error| error.to_string())?)
        .ok_or_else(|| "未找到可用显示器".to_string())?;
    let area = monitor.work_area();
    let min_x = area.position.x;
    let max_x = area.position.x + area.size.width.saturating_sub(size.width) as i32;
    let span = max_x.saturating_sub(min_x);
    let margin = (24.0 * monitor.scale_factor()).round() as i32;
    let target = PhysicalPosition::new(
        min_x + span * slot / 2,
        area.position.y + area.size.height.saturating_sub(size.height) as i32 - margin,
    );
    let target = clamped_position(&window, target.x, target.y)?;
    window
        .set_position(target)
        .map_err(|error| error.to_string())?;
    pet_window_context_at(&window, target)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let default_panic_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |panic_info| {
        default_panic_hook(panic_info);
        log::error!(target: "desktop_pet::panic", "unhandled Rust panic: {panic_info}");
    }));
    tauri::Builder::default()
        // Configured WebViews may invoke commands before the setup hook runs.
        .manage(SettingsWriteLock(Mutex::new(())))
        .manage(SettingsWindowLock(Mutex::new(())))
        .manage(CoordinationManager::default())
        .manage(LastActivePet(Mutex::new(None)))
        .manage(WindowLiftManager::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            log::info!(
                target: "desktop_pet::lifecycle",
                "secondary launch redirected to the existing instance"
            );
            request_settings_window(app.clone());
        }))
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .max_file_size(2_000_000)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(3))
                .build(),
        )
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .invoke_handler(tauri::generate_handler![
            pomodoro::get_pomodoro_state,
            pomodoro::pomodoro_action,
            pomodoro::set_pomodoro_visible,
            get_app_settings,
            update_app_settings,
            update_pet_settings,
            report_pet_runtime_state,
            get_coordination_snapshot,
            request_coordination_scene,
            complete_coordination_scene,
            cancel_coordination_scene,
            arrange_pet_group,
            get_diagnostic_summary,
            export_diagnostic_report,
            sample_pet_cursor,
            drag_pet_window,
            cancel_pet_drag,
            set_pet_cursor_passthrough,
            attach_window_lift,
            get_window_lift_target,
            detach_window_lift,
            show_settings_window,
            show_pet_context_menu,
            get_pet_window_context,
            move_pet_window,
            move_lift_pet_window,
            restore_pet_window,
            initialize_pet_window
        ])
        .setup(|app| {
            app.manage(pomodoro::PomodoroManager::new(app.handle()).map_err(std::io::Error::other)?);
            pomodoro::PomodoroManager::spawn(app.handle().clone());
            #[cfg(target_os = "macos")]
            for id in PET_IDS {
                if let Some(window) = app.get_webview_window(&pet_window_label(id)) {
                    window_drag::configure_pet_window(&window).map_err(std::io::Error::other)?;
                }
            }
            log::info!(
                target: "desktop_pet::lifecycle",
                "application started: version={} platform={}/{} pid={}",
                app.package_info().version,
                std::env::consts::OS,
                std::env::consts::ARCH,
                std::process::id(),
            );
            let startup_settings = match read_settings(app.handle()) {
                Ok(settings) => settings,
                Err(error) => {
                    log::error!(
                        target: "desktop_pet::settings",
                        "settings load failed; defaults will be used: {error}"
                    );
                    AppSettings::default()
                }
            };
            if let Err(error) = apply_system_settings(app.handle(), &startup_settings) {
                log::error!(
                    target: "desktop_pet::settings",
                    "startup system settings failed: {error}"
                );
            }
            let show_pet =
                MenuItem::with_id(app, "show_all_pets", "显示全部桌宠", true, None::<&str>)?;
            let show_settings =
                MenuItem::with_id(app, "show_settings", "打开设置", true, None::<&str>)?;
            let hide_pet =
                MenuItem::with_id(app, "hide_all_pets", "隐藏全部桌宠", true, None::<&str>)?;
            let show_airui = CheckMenuItem::with_id(
                app,
                "show_airui",
                "爱芮",
                true,
                startup_settings.pets.airui.visible,
                None::<&str>,
            )?;
            let show_nangong = CheckMenuItem::with_id(
                app,
                "show_nangong",
                "南宫",
                true,
                startup_settings.pets.nangong.visible,
                None::<&str>,
            )?;
            let show_qianxia = CheckMenuItem::with_id(
                app,
                "show_qianxia",
                "千夏",
                true,
                startup_settings.pets.qianxia.visible,
                None::<&str>,
            )?;
            let character_visibility_menu = Submenu::with_items(
                app,
                "显示角色",
                true,
                &[&show_airui, &show_nangong, &show_qianxia],
            )?;
            let always_on_top = CheckMenuItem::with_id(
                app,
                "always_on_top",
                "始终置顶",
                true,
                startup_settings.always_on_top,
                None::<&str>,
            )?;
            let auto_walk = CheckMenuItem::with_id(
                app,
                "auto_walk",
                "自动漫步",
                true,
                startup_settings.auto_walk,
                None::<&str>,
            )?;
            let gaze_tracking = CheckMenuItem::with_id(
                app,
                "gaze_tracking",
                "鼠标视线追踪",
                true,
                startup_settings.gaze_tracking,
                None::<&str>,
            )?;
            let coordination_enabled = CheckMenuItem::with_id(
                app,
                "coordination_enabled",
                "三角色联动",
                true,
                startup_settings.coordination.enabled,
                None::<&str>,
            )?;
            let gather_pets =
                MenuItem::with_id(app, "gather_pets", "集合角色", true, None::<&str>)?;
            let disperse_pets =
                MenuItem::with_id(app, "disperse_pets", "散开角色", true, None::<&str>)?;
            let gather_here =
                MenuItem::with_id(app, "gather_here", "集合到这里", true, None::<&str>)?;
            app.manage(TraySettingsItems {
                airui: show_airui.clone(),
                nangong: show_nangong.clone(),
                qianxia: show_qianxia.clone(),
                always_on_top: always_on_top.clone(),
                auto_walk: auto_walk.clone(),
                gaze_tracking: gaze_tracking.clone(),
                coordination: coordination_enabled.clone(),
            });
            let pomodoro_open = MenuItem::with_id(app, "pomodoro_open", "番茄钟", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[
                    &show_pet,
                    &character_visibility_menu,
                    &always_on_top,
                    &auto_walk,
                    &gaze_tracking,
                    &coordination_enabled,
                    &gather_pets,
                    &disperse_pets,
                    &gather_here,
                    &show_settings,
                    &pomodoro_open,
                    &hide_pet,
                    &quit,
                ],
            )?;
            app.manage(PetContextMenu(menu.clone()));

            let mut tray = TrayIconBuilder::with_id("main-tray")
                .tooltip("妄想天使桌宠")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "show_all_pets" => {
                        let _ = update_all_pet_visibility(app, true);
                    }
                    "show_airui" => {
                        let checked = show_airui.is_checked().unwrap_or(true);
                        let _ = update_pet_instance(
                            app,
                            "airui",
                            PetSettingsPatch {
                                visible: Some(checked),
                                ..Default::default()
                            },
                        );
                    }
                    "show_nangong" => {
                        let checked = show_nangong.is_checked().unwrap_or(true);
                        let _ = update_pet_instance(
                            app,
                            "nangong",
                            PetSettingsPatch {
                                visible: Some(checked),
                                ..Default::default()
                            },
                        );
                    }
                    "show_qianxia" => {
                        let checked = show_qianxia.is_checked().unwrap_or(true);
                        let _ = update_pet_instance(
                            app,
                            "qianxia",
                            PetSettingsPatch {
                                visible: Some(checked),
                                ..Default::default()
                            },
                        );
                    }
                    "pomodoro_open" => pomodoro::request_show_window(app.clone()),
                    "show_settings" => request_settings_window(app.clone()),
                    "always_on_top" => {
                        let checked = always_on_top.is_checked().unwrap_or(true);
                        let _ = update_settings(
                            app,
                            AppSettingsPatch {
                                always_on_top: Some(checked),
                                ..Default::default()
                            },
                        );
                    }
                    "auto_walk" => {
                        let checked = auto_walk.is_checked().unwrap_or(true);
                        let _ = update_settings(
                            app,
                            AppSettingsPatch {
                                auto_walk: Some(checked),
                                ..Default::default()
                            },
                        );
                    }
                    "gaze_tracking" => {
                        let checked = gaze_tracking.is_checked().unwrap_or(true);
                        let _ = update_settings(
                            app,
                            AppSettingsPatch {
                                gaze_tracking: Some(checked),
                                ..Default::default()
                            },
                        );
                    }
                    "coordination_enabled" => {
                        let checked = coordination_enabled.is_checked().unwrap_or(true);
                        let coordination = read_settings(app)
                            .map(|settings| CoordinationSettings {
                                enabled: checked,
                                ..settings.coordination
                            })
                            .unwrap_or_else(|_| CoordinationSettings {
                                enabled: checked,
                                ..Default::default()
                            });
                        let _ = update_settings(
                            app,
                            AppSettingsPatch {
                                coordination: Some(coordination),
                                ..Default::default()
                            },
                        );
                    }
                    "gather_pets" => {
                        let manager = app.state::<CoordinationManager>();
                        if let Ok(settings) = read_settings(app) {
                            if settings.coordination.enabled {
                                let dispatch = manager.request_layout("gather", None);
                                emit_dispatch(app, dispatch);
                            }
                        }
                    }
                    "disperse_pets" => {
                        let manager = app.state::<CoordinationManager>();
                        if let Ok(settings) = read_settings(app) {
                            if settings.coordination.enabled {
                                let dispatch = manager.request_layout("disperse", None);
                                emit_dispatch(app, dispatch);
                            }
                        }
                    }
                    "gather_here" => {
                        let active = app
                            .try_state::<LastActivePet>()
                            .and_then(|state| state.0.lock().ok().and_then(|value| value.clone()));
                        let manager = app.state::<CoordinationManager>();
                        if let Ok(settings) = read_settings(app) {
                            if settings.coordination.enabled {
                                let dispatch = manager.request_layout("gather", active.as_deref());
                                emit_dispatch(app, dispatch);
                            }
                        }
                    }
                    "hide_all_pets" => {
                        let _ = update_all_pet_visibility(app, false);
                    }
                    "quit" => app.exit(0),
                    _ => {}
                });

            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit) {
                if let Some(manager) = app.try_state::<pomodoro::PomodoroManager>() { manager.checkpoint(); }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrates_single_pet_settings_to_three_instances() {
        let mut settings = AppSettings::default();
        settings.schema_version = 2;
        settings.selected_character = Some("nangong".into());
        settings.scale = Some(0.85);
        settings.last_placement = Some(SavedPlacement {
            x: 120,
            y: 240,
            monitor_name: Some("primary".into()),
        });

        let migrated = migrate_settings(settings);

        assert_eq!(migrated.schema_version, 6);
        assert!(!migrated.window_lift_enabled);
        assert!(!migrated.auto_window_lift_enabled);
        for id in PET_IDS {
            let pet = migrated.pets.get(id).expect("pet settings");
            assert!(pet.visible);
            assert!((pet.scale - 0.85).abs() < f64::EPSILON);
        }
        let placement = migrated
            .pets
            .nangong
            .last_placement
            .expect("legacy placement");
        assert_eq!((placement.x, placement.y), (120, 240));
        assert!(migrated.pets.airui.last_placement.is_none());
        assert!(migrated.pets.qianxia.last_placement.is_none());
        assert!(migrated.selected_character.is_none());
        assert!(migrated.scale.is_none());
        assert!(migrated.last_placement.is_none());
    }

    #[test]
    fn accepts_only_the_three_pet_window_labels() {
        assert_eq!(pet_id_from_window_label("pet-airui"), Some("airui"));
        assert_eq!(pet_id_from_window_label("pet-nangong"), Some("nangong"));
        assert_eq!(pet_id_from_window_label("pet-qianxia"), Some("qianxia"));
        assert_eq!(pet_id_from_window_label("main"), None);
        assert_eq!(pet_id_from_window_label("settings"), None);
    }

    #[test]
    fn migration_preserves_manual_lift_and_defaults_automatic_lift_off() {
        let old: AppSettings = serde_json::from_value(serde_json::json!({
            "schemaVersion": 5, "windowLiftEnabled": true, "debugMode": true
        }))
        .unwrap();
        let migrated = migrate_settings(old);
        assert!(migrated.window_lift_enabled);
        assert!(!migrated.auto_window_lift_enabled);
        assert!(migrated.debug_mode);
        assert_eq!(migrated.schema_version, 6);
    }

    #[test]
    fn automatic_lift_setting_round_trips_and_patches_independently() {
        let mut settings = AppSettings::default();
        let patch: AppSettingsPatch = serde_json::from_value(serde_json::json!({
            "autoWindowLiftEnabled": true
        }))
        .unwrap();
        patch.apply(&mut settings);
        assert!(!settings.window_lift_enabled);
        let encoded = serde_json::to_value(&settings).unwrap();
        assert_eq!(encoded["autoWindowLiftEnabled"], true);
        let restored = migrate_settings(serde_json::from_value(encoded).unwrap());
        assert!(restored.auto_window_lift_enabled);
        assert!(!restored.window_lift_enabled);
    }
}
