use std::{
    fs::{self, File},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::{
    coordination::CoordinationManager, pet_window_label, read_settings, AppSettings, PET_IDS,
};

const REPORT_FORMAT_VERSION: u32 = 1;
const MAX_LOG_FILES: usize = 3;
const MAX_LOG_TAIL_BYTES: u64 = 64 * 1024;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticSummary {
    generated_at: u64,
    app_version: String,
    platform: String,
    architecture: String,
    process_id: u32,
    log_directory: String,
    log_file_count: usize,
    pet_window_count: usize,
    visible_pet_count: usize,
    single_instance_enabled: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticExportResult {
    pub report_path: String,
    pub log_directory: String,
    pub included_log_files: usize,
    pub bytes_written: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticWindow {
    label: String,
    exists: bool,
    visible: Option<bool>,
    focused: Option<bool>,
    x: Option<i32>,
    y: Option<i32>,
    width: Option<u32>,
    height: Option<u32>,
    scale_factor: Option<f64>,
    monitor_name: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticLogExcerpt {
    file_name: String,
    file_size: u64,
    truncated: bool,
    tail: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticReport {
    format_version: u32,
    generated_at: u64,
    app: Value,
    settings: Value,
    windows: Vec<DiagnosticWindow>,
    coordination: Option<Value>,
    logs: Vec<DiagnosticLogExcerpt>,
}

pub fn get_summary(app: &AppHandle) -> Result<DiagnosticSummary, String> {
    let log_directory = ensure_log_directory(app)?;
    let log_files = log_file_paths(&log_directory);
    let mut pet_window_count = 0;
    let mut visible_pet_count = 0;
    for id in PET_IDS {
        if let Some(window) = app.get_webview_window(&pet_window_label(id)) {
            pet_window_count += 1;
            if window.is_visible().unwrap_or(false) {
                visible_pet_count += 1;
            }
        }
    }
    Ok(DiagnosticSummary {
        generated_at: epoch_millis(),
        app_version: app.package_info().version.to_string(),
        platform: std::env::consts::OS.to_string(),
        architecture: std::env::consts::ARCH.to_string(),
        process_id: std::process::id(),
        log_directory: log_directory.to_string_lossy().into_owned(),
        log_file_count: log_files.len(),
        pet_window_count,
        visible_pet_count,
        single_instance_enabled: true,
    })
}

pub fn export_report(app: &AppHandle) -> Result<DiagnosticExportResult, String> {
    let log_directory = ensure_log_directory(app)?;
    let home_directory = app
        .path()
        .home_dir()
        .ok()
        .map(|path| path.to_string_lossy().into_owned());
    let settings = read_settings(app).unwrap_or_default();
    let logs = collect_log_excerpts(&log_directory, home_directory.as_deref());
    let coordination = app
        .try_state::<CoordinationManager>()
        .and_then(|manager| serde_json::to_value(manager.snapshot()).ok());
    let generated_at = epoch_millis();
    let report = DiagnosticReport {
        format_version: REPORT_FORMAT_VERSION,
        generated_at,
        app: json!({
            "name": app.package_info().name,
            "version": app.package_info().version.to_string(),
            "identifier": app.config().identifier,
            "platform": std::env::consts::OS,
            "architecture": std::env::consts::ARCH,
            "processId": std::process::id(),
            "singleInstanceEnabled": true,
        }),
        settings: settings_summary(&settings),
        windows: window_summaries(app),
        coordination,
        logs,
    };
    let bytes = serde_json::to_vec_pretty(&report).map_err(|error| error.to_string())?;
    let report_path = log_directory.join(format!("diagnostic-report-{generated_at}.json"));
    let mut file = File::create(&report_path).map_err(|error| error.to_string())?;
    file.write_all(&bytes).map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    Ok(DiagnosticExportResult {
        report_path: report_path.to_string_lossy().into_owned(),
        log_directory: log_directory.to_string_lossy().into_owned(),
        included_log_files: report.logs.len(),
        bytes_written: bytes.len(),
    })
}

fn ensure_log_directory(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_log_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory)
}

fn settings_summary(settings: &AppSettings) -> Value {
    let pet = |id: &str| {
        settings.pets.get(id).map(|pet| {
            json!({
                "visible": pet.visible,
                "scale": pet.scale,
                "hasSavedPlacement": pet.last_placement.is_some(),
            })
        })
    };
    json!({
        "schemaVersion": settings.schema_version,
        "pets": {
            "airui": pet("airui"),
            "nangong": pet("nangong"),
            "qianxia": pet("qianxia"),
        },
        "alwaysOnTop": settings.always_on_top,
        "autoWalk": settings.auto_walk,
        "walkFrequency": settings.walk_frequency,
        "movementSpeed": settings.movement_speed,
        "clickEnabled": settings.click_enabled,
        "doubleClickEnabled": settings.double_click_enabled,
        "hoverEnabled": settings.hover_enabled,
        "gazeTracking": settings.gaze_tracking,
        "windowLiftEnabled": settings.window_lift_enabled,
        "autoWindowLiftEnabled": settings.auto_window_lift_enabled,
        "performanceMode": settings.performance_mode,
        "frameRate": settings.frame_rate,
        "debugMode": settings.debug_mode,
        "launchAtLogin": settings.launch_at_login,
        "coordination": {
            "enabled": settings.coordination.enabled,
            "partnerGaze": settings.coordination.partner_gaze,
            "reactionEcho": settings.coordination.reaction_echo,
            "automaticScenes": settings.coordination.automatic_scenes,
        },
    })
}

fn window_summaries(app: &AppHandle) -> Vec<DiagnosticWindow> {
    let mut labels = PET_IDS
        .into_iter()
        .map(pet_window_label)
        .collect::<Vec<_>>();
    labels.push("settings".into());
    labels
        .into_iter()
        .map(|label| {
            let Some(window) = app.get_webview_window(&label) else {
                return DiagnosticWindow {
                    label,
                    exists: false,
                    visible: None,
                    focused: None,
                    x: None,
                    y: None,
                    width: None,
                    height: None,
                    scale_factor: None,
                    monitor_name: None,
                };
            };
            let position = window.outer_position().ok();
            let size = window.outer_size().ok();
            let monitor_name = window
                .current_monitor()
                .ok()
                .flatten()
                .and_then(|monitor| monitor.name().cloned());
            DiagnosticWindow {
                label,
                exists: true,
                visible: window.is_visible().ok(),
                focused: window.is_focused().ok(),
                x: position.map(|value| value.x),
                y: position.map(|value| value.y),
                width: size.map(|value| value.width),
                height: size.map(|value| value.height),
                scale_factor: window.scale_factor().ok(),
                monitor_name,
            }
        })
        .collect()
}

fn log_file_paths(directory: &Path) -> Vec<PathBuf> {
    let mut files = fs::read_dir(directory)
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("log"))
        .collect::<Vec<_>>();
    files.sort_by_key(|path| {
        std::cmp::Reverse(
            path.metadata()
                .and_then(|metadata| metadata.modified())
                .ok()
                .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis())
                .unwrap_or_default(),
        )
    });
    files
}

fn collect_log_excerpts(
    directory: &Path,
    home_directory: Option<&str>,
) -> Vec<DiagnosticLogExcerpt> {
    log_file_paths(directory)
        .into_iter()
        .take(MAX_LOG_FILES)
        .filter_map(|path| read_log_excerpt(&path, home_directory).ok())
        .collect()
}

fn read_log_excerpt(
    path: &Path,
    home_directory: Option<&str>,
) -> Result<DiagnosticLogExcerpt, String> {
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let file_size = file.metadata().map_err(|error| error.to_string())?.len();
    let start = file_size.saturating_sub(MAX_LOG_TAIL_BYTES);
    file.seek(SeekFrom::Start(start))
        .map_err(|error| error.to_string())?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    let mut tail = String::from_utf8_lossy(&bytes).into_owned();
    if let Some(home) = home_directory.filter(|value| !value.is_empty()) {
        tail = tail.replace(home, "<home>");
    }
    if start > 0 {
        tail.insert_str(0, "[earlier log content omitted]\n");
    }
    Ok(DiagnosticLogExcerpt {
        file_name: path
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_else(|| "application.log".into()),
        file_size,
        truncated: start > 0,
        tail,
    })
}

fn epoch_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}
