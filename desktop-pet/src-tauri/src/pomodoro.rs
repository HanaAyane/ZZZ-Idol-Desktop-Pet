//! Single authoritative timer, independent of every WebView and pet visibility.
use crate::pomodoro_audio::{AudioCommand, AudioService};
use std::{
    io::Write,
    path::PathBuf,
    sync::Mutex,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, Manager, WebviewWindow};

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Preferences {
    pub focus_minutes: u32,
    pub break_minutes: u32,
    pub default_rounds: u32,
    pub sound_enabled: bool,
    pub volume: u32,
}
impl Default for Preferences {
    fn default() -> Self {
        Self {
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
            version: 1,
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
        self.phase == "focus" || self.phase == "break"
    }
    fn restore(mut self) -> Result<Self, String> {
        self.preferences.validate()?;
        if self.version != 1
            || !matches!(
                self.phase.as_str(),
                "idle" | "focus" | "break" | "completed" | "stopped"
            )
            || !(1..=99).contains(&self.total_rounds)
            || self.completed_rounds > self.total_rounds
            || !(60_000..=10_800_000).contains(&self.focus_ms)
            || !(60_000..=3_600_000).contains(&self.break_ms)
            || self.remaining_ms > self.duration_ms
            || self.duration_ms > 10_800_000
            || (self.active()
                && (self.session_id.is_empty() || self.completed_rounds >= self.total_rounds))
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
        if !matches!(action, "start" | "preferences")
            && session != Some(s.session_id.as_str())
        {
            return Err("计时已更新，请重新操作。".into());
        }
        match action {
            "start" => {
                if s.active() {
                    return Err("当前已有计时，请先结束本组。".into());
                }
                let p = preferences.ok_or("缺少计时参数")?;
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
                s.duration_ms = s.focus_ms;
                s.remaining_ms = s.focus_ms;
                s.total_rounds = p.default_rounds;
                s.completed_rounds = 0;
                s.phase = "focus".into();
                s.paused = false;
                s.notice.clear();
                Ok(Some("start"))
            }
            "preferences" => {
                let p = preferences.ok_or("缺少设置")?;
                p.validate()?;
                if s.active()
                    && (p.focus_minutes != s.preferences.focus_minutes
                        || p.break_minutes != s.preferences.break_minutes
                        || p.default_rounds != s.preferences.default_rounds)
                {
                    return Err("计时中只能修改声音设置。".into());
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
            "add" if s.active() && s.total_rounds < 99 => {
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
            Ok(Some(sound)) => Some(*sound),
            _ => transition,
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
    let _creation = manager.window_creation.lock().map_err(|_| "番茄钟窗口创建锁不可用")?;
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
}
