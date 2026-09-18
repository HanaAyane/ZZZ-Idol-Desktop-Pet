import type { UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { action, getState, native, setVisible, subscribe } from "./client";
import { formatTime, isActive, phaseLabel, plannedMinutes, validPreferences, type PomodoroSnapshot, type Preferences } from "./model";
import "./pomodoro.css";
const background = new URL("../assets/pomodoro-window.png", import.meta.url).href;

export class PomodoroApp {
  private snapshot: PomodoroSnapshot | null = null;
  private unlisten?: UnlistenFn;
  private disposed = false;
  private busy = false;
  private dirty = false;
  private soundPage = false;
  private confirmStop = false;
  private localError = "";
  private preferenceQueue: Promise<void> = Promise.resolve();
  private draftRevision = 0;
  constructor(private readonly root: HTMLElement) {
    root.innerHTML = `
      <main class="pomodoro-shell" aria-label="番茄钟">
        <img class="pomodoro-frame" src="${background}" alt="" draggable="false">
        <div class="pomodoro-drag" title="拖动番茄钟窗口" aria-hidden="true"></div>
        <section class="pomodoro-screen">
          <header class="pomodoro-header"><span>FOCUS WITH ANGELS</span></header>
          <div class="pomodoro-phase"><span data-phase role="status">准备专注</span><span data-rounds></span></div>
          <div data-main>
            <div class="pomodoro-time" data-time aria-label="剩余时间">25:00</div>
            <progress data-progress max="1" value="0" aria-label="本阶段进度"></progress>
            <div class="pomodoro-inputs" data-inputs>
              <label>番茄个数<input data-pref="defaultRounds" type="number" min="1" max="99" step="1" value="2"></label>
              <label>专注 / 分<input data-pref="focusMinutes" type="number" min="1" max="180" step="1" value="25"></label>
              <label>休息 / 分<input data-pref="breakMinutes" type="number" min="1" max="60" step="1" value="5"></label>
            </div>
            <p class="pomodoro-summary" data-summary>2 个番茄钟 · 预计 55 分钟</p>
            <div class="pomodoro-actions">
              <button class="pomodoro-primary" data-command="primary">开始专注</button>
              <button data-command="add" hidden>+1 个</button>
              <button data-command="skip" hidden>跳过休息</button>
              <button data-command="stop" hidden>结束</button>
            </div>
            <div class="pomodoro-confirm" data-confirm hidden><span>结束本组计时？</span><button data-command="confirm">结束</button><button data-command="cancel">返回</button></div>
          </div>
          <div class="pomodoro-sounds" data-sounds hidden>
            <label class="pomodoro-sound-toggle"><span>声音提醒</span><input data-pref="soundEnabled" type="checkbox" checked></label>
            <label class="pomodoro-volume">音量 <output data-volume>60%</output><input data-pref="volume" type="range" min="0" max="100" value="60"></label>
          </div>
          <p class="pomodoro-notice" data-notice role="status"></p>
        </section>
        <footer class="pomodoro-footer"><button data-command="sounds">声音设置</button><span>桌面置顶 · 专注陪伴</span><button data-command="close" title="关闭番茄钟窗口，计时继续">关闭</button></footer>
      </main>`;
    root.querySelector(".pomodoro-drag")!.addEventListener("pointerdown", event => {
      if ((event as PointerEvent).button === 0 && native()) void getCurrentWindow().startDragging().catch(e => this.error(e));
    });
    root.querySelectorAll<HTMLButtonElement>("[data-command]").forEach(button => button.addEventListener("click", () => void this.command(button.dataset.command!)));
    root.querySelectorAll<HTMLInputElement>("[data-pref]").forEach(input => {
      input.addEventListener("input", () => { this.dirty = true; this.draftRevision += 1; this.localError = ""; this.updateDraft(); });
      input.addEventListener("change", () => void this.savePreferences());
    });
  }
  async mount(): Promise<void> {
    if (!native()) { this.error("界面预览：请在桌宠应用中开始计时。"); return; }
    try {
      const unlisten = await subscribe(s => this.render(s));
      if (this.disposed) { unlisten(); return; }
      this.unlisten = unlisten;
      this.render(await getState());
    } catch (e) { this.error(e); }
  }
  dispose(): void { this.disposed = true; this.unlisten?.(); }
  private element<T extends HTMLElement = HTMLElement>(selector: string): T { return this.root.querySelector<T>(selector)!; }
  private preferences(): Preferences {
    const input = (key: string) => this.element<HTMLInputElement>(`[data-pref="${key}"]`);
    return { defaultRounds: input("defaultRounds").valueAsNumber, focusMinutes: input("focusMinutes").valueAsNumber,
      breakMinutes: input("breakMinutes").valueAsNumber, soundEnabled: input("soundEnabled").checked, volume: input("volume").valueAsNumber };
  }
  private updateDraft(): void {
    const p = this.preferences();
    this.element("[data-volume]").textContent = `${p.volume}%`;
    if (!this.snapshot || !isActive(this.snapshot)) {
      this.element("[data-summary]").textContent = validPreferences(p) ? `${p.defaultRounds} 个番茄钟 · 预计 ${plannedMinutes(p)} 分钟` : "请输入范围内的整数";
      this.element("[data-time]").textContent = validPreferences(p) ? formatTime(p.focusMinutes * 60_000) : "--:--";
    }
  }
  private savePreferences(): Promise<void> {
    const p = this.preferences();
    if (!validPreferences(p)) { this.error("个数 1～99，专注 1～180 分钟，休息 1～60 分钟。" ); return Promise.resolve(); }
    if (!native() || !this.snapshot) return Promise.resolve();
    const revision = this.draftRevision;
    this.preferenceQueue = this.preferenceQueue.then(async () => {
      if (this.disposed || !this.snapshot) return;
      try {
        const s = await action("preferences", this.snapshot.sessionId, p);
        if (revision === this.draftRevision) this.dirty = false;
        this.render(s);
      } catch (e) { this.error(e); }
    });
    return this.preferenceQueue;
  }
  private async command(command: string): Promise<void> {
    if (command === "close") {
      if (!native()) { this.error("界面预览：请在桌宠应用中关闭窗口。"); return; }
      try { await this.preferenceQueue; await setVisible(false); }
      catch (e) { this.error(e); }
      return;
    }
    if (command === "sounds") { this.soundPage = !this.soundPage; this.layout(); return; }
    if (command === "stop") { this.confirmStop = true; this.layout(); return; }
    if (command === "cancel") { this.confirmStop = false; this.layout(); return; }
    if (!this.snapshot || this.busy || !native()) return;
    let name = command;
    if (command === "primary") name = isActive(this.snapshot) ? (this.snapshot.paused ? "resume" : "pause") : "start";
    if (command === "confirm") name = "stop";
    const p = this.preferences();
    if (name === "start" && !validPreferences(p)) { this.error("请先填写有效的轮数和时长。" ); return; }
    this.localError = ""; this.busy = true; this.layout();
    try {
      await this.preferenceQueue;
      const s = await action(name, this.snapshot.sessionId, name === "start" ? p : undefined);
      this.confirmStop = false; this.dirty = false; this.render(s);
    } catch (e) { this.error(e); }
    finally { this.busy = false; this.layout(); }
  }
  private layout(): void {
    this.element("[data-main]").hidden = this.soundPage;
    this.element("[data-sounds]").hidden = !this.soundPage;
    this.element("[data-confirm]").hidden = !this.confirmStop;
    this.element(".pomodoro-actions").hidden = this.confirmStop;
    this.element("[data-command='sounds']").textContent = this.soundPage ? "← 返回计时" : "声音设置";
    this.root.querySelectorAll<HTMLButtonElement>(".pomodoro-actions button, .pomodoro-confirm button").forEach(b => { b.disabled = this.busy; });
    if (this.snapshot && this.snapshot.totalRounds >= 99) this.element<HTMLButtonElement>("[data-command='add']").disabled = true;
  }
  private render(s: PomodoroSnapshot): void {
    if (this.disposed || (this.snapshot && s.revision < this.snapshot.revision)) return;
    this.snapshot = s;
    const active = isActive(s);
    if (!this.dirty) {
      for (const [key, value] of Object.entries(s.preferences)) {
        const input = this.element<HTMLInputElement>(`[data-pref="${key}"]`);
        if (input === document.activeElement) continue;
        if (typeof value === "boolean") input.checked = value; else input.value = String(value);
      }
    }
    this.element("[data-phase]").textContent = phaseLabel(s);
    this.element("[data-rounds]").textContent = active ? `${s.phase === "focus" ? s.completedRounds + 1 : s.completedRounds} / ${s.totalRounds}` : "";
    this.element("[data-time]").textContent = formatTime(s.phase === "completed" ? 0 : active ? s.remainingMs : s.preferences.focusMinutes * 60_000);
    this.element<HTMLProgressElement>("[data-progress]").value = s.phase === "completed" ? 1 : active ? Math.max(0, 1 - s.remainingMs / Math.max(1, s.durationMs)) : 0;
    this.element("[data-inputs]").hidden = active;
    this.element("[data-summary]").textContent = active ? `已完成 ${s.completedRounds} 个 · 共 ${s.totalRounds} 个番茄钟` : s.phase === "completed" || s.phase === "stopped" ? `已完成 ${s.completedRounds} / ${s.totalRounds} 个番茄钟` : `${s.preferences.defaultRounds} 个番茄钟 · 预计 ${plannedMinutes(s.preferences)} 分钟`;
    this.element("[data-command='primary']").textContent = active ? (s.paused ? "继续" : "暂停") : s.phase === "idle" ? "开始专注" : "再来一组";
    this.element("[data-command='add']").hidden = !active;
    this.element("[data-command='skip']").hidden = s.phase !== "break";
    this.element("[data-command='stop']").hidden = !active;
    this.element("[data-volume]").textContent = `${s.preferences.volume}%`;
    this.root.querySelectorAll<HTMLInputElement>("[data-inputs] input").forEach(input => { input.disabled = active; });
    this.element("[data-notice]").textContent = this.localError || s.persistenceError || s.audioError || s.notice;
    if (!active && this.dirty) this.updateDraft();
    if (!active) this.confirmStop = false;
    this.layout();
  }
  private error(error: unknown): void { this.localError = String(error); this.element("[data-notice]").textContent = this.localError; }
}
