import { getState as getPomodoroState, setVisible as setPomodoroVisible, subscribe as subscribePomodoro } from "../pomodoro/client";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { CHARACTERS } from "../characters";
import { APP_SETTINGS_STATE, COORDINATION_STATE, listenAppEvent } from "../characters/events";
import type { CharacterId } from "../characters/types";
import type { CoordinationSnapshot } from "../pet/coordinationTypes";
import {
  exportDiagnosticReport,
  getDiagnosticSummary,
  type DiagnosticSummary,
} from "../diagnostics";
import {
  arrangePetGroup,
  DEFAULT_APP_SETTINGS,
  getAppSettings,
  updateAppSettings,
  updatePetSettings,
  type AppSettings,
  type AppSettingsPatch,
  type PetInstanceSettingsPatch,
} from "./appSettings";

const settingsLogo = new URL("../assets/settings-logo.png", import.meta.url).href;
const characterAvatars: Record<CharacterId, string> = {
  airui: new URL("../assets/character-avatars/airui.png", import.meta.url).href,
  nangong: new URL("../assets/character-avatars/nangong.png", import.meta.url).href,
  qianxia: new URL("../assets/character-avatars/qianxia.png", import.meta.url).href,
};

export class SettingsApp {
  private readonly unlisteners: UnlistenFn[] = [];
  private saveTimer: number | null = null;
  private pendingPatch: AppSettingsPatch = {};
  private settings: AppSettings | null = null;
  private coordinationSnapshot: CoordinationSnapshot | null = null;

  constructor(private readonly root: HTMLElement) {
    this.root.innerHTML = `
      <main class="settings-shell">
        <header class="settings-header">
          <div>
            <p class="eyebrow">ZZZ IDOL DESKTOP PET</p>
            <h1>桌宠设置</h1>
            <p>更改会即时应用并自动保存。</p>
          </div>
          <img class="settings-logo" src="${settingsLogo}" alt="妄想" width="614" height="378" draggable="false" />
        </header>

        <section class="character-picker" aria-labelledby="character-picker-title">
          <div class="section-heading">
            <div><p class="eyebrow">CHARACTER</p><h2 id="character-picker-title">桌宠角色</h2></div>
            <output data-character-status role="status" aria-live="polite">正在读取设置…</output>
          </div>
          <div class="character-grid">
            ${CHARACTERS.map((character, index) => `
              <article class="character-option" data-pet-card="${character.id}">
                <span class="character-number">0${index + 1}</span>
                <div class="character-heading">
                  <span class="character-name">${character.displayName}</span>
                  <img class="character-avatar" src="${characterAvatars[character.id]}" alt="" width="64" height="64" draggable="false" />
                </div>
                <label class="character-visibility"><input class="toggle" type="checkbox" data-pet-visible="${character.id}">显示在桌面</label>
                <span class="character-state" data-pet-state="${character.id}">已显示</span>
              </article>`).join("")}
          </div>
        </section>

        <section class="settings-section" aria-labelledby="appearance-title">
          <div class="section-heading"><div><p class="eyebrow">APPEARANCE</p><h2 id="appearance-title">外观与窗口</h2></div></div>
          <div class="setting-list">
            ${CHARACTERS.map((character) => this.petScaleRow(character.id, `${character.displayName}大小`)).join("")}
            ${this.switchRow("alwaysOnTop", "始终置顶", "让桌宠保持在普通窗口上方")}
            ${this.switchRow("gazeTracking", "鼠标视线追踪", "待机和漫步时让眼神跟随鼠标")}
          </div>
        </section>

        <section class="settings-section" aria-labelledby="pomodoro-title">
          <div class="section-heading"><div><p class="eyebrow">POMODORO</p><h2 id="pomodoro-title">番茄钟</h2></div></div>
          <div class="setting-list"><label class="setting-row"><span><strong>显示番茄钟</strong><small>在桌面置顶窗口中设置轮数、专注和休息；关闭窗口后继续计时</small></span><input class="toggle" type="checkbox" data-pomodoro-visible></label></div>
          <output data-pomodoro-error role="status"></output>
        </section>

        <section class="settings-section" aria-labelledby="behavior-title">
          <div class="section-heading"><div><p class="eyebrow">BEHAVIOR</p><h2 id="behavior-title">行为与互动</h2></div></div>
          <div class="setting-list">
            ${this.switchRow("autoWalk", "自动漫步", "在当前显示器工作区内向左、右、左上、左下、右上、右下自由漫步")}
            ${this.rangeRow("walkFrequency", "漫步频率", "停留间隔倍率", 50, 200, 10, "%")}
            ${this.rangeRow("movementSpeed", "移动速度", "原生窗口移动速度倍率", 50, 200, 10, "%")}
            ${this.switchRow("clickEnabled", "单击与连续点击反馈", "允许单击和连续点击触发动作")}
            ${this.switchRow("doubleClickEnabled", "双击反馈", "允许双击触发稀有动作")}
            ${this.switchRow("hoverEnabled", "悬停反馈", "鼠标停留后切换注视表情")}
            ${this.switchRow("windowLiftEnabled", "手动窗口托举", "拖到普通窗口底边后持续托举，直到拖离、按 Esc 或目标失效；三名角色可托举同一窗口")}
            ${this.switchRow("autoWindowLiftEnabled", "漫步时自动托举", "需开启“自动漫步”；走到窗口底边正下方附近时托举 10 秒，放下后冷却 15 秒；不限制手动托举时长")}
          </div>
        </section>

        <section class="settings-section" aria-labelledby="coordination-title">
          <div class="section-heading"><div><p class="eyebrow">COORDINATION</p><h2 id="coordination-title">三角色联动</h2></div><output data-coordination-status role="status" aria-live="polite">场景空闲</output></div>
          <div class="setting-list">
            ${this.coordinationSwitchRow("enabled", "联动总开关", "关闭后立即取消活动场景，并保持三个角色独立运行")}
            ${this.coordinationSwitchRow("partnerGaze", "互相注视", "鼠标安静时，优先让同一工作区内最近的角色成为视线目标")}
            ${this.coordinationSwitchRow("reactionEcho", "点击回应", "单击回应一名角色，双击最多错峰回应两名角色")}
            ${this.coordinationSwitchRow("automaticScenes", "自动联动场景", "实验性：当前版本保留设置位，默认关闭")}
            <div class="coordination-actions">
              <button type="button" data-coordination-action="gather">集合角色</button>
              <button type="button" data-coordination-action="disperse">散开角色</button>
            </div>
          </div>
        </section>

        <section class="settings-section" aria-labelledby="system-title">
          <div class="section-heading"><div><p class="eyebrow">SYSTEM</p><h2 id="system-title">性能与系统</h2></div></div>
          <div class="setting-list">
            ${this.selectRow("performanceMode", "性能模式", "控制渲染分辨率", [
              ["quality", "高质量"], ["balanced", "平衡"], ["saving", "省电"],
            ])}
            ${this.selectRow("frameRate", "帧率", "省电模式的自动帧率为 30 FPS", [
              ["auto", "自动"], ["60", "60 FPS"], ["30", "30 FPS"],
            ])}
            ${this.switchRow("debugMode", "调试模式", "开启后显示桌宠状态提示，并可按 D 打开调试面板")}
            ${this.switchRow("launchAtLogin", "开机自动启动", "登录系统后自动运行桌宠")}
          </div>
        </section>

        <section class="settings-section" aria-labelledby="diagnostics-title">
          <div class="section-heading">
            <div><p class="eyebrow">DIAGNOSTICS</p><h2 id="diagnostics-title">故障诊断</h2></div>
            <output data-diagnostics-status role="status" aria-live="polite">正在读取运行状态…</output>
          </div>
          <p class="diagnostics-description">应用会保留有限大小的本地运行日志。导出报告包含版本、窗口、设置摘要、联动状态和最近日志，不包含鼠标轨迹。</p>
          <div class="diagnostics-actions">
            <button type="button" data-diagnostics-action="refresh">刷新状态</button>
            <button type="button" data-diagnostics-action="export">导出诊断报告</button>
          </div>
          <output class="diagnostics-path" data-diagnostics-path hidden></output>
        </section>

        <section class="settings-section" aria-labelledby="author-title">
          <div class="section-heading"><div><p class="eyebrow">AUTHOR</p><h2 id="author-title">作者信息</h2></div></div>
          <p class="author-name">HanaAyane</p>
          <nav class="author-links" aria-label="作者主页">
            <a href="https://space.bilibili.com/13745360" target="_blank" rel="noopener noreferrer">B 站主页 <span aria-hidden="true">↗</span></a>
            <a href="https://github.com/HanaAyane" target="_blank" rel="noopener noreferrer">GitHub <span aria-hidden="true">↗</span></a>
          </nav>
          <output class="author-link-error" data-author-link-error role="status" aria-live="polite" hidden></output>
        </section>

        <footer class="settings-footer">
          <span data-save-status>配置由应用统一保存</span>
          <span>关闭后释放设置页资源，不会退出桌宠</span>
        </footer>
      </main>`;

    this.bindControls();
  }

  async mount(): Promise<void> {
    this.unlisteners.push(
      await listenAppEvent(APP_SETTINGS_STATE, (settings) => this.renderSettings(settings)),
      await listenAppEvent(COORDINATION_STATE, (snapshot) => this.renderCoordinationState(snapshot)),
    );
    this.renderSettings(await getAppSettings());
    if (window.__TAURI_INTERNALS__) {
      const toggle = this.root.querySelector<HTMLInputElement>("[data-pomodoro-visible]")!;
      let revision = -1;
      const renderVisibility = (s: { revision: number; windowVisible: boolean }) => {
        if (s.revision >= revision) { revision = s.revision; toggle.checked = s.windowVisible; }
      };
      this.unlisteners.push(await subscribePomodoro(renderVisibility));
      renderVisibility(await getPomodoroState());
    }
    await this.refreshDiagnostics();
  }

  dispose(): void {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.unlisteners.splice(0).forEach((unlisten) => unlisten());
  }

  private bindControls(): void {
    this.root.querySelectorAll<HTMLAnchorElement>(".author-links a").forEach((link) => {
      link.addEventListener("click", async (event) => {
        if (!window.__TAURI_INTERNALS__) return;
        event.preventDefault();
        const status = this.root.querySelector<HTMLOutputElement>("[data-author-link-error]")!;
        status.hidden = true;
        try {
          await openUrl(link.href);
        } catch {
          status.textContent = `无法打开浏览器，请复制链接访问：${link.href}`;
          status.hidden = false;
        }
      });
    });
    this.root.querySelector<HTMLInputElement>("[data-pomodoro-visible]")!.addEventListener("change", async event => {
      const input = event.target as HTMLInputElement;
      input.disabled = true;
      try { await setPomodoroVisible(input.checked); }
      catch (error) { input.checked = !input.checked; this.root.querySelector("[data-pomodoro-error]")!.textContent = String(error); }
      finally { input.disabled = false; }
    });
    this.root.querySelectorAll<HTMLInputElement>("[data-pet-visible]").forEach((input) => {
      input.addEventListener("change", () => {
        void this.savePetSettings(input.dataset.petVisible as CharacterId, { visible: input.checked });
      });
    });
    this.root.querySelectorAll<HTMLInputElement>("[data-pet-scale]").forEach((input) => {
      input.addEventListener("input", () => {
        const output = this.root.querySelector<HTMLOutputElement>(`[data-pet-scale-output='${input.dataset.petScale}']`);
        if (output) output.textContent = `${input.value}%`;
      });
      input.addEventListener("change", () => {
        void this.savePetSettings(input.dataset.petScale as CharacterId, { scale: Number(input.value) / 100 });
      });
    });
    this.root.querySelectorAll<HTMLInputElement>("input[type='checkbox'][data-setting]").forEach((input) => {
      input.addEventListener("change", () => this.queueSave({ [input.dataset.setting!]: input.checked } as AppSettingsPatch, 0));
    });
    this.root.querySelectorAll<HTMLInputElement>("input[type='range'][data-setting]").forEach((input) => {
      input.addEventListener("input", () => {
        const output = this.root.querySelector<HTMLOutputElement>(`[data-output='${input.dataset.setting}']`);
        if (output) output.textContent = `${input.value}%`;
        this.queueSave({ [input.dataset.setting!]: Number(input.value) / 100 } as AppSettingsPatch);
      });
    });
    this.root.querySelectorAll<HTMLSelectElement>("select[data-setting]").forEach((select) => {
      select.addEventListener("change", () => this.queueSave({ [select.dataset.setting!]: select.value } as AppSettingsPatch, 0));
    });
    this.root.querySelectorAll<HTMLInputElement>("input[data-coordination-setting]").forEach((input) => {
      input.addEventListener("change", () => {
        const key = input.dataset.coordinationSetting as keyof AppSettings["coordination"];
        const coordination = {
          ...(this.settings?.coordination ?? DEFAULT_APP_SETTINGS.coordination),
          [key]: input.checked,
        };
        void updateAppSettings({ coordination }).then((settings) => {
          this.renderSettings(settings);
          this.requireElement<HTMLElement>("[data-save-status]").textContent = "已自动保存";
        }).catch((error) => {
          this.requireElement<HTMLElement>("[data-save-status]").textContent = `保存失败：${String(error)}`;
        });
      });
    });
    this.root.querySelectorAll<HTMLButtonElement>("[data-coordination-action]").forEach((button) => {
      button.addEventListener("click", () => {
        const mode = button.dataset.coordinationAction as "gather" | "disperse";
        void arrangePetGroup(mode).catch((error) => {
          this.requireElement<HTMLElement>("[data-save-status]").textContent = `联动失败：${String(error)}`;
        });
      });
    });
    this.root.querySelector<HTMLButtonElement>("[data-diagnostics-action='refresh']")?.addEventListener("click", () => {
      void this.refreshDiagnostics();
    });
    this.root.querySelector<HTMLButtonElement>("[data-diagnostics-action='export']")?.addEventListener("click", (event) => {
      void this.exportDiagnostics(event.currentTarget as HTMLButtonElement);
    });
  }

  private async refreshDiagnostics(): Promise<void> {
    const status = this.requireElement<HTMLOutputElement>("[data-diagnostics-status]");
    status.textContent = "正在读取运行状态…";
    status.classList.remove("settings-status--error");
    try {
      this.renderDiagnosticSummary(await getDiagnosticSummary());
    } catch (error) {
      status.textContent = `读取失败：${String(error)}`;
      status.classList.add("settings-status--error");
    }
  }

  private renderDiagnosticSummary(summary: DiagnosticSummary): void {
    const status = this.requireElement<HTMLOutputElement>("[data-diagnostics-status]");
    status.classList.remove("settings-status--error");
    status.textContent = `v${summary.appVersion} · ${summary.platform}/${summary.architecture} · ${summary.visiblePetCount}/${summary.petWindowCount} 个角色可见 · ${summary.logFileCount} 个日志`;
  }

  private async exportDiagnostics(button: HTMLButtonElement): Promise<void> {
    const status = this.requireElement<HTMLOutputElement>("[data-diagnostics-status]");
    const path = this.requireElement<HTMLOutputElement>("[data-diagnostics-path]");
    button.disabled = true;
    status.textContent = "正在导出诊断报告…";
    status.classList.remove("settings-status--error");
    try {
      const report = await exportDiagnosticReport();
      status.textContent = `已导出 ${(report.bytesWritten / 1024).toFixed(1)} KB · 包含 ${report.includedLogFiles} 个日志`;
      path.hidden = false;
      path.textContent = report.reportPath;
      path.title = report.reportPath;
    } catch (error) {
      status.textContent = `导出失败：${String(error)}`;
      status.classList.add("settings-status--error");
    } finally {
      button.disabled = false;
    }
  }

  private queueSave(patch: AppSettingsPatch, delay = 120): void {
    this.pendingPatch = { ...this.pendingPatch, ...patch };
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    const saveStatus = this.requireElement<HTMLElement>("[data-save-status]");
    saveStatus.textContent = "正在保存…";
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      const pending = this.pendingPatch;
      this.pendingPatch = {};
      void updateAppSettings(pending).then((settings) => {
        this.renderSettings(settings);
        saveStatus.textContent = "已自动保存";
      }).catch((error) => {
        saveStatus.textContent = `保存失败：${String(error)}`;
      });
    }, delay);
  }

  private renderSettings(settings: AppSettings): void {
    this.settings = settings;
    let visibleCount = 0;
    for (const character of CHARACTERS) {
      const pet = settings.pets[character.id];
      if (pet.visible) visibleCount += 1;
      const card = this.root.querySelector<HTMLElement>(`[data-pet-card='${character.id}']`);
      card?.classList.toggle("character-option--active", pet.visible);
      const visibleInput = this.root.querySelector<HTMLInputElement>(`[data-pet-visible='${character.id}']`);
      if (visibleInput) visibleInput.checked = pet.visible;
      const state = this.root.querySelector<HTMLElement>(`[data-pet-state='${character.id}']`);
      if (state) state.textContent = pet.visible ? "已显示" : "已隐藏";
      const scaleInput = this.root.querySelector<HTMLInputElement>(`[data-pet-scale='${character.id}']`);
      const scaleOutput = this.root.querySelector<HTMLOutputElement>(`[data-pet-scale-output='${character.id}']`);
      const scalePercent = String(Math.round(pet.scale * 100));
      if (scaleInput) scaleInput.value = scalePercent;
      if (scaleOutput) scaleOutput.textContent = `${scalePercent}%`;
    }
    this.requireElement<HTMLOutputElement>("[data-character-status]").textContent = `${visibleCount}/3 个角色显示中`;
    for (const [key, value] of Object.entries(settings)) {
      const control = this.root.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-setting='${key}']`);
      if (!control) continue;
      if (control instanceof HTMLInputElement && control.type === "checkbox") control.checked = Boolean(value);
      else if (control instanceof HTMLInputElement && control.type === "range") {
        control.value = String(Math.round(Number(value) * 100));
        const output = this.root.querySelector<HTMLOutputElement>(`[data-output='${key}']`);
        if (output) output.textContent = `${control.value}%`;
      } else control.value = String(value);
    }
    for (const [key, value] of Object.entries(settings.coordination)) {
      const control = this.root.querySelector<HTMLInputElement>(`[data-coordination-setting='${key}']`);
      if (control) control.checked = Boolean(value);
    }
    this.renderCoordinationState(this.coordinationSnapshot);
  }

  private renderCoordinationState(snapshot: CoordinationSnapshot | null): void {
    this.coordinationSnapshot = snapshot;
    const output = this.root.querySelector<HTMLOutputElement>("[data-coordination-status]");
    if (!output) return;
    if (!snapshot) {
      output.textContent = "场景空闲";
      return;
    }
    const active = snapshot.activeScene;
    const loadedCount = Object.values(snapshot.pets).filter((pet) => pet?.loaded && pet.visible).length;
    output.textContent = active
      ? `场景 #${active.sceneId} · ${active.kind} · ${active.pendingIds.length} 个待完成`
      : `${loadedCount}/3 个角色可联动 · 场景空闲`;
  }

  private async savePetSettings(id: CharacterId, patch: PetInstanceSettingsPatch): Promise<void> {
    const saveStatus = this.requireElement<HTMLElement>("[data-save-status]");
    saveStatus.textContent = "正在保存…";
    try {
      this.renderSettings(await updatePetSettings(id, patch));
      saveStatus.textContent = "已自动保存";
    } catch (error) {
      saveStatus.textContent = `保存失败：${String(error)}`;
    }
  }

  private switchRow(key: keyof AppSettings, title: string, description: string): string {
    return `<label class="setting-row"><span><strong>${title}</strong><small>${description}</small></span><input class="toggle" type="checkbox" data-setting="${key}"></label>`;
  }

  private coordinationSwitchRow(
    key: keyof AppSettings["coordination"],
    title: string,
    description: string,
  ): string {
    return `<label class="setting-row"><span><strong>${title}</strong><small>${description}</small></span><input class="toggle" type="checkbox" data-coordination-setting="${key}"></label>`;
  }

  private rangeRow(key: keyof AppSettings, title: string, description: string, min: number, max: number, step: number, suffix: string): string {
    return `<label class="setting-row setting-row--range"><span><strong>${title}</strong><small>${description}</small></span><span class="scale-control"><input type="range" min="${min}" max="${max}" step="${step}" data-setting="${key}"><output data-output="${key}">100${suffix}</output></span></label>`;
  }

  private petScaleRow(id: CharacterId, title: string): string {
    return `<label class="setting-row setting-row--range"><span><strong>${title}</strong><small>只缩放该角色，透明安全画布保持不变</small></span><span class="scale-control"><input type="range" min="60" max="125" step="5" data-pet-scale="${id}"><output data-pet-scale-output="${id}">100%</output></span></label>`;
  }

  private selectRow(key: keyof AppSettings, title: string, description: string, options: string[][]): string {
    return `<label class="setting-row"><span><strong>${title}</strong><small>${description}</small></span><select data-setting="${key}">${options.map(([value, label]) => `<option value="${value}">${label}</option>`).join("")}</select></label>`;
  }

  private requireElement<T extends Element = HTMLElement>(selector: string): T {
    const element = this.root.querySelector<T>(selector);
    if (!element) throw new Error(`界面元素不存在：${selector}`);
    return element;
  }
}
