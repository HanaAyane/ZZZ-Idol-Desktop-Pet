//! Single authoritative timer, independent of every WebView and pet visibility.
use crate::pomodoro_audio::{AudioCommand, AudioService};
use std::{
    io::Write,
    path::PathBuf,
    sync::Mutex,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, Manager, WebviewWindow};

const MAX_CUSTOM_MINUTES: u32 = 720;
const MAX_REMINDERS: usize = 64;

#[derive(Clone, Copy, Debug, Default, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum TimerMode {
    #[default]
    Pomodoro,
    Custom,
}

fn validate_reminders(total: u32, reminders: &[u32]) -> Result<(), String> {
    if !(1..=MAX_CUSTOM_MINUTES).contains(&total) {
        return Err("总时长须为 1～720 分钟。".into());
    }
    if reminders.len() > MAX_REMINDERS {
        return Err("最多设置 64 个提醒时间点。".into());
    }
    if reminders.iter().any(|&m| m == 0 || m >= total) {
        return Err("提醒须为大于 0 且小于总时长的整数分钟；结束时会自动提醒。".into());
    }
    if reminders.windows(2).any(|w| w[0] >= w[1]) {
        return Err("提醒时间点不可重复，且须按时间排序。".into());
    }
    Ok(())
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Preferences {
    pub mode: TimerMode,
    pub custom_minutes: u32,
    pub reminder_minutes: Vec<u32>,
    pub focus_minutes: u32,
    pub break_minutes: u32,
    pub default_rounds: u32,
    pub sound_enabled: bool,
    pub volume: u32,
}
impl Default for Preferences {
    fn default() -> Self {
        Self {
            mode: TimerMode::Pomodoro,
            custom_minutes: 120,
            reminder_minutes: vec![25, 45],
            focus_minutes: 25,
            break_minutes: 5,
            default_rounds: 2,
            sound_enabled: true,
            volume: 60,
        }
    }
}
impl Preferences {
    pub fn validate(&self) -> Result<(), String> {
        validate_reminders(self.custom_minutes, &self.reminder_minutes)?;
        if !(1..=180).contains(&self.focus_minutes)
            || !(1..=60).contains(&self.break_minutes)
            || !(1..=99).contains(&self.default_rounds)
            || self.volume > 100
        {
            Err("专注须为 1～180 分钟，休息为 1～60 分钟，个数为 1～99，音量为 0～100。".into())
        } else {
            Ok(())
        }
    }
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Snapshot {
    pub version: u32,
    pub mode: TimerMode,
    pub reminder_minutes: Vec<u32>,
    pub next_reminder_index: usize,
    pub session_id: String,
    pub revision: u64,
    pub phase: String,
    pub paused: bool,
    pub remaining_ms: u64,
    pub duration_ms: u64,
    pub completed_rounds: u32,
    pub total_rounds: u32,
    pub focus_ms: u64,
    pub break_ms: u64,
    pub preferences: Preferences,
    pub notice: String,
    pub window_visible: bool,
    pub window_x: Option<i32>,
    pub window_y: Option<i32>,
    pub persistence_error: Option<String>,
    pub audio_error: Option<String>,
}
impl Default for Snapshot {
    fn default() -> Self {
        Self {
            version: 2,
            mode: TimerMode::Pomodoro,
            reminder_minutes: Vec::new(),
            next_reminder_index: 0,
            session_id: String::new(),
            revision: 0,
            phase: "idle".into(),
            paused: false,
            remaining_ms: 1_500_000,
            duration_ms: 1_500_000,
            completed_rounds: 0,
            total_rounds: 2,
            focus_ms: 1_500_000,
            break_ms: 300_000,
            preferences: Preferences::default(),
            notice: String::new(),
            window_visible: false,
            window_x: None,
            window_y: None,
            persistence_error: None,
            audio_error: None,
        }
    }
}
impl Snapshot {
    fn active(&self) -> bool {
        matches!(self.phase.as_str(), "focus" | "break" | "custom")
    }
    fn restore(mut self) -> Result<Self, String> {
        // v1 has no custom timer fields. Preserve its Pomodoro progress.
        if self.version == 1 {
            self.mode = TimerMode::Pomodoro;
            self.reminder_minutes.clear();
            self.next_reminder_index = 0;
            self.version = 2;
        }
        self.preferences.validate()?;
        if self.version != 2
            || !matches!(
                self.phase.as_str(),
                "idle" | "focus" | "break" | "custom" | "completed" | "stopped"
            )
            || !(1..=99).contains(&self.total_rounds)
            || self.completed_rounds > self.total_rounds
            || !(60_000..=10_800_000).contains(&self.focus_ms)
            || !(60_000..=3_600_000).contains(&self.break_ms)
            || self.remaining_ms > self.duration_ms
            || self.duration_ms > MAX_CUSTOM_MINUTES as u64 * 60_000
            || (self.active()
                && (self.session_id.is_empty() || self.completed_rounds >= self.total_rounds))
        {
            return Err("番茄钟进度格式无效".into());
        }
        if self.mode == TimerMode::Custom {
            if self.duration_ms % 60_000 != 0
                || matches!(self.phase.as_str(), "focus" | "break")
                || self.next_reminder_index > self.reminder_minutes.len()
            {
                return Err("自定义计时进度格式无效".into());
            }
            validate_reminders((self.duration_ms / 60_000) as u32, &self.reminder_minutes)?;
            let elapsed_ms = self.duration_ms - self.remaining_ms;
            let due_count = self
                .reminder_minutes
                .iter()
                .take_while(|&&m| m as u64 * 60_000 <= elapsed_ms)
                .count();
            if self.next_reminder_index != due_count {
                return Err("自定义计时提醒进度无效".into());
            }
        } else if self.phase == "custom"
            || self.duration_ms > 10_800_000
            || !self.reminder_minutes.is_empty()
            || self.next_reminder_index != 0
        {
            return Err("番茄钟进度格式无效".into());
        }
        if self.active() {
            self.paused = true;
            self.notice = "已恢复上次进度，点击继续。".into();
        }
        self.window_visible = false;
        self.revision = 0;
        self.audio_error = None;
        self.persistence_error = None;
        Ok(self)
    }
}
struct ClockState {
    snapshot: Snapshot,
    last_tick: Instant,
    last_wall: SystemTime,
    carry: Duration,
}
impl ClockState {
    fn new(snapshot: Snapshot) -> Self {
        Self {
            snapshot,
            last_tick: Instant::now(),
            last_wall: SystemTime::now(),
            carry: Duration::ZERO,
        }
    }
    /// No per-second subtraction: account for the measured monotonic duration.
    fn advance(&mut self, elapsed: Duration, gap: bool) -> Option<&'static str> {
        let s = &mut self.snapshot;
        if !s.active() || s.paused {
            return None;
        }
        if gap {
            s.paused = true;
            s.notice = "检测到休眠或计时中断，已暂停，请确认后继续。".into();
            return Some("stop");
        }
        let precise = elapsed + self.carry;
        let elapsed_ms = precise.as_millis().min(u64::MAX as u128) as u64;
        self.carry = precise - Duration::from_millis(elapsed_ms);
        if s.mode == TimerMode::Custom {
            s.remaining_ms = s.remaining_ms.saturating_sub(elapsed_ms);
            let used_ms = s.duration_ms - s.remaining_ms;
            let previous_index = s.next_reminder_index;
            while s
                .reminder_minutes
                .get(s.next_reminder_index)
                .is_some_and(|&m| m as u64 * 60_000 <= used_ms)
            {
                s.next_reminder_index += 1;
            }
            if s.remaining_ms == 0 {
                s.phase = "completed".into();
                s.notice = "计时结束，辛苦了！".into();
                return Some("complete");
            }
            if s.next_reminder_index != previous_index {
                // Crossing a boundary triggers once, even when a tick is slightly late.
                s.notice = format!(
                    "已用 {} 分钟，剩余 {} 分钟。",
                    used_ms / 60_000,
                    s.remaining_ms.div_ceil(60_000)
                );
                return Some("reminder");
            }
            if s.next_reminder_index > 0
                && used_ms - s.reminder_minutes[s.next_reminder_index - 1] as u64 * 60_000 >= 10_000
                && s.notice.starts_with("已用 ")
            {
                s.notice.clear();
            }
            return None;
        }
        if elapsed_ms < s.remaining_ms {
            s.remaining_ms -= elapsed_ms;
            return None;
        }
        s.notice.clear();
        if s.phase == "focus" {
            s.completed_rounds += 1;
            if s.completed_rounds == s.total_rounds {
                s.phase = "completed".into();
                s.remaining_ms = 0;
                return Some("complete");
            }
            s.phase = "break".into();
            s.remaining_ms = s.break_ms;
            s.duration_ms = s.break_ms;
            Some("break")
        } else {
            s.phase = "focus".into();
            s.remaining_ms = s.focus_ms;
            s.duration_ms = s.focus_ms;
            Some("resume")
        }
    }
    fn tick(&mut self) -> Option<&'static str> {
        let now = Instant::now();
        let wall = SystemTime::now();
        let elapsed = now.duration_since(self.last_tick);
        // SystemTime gap also detects macOS suspend where Instant may exclude sleep.
        let gap = elapsed > Duration::from_secs(5)
            || wall
                .duration_since(self.last_wall)
                .map_or(true, |d| d > Duration::from_secs(5));
        self.last_tick = now;
        self.last_wall = wall;
        self.advance(elapsed, gap)
    }
    fn action(
        &mut self,
        action: &str,
        session: Option<&str>,
        preferences: Option<Preferences>,
    ) -> Result<Option<&'static str>, String> {
        let s = &mut self.snapshot;
        if !matches!(action, "start" | "preferences") && session != Some(s.session_id.as_str()) {
            return Err("计时已更新，请重新操作。".into());
        }
        match action {
            "start" => {
                if s.active() {
                    return Err("当前已有计时，请先结束本组。".into());
                }
                let mut p = preferences.ok_or("缺少计时参数")?;
                p.reminder_minutes.sort_unstable();
                p.validate()?;
                s.preferences = p.clone();
                s.session_id = format!(
                    "{}-{}",
                    SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_nanos(),
                    s.revision
                );
                s.focus_ms = p.focus_minutes as u64 * 60_000;
                s.break_ms = p.break_minutes as u64 * 60_000;
                s.mode = p.mode;
                s.reminder_minutes = if p.mode == TimerMode::Custom {
                    p.reminder_minutes.clone()
                } else {
                    Vec::new()
                };
                s.next_reminder_index = 0;
                s.duration_ms = if p.mode == TimerMode::Custom {
                    p.custom_minutes as u64 * 60_000
                } else {
                    s.focus_ms
                };
                s.remaining_ms = s.duration_ms;
                s.total_rounds = p.default_rounds;
                s.completed_rounds = 0;
                s.phase = if p.mode == TimerMode::Custom {
                    "custom"
                } else {
                    "focus"
                }
                .into();
                s.paused = false;
                s.notice.clear();
                self.carry = Duration::ZERO;
                Ok(Some("start"))
            }
            "preferences" => {
                let mut p = preferences.ok_or("缺少设置")?;
                p.reminder_minutes.sort_unstable();
                p.validate()?;
                let timing_changed = p.focus_minutes != s.preferences.focus_minutes
                    || p.break_minutes != s.preferences.break_minutes
                    || p.default_rounds != s.preferences.default_rounds
                    || p.mode != s.preferences.mode
                    || p.custom_minutes != s.preferences.custom_minutes
                    || p.reminder_minutes != s.preferences.reminder_minutes;
                if s.active() && timing_changed {
                    return Err("计时中只能修改声音设置。".into());
                }
                if timing_changed {
                    s.phase = "idle".into();
                    s.paused = false;
                    s.mode = p.mode;
                    s.reminder_minutes = if p.mode == TimerMode::Custom {
                        p.reminder_minutes.clone()
                    } else {
                        Vec::new()
                    };
                    s.next_reminder_index = 0;
                    s.duration_ms = if p.mode == TimerMode::Custom {
                        p.custom_minutes as u64 * 60_000
                    } else {
                        p.focus_minutes as u64 * 60_000
                    };
                    s.remaining_ms = s.duration_ms;
                    s.completed_rounds = 0;
                    s.total_rounds = p.default_rounds;
                    s.notice.clear();
                }
                s.preferences = p;
                Ok(None)
            }
            "pause" if s.active() => {
                let sound = if s.paused { None } else { Some("pause") };
                s.paused = true;
                s.notice.clear();
                Ok(sound)
            }
            "resume" if s.active() => {
                s.paused = false;
                s.notice.clear();
                Ok(None)
            }
            "add" if s.active() && s.mode == TimerMode::Pomodoro && s.total_rounds < 99 => {
                s.total_rounds += 1;
                Ok(None)
            }
            "skip" if s.phase == "break" => {
                s.phase = "focus".into();
                s.remaining_ms = s.focus_ms;
                s.duration_ms = s.focus_ms;
                s.notice.clear();
                Ok(Some("stop"))
            }
            "stop" if s.active() => {
                s.phase = "stopped".into();
                s.paused = false;
                s.notice.clear();
                Ok(Some("stop"))
            }
            _ => Err("当前状态不支持此操作。".into()),
        }
    }
}
pub struct PomodoroManager {
    inner: Mutex<ClockState>,
    window_creation: Mutex<()>,
    path: PathBuf,
    audio: AudioService,
}
impl PomodoroManager {
    pub fn new(app: &tauri::AppHandle) -> Result<Self, String> {
        let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let path = dir.join("pomodoro-session.json");
        let mut snapshot = Snapshot::default();
        if path.exists() {
            match std::fs::read(&path)
                .map_err(|e| e.to_string())
                .and_then(|v| serde_json::from_slice::<Snapshot>(&v).map_err(|e| e.to_string()))
                .and_then(Snapshot::restore)
            {
                Ok(s) => snapshot = s,
                Err(e) => {
                    let backup = path.with_extension(format!(
                        "{}.corrupt",
                        SystemTime::now()
                            .duration_since(UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_millis()
                    ));
                    if let Err(error) = std::fs::copy(&path, backup) {
                        return Err(format!("进度备份失败：{error}"));
                    }
                    log::warn!(target: "desktop_pet::pomodoro", "session recovery: {e}");
                    snapshot.notice = "旧进度无法读取，已备份并重置。".into();
                }
            }
        }
        Ok(Self {
            inner: Mutex::new(ClockState::new(snapshot)),
            window_creation: Mutex::new(()),
            path,
            audio: AudioService::new(),
        })
    }
    fn save(&self, s: &mut Snapshot) {
        let result = (|| -> Result<(), String> {
            let bytes = serde_json::to_vec_pretty(s).map_err(|e| e.to_string())?;
            let mut file =
                atomic_write_file::AtomicWriteFile::open(&self.path).map_err(|e| e.to_string())?;
            file.write_all(&bytes).map_err(|e| e.to_string())?;
            file.commit().map_err(|e| e.to_string())
        })();
        let error = result
            .err()
            .map(|e| format!("进度保存失败，重启后可能无法恢复：{e}"));
        if error != s.persistence_error {
            if let Some(e) = &error {
                log::warn!(target: "desktop_pet::pomodoro", "{e}");
            }
        }
        s.persistence_error = error;
    }
    fn sound(&self, s: &Snapshot, event: Option<&'static str>) {
        if event == Some("stop") || !s.preferences.sound_enabled || s.preferences.volume == 0 {
            self.audio.send(AudioCommand::Stop);
        } else if let Some(sound) = event {
            self.audio.send(AudioCommand::Play(
                sound,
                s.preferences.volume as f32 / 100.0,
            ));
        } else {
            self.audio
                .send(AudioCommand::Volume(s.preferences.volume as f32 / 100.0));
        }
    }
    pub fn snapshot(&self) -> Snapshot {
        self.inner.lock().unwrap().snapshot.clone()
    }
    pub fn command(
        &self,
        app: &tauri::AppHandle,
        action: &str,
        session: Option<&str>,
        preferences: Option<Preferences>,
    ) -> Result<Snapshot, String> {
        let mut state = self.inner.lock().map_err(|_| "计时锁不可用")?;
        let transition = state.tick();
        let result = state.action(action, session, preferences);
        // A rejected stale command must not erase a natural completion.
        let sound = match &result {
            Ok(Some(sound @ ("stop" | "start"))) => Some(*sound),
            Ok(sound) => transition.or(*sound),
            Err(_) => transition,
        };
        state.snapshot.revision += 1;
        self.sound(&state.snapshot, sound);
        self.save(&mut state.snapshot);
        let snapshot = state.snapshot.clone();
        drop(state);
        let _ = app.emit("pomodoro-state", &snapshot);
        log::info!(target: "desktop_pet::pomodoro", "command={action} phase={} rounds={}/{} revision={}", snapshot.phase, snapshot.completed_rounds, snapshot.total_rounds, snapshot.revision);
        result.map(|_| snapshot)
    }
    pub fn window_state(
        &self,
        app: &tauri::AppHandle,
        visible: bool,
        position: Option<tauri::PhysicalPosition<i32>>,
    ) {
        let mut state = self.inner.lock().unwrap();
        state.snapshot.window_visible = visible;
        if let Some(p) = position {
            state.snapshot.window_x = Some(p.x);
            state.snapshot.window_y = Some(p.y);
        }
        state.snapshot.revision += 1;
        self.save(&mut state.snapshot);
        let snapshot = state.snapshot.clone();
        drop(state);
        let _ = app.emit("pomodoro-state", snapshot);
    }
    pub fn checkpoint(&self) {
        let mut state = self.inner.lock().unwrap();
        state.tick();
        self.save(&mut state.snapshot);
        self.audio.send(AudioCommand::Stop);
    }
    pub fn spawn(app: tauri::AppHandle) {
        std::thread::spawn(move || {
            let mut checkpoint = Instant::now();
            let mut broadcast = Instant::now();
            loop {
                std::thread::sleep(Duration::from_millis(250));
                let manager = app.state::<Self>();
                let mut state = manager.inner.lock().unwrap();
                let event = state.tick();
                if let Some(event) = event {
                    manager.sound(&state.snapshot, Some(event));
                    log::info!(target: "desktop_pet::pomodoro", "transition={event} phase={} completed={}/{}", state.snapshot.phase, state.snapshot.completed_rounds, state.snapshot.total_rounds);
                }
                state.snapshot.audio_error = manager.audio.error.lock().unwrap().clone();
                if event.is_some()
                    || (state.snapshot.active()
                        && !state.snapshot.paused
                        && checkpoint.elapsed() >= Duration::from_secs(10))
                {
                    manager.save(&mut state.snapshot);
                    checkpoint = Instant::now();
                }
                state.snapshot.revision += 1;
                let snapshot = state.snapshot.clone();
                drop(state);
                if event.is_some() || broadcast.elapsed() >= Duration::from_secs(1) {
                    if app.get_webview_window("pomodoro").is_some()
                        || app.get_webview_window("settings").is_some()
                    {
                        let _ = app.emit("pomodoro-state", snapshot);
                    }
                    broadcast = Instant::now();
                }
            }
        });
    }
}
fn require_controller(window: &WebviewWindow) -> Result<(), String> {
    if matches!(window.label(), "settings" | "pomodoro") {
        Ok(())
    } else {
        Err("此窗口不可控制番茄钟".into())
    }
}
#[tauri::command]
pub fn get_pomodoro_state(
    window: WebviewWindow,
    app: tauri::AppHandle,
) -> Result<Snapshot, String> {
    require_controller(&window)?;
    Ok(app.state::<PomodoroManager>().snapshot())
}
#[tauri::command]
pub fn pomodoro_action(
    window: WebviewWindow,
    app: tauri::AppHandle,
    action: String,
    session_id: Option<String>,
    preferences: Option<Preferences>,
) -> Result<Snapshot, String> {
    require_controller(&window)?;
    app.state::<PomodoroManager>()
        .command(&app, &action, session_id.as_deref(), preferences)
}
#[tauri::command]
pub async fn set_pomodoro_visible(
    window: WebviewWindow,
    app: tauri::AppHandle,
    visible: bool,
) -> Result<(), String> {
    require_controller(&window)?;
    if visible {
        show_window(app).await
    } else {
        close_window(&app)
    }
}
pub fn close_window(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("pomodoro") {
        w.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}
pub fn request_show_window(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        if let Err(error) = show_window(app).await {
            log::error!(target: "desktop_pet::pomodoro", "window open failed: {error}");
        }
    });
}

async fn show_window(app: tauri::AppHandle) -> Result<(), String> {
    // WebView2 creation must not block the Windows command or menu event callback.
    tauri::async_runtime::spawn_blocking(move || create_or_show_window(&app))
        .await
        .map_err(|error| error.to_string())?
}

fn create_or_show_window(app: &tauri::AppHandle) -> Result<(), String> {
    let manager = app.state::<PomodoroManager>();
    // Serialize creation without holding the timer state lock: the new WebView
    // and its window events can read that state while building.
    let _creation = manager
        .window_creation
        .lock()
        .map_err(|_| "番茄钟窗口创建锁不可用")?;
    if let Some(w) = app.get_webview_window("pomodoro") {
        w.show().map_err(|e| e.to_string())?;
        w.set_focus().map_err(|e| e.to_string())?;
        log::info!(target: "desktop_pet::pomodoro", "existing window focused");
        return Ok(());
    }
    let saved = manager.snapshot();
    log::info!(target: "desktop_pet::pomodoro", "creating window");
    let w = tauri::WebviewWindowBuilder::new(
        app,
        "pomodoro",
        tauri::WebviewUrl::App("index.html?window=pomodoro".into()),
    )
    .title("妄想天使 · 番茄钟")
    .inner_size(440.0, 440.0)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .center()
    .build()
    .map_err(|e| e.to_string())?;
    if let (Some(x), Some(y)) = (saved.window_x, saved.window_y) {
        let size = w.outer_size().map_err(|e| e.to_string())?;
        if w.available_monitors()
            .map_err(|e| e.to_string())?
            .iter()
            .any(|m| {
                let a = m.work_area();
                x >= a.position.x
                    && y >= a.position.y
                    && x as i64 + size.width as i64 <= a.position.x as i64 + a.size.width as i64
                    && y as i64 + size.height as i64 <= a.position.y as i64 + a.size.height as i64
            })
        {
            w.set_position(tauri::PhysicalPosition::new(x, y))
                .map_err(|e| e.to_string())?;
        }
    }
    let handle = app.clone();
    let tracked = w.clone();
    w.on_window_event(move |event| match event {
        tauri::WindowEvent::CloseRequested { .. } => handle
            .state::<PomodoroManager>()
            .window_state(&handle, false, tracked.outer_position().ok()),
        tauri::WindowEvent::Moved(position) => {
            let manager = handle.state::<PomodoroManager>();
            let mut state = manager.inner.lock().unwrap();
            state.snapshot.window_x = Some(position.x);
            state.snapshot.window_y = Some(position.y);
        }
        tauri::WindowEvent::Destroyed => handle
            .state::<PomodoroManager>()
            .window_state(&handle, false, None),
        _ => {}
    });
    app.state::<PomodoroManager>().window_state(app, true, None);
    log::info!(target: "desktop_pet::pomodoro", "window ready");
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    fn started(rounds: u32) -> ClockState {
        let mut state = ClockState::new(Snapshot::default());
        state
            .action(
                "start",
                None,
                Some(Preferences {
                    default_rounds: rounds,
                    ..Default::default()
                }),
            )
            .unwrap();
        state
    }
    fn command(s: &mut ClockState, action: &str) {
        let id = s.snapshot.session_id.clone();
        s.action(action, Some(&id), None).unwrap();
    }
    #[test]
    fn one_round_has_no_break_and_completes_once() {
        let mut s = started(1);
        assert_eq!(
            s.advance(Duration::from_secs(1500), false),
            Some("complete")
        );
        assert_eq!(s.snapshot.completed_rounds, 1);
        assert_eq!(s.advance(Duration::from_secs(1500), false), None);
    }
    #[test]
    fn n_rounds_have_exactly_n_minus_one_breaks() {
        let mut s = started(4);
        for n in 1..=4 {
            assert_eq!(
                s.advance(Duration::from_secs(1500), false),
                Some(if n == 4 { "complete" } else { "break" })
            );
            assert_eq!(s.snapshot.completed_rounds, n);
            if n < 4 {
                assert_eq!(s.advance(Duration::from_secs(300), false), Some("resume"));
            }
        }
    }
    #[test]
    fn pause_sound_only_plays_when_entering_pause() {
        for phase in ["focus", "break"] {
            let mut s = started(2);
            s.snapshot.phase = phase.into();
            let id = s.snapshot.session_id.clone();
            assert_eq!(s.action("pause", Some(&id), None).unwrap(), Some("pause"));
            assert!(s.snapshot.paused);
            assert_eq!(s.action("pause", Some(&id), None).unwrap(), None);
        }
    }
    #[test]
    fn add_during_last_focus_and_pause_does_not_reset_time() {
        let mut s = started(1);
        s.advance(Duration::from_secs(100), false);
        command(&mut s, "pause");
        command(&mut s, "add");
        s.advance(Duration::from_secs(500), false);
        assert_eq!(s.snapshot.remaining_ms, 1_400_000);
        assert!(s.snapshot.paused);
        command(&mut s, "resume");
        assert_eq!(s.advance(Duration::from_secs(1400), false), Some("break"));
    }
    #[test]
    fn skip_paused_break_keeps_pause_and_completion_count() {
        let mut s = started(2);
        s.advance(Duration::from_secs(1500), false);
        command(&mut s, "pause");
        command(&mut s, "skip");
        assert_eq!(s.snapshot.phase, "focus");
        assert!(s.snapshot.paused);
        assert_eq!(s.snapshot.completed_rounds, 1);
    }
    #[test]
    fn long_gap_pauses_without_completing_and_stale_commands_are_rejected() {
        let mut s = started(2);
        s.advance(Duration::from_secs(9999), true);
        assert!(s.snapshot.paused);
        assert_eq!(s.snapshot.completed_rounds, 0);
        assert!(s.action("add", Some("old"), None).is_err());
        command(&mut s, "stop");
        assert_eq!(s.snapshot.completed_rounds, 0);
    }
    #[test]
    fn restore_freezes_session_and_rejects_invalid_data() {
        let s = started(2).snapshot.restore().unwrap();
        assert!(s.paused);
        assert!(!s.window_visible);
        let mut bad = s;
        bad.total_rounds = 0;
        assert!(bad.restore().is_err());
    }
    #[test]
    fn completed_session_rejects_add_and_active_session_rejects_restart() {
        let mut s = started(1);
        assert!(s
            .action("start", None, Some(Preferences::default()))
            .is_err());
        s.advance(Duration::from_secs(1500), false);
        let id = s.snapshot.session_id.clone();
        assert!(s.action("add", Some(&id), None).is_err());
    }
    #[test]
    fn round_cap_and_parameter_bounds_are_enforced() {
        let mut s = started(99);
        let id = s.snapshot.session_id.clone();
        assert!(s.action("add", Some(&id), None).is_err());
        assert!(Preferences {
            volume: 101,
            ..Default::default()
        }
        .validate()
        .is_err());
        assert!(Preferences {
            focus_minutes: 0,
            ..Default::default()
        }
        .validate()
        .is_err());
    }
    fn custom_started(total: u32, reminders: Vec<u32>) -> ClockState {
        let mut s = ClockState::new(Snapshot::default());
        s.action(
            "start",
            None,
            Some(Preferences {
                mode: TimerMode::Custom,
                custom_minutes: total,
                reminder_minutes: reminders,
                ..Default::default()
            }),
        )
        .unwrap();
        s
    }
    #[test]
    fn custom_crosses_unequal_reminders_once_without_interrupting_countdown() {
        let mut s = custom_started(120, vec![45, 25]);
        assert_eq!(s.snapshot.reminder_minutes, vec![25, 45]);
        assert_eq!(s.advance(Duration::from_millis(1_499_900), false), None);
        assert_eq!(
            s.advance(Duration::from_millis(300), false),
            Some("reminder")
        );
        assert_eq!(s.snapshot.next_reminder_index, 1);
        assert_eq!(s.snapshot.phase, "custom");
        assert!(!s.snapshot.paused);
        assert_eq!(s.snapshot.remaining_ms, 5_699_800);
        assert_eq!(s.advance(Duration::from_millis(250), false), None);
        assert_eq!(
            s.advance(Duration::from_millis(1_199_550), false),
            Some("reminder")
        );
        assert_eq!(s.snapshot.next_reminder_index, 2);
        assert_eq!(s.snapshot.remaining_ms, 75 * 60_000);
        assert_eq!(s.advance(Duration::from_secs(1), false), None);
    }
    #[test]
    fn custom_pause_resume_shifts_reminders_by_the_pause_duration() {
        let mut s = custom_started(120, vec![25, 45]);
        s.advance(Duration::from_secs(24 * 60), false);
        command(&mut s, "pause");
        let remaining = s.snapshot.remaining_ms;
        assert_eq!(s.advance(Duration::from_secs(30 * 60), false), None);
        assert_eq!(s.snapshot.remaining_ms, remaining);
        assert_eq!(s.snapshot.next_reminder_index, 0);
        command(&mut s, "resume");
        assert_eq!(s.advance(Duration::from_secs(59), false), None);
        assert_eq!(s.advance(Duration::from_secs(1), false), Some("reminder"));
    }
    #[test]
    fn custom_restores_paused_without_replaying_fired_reminders() {
        let mut s = custom_started(120, vec![25, 45]);
        s.advance(Duration::from_secs(25 * 60), false);
        let json = serde_json::to_string(&s.snapshot).unwrap();
        let restored = serde_json::from_str::<Snapshot>(&json)
            .unwrap()
            .restore()
            .unwrap();
        let mut s = ClockState::new(restored);
        assert!(s.snapshot.paused);
        assert_eq!(s.snapshot.next_reminder_index, 1);
        assert_eq!(s.advance(Duration::from_secs(99_999), false), None);
        command(&mut s, "resume");
        assert_eq!(s.advance(Duration::from_secs(1), false), None);
        assert_eq!(
            s.advance(Duration::from_secs(20 * 60 - 1), false),
            Some("reminder")
        );
        assert_eq!(s.snapshot.next_reminder_index, 2);
    }
    #[test]
    fn custom_sleep_does_not_consume_or_replay_reminders() {
        let mut s = custom_started(120, vec![25, 45]);
        s.advance(Duration::from_secs(24 * 60), false);
        let remaining = s.snapshot.remaining_ms;
        assert_eq!(s.advance(Duration::from_secs(3600), true), Some("stop"));
        assert!(s.snapshot.paused);
        assert_eq!(s.snapshot.remaining_ms, remaining);
        assert_eq!(s.snapshot.next_reminder_index, 0);
        command(&mut s, "resume");
        assert_eq!(s.advance(Duration::from_secs(60), false), Some("reminder"));
    }
    #[test]
    fn custom_completion_is_single_and_no_reminders_is_valid() {
        for reminders in [vec![], vec![1, 3]] {
            let mut s = custom_started(4, reminders);
            assert_eq!(s.advance(Duration::from_secs(240), false), Some("complete"));
            assert_eq!(s.snapshot.phase, "completed");
            assert_eq!(s.snapshot.remaining_ms, 0);
            assert_eq!(
                s.snapshot.next_reminder_index,
                s.snapshot.reminder_minutes.len()
            );
            assert_eq!(s.advance(Duration::from_secs(1), false), None);
            assert!(s.snapshot.clone().restore().is_ok());
        }
    }
    #[test]
    fn custom_settings_are_frozen_until_stopped_but_sound_can_change() {
        let mut s = custom_started(120, vec![25, 45]);
        command(&mut s, "pause");
        let id = s.snapshot.session_id.clone();
        let original = s.snapshot.preferences.clone();
        for changed in [
            Preferences {
                custom_minutes: 121,
                ..original.clone()
            },
            Preferences {
                reminder_minutes: vec![30],
                ..original.clone()
            },
            Preferences {
                mode: TimerMode::Pomodoro,
                ..original.clone()
            },
        ] {
            assert!(s.action("preferences", Some(&id), Some(changed)).is_err());
        }
        assert!(s.action("add", Some(&id), None).is_err());
        assert!(s.action("skip", Some(&id), None).is_err());
        assert!(s.action("start", None, Some(original.clone())).is_err());
        let quiet = Preferences {
            sound_enabled: false,
            volume: 20,
            ..original.clone()
        };
        s.action("preferences", Some(&id), Some(quiet)).unwrap();
        assert_eq!(s.snapshot.remaining_ms, 120 * 60_000);
        command(&mut s, "stop");
        assert_eq!(s.advance(Duration::from_secs(3600), false), None);
        s.action("start", None, Some(original)).unwrap();
        assert_eq!(s.snapshot.next_reminder_index, 0);
        assert_ne!(s.snapshot.session_id, id);
        assert!(s.action("pause", Some(&id), None).is_err());
    }
    #[test]
    fn custom_rejects_duplicate_out_of_range_and_invalid_saved_cursor() {
        for reminders in [vec![0], vec![120], vec![121], vec![25, 25]] {
            let mut s = ClockState::new(Snapshot::default());
            assert!(s
                .action(
                    "start",
                    None,
                    Some(Preferences {
                        mode: TimerMode::Custom,
                        reminder_minutes: reminders,
                        ..Default::default()
                    })
                )
                .is_err());
        }
        let mut s = custom_started(720, vec![719]);
        assert!(s.snapshot.clone().restore().is_ok());
        s.snapshot.next_reminder_index = 1;
        assert!(s.snapshot.restore().is_err());
        assert!(validate_reminders(721, &[]).is_err());
        assert!(validate_reminders(720, &(1..=65).collect::<Vec<_>>()).is_err());
    }
    #[test]
    fn legacy_v1_json_preserves_pomodoro_progress_and_defaults_to_old_mode() {
        let mut old = serde_json::to_value(started(2).snapshot).unwrap();
        old["version"] = 1.into();
        old["remainingMs"] = 123_456.into();
        for field in ["mode", "reminderMinutes", "nextReminderIndex"] {
            old.as_object_mut().unwrap().remove(field);
        }
        for field in ["mode", "customMinutes", "reminderMinutes"] {
            old["preferences"].as_object_mut().unwrap().remove(field);
        }
        let s = serde_json::from_value::<Snapshot>(old)
            .unwrap()
            .restore()
            .unwrap();
        assert_eq!(s.version, 2);
        assert_eq!(s.mode, TimerMode::Pomodoro);
        assert_eq!(s.preferences.mode, TimerMode::Pomodoro);
        assert_eq!(s.remaining_ms, 123_456);
        assert!(s.paused);
        assert_eq!(s.total_rounds, 2);
        assert!(s.reminder_minutes.is_empty());
    }
    #[test]
    fn custom_notice_expires_and_mode_change_returns_to_ready() {
        let mut s = custom_started(120, vec![25]);
        s.advance(Duration::from_secs(25 * 60), false);
        assert!(s.snapshot.notice.starts_with("已用 "));
        s.advance(Duration::from_secs(10), false);
        assert!(s.snapshot.notice.is_empty());
        command(&mut s, "stop");
        s.action("preferences", None, Some(Preferences::default()))
            .unwrap();
        assert_eq!(s.snapshot.phase, "idle");
        assert_eq!(s.snapshot.mode, TimerMode::Pomodoro);
        assert_eq!(s.snapshot.remaining_ms, 25 * 60_000);
        assert!(s.snapshot.restore().is_ok());
    }
}
