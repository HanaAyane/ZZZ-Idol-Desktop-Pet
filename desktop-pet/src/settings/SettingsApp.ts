import { enterRoom, showRoom } from "../room/client";
import { getState as getPomodoroState, setVisible as setPomodoroVisible, subscribe as subscribePomodoro } from "../pomodoro/client";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { invoke } from "@tauri-apps/api/core";
import { installVerifiedUpdate, prepareUpdateState, type InstallableUpdate } from "./oneClickUpdate";
import { getVersion } from "@tauri-apps/api/app";
import { version as previewVersion } from "../../package.json";
import { checkForUpdates, RELEASES_URL } from "./updates";
import { CHARACTERS } from "../characters";
import { CONTRIBUTORS } from "./contributors";
import { APP_SETTINGS_STATE, COORDINATION_STATE, listenAppEvent } from "../characters/events";
import type { CharacterId } from "../characters/types";
import type { CoordinationSnapshot } from "../pet/coordinationTypes";
import {
  PET_SCALE_MAX_PERCENT,
  PET_SCALE_MIN_PERCENT,
  PET_SCALE_STEP_PERCENT,
} from "../petScale";
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

const authorAvatar = new URL("../assets/contributors/hanaayane.png", import.meta.url).href;
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
  private updateRequest: AbortController | null = null;
  private pendingUpdate: InstallableUpdate | null = null;
  private installingUpdate = false;
  private queuedSave: Promise<void> = Promise.resolve();
  private disposed = false;

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

        <section class="settings-section" aria-labelledby="room-title">
          <div class="section-heading"><div><p class="eyebrow">LIVING SPACE</p><h2 id="room-title">妄想天使活动室</h2></div></div>
          <div class="setting-list"><div class="setting-row"><span><strong>三个人的小小生活空间</strong><small>把桌宠拖进房间，一起漫步、坐沙发或躺坐垫；角色随房间同步缩放，拖动窗口边缘缩放至 20%，上沿切换昼夜</small></span><button type="button" class="settings-action" data-open-room>打开活动室</button></div></div>
          <div class="setting-list"><div class="setting-row"><span><strong>邀请角色</strong><small>也可以直接把桌宠拖进活动室；拖到家具上休息，拖出房间回到桌面</small></span><button type="button" class="settings-action" data-room-invite>邀请三人入住</button></div></div>
          <output data-room-error role="status"></output>
        </section>

        <section class="settings-section" aria-labelledby="pomodoro-title">
          <div class="section-heading"><div><p class="eyebrow">POMODORO</p><h2 id="pomodoro-title">番茄钟</h2></div></div>
          <div class="setting-list"><label class="setting-row"><span><strong>显示番茄钟</strong><small>支持番茄钟与自定义计时，可设置多个提醒时间点；关闭窗口后继续计时</small></span><input class="toggle" type="checkbox" data-pomodoro-visible></label></div>
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

        <section class="settings-section" aria-labelledby="updates-title">
          <div class="section-heading"><div><p class="eyebrow">UPDATES</p><h2 id="updates-title">软件更新</h2></div></div>
          <div class="setting-list"><div class="setting-row">
            <span><strong data-current-version>正在读取当前版本…</strong><small>检查最新正式版；Windows 支持下载签名更新并安装重启，也可手动下载。</small></span>
            <button type="button" data-check-updates>检查更新</button>
          </div></div>
          <output class="update-status" data-update-status role="status" aria-live="polite">点击“检查更新”获取最新版本。</output>
          <button type="button" class="update-install" data-install-update hidden>一键更新并重启</button>
          <progress class="update-progress" data-update-progress max="100" hidden aria-label="更新下载进度"></progress>
          <pre class="update-notes" data-update-notes hidden></pre>
          <nav class="author-links update-links" aria-label="软件更新">
            <a data-update-link href="${RELEASES_URL}" target="_blank" rel="noopener noreferrer">查看 GitHub Release <span aria-hidden="true">↗</span></a>
          </nav>
          <output class="author-link-error" data-update-link-error role="status" aria-live="polite" hidden></output>
        </section>

        <section class="settings-section" aria-labelledby="author-title">
          <div class="section-heading"><div><p class="eyebrow">CREATOR · MAINTAINER</p><h2 id="author-title">项目作者</h2></div></div>
          <div class="author-profile">
            <img class="author-avatar" src="${authorAvatar}" alt="" width="64" height="64" loading="lazy" draggable="false">
            <p class="author-name">HanaAyane</p>
          </div>
          <nav class="author-links" aria-label="作者主页">
            <a href="https://space.bilibili.com/13745360" target="_blank" rel="noopener noreferrer">B 站主页 <span aria-hidden="true">↗</span></a>
            <a href="https://github.com/HanaAyane" target="_blank" rel="noopener noreferrer">GitHub <span aria-hidden="true">↗</span></a>
          </nav>
          <output class="author-link-error" data-author-link-error role="status" aria-live="polite" hidden></output>
        </section>

        <section class="settings-section" aria-labelledby="contributors-title">
          <div class="section-heading"><div><p class="eyebrow">CONTRIBUTORS</p><h2 id="contributors-title">开源贡献者</h2></div></div>
          <p class="credits-description">感谢为项目修复问题、完善体验的开发者。</p>
          <ul class="contributors-grid" aria-label="开源贡献者">
            ${CONTRIBUTORS.map((contributor) => `
              <li class="contributor-card">
                <div class="contributor-heading">
                  <img class="contributor-avatar" src="${contributor.avatar}" alt="" width="48" height="48" loading="lazy" draggable="false">
                  <a class="contributor-name" href="https://github.com/${contributor.login}" target="_blank" rel="noopener noreferrer" aria-label="${contributor.login} 的 GitHub 主页">@${contributor.login}<span aria-hidden="true">↗</span></a>
                </div>
              </li>`).join("")}
          </ul>
          <p class="contributors-thanks">从一个人的小小创意，到大家共同完善的作品。感谢每一份贡献 ♡</p>
          <output class="author-link-error" data-contributor-link-error role="status" aria-live="polite" hidden></output>
        </section>

        <footer class="settings-footer">
          <span data-save-status>配置由应用统一保存</span>
          <span>关闭后释放设置页资源，不会退出桌宠</span>
        </footer>
      </main>`;

    this.bindControls();
    this.syncRangeFills();
    this.syncSelects();
  }

  async mount(): Promise<void> {
    void this.readCurrentVersion().catch(() => {
      if (!this.disposed) this.requireElement("[data-current-version]").textContent = "当前版本读取失败，请重试检查更新";
    });
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
    this.disposed = true;
    this.updateRequest?.abort();
    if (!this.installingUpdate) void this.releaseUpdate();
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.unlisteners.splice(0).forEach((unlisten) => unlisten());
  }

  private bindControls(): void {
    this.requireElement("[data-install-update]").addEventListener("click", () => {
      void this.installUpdate();
    });
    this.requireElement("[data-check-updates]").addEventListener("click", () => {
      void this.checkUpdates();
    });
    this.root.querySelector<HTMLButtonElement>("[data-open-room]")!.addEventListener("click", async () => {
      const output = this.root.querySelector<HTMLOutputElement>("[data-room-error]")!;
      try {
        if (window.__TAURI_INTERNALS__) await showRoom();
        else window.open("?window=room", "_blank");
        output.textContent = "";
      } catch (error) { output.textContent = String(error); }
    });
    this.root.querySelector<HTMLButtonElement>("[data-room-invite]")!.addEventListener("click", async event => {
      const button = event.currentTarget as HTMLButtonElement;
      const output = this.root.querySelector<HTMLOutputElement>("[data-room-error]")!;
      button.disabled = true;
      try {
        const visible = CHARACTERS.filter(c => this.settings?.pets[c.id].visible);
        if (!visible.length) throw new Error("请先显示至少一名桌宠角色");
        await showRoom();
        for (const c of visible) await enterRoom(c.id);
        output.textContent = "";
      } catch (error) { output.textContent = String(error); }
      finally { button.disabled = false; }
    });
    this.root.querySelectorAll<HTMLAnchorElement>(".author-links a, .contributor-name").forEach((link) => {
      link.addEventListener("click", async (event) => {
        if (!window.__TAURI_INTERNALS__) return;
        event.preventDefault();
        const status = link.closest("section")!.querySelector<HTMLOutputElement>(".author-link-error")!;
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
        this.syncRangeFill(input);
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
        this.syncRangeFill(input);
        this.queueSave({ [input.dataset.setting!]: Number(input.value) / 100 } as AppSettingsPatch);
      });
    });
    this.bindSelects();
    this.root.querySelectorAll<HTMLElement>("[data-pet-card]").forEach((card) => {
      card.addEventListener("click", (event) => {
        if ((event.target as HTMLElement).closest("label, input, button, a")) return;
        const input = card.querySelector<HTMLInputElement>("[data-pet-visible]");
        if (input && !input.disabled) input.click();
      });
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

  private async readCurrentVersion(): Promise<string> {
    const version = window.__TAURI_INTERNALS__ ? await getVersion() : previewVersion;
    if (!this.disposed) this.requireElement("[data-current-version]").textContent = `当前版本：v${version}`;
    return version;
  }

  private async checkUpdates(): Promise<void> {
    if (this.updateRequest || this.installingUpdate) return;
    const request = new AbortController();
    this.updateRequest = request;
    const button = this.requireElement<HTMLButtonElement>("[data-check-updates]");
    const status = this.requireElement<HTMLOutputElement>("[data-update-status]");
    const link = this.requireElement<HTMLAnchorElement>("[data-update-link]");
    button.disabled = true;
    button.textContent = "正在检查…";
    status.textContent = "正在连接 GitHub…";
    status.classList.remove("settings-status--error");
    link.href = RELEASES_URL;
    link.textContent = "查看 GitHub Release ↗";
    this.requireElement<HTMLOutputElement>("[data-update-link-error]").hidden = true;
    this.requireElement<HTMLButtonElement>("[data-install-update]").hidden = true;
    this.requireElement("[data-update-progress]").hidden = true;
    this.requireElement("[data-update-notes]").hidden = true;
    try {
      await this.releaseUpdate();
      const currentVersion = await this.readCurrentVersion();
      if (this.disposed) return;
      if (window.__TAURI_INTERNALS__) {
        try {
          const { check } = await import("@tauri-apps/plugin-updater");
          const update = await check({ timeout: 10_000 });
          if (this.disposed) {
            await update?.close();
            return;
          }
          if (update) {
            this.pendingUpdate = update;
            status.textContent = `发现新版本 v${update.version}（当前 v${currentVersion}）。点击一键更新，安装后将重启桌宠。`;
            this.requireElement<HTMLButtonElement>("[data-install-update]").hidden = false;
            const notes = this.requireElement("[data-update-notes]");
            notes.textContent = update.body || "此版本未提供更新说明。";
            notes.hidden = false;
            return;
          }
        } catch {
          // 签名清单不可用或当前平台暂不支持时，保留原有手动更新入口。
        }
      }
      const result = await checkForUpdates(currentVersion, { signal: request.signal });
      if (this.disposed) return;
      if (result.status === "available") {
        status.textContent = `发现新版本 v${result.latestVersion}（当前 v${currentVersion}）。请前往 GitHub 下载并安装（此版本暂未提供可用的一键更新包）。`;
        link.textContent = "前往 GitHub 更新 ↗";
      } else if (result.status === "current") {
        status.textContent = `当前已是最新正式版 v${currentVersion}。`;
      } else {
        status.textContent = `当前版本 v${currentVersion} 高于最新正式版 v${result.latestVersion}，无需更新。`;
      }
      link.href = result.releaseUrl;
    } catch (error) {
      if (this.disposed) return;
      status.textContent = `检查失败：${error instanceof Error ? error.message : String(error)}`;
      status.classList.add("settings-status--error");
    } finally {
      this.updateRequest = null;
      if (!this.disposed) {
        button.disabled = false;
        button.textContent = "检查更新";
      }
    }
  }

  private async releaseUpdate(): Promise<void> {
    const update = this.pendingUpdate;
    this.pendingUpdate = null;
    try { await update?.close(); } catch { /* 关闭页面时资源可能已释放。 */ }
  }

  private async installUpdate(): Promise<void> {
    const update = this.pendingUpdate;
    if (!update || this.installingUpdate || this.updateRequest) return;
    this.installingUpdate = true;
    this.closeSelects();
    const button = this.requireElement<HTMLButtonElement>("[data-install-update]");
    const checkButton = this.requireElement<HTMLButtonElement>("[data-check-updates]");
    const progress = this.requireElement<HTMLProgressElement>("[data-update-progress]");
    const status = this.requireElement("[data-update-status]");
    const controls = Array.from(this.root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>("input, select, button"));
    const disabled = controls.map(control => control.disabled);
    controls.forEach(control => { control.disabled = true; });
    progress.hidden = false;
    progress.removeAttribute("value");
    status.classList.remove("settings-status--error");
    status.textContent = "正在下载更新，下载完成后验证签名并安装重启…";
    try {
      await installVerifiedUpdate(update, async () => {
        if (this.disposed) throw new Error("设置页已关闭，本次安装已取消。");
        if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
        this.saveTimer = null;
        await this.queuedSave;
        await prepareUpdateState(
          () => this.pendingPatch,
          () => { this.pendingPatch = {}; },
          updateAppSettings,
          () => invoke("prepare_for_update"),
        );
      }, state => {
        if (this.disposed) return;
        if (state.phase === "downloading") {
          const mb = (state.downloaded / 1024 / 1024).toFixed(1);
          if (state.total && state.total > 0) {
            progress.value = Math.min(100, state.downloaded / state.total * 100);
            status.textContent = `正在下载更新：${Math.floor(progress.value)}%（${mb} MB）`;
          } else status.textContent = `正在下载更新：${mb} MB`;
        } else if (state.phase === "preparing") status.textContent = "签名验证通过，正在保存设置与计时状态…";
        else status.textContent = "正在启动安装程序，完成后将自动重启桌宠…";
      });
    } catch (error) {
      if (!this.disposed) {
        status.textContent = `更新未完成：${String(error)}。可重新检查更新，或手动下载安装。`;
        status.classList.add("settings-status--error");
      }
    } finally {
      this.installingUpdate = false;
      await this.releaseUpdate();
      if (!this.disposed) {
        controls.forEach((control, index) => { control.disabled = disabled[index]; });
        checkButton.disabled = false;
        button.hidden = true;
        button.disabled = false;
        progress.hidden = true;
      }
    }
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
      // Read the latest pending edits only after older writes have settled.
      this.queuedSave = this.queuedSave.then(async () => {
        const pending = this.pendingPatch;
        this.pendingPatch = {};
        if (!Object.keys(pending).length) return;
        try {
          const settings = await updateAppSettings(pending);
          if (!this.disposed) {
            this.renderSettings(settings);
            saveStatus.textContent = "已自动保存";
          }
        } catch (error) {
          this.pendingPatch = { ...pending, ...this.pendingPatch };
          if (!this.disposed) saveStatus.textContent = `保存失败：${String(error)}`;
        }
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
    this.syncRangeFills();
    this.syncSelects();
  }

  /** 把滑块的已填充比例同步给样式，用于渐变着色。 */
  private syncRangeFill(input: HTMLInputElement): void {
    const min = Number(input.min || 0);
    const max = Number(input.max || 100);
    const value = Number(input.value);
    const ratio = Number.isFinite(value) && max > min ? (value - min) / (max - min) : 0;
    input.style.setProperty("--fill", `${(Math.min(1, Math.max(0, ratio)) * 100).toFixed(2)}%`);
  }

  private syncRangeFills(): void {
    this.root.querySelectorAll<HTMLInputElement>("input[type='range']").forEach((input) => this.syncRangeFill(input));
  }

  /** 自绘下拉框：按钮 + 选项列表，支持点击外部、Esc、方向键与回车选择。 */
  private bindSelects(): void {
    document.addEventListener("click", () => this.closeSelects());
    for (const control of Array.from(this.root.querySelectorAll<HTMLElement>("[data-select]"))) {
      const button = control.querySelector<HTMLButtonElement>(".settings-select-button");
      const list = control.querySelector<HTMLUListElement>(".settings-select-list");
      const input = control.querySelector<HTMLInputElement>("input[data-setting]");
      if (!button || !list || !input) continue;
      const options = Array.from(list.querySelectorAll<HTMLLIElement>("[role='option']"));
      const close = (focusButton = false): void => {
        list.hidden = true;
        button.setAttribute("aria-expanded", "false");
        if (focusButton) button.focus();
      };
      const open = (direction: 1 | -1): void => {
        if (this.installingUpdate || button.disabled) return;
        this.closeSelects(control);
        list.hidden = false;
        button.setAttribute("aria-expanded", "true");
        const index = options.findIndex((option) => option.getAttribute("aria-selected") === "true");
        const target = direction === 1
          ? options[index === -1 ? 0 : index]
          : options[index === -1 ? options.length - 1 : index];
        target?.focus();
      };
      const choose = (option: HTMLLIElement): void => {
        if (this.installingUpdate || button.disabled || input.disabled) return;
        const value = option.dataset.value ?? "";
        close(true);
        if (input.value === value) return;
        input.value = value;
        this.syncSelect(control);
        this.queueSave({ [input.dataset.setting!]: value } as AppSettingsPatch, 0);
      };
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        if (list.hidden) open(1); else close();
      });
      button.addEventListener("keydown", (event) => {
        if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          open(1);
        } else if (event.key === "ArrowUp") {
          event.preventDefault();
          open(-1);
        } else if (event.key === "Escape") {
          close();
        }
      });
      options.forEach((option, index) => {
        option.addEventListener("click", (event) => { event.stopPropagation(); choose(option); });
        option.addEventListener("keydown", (event) => {
          if (event.key === "ArrowDown") { event.preventDefault(); options[Math.min(options.length - 1, index + 1)]?.focus(); }
          else if (event.key === "ArrowUp") { event.preventDefault(); options[Math.max(0, index - 1)]?.focus(); }
          else if (event.key === "Home") { event.preventDefault(); options[0]?.focus(); }
          else if (event.key === "End") { event.preventDefault(); options[options.length - 1]?.focus(); }
          else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); choose(option); }
          else if (event.key === "Escape") { event.preventDefault(); close(true); }
          else if (event.key === "Tab") close();
        });
      });
    }
  }

  private closeSelects(except?: HTMLElement): void {
    for (const control of Array.from(this.root.querySelectorAll<HTMLElement>("[data-select]"))) {
      if (control === except) continue;
      const list = control.querySelector<HTMLUListElement>(".settings-select-list");
      if (list && !list.hidden) {
        list.hidden = true;
        control.querySelector<HTMLButtonElement>(".settings-select-button")?.setAttribute("aria-expanded", "false");
      }
    }
  }

  private syncSelect(control: HTMLElement): void {
    const input = control.querySelector<HTMLInputElement>("input[data-setting]");
    if (!input) return;
    const options = Array.from(control.querySelectorAll<HTMLLIElement>("[role='option']"));
    const selected = options.find((option) => option.dataset.value === input.value) ?? options[0];
    for (const option of options) option.setAttribute("aria-selected", String(option === selected));
    const label = control.querySelector<HTMLElement>("[data-select-label]");
    if (label) label.textContent = selected?.textContent ?? "";
  }

  private syncSelects(): void {
    for (const control of Array.from(this.root.querySelectorAll<HTMLElement>("[data-select]"))) this.syncSelect(control);
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
    return `<label class="setting-row setting-row--range"><span><strong>${title}</strong><small>只缩放该角色，透明安全画布保持不变</small></span><span class="scale-control"><input type="range" min="${PET_SCALE_MIN_PERCENT}" max="${PET_SCALE_MAX_PERCENT}" step="${PET_SCALE_STEP_PERCENT}" data-pet-scale="${id}"><output data-pet-scale-output="${id}">100%</output></span></label>`;
  }

  private selectRow(key: keyof AppSettings, title: string, description: string, options: string[][]): string {
    const [value, label] = options[0];
    return `<div class="setting-row"><span><strong id="${key}-title">${title}</strong><small id="${key}-description">${description}</small></span><div class="settings-select" data-select="${key}">
      <button type="button" class="settings-select-button" aria-haspopup="listbox" aria-expanded="false" aria-labelledby="${key}-title ${key}-value" aria-describedby="${key}-description" aria-controls="${key}-options"><span id="${key}-value" data-select-label>${label}</span></button>
      <ul id="${key}-options" class="settings-select-list" role="listbox" aria-labelledby="${key}-title" hidden>${options.map(([optionValue, optionLabel]) => `<li role="option" tabindex="-1" data-value="${optionValue}" aria-selected="false">${optionLabel}</li>`).join("")}</ul>
      <input type="hidden" data-setting="${key}" value="${value}">
    </div></div>`;
  }

  private requireElement<T extends Element = HTMLElement>(selector: string): T {
    const element = this.root.querySelector<T>(selector);
    if (!element) throw new Error(`界面元素不存在：${selector}`);
    return element;
  }
}
