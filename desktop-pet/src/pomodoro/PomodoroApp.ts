import type { UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { action, getState, native, setVisible, subscribe } from "./client";
import { customSummary, formatTime, isActive, phaseLabel, plannedMinutes, preferencesError, reminderError, type PomodoroSnapshot, type Preferences, type TimerMode } from "./model";
import "./pomodoro.css";
const background = new URL("../assets/pomodoro-window.png", import.meta.url).href;

export class PomodoroApp {
  private snapshot: PomodoroSnapshot | null = null;
  private unlisten?: UnlistenFn;
  private disposed = false;
  private busy = false;
  private dirty = false;
  private page: "timer" | "sounds" | "reminders" = "timer";
  private mode: TimerMode = "pomodoro";
  private reminders = [25, 45];
  private confirmStop = false;
  private localError = "";
  private preferenceQueue: Promise<void> = Promise.resolve();
  private draftRevision = 0;
  constructor(private readonly root: HTMLElement) {
    root.innerHTML = `
      <main class="pomodoro-shell" aria-label="专注计时" data-state="idle">
        <img class="pomodoro-frame" src="${background}" alt="" draggable="false">
        <div class="pomodoro-screen-glow" aria-hidden="true"></div>
        <div class="pomodoro-drag" title="拖动计时窗口" aria-hidden="true"></div>
        <section class="pomodoro-screen">
          <div class="pomodoro-modes" role="group" aria-label="计时模式">
            <button data-command="mode-pomodoro" aria-pressed="true">番茄钟</button><button data-command="mode-custom" aria-pressed="false">自定义计时</button>
          </div>
          <div class="pomodoro-phase">
            <span class="pomodoro-phase-chip"><i class="pomodoro-led" aria-hidden="true"></i><span data-phase role="status">准备专注</span></span>
            <span class="pomodoro-rounds" data-rounds></span>
          </div>
          <div class="pomodoro-rail" data-rail aria-hidden="true"></div>
          <div data-main>
            <div class="pomodoro-time" data-time aria-label="剩余时间">25:00</div>
            <div class="pomodoro-progress">
              <progress data-progress max="1" value="0" aria-label="计时进度"></progress>
              <div class="pomodoro-ticks" data-ticks aria-hidden="true"></div>
            </div>
            <div data-setup>
              <div class="pomodoro-inputs" data-inputs>
                <label>番茄个数<input data-pref="defaultRounds" type="number" min="1" max="99" step="1" value="2"></label>
                <label>专注 / 分<input data-pref="focusMinutes" type="number" min="1" max="180" step="1" value="25"></label>
                <label>休息 / 分<input data-pref="breakMinutes" type="number" min="1" max="60" step="1" value="5"></label>
              </div>
              <div class="pomodoro-custom" data-custom hidden>
                <label>总时长 / 分<input data-pref="customMinutes" type="number" min="1" max="720" step="1" value="120"></label>
                <button data-command="reminders">提醒时间点 <span data-reminder-count>2 个</span> ›</button>
              </div>
            </div>
            <p class="pomodoro-summary" data-summary>2 个番茄钟 · 预计 55 分钟</p>
            <div class="pomodoro-actions">
              <button class="pomodoro-primary" data-command="primary">开始专注</button>
              <button data-command="add" hidden>+1 个</button>
              <button data-command="skip" hidden>跳过休息</button>
              <button data-command="stop" hidden>结束</button>
            </div>
            <div class="pomodoro-confirm" data-confirm hidden><span>结束本次计时？</span><button data-command="confirm">结束</button><button data-command="cancel">返回</button></div>
          </div>
          <div class="pomodoro-reminders" data-reminders hidden>
            <div class="pomodoro-panel">
              <div class="pomodoro-panel-head"><span>提醒时间点</span><span data-reminder-count-page>2 个</span></div>
              <p class="pomodoro-help">从本次开始累计，暂停不计入。时间到点响铃，计时继续。</p>
              <div class="pomodoro-chips" data-reminder-list aria-label="提醒时间点"></div>
              <form class="pomodoro-reminder-add" data-reminder-form>
                <label>第 <input data-reminder-input aria-label="新增提醒的分钟数" type="number" min="1" max="119" step="1" placeholder="分钟"> 分钟</label>
                <button type="submit">添加</button>
              </form>
              <p class="pomodoro-help" data-reminder-help></p>
            </div>
            <button class="pomodoro-primary" data-command="done-reminders">完成</button>
          </div>
          <div class="pomodoro-sounds" data-sounds hidden>
            <div class="pomodoro-panel">
              <label class="pomodoro-sound-toggle"><span>声音提醒</span><input class="pomodoro-switch" data-pref="soundEnabled" type="checkbox" checked></label>
              <label class="pomodoro-volume"><span class="pomodoro-volume-head">音量 <output data-volume>60%</output></span><input data-pref="volume" type="range" min="0" max="100" value="60"></label>
            </div>
          </div>
          <p class="pomodoro-notice" data-notice role="status"></p>
        </section>
        <footer class="pomodoro-footer"><button data-command="sounds">声音设置</button><span>桌面置顶 · 专注陪伴</span><button data-command="close" title="关闭计时窗口，计时继续">关闭</button></footer>
      </main>`;
    this.installSteppers();
    root.querySelector(".pomodoro-drag")!.addEventListener("pointerdown", event => {
      if ((event as PointerEvent).button === 0 && native()) void getCurrentWindow().startDragging().catch(e => this.error(e));
    });
    root.addEventListener("click", event => {
      const stepper = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-step]");
      if (stepper) { this.step(stepper); return; }
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-command]");
      if (button && !button.disabled) void this.command(button.dataset.command!);
    });
    root.querySelectorAll<HTMLInputElement>("[data-pref]").forEach(input => {
      input.addEventListener("input", () => this.draftChanged());
      input.addEventListener("change", () => void this.savePreferences());
    });
    this.element<HTMLFormElement>("[data-reminder-form]").addEventListener("submit", event => { event.preventDefault(); this.addReminder(); });
    this.renderReminders();
    this.renderRail();
    this.renderTicks();
    this.updateDraft();
    this.layout();
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
  /** 给数字输入框包一层，换成主题化的上下按钮（隐藏系统原生微调箭头）。 */
  private installSteppers(): void {
    const names: Record<string, string> = { defaultRounds: "番茄个数", focusMinutes: "专注分钟", breakMinutes: "休息分钟", customMinutes: "总时长" };
    for (const input of this.root.querySelectorAll<HTMLInputElement>('input[type="number"]')) {
      const name = names[input.dataset.pref ?? ""] ?? "提醒分钟";
      const wrapper = document.createElement("span");
      wrapper.className = "pomodoro-number";
      input.replaceWith(wrapper);
      wrapper.append(input);
      const stepper = document.createElement("span");
      stepper.className = "pomodoro-stepper";
      for (const [direction, label] of [["up", `增加${name}`], ["down", `减少${name}`]] as const) {
        const button = document.createElement("button");
        button.type = "button";
        button.tabIndex = -1;
        button.dataset.step = direction;
        button.setAttribute("aria-label", label);
        stepper.append(button);
      }
      wrapper.append(stepper);
    }
  }
  private step(stepper: HTMLButtonElement): void {
    if (stepper.disabled) return;
    const input = stepper.closest(".pomodoro-number")?.querySelector<HTMLInputElement>('input[type="number"]');
    if (!input || input.disabled) return;
    try { if (stepper.dataset.step === "up") input.stepUp(); else input.stepDown(); } catch { return; }
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.focus();
  }
  private element<T extends HTMLElement = HTMLElement>(selector: string): T { return this.root.querySelector<T>(selector)!; }
  private preferences(): Preferences {
    const input = (key: string) => this.element<HTMLInputElement>(`[data-pref="${key}"]`);
    return { mode: this.mode, customMinutes: input("customMinutes").valueAsNumber, reminderMinutes: [...this.reminders],
      defaultRounds: input("defaultRounds").valueAsNumber, focusMinutes: input("focusMinutes").valueAsNumber,
      breakMinutes: input("breakMinutes").valueAsNumber, soundEnabled: input("soundEnabled").checked, volume: input("volume").valueAsNumber };
  }
  private draftChanged(): void {
    this.dirty = true; this.draftRevision += 1; this.localError = "";
    this.element("[data-notice]").textContent = "";
    this.updateDraft(); this.layout();
  }
  private updateDraft(): void {
    const p = this.preferences();
    const error = preferencesError(p);
    this.element("[data-volume]").textContent = `${p.volume}%`;
    const volumeFill = Number.isFinite(p.volume) ? Math.min(100, Math.max(0, p.volume)) : 0;
    this.element<HTMLInputElement>('[data-pref="volume"]').style.setProperty("--fill", `${volumeFill}%`);
    if (!this.snapshot || !isActive(this.snapshot)) {
      const points = p.reminderMinutes.length ? `第 ${p.reminderMinutes.join("、")} 分钟提醒` : "仅结束时提醒";
      this.element("[data-summary]").textContent = error || (p.mode === "custom" ? points : `${p.defaultRounds} 个番茄钟 · 预计 ${plannedMinutes(p)} 分钟`);
      this.element("[data-time]").textContent = error ? "--:--" : formatTime((p.mode === "custom" ? p.customMinutes : p.focusMinutes) * 60_000);
      this.element("[data-phase]").textContent = p.mode === "custom" ? "准备计时" : "准备专注";
      this.element<HTMLProgressElement>("[data-progress]").value = 0;
    }
    const count = `${p.reminderMinutes.length} 个`;
    this.element("[data-reminder-count]").textContent = count;
    this.element("[data-reminder-count-page]").textContent = count;
    this.element<HTMLInputElement>("[data-reminder-input]").max = String(p.customMinutes - 1);
    this.element("[data-reminder-help]").textContent = Number.isInteger(p.customMinutes) ? `第 ${p.customMinutes} 分钟自动结束并提醒` : "请先设置总时长";
  }
  /** 轮次轨道：番茄钟模式下每个分段代表一个番茄。 */
  private renderRail(): void {
    const rail = this.element("[data-rail]");
    const s = this.snapshot;
    const active = Boolean(s && isActive(s));
    if ((active ? s!.mode : this.mode) === "custom") { rail.hidden = true; rail.replaceChildren(); return; }
    rail.hidden = false;
    const total = Math.min(99, Math.max(1, Math.round(active ? s!.totalRounds : this.preferences().defaultRounds) || 1));
    rail.style.setProperty("--rounds", String(total));
    const completed = active ? Math.min(s!.completedRounds, total) : 0;
    const current = active && s!.phase === "focus" ? completed : -1;
    if (rail.childElementCount !== total) rail.replaceChildren(...Array.from({ length: total }, () => document.createElement("i")));
    Array.from(rail.children).forEach((segment, index) => {
      segment.setAttribute("data-done", String(index < completed));
      segment.setAttribute("data-current", String(index === current));
    });
  }
  /** 自定义计时模式下，在进度条上标出提醒时间点。 */
  private renderTicks(): void {
    const ticks = this.element("[data-ticks]");
    const s = this.snapshot;
    const active = Boolean(s && isActive(s));
    const custom = (active ? s!.mode : this.mode) === "custom";
    ticks.replaceChildren();
    if (!custom) return;
    const totalMinutes = active ? Math.max(1, s!.durationMs / 60_000) : this.preferences().customMinutes;
    for (const minute of active ? s!.reminderMinutes : this.reminders) {
      if (!Number.isFinite(minute) || minute <= 0 || minute >= totalMinutes) continue;
      const tick = document.createElement("i");
      tick.style.left = `${(minute / totalMinutes) * 100}%`;
      ticks.append(tick);
    }
  }
  private renderReminders(): void {
    const list = this.element("[data-reminder-list]");
    list.replaceChildren();
    if (!this.reminders.length) { list.textContent = "还没有中途提醒，可直接倒计时。"; return; }
    for (const minute of this.reminders) {
      const button = document.createElement("button");
      button.dataset.command = `remove-${minute}`;
      button.textContent = `${minute} 分 ×`;
      button.setAttribute("aria-label", `删除第 ${minute} 分钟提醒`);
      list.append(button);
    }
  }
  private addReminder(): void {
    if (this.busy || (this.snapshot && isActive(this.snapshot))) return;
    const input = this.element<HTMLInputElement>("[data-reminder-input]");
    const reminders = [...this.reminders, input.valueAsNumber].sort((a, b) => a - b);
    const error = reminderError(this.preferences().customMinutes, reminders);
    if (error) { this.error(error); return; }
    this.reminders = reminders; input.value = "";
    this.renderReminders(); this.draftChanged(); void this.savePreferences(); input.focus();
  }
  private savePreferences(): Promise<void> {
    const p = this.preferences();
    const error = preferencesError(p);
    if (error) { this.error(error); return Promise.resolve(); }
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
      try { await this.preferenceQueue; await setVisible(false); } catch (e) { this.error(e); }
      return;
    }
    if (this.busy) return;
    const active = this.snapshot && isActive(this.snapshot);
    if (command.startsWith("mode-")) {
      if (active) return;
      this.mode = command === "mode-custom" ? "custom" : "pomodoro";
      this.page = "timer"; this.draftChanged(); await this.savePreferences(); return;
    }
    if (command === "reminders") { if (!active) { this.page = "reminders"; this.updateDraft(); this.layout(); } return; }
    if (command.startsWith("remove-")) {
      if (active) return;
      this.reminders = this.reminders.filter(m => m !== Number(command.slice(7)));
      this.renderReminders(); this.draftChanged(); await this.savePreferences(); return;
    }
    if (command === "done-reminders") {
      const error = preferencesError(this.preferences());
      if (error) { this.error(error); return; }
      this.page = "timer"; this.layout(); return;
    }
    if (command === "sounds") { this.page = this.page === "timer" ? "sounds" : "timer"; this.layout(); return; }
    if (command === "stop") { this.confirmStop = true; this.layout(); return; }
    if (command === "cancel") { this.confirmStop = false; this.layout(); return; }
    if (!this.snapshot || !native()) return;
    let name = command;
    if (command === "primary") name = active ? (this.snapshot.paused ? "resume" : "pause") : "start";
    if (command === "confirm") name = "stop";
    const p = this.preferences();
    if (name === "start" && preferencesError(p)) { this.error(preferencesError(p)); return; }
    this.localError = ""; this.busy = true; this.layout();
    try {
      await this.preferenceQueue;
      const s = await action(name, this.snapshot.sessionId, name === "start" ? p : undefined);
      this.confirmStop = false; this.dirty = false; this.render(s);
    } catch (e) { this.error(e); }
    finally { this.busy = false; this.layout(); }
  }
  private layout(): void {
    const s = this.snapshot;
    const active = Boolean(s && isActive(s));
    const custom = (active ? s!.mode : this.mode) === "custom";
    this.element("[data-main]").hidden = this.page !== "timer";
    this.element("[data-sounds]").hidden = this.page !== "sounds";
    this.element("[data-reminders]").hidden = this.page !== "reminders";
    this.element("[data-setup]").hidden = active;
    this.element("[data-inputs]").hidden = custom;
    this.element("[data-custom]").hidden = !custom;
    this.element("[data-confirm]").hidden = !this.confirmStop;
    this.element(".pomodoro-actions").hidden = this.confirmStop;
    this.element("[data-command='sounds']").textContent = this.page === "timer" ? "声音设置" : "← 返回计时";
    this.element("[data-command='primary']").textContent = active ? (s!.paused ? "继续" : "暂停") : custom ? "开始计时" : "开始专注";
    this.element("[data-command='add']").hidden = !active || custom;
    this.element("[data-command='skip']").hidden = s?.phase !== "break";
    this.element("[data-command='stop']").hidden = !active;
    this.root.querySelectorAll<HTMLButtonElement>(".pomodoro-actions button, .pomodoro-confirm button").forEach(b => { b.disabled = this.busy; });
    this.root.querySelectorAll<HTMLInputElement | HTMLButtonElement>("[data-setup] input, [data-setup] button, [data-reminders] input, [data-reminders] button, .pomodoro-modes button")
      .forEach(b => { b.disabled = this.busy || active; });
    for (const mode of ["pomodoro", "custom"]) this.element(`[data-command='mode-${mode}']`).setAttribute("aria-pressed", String(mode === (custom ? "custom" : "pomodoro")));
    if (s && s.totalRounds >= 99) this.element<HTMLButtonElement>("[data-command='add']").disabled = true;
    const shell = this.element<HTMLElement>(".pomodoro-shell");
    shell.dataset.state = s ? s.phase : "idle";
    shell.dataset.paused = String(Boolean(active && s!.paused));
    shell.dataset.running = String(Boolean(active && !s!.paused));
    this.renderRail();
    this.renderTicks();
  }
  private render(s: PomodoroSnapshot): void {
    if (this.disposed || (this.snapshot && s.revision < this.snapshot.revision)) return;
    this.snapshot = s;
    const active = isActive(s);
    if (!this.dirty) {
      this.mode = s.preferences.mode;
      const remindersChanged = this.reminders.join() !== s.preferences.reminderMinutes.join();
      this.reminders = [...s.preferences.reminderMinutes];
      if (remindersChanged) this.renderReminders();
      for (const key of ["defaultRounds", "focusMinutes", "breakMinutes", "customMinutes", "soundEnabled", "volume"] as const) {
        const input = this.element<HTMLInputElement>(`[data-pref="${key}"]`);
        if (input === document.activeElement) continue;
        const value = s.preferences[key];
        if (typeof value === "boolean") input.checked = value; else input.value = String(value);
      }
    }
    this.updateDraft();
    this.element("[data-phase]").textContent = phaseLabel(s);
    this.element("[data-rounds]").textContent = active ? s.mode === "custom" ? `${s.nextReminderIndex} / ${s.reminderMinutes.length} 次提醒` : `${s.phase === "focus" ? s.completedRounds + 1 : s.completedRounds} / ${s.totalRounds}` : "";
    if (active || s.phase === "completed") {
      this.element("[data-time]").textContent = formatTime(s.remainingMs);
      this.element<HTMLProgressElement>("[data-progress]").value = Math.max(0, 1 - s.remainingMs / Math.max(1, s.durationMs));
    }
    if (active || s.phase === "completed" || s.phase === "stopped") this.element("[data-summary]").textContent = s.mode === "custom" ? customSummary(s) : `已完成 ${s.completedRounds} / ${s.totalRounds} 个番茄钟`;
    this.element("[data-notice]").textContent = this.localError || s.persistenceError || s.audioError || s.notice;
    if (!active && this.dirty) this.updateDraft();
    if (!active) this.confirmStop = false;
    this.layout();
  }
  private error(error: unknown): void { this.localError = String(error); this.element("[data-notice]").textContent = this.localError; }
}
