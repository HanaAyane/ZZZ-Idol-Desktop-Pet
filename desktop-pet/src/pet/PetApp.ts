import type { UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { logCoordinationStatus, logWindowLiftStatus } from "../diagnostics";
import { CHARACTER_BY_ID } from "../characters";
import { APP_SETTINGS_STATE, listenAppEvent } from "../characters/events";
import {
  getAppSettings,
  updatePetSettings,
  type AppSettings,
} from "../settings/appSettings";
import type { CharacterDefinition, CharacterId } from "../characters/types";
import type {
  CoordinationCommand,
  CoordinationMoveTarget,
  CoordinationRuntimeState,
  CoordinationSceneToken,
  CoordinationSnapshot,
} from "./coordinationTypes";
import {
  SpineRenderer,
  type SpineCharacterMetadata,
  type SpineRendererDiagnostics,
} from "../renderer/SpineRenderer";
import { PetInteractionController, type PetInteractionSnapshot } from "./PetInteractionController";
import { shouldMirrorForFacingDirection } from "./characterFacing";
import { ROAMING_DIRECTIONS, ROAMING_DIRECTION_LABELS, type RoamingDirection } from "./roamingGeometry";
import {
  PetRoamingController,
  type PetRoamingSnapshot,
  type PetWindowContext,
  type WalkDirection,
} from "./PetRoamingController";
import { PetStateMachine, type PetStateSnapshot } from "./PetStateMachine";
import { PetCoordinationController } from "./PetCoordinationController";
import { WindowLiftController, type WindowLiftControllerSnapshot, type WindowLiftMode } from "./WindowLiftController";
import { probeFromVisibleBounds } from "./windowLiftGeometry";
import {
  getLiftAction,
  liftCharacterDefinition,
  type SpecialActionDefinition,
} from "./specialActions";

interface AnimationValidationResult {
  attempted: number;
  succeeded: string[];
  failed: Array<{ action: string; message: string }>;
}

interface ReloadResult {
  cycles: number;
  samples: SpineRendererDiagnostics["memory"][];
}

interface InteractionValidationResult {
  passed: boolean;
  checks: Record<string, boolean>;
}

interface ExpressionValidationResult {
  attempted: number;
  succeeded: string[];
  failed: Array<{ overlay: string; message: string }>;
}

export interface Phase4DebugApi {
  getState(): {
    metadata: SpineCharacterMetadata | null;
    renderer: SpineRendererDiagnostics;
    behavior: PetStateSnapshot;
    interaction: PetInteractionSnapshot;
    roaming: PetRoamingSnapshot;
    coordination: ReturnType<PetCoordinationController["getSnapshot"]>;
    windowLift: WindowLiftControllerSnapshot;
  };
  play(action: string, loop?: boolean): number;
  setOverlay(action: string): void;
  setPlaying(playing: boolean): void;
  getSlotFingerprint(): string;
  diagnosePixelHitTest(): ReturnType<SpineRenderer["diagnosePixelHitTest"]>;
  setSkin(skin: string): void;
  setCharacterScale(scale: number): void;
  cycleAllActions(delayMs?: number): Promise<AnimationValidationResult>;
  cycleExpressions(delayMs?: number): Promise<ExpressionValidationResult>;
  reload(cycles?: number): Promise<ReloadResult>;
  testContextRecovery(): Promise<boolean>;
  simulateClick(): void;
  simulateDoubleClick(): void;
  simulateRapidClick(): void;
  simulateDrag(): void;
  simulateWalk(distanceCssPx?: number, direction?: RoamingDirection): Promise<boolean>;
  validateInteractions(): Promise<InteractionValidationResult>;
  simulateCoordinationClick(): void;
  cancelCoordination(): Promise<void>;
  arrangeCoordination(mode: "gather" | "disperse"): void;
}

export class PetApp {
  private readonly stage: HTMLElement;
  private readonly feedback: HTMLElement;
  private readonly debugPanel: HTMLElement;
  private readonly actionSelect: HTMLSelectElement;
  private readonly skinSelect: HTMLSelectElement;
  private readonly overlaySelect: HTMLSelectElement;
  private readonly validationOutput: HTMLElement;
  private readonly stateOutput: HTMLElement;
  private readonly runValidationButton: HTMLButtonElement;
  private readonly renderer: SpineRenderer;
  private readonly stateMachine: PetStateMachine;
  private readonly interactionController: PetInteractionController;
  private readonly roamingController: PetRoamingController;
  private readonly coordinationController: PetCoordinationController;
  private readonly windowLiftController: WindowLiftController;
  private liftNoticeTimer: number | null = null;
  private readonly petShell: HTMLElement;
  private readonly unlisteners: UnlistenFn[] = [];
  private metadata: SpineCharacterMetadata | null = null;
  private readonly currentDefinition: CharacterDefinition;
  private currentActionIndex = 0;
  private validationRunning = false;
  private interactionEnabled = false;
  private pixelProbeSummary = "探针待加载";
  private skinBeforeWalking = "";
  private facingDirection: WalkDirection = "left";
  private roamingSummary = "漫步待初始化";
  private switchGeneration = 0;
  private disposed = false;
  private settings: AppSettings | null = null;
  private currentWindowContext: PetWindowContext | null = null;
  private lastUserInteractionAt = 0;
  private readonly coordinationTimers = new Map<string, number>();
  private liftAction: SpecialActionDefinition | null = null;
  private activeRig: "main" | "lift" = "main";
  private automaticReturnY: number | null = null;
  private automaticReturnFacing: WalkDirection = "left";

  constructor(
    private readonly root: HTMLElement,
    private readonly characterId: CharacterId,
  ) {
    this.currentDefinition = CHARACTER_BY_ID[characterId];
    this.root.innerHTML = `
      <main class="pet-shell" data-debug-mode="false" aria-label="妄想天使桌宠动画窗口">
        <div class="spine-stage" data-spine-stage></div>
        <div class="pet-feedback" data-feedback role="status" aria-live="polite">
          <span class="loading-spinner" aria-hidden="true"></span>
          <span data-feedback-text>正在加载${this.currentDefinition.displayName}…</span>
        </div>
        <aside class="pet-debug-panel" data-debug-panel hidden aria-label="阶段 4 交互自检">
          <header>
            <div>
              <strong>阶段 4 自检</strong>
              <small>按 D 隐藏 · 画布支持点击、悬停和拖拽</small>
            </div>
            <button type="button" data-debug-close aria-label="关闭自检面板">×</button>
          </header>
          <label>身体动作<select data-action-select data-character-control></select></label>
          <div class="debug-row">
            <label>皮肤<select data-skin-select data-character-control></select></label>
            <label>基础表情<select data-overlay-select data-character-control></select></label>
          </div>
          <div class="debug-actions">
            <button type="button" data-previous-action data-character-control>上一个</button>
            <button type="button" data-next-action data-character-control>下一个</button>
            <button type="button" data-run-validation data-character-control>运行全部动画</button>
          </div>
          <div class="debug-actions debug-actions--interaction">
            <button type="button" data-simulate-click data-character-control>模拟单击</button>
            <button type="button" data-simulate-double data-character-control>模拟双击</button>
            <button type="button" data-simulate-rapid data-character-control>模拟连点</button>
            <button type="button" data-simulate-drag data-character-control>模拟拖放</button>
            <button type="button" data-cycle-expressions data-character-control>切换全部表情</button>
            <button type="button" data-validate-interactions data-character-control>交互状态自检</button>
          </div>
          <div class="debug-row">
            <label>漫步方向<select data-walk-direction data-character-control>${ROAMING_DIRECTIONS.map(direction => `<option value="${direction}"${direction === "right" ? " selected" : ""}>${ROAMING_DIRECTION_LABELS[direction]}</option>`).join("")}</select></label>
            <button type="button" data-simulate-walk data-character-control>模拟漫步</button>
          </div>
          <div class="debug-actions debug-actions--secondary">
            <button type="button" data-reload data-character-control>重复加载 ×5</button>
            <button type="button" data-context data-character-control>模拟 WebGL 恢复</button>
            <button type="button" data-simulate-coordination data-character-control>模拟他人点击</button>
            <button type="button" data-cancel-coordination data-character-control>取消联动</button>
            <button type="button" data-gather-coordination data-character-control>集合到本角色</button>
          </div>
          <output data-state-output>状态：尚未加载</output>
          <output data-validation-output>等待自检</output>
        </aside>
      </main>
    `;

    this.stage = this.requireElement<HTMLElement>("[data-spine-stage]");
    this.petShell = this.requireElement<HTMLElement>(".pet-shell");
    this.feedback = this.requireElement<HTMLElement>("[data-feedback]");
    this.debugPanel = this.requireElement<HTMLElement>("[data-debug-panel]");
    this.actionSelect = this.requireElement<HTMLSelectElement>("[data-action-select]");
    this.skinSelect = this.requireElement<HTMLSelectElement>("[data-skin-select]");
    this.overlaySelect = this.requireElement<HTMLSelectElement>("[data-overlay-select]");
    this.stateOutput = this.requireElement<HTMLElement>("[data-state-output]");
    this.validationOutput = this.requireElement<HTMLElement>("[data-validation-output]");
    this.runValidationButton = this.requireElement<HTMLButtonElement>("[data-run-validation]");
    this.renderer = new SpineRenderer(this.stage, {
      onActionComplete: (action, loopCount, playbackId) => {
        this.stateMachine?.handleActionComplete(action, loopCount, playbackId);
      },
      onLoadProgress: (message) => this.setFeedback(message, "loading"),
      onContextChange: (state) => {
        if (state === "lost") this.setFeedback("WebGL 上下文已丢失，正在等待恢复…", "loading");
        else this.hideFeedback();
      },
    });
    this.stateMachine = new PetStateMachine({
      play: (action, loop, overlay) => this.renderer.playAction(action, loop, overlay),
      setOverlay: (overlay) => this.renderer.setOverlay(overlay),
      onStateChange: (snapshot) => this.handleStateChange(snapshot),
      canPlayIdleRandomAction: () =>
        this.interactionEnabled
        && this.debugPanel.hidden
        && !this.validationRunning
        && !this.coordinationController.gaze.hasSceneTargetLock(),
      onCoordinationComplete: (token) => this.coordinationController.complete(token, "completed"),
      onCoordinationCancel: (_token, reason) => void this.coordinationController.cancelActive(reason),
    });
    this.interactionController = new PetInteractionController(this.stage, {
      sampleAlphaAt: (clientX, clientY) => this.renderer.sampleAlphaAt(clientX, clientY),
      onCursorSample: (clientX, clientY) => {
        const interaction = this.interactionController.getSnapshot();
        this.coordinationController.gaze.setMouseTarget(
          clientX,
          clientY,
          interaction.pointerDown || interaction.dragging || interaction.hoverActive,
        );
      },
      onPixelPassthroughSample: (passthrough, alpha) => {
        this.petShell.dataset.pixelPassthrough = String(passthrough);
        const gaze = this.renderer.getDiagnostics().gaze;
        const diagnostic = `逐像素命中：${passthrough ? "透明穿透" : "角色可交互"}；Alpha ${alpha?.toFixed(3) ?? "安全模式"}；视线 ${gaze.x.toFixed(2)},${gaze.y.toFixed(2)}；${this.pixelProbeSummary}；${this.roamingSummary}`;
        this.petShell.setAttribute("aria-label", `妄想天使桌宠动画窗口；${diagnostic}`);
        this.petShell.setAttribute("aria-description", diagnostic);
      },
      onPointerIntent: () => {
        this.coordinationController.gaze.setDirectInteraction(true);
        this.noteUserInteraction();
        this.roamingController?.interrupt();
      },
      onHover: (hovered) => {
        if (this.activeRig === "lift") return;
        if (this.roamingController?.getSnapshot().walking) return;
        this.coordinationController.gaze.setDirectInteraction(hovered);
        if (hovered) this.roamingController?.interrupt();
        if (this.interactionEnabled || !hovered) this.stateMachine.setHovered(hovered);
      },
      onReaction: (kind) => {
        if (!this.interactionEnabled || this.activeRig === "lift") return;
        if (this.stateMachine.trigger(kind)) {
          this.noteUserInteraction();
          this.coordinationController.requestReactionEcho(kind);
        }
      },
      onDragStart: () => {
        // Once the user takes over, never return to the old automatic walk lane.
        this.automaticReturnY = null;
        this.windowLiftController?.notePetDragStart();
        if (this.activeRig === "lift") {
          this.roamingController?.interrupt();
          return;
        }
        if (this.interactionEnabled && this.stateMachine.startDragging()) {
          void this.coordinationController.cancelActive("dragging");
          this.renderer.startDragSway();
        }
      },
      onDragMove: (deltaX, deltaY, elapsedMs) => {
        if (this.interactionEnabled && this.activeRig === "main") {
          this.renderer.pushDragMotion(deltaX, deltaY, elapsedMs);
        }
      },
      onDragEnd: () => {
        void this.handlePetDragEnd();
      },
      onError: (error) => {
        console.error(error);
      },
    });
    this.roamingController = new PetRoamingController({
      canStartWalking: () =>
        this.interactionEnabled
        && this.debugPanel.hidden
        && ["idle", "walking"].includes(this.stateMachine.getSnapshot().state),
      onWalkStart: (direction) => this.startWalking(direction),
      onWalkStop: () => this.stopWalking(),
      onPositionSettled: (context) => this.savePetPosition(context),
      onCoordinatedMoveComplete: (token) => {
        logCoordinationStatus(this.characterId, "move_arrived", { ...token, position: this.roamingController.getSnapshot().context });
        this.coordinationController.complete(token, "completed");
      },
      onCoordinatedMoveCancel: (_token, reason) => void this.coordinationController.cancelActive(reason),
      onSnapshot: (snapshot) => {
        if (snapshot.context) {
          this.currentWindowContext = snapshot.context;
          this.coordinationController.gaze.setWindowContext(snapshot.context);
          void this.coordinationController.report();
        }
        const diagnostics = this.renderer.getDiagnostics();
        const skin = diagnostics.currentSkin || "未加载";
        this.roamingSummary = snapshot.walking
          ? `漫步 (${snapshot.currentX}, ${snapshot.currentY})→(${snapshot.targetX}, ${snapshot.targetY}) ${snapshot.direction} 皮肤=${skin} 镜像=${diagnostics.mirroredFromDefault}`
          : `停留 (${snapshot.currentX}, ${snapshot.currentY})`;
        if (this.liftAction && snapshot.walking && !snapshot.coordinationToken) {
          void this.windowLiftController?.tryAutomaticAttach(this.liftAction);
        }
      },
      onError: (error) => {
        console.error(error);
      },
    });
    this.coordinationController = new PetCoordinationController(this.characterId, {
      getRuntimeState: () => this.buildCoordinationRuntimeState(),
      setGazeTarget: (clientX, clientY, active) => {
        const state = this.stateMachine.getSnapshot().state;
        const allowed = ["idle", "hover", "walking"].includes(state);
        this.renderer.setGazeTarget(clientX, clientY, active && allowed);
      },
      canAcceptCoordinationReaction: () => this.canAcceptCoordinationReaction(),
      canAcceptCoordinationMove: () => this.canAcceptCoordinationMove(),
      onCoordinationReaction: (command) => this.handleCoordinationReaction(command),
      onCoordinationMove: (target, token, mode, expiresAt) => this.handleCoordinationMove(target, token, mode, expiresAt),
      onCoordinationCancel: (token, reason) => this.handleCoordinationCancel(token, reason),
      onCoordinationState: (snapshot) => this.handleCoordinationState(snapshot),
      onError: (error) => console.error(error),
    });
    this.windowLiftController = new WindowLiftController({
      getWindowContext: () => this.currentWindowContext ?? this.roamingController.getSnapshot().context,
      getProbe: () => {
        if (this.activeRig === "lift") return this.renderer.getWindowLiftGeometry();
        const bounds = this.renderer.getVisibleBounds();
        return bounds ? probeFromVisibleBounds(bounds) : null;
      },
      getLiftGeometry: () => this.renderer.getWindowLiftGeometry(),
      canAutomaticallyAttach: () => {
        const roaming = this.roamingController.getSnapshot();
        const interaction = this.interactionController.getSnapshot();
        return Boolean(this.settings?.autoWalk && this.settings?.pets[this.characterId].visible)
          && this.activeRig === "main" && this.interactionEnabled && this.debugPanel.hidden
          && !this.validationRunning && roaming.walking && !roaming.coordinationToken
          && !interaction.pointerDown && !interaction.dragging && !interaction.hoverActive
          && this.stateMachine.getSnapshot().state === "walking";
      },
      onAttached: (action, mode) => this.enterWindowLiftMode(action, mode),
      onDetached: (reason) => this.exitWindowLiftMode(reason),
      onPosition: (context) => this.roamingController.noteExternalPosition(context),
      onNotice: (reason) => this.showWindowLiftNotice(reason),
      onError: (error) => console.error(error),
    });
    this.interactionController.setEnabled(false);
    this.bindControls();
    this.installDebugApi();
  }

  async mount(): Promise<void> {
    this.settings = await this.loadSettingsWithMigration();
    this.liftAction = await getLiftAction(this.characterId);
    this.applySettings(this.settings);
    await this.bindAppEvents();
    await this.coordinationController.mount();
    await this.roamingController.initialize(this.settings.pets[this.characterId].lastPlacement);
    await this.loadCharacter();
    await this.coordinationController.report(true);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener("keydown", this.handleKeydown);
    this.unlisteners.splice(0).forEach((unlisten) => unlisten());
    this.coordinationTimers.forEach((timer) => window.clearTimeout(timer));
    this.coordinationTimers.clear();
    this.coordinationController.dispose();
    this.windowLiftController.dispose();
    if (this.liftNoticeTimer !== null) window.clearTimeout(this.liftNoticeTimer);
    this.interactionController.dispose();
    this.roamingController.dispose();
    this.stateMachine.dispose();
    this.renderer.dispose();
    delete window.__zzzPetDebug;
  }

  private async bindAppEvents(): Promise<void> {
    this.unlisteners.push(
      await listenAppEvent(APP_SETTINGS_STATE, (settings) => this.applySettings(settings)),
    );
  }

  private configureAnimationOptions(metadata: SpineCharacterMetadata): void {
    const runtimeActions = metadata.actions.filter((action) => action !== "0");
    this.fillSelect(this.actionSelect, metadata.bodyActions.filter((action) => action !== "0"));
    this.fillSelect(this.skinSelect, metadata.skins);
    this.fillSelect(
      this.overlaySelect,
      ["", ...this.userFacingOverlays(metadata)],
      "— 无表情叠加 —",
    );
    this.runValidationButton.textContent = `运行 ${runtimeActions.length} 项`;
  }

  private syncControls(): void {
    const { preferredAction, preferredOverlay } = this.currentDefinition;
    this.actionSelect.value = preferredAction;
    this.skinSelect.value = this.renderer.getDiagnostics().currentSkin;
    this.overlaySelect.value = preferredOverlay;
    const actions = this.metadata?.bodyActions.filter((action) => action !== "0") ?? [];
    this.currentActionIndex = Math.max(0, actions.indexOf(preferredAction));
  }

  private fillSelect(select: HTMLSelectElement, values: string[], emptyLabel = ""): void {
    select.replaceChildren(
      ...values.map((value) => {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = value || emptyLabel;
        return option;
      }),
    );
  }

  private bindControls(): void {
    this.actionSelect.addEventListener("change", () => this.playSelectedAction());
    this.skinSelect.addEventListener("change", () => {
      this.renderer.setSkin(this.skinSelect.value);
    });
    this.overlaySelect.addEventListener("change", () => {
      this.stateMachine.setRestOverlay(this.overlaySelect.value);
    });
    this.requireElement<HTMLButtonElement>("[data-previous-action]").addEventListener("click", () => {
      this.stepAction(-1);
    });
    this.requireElement<HTMLButtonElement>("[data-next-action]").addEventListener("click", () => {
      this.stepAction(1);
    });
    this.runValidationButton.addEventListener("click", () => void this.runActionValidation());
    this.requireElement<HTMLButtonElement>("[data-reload]").addEventListener("click", () => {
      void this.runReloadValidation();
    });
    this.requireElement<HTMLButtonElement>("[data-context]").addEventListener("click", () => {
      void this.runContextValidation();
    });
    this.requireElement<HTMLButtonElement>("[data-simulate-coordination]").addEventListener("click", () => {
      this.coordinationController.requestReactionEcho("click");
    });
    this.requireElement<HTMLButtonElement>("[data-cancel-coordination]").addEventListener("click", () => {
      void this.coordinationController.cancelActive("debug_cancelled");
    });
    this.requireElement<HTMLButtonElement>("[data-gather-coordination]").addEventListener("click", () => {
      this.coordinationController.arrange("gather", this.characterId);
    });
    this.requireElement<HTMLButtonElement>("[data-simulate-click]").addEventListener("click", () => {
      this.interactionController.simulateClick();
    });
    this.requireElement<HTMLButtonElement>("[data-simulate-double]").addEventListener("click", () => {
      this.interactionController.simulateDoubleClick();
    });
    this.requireElement<HTMLButtonElement>("[data-simulate-rapid]").addEventListener("click", () => {
      this.interactionController.simulateRapidClick();
    });
    this.requireElement<HTMLButtonElement>("[data-simulate-drag]").addEventListener("click", () => {
      this.interactionController.simulateDrag();
    });
    this.requireElement<HTMLButtonElement>("[data-simulate-walk]").addEventListener("click", () => {
      this.debugPanel.hidden = true;
      this.interactionController.reset();
      this.stateMachine.forceIdle();
      const direction = this.requireElement<HTMLSelectElement>("[data-walk-direction]").value as RoamingDirection;
      void this.roamingController.simulateWalk(120, direction);
    });
    this.requireElement<HTMLButtonElement>("[data-cycle-expressions]").addEventListener("click", () => {
      void this.runExpressionValidation();
    });
    this.requireElement<HTMLButtonElement>("[data-validate-interactions]").addEventListener("click", () => {
      void this.runInteractionValidation();
    });
    this.requireElement<HTMLButtonElement>("[data-debug-close]").addEventListener("click", () => {
      this.debugPanel.hidden = true;
    });
    window.addEventListener("keydown", this.handleKeydown);
  }

  private readonly handleKeydown = (event: KeyboardEvent) => {
    if (event.key === "Escape" && this.windowLiftController.getSnapshot().attached) {
      void this.windowLiftController.detach("escape_key");
      event.preventDefault();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key === ",") {
      void invoke<void>("show_settings_window").catch((error) => {
        console.error(error);
      });
      event.preventDefault();
      return;
    }
    if (event.key.toLowerCase() === "d") {
      if (!this.settings?.debugMode) return;
      this.debugPanel.hidden = !this.debugPanel.hidden;
      this.roamingController.interrupt();
      void this.coordinationController.report(true);
      event.preventDefault();
      return;
    }
    if (this.debugPanel.hidden || event.target instanceof HTMLSelectElement) return;
    if (event.key === "ArrowRight") {
      this.stepAction(1);
      event.preventDefault();
    } else if (event.key === "ArrowLeft") {
      this.stepAction(-1);
      event.preventDefault();
    }
  };

  private async loadCharacter(force = false): Promise<boolean> {
    const definition = this.currentDefinition;
    if (!force && this.activeRig === "main" && this.metadata?.id === this.characterId) return true;
    const generation = ++this.switchGeneration;
    this.setInteractionEnabled(false);
    this.interactionController.reset();
    this.setCharacterControlsDisabled(true);
    this.setFeedback(`正在切换到${definition.displayName}…`, "loading");
    try {
      const metadata = await this.renderer.loadCharacter(definition);
      if (generation !== this.switchGeneration || this.disposed) {
        if (generation === this.switchGeneration) this.setInteractionEnabled(Boolean(this.metadata));
        return false;
      }
      this.metadata = metadata;
      this.activeRig = "main";
      this.petShell.dataset.windowLift = "false";
      this.facingDirection = "left";
      const pixelProbe = this.renderer.diagnosePixelHitTest();
      this.pixelProbeSummary = `透明/角色探针 ${pixelProbe.transparentAlpha?.toFixed(3) ?? "失败"}/${pixelProbe.characterAlpha?.toFixed(3) ?? "失败"}`;
      this.stateMachine.configure(definition, metadata);
      this.configureAnimationOptions(metadata);
      this.syncControls();
      this.hideFeedback();
      this.validationOutput.textContent = `${metadata.actions.length} 个动画 · ${metadata.texturePages.length} 页纹理`;
      this.setInteractionEnabled(true);
      return true;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        if (generation === this.switchGeneration) this.setInteractionEnabled(Boolean(this.metadata));
        return false;
      }
      const message = this.errorMessage(error);
      console.error(error);
      this.setFeedback(`切换失败：${message}`, "error");
      this.setInteractionEnabled(Boolean(this.metadata));
      return false;
    } finally {
      if (generation === this.switchGeneration && !this.validationRunning) {
        this.setCharacterControlsDisabled(false);
      }
    }
  }

  private async handlePetDragEnd(): Promise<void> {
    if (!this.interactionEnabled) return;
    if (this.activeRig === "main") {
      if (this.stateMachine.endDragging()) this.renderer.endDragSway();
    }
    this.coordinationController.gaze.setDirectInteraction(false);
    this.noteUserInteraction();
    await this.refreshRoamingPosition();
    if (this.liftAction) {
      await this.windowLiftController.notePetDragEnd(this.liftAction);
    }
  }

  private async enterWindowLiftMode(action: SpecialActionDefinition, mode: WindowLiftMode): Promise<void> {
    if (this.activeRig === "lift" || this.disposed) return;
    const generation = ++this.switchGeneration;
    this.automaticReturnY = mode === "automatic" ? this.currentWindowContext?.y ?? null : null;
    this.automaticReturnFacing = this.facingDirection;
    this.setInteractionEnabled(false);
    await this.roamingController.pauseForWindowLift();
    if (generation !== this.switchGeneration || this.disposed) return;
    this.stateMachine.forceIdle();
    void this.coordinationController.cancelActive("window_lift");
    this.debugPanel.hidden = true;
    this.setInteractionEnabled(false);
    this.setCharacterControlsDisabled(true);
    this.setFeedback(`正在让${this.currentDefinition.displayName}托举窗口…`, "loading");
    try {
      const definition = liftCharacterDefinition(this.currentDefinition, action);
      const metadata = await this.renderer.loadCharacter(definition);
      if (generation !== this.switchGeneration || this.disposed) return;
      this.metadata = metadata;
      this.activeRig = "lift";
      this.petShell.dataset.windowLift = "true";
      if (!this.stateMachine.startWindowLift(action.bodyAction, action.overlay)) {
        throw new Error("托举状态无法启动");
      }
      this.validationOutput.textContent = `${action.displayName} · 窗口移动时跟随`;
      this.hideFeedback();
      this.setInteractionEnabled(true);
      void this.coordinationController.report(true);
    } catch (error) {
      if (generation === this.switchGeneration) {
        this.setFeedback(`托举失败：${this.errorMessage(error)}`, "error");
        this.setCharacterControlsDisabled(false);
        this.setInteractionEnabled(true);
      }
      throw error;
    }
  }

  private async exitWindowLiftMode(reason: string): Promise<void> {
    if (this.activeRig !== "lift" || this.disposed) return;
    const returnY = this.automaticReturnY;
    const returnFacing = this.automaticReturnFacing;
    this.automaticReturnY = null;
    this.validationOutput.textContent = `已放下窗口：${reason}`;
    const restored = await this.loadCharacter(true);
    if (!restored) throw new Error("恢复主角色骨骼失败");
    const context = this.currentWindowContext;
    if (context) {
      const next = await invoke<PetWindowContext>("move_pet_window", { x: context.x, y: returnY ?? context.y });
      this.roamingController.noteExternalPosition(next);
    }
    if (returnY !== null) this.applyFacingDirection(returnFacing);
  }

  private showWindowLiftNotice(reason: string): void {
    const labels: Record<string, string> = {
      attached: "已托住窗口 · 拖离或按 Esc 放下",
      automatic_attached: "自动托举中 · 10 秒后恢复漫步",
      automatic_timeout: "自动托举结束 · 已恢复日常活动",
      automatic_disabled: "已关闭漫步自动托举",
      no_nearby_window: "未吸附：请将人物头顶靠近普通窗口底边后松手",
      insufficient_visible_space: "未吸附：窗口底边或屏幕边缘没有足够空间容纳人物",
      target_unavailable: "已放下：目标窗口已隐藏、关闭或不再可用",
      settings_disabled: "已关闭窗口托举",
      attachment_failed: "托举加载失败，请重试并查看调试日志",
      tracking_failed: "窗口跟随失败，已安全放下",
      released: "已放下窗口",
    };
    const message = labels[reason] ?? "已放下窗口";
    logWindowLiftStatus(this.characterId, reason);
    this.validationOutput.textContent = message;
    this.setFeedback(message, "ready");
    this.liftNoticeTimer = window.setTimeout(() => {
      this.liftNoticeTimer = null;
      this.hideFeedback();
    }, 2600);
  }

  private setCharacterControlsDisabled(disabled: boolean): void {
    this.root.querySelectorAll<HTMLButtonElement | HTMLSelectElement>("[data-character-control]").forEach((control) => {
      control.disabled = disabled;
    });
  }

  private playSelectedAction(): void {
    if (!this.metadata) return;
    const visibleActions = this.metadata.bodyActions.filter((action) => action !== "0");
    const action = this.actionSelect.value;
    const overlay = this.overlayForAction(action);
    this.currentActionIndex = visibleActions.indexOf(action);
    this.overlaySelect.value = overlay;
    this.stateMachine.setRestPose(action, overlay);
  }

  private stepAction(direction: -1 | 1): void {
    if (!this.metadata || this.validationRunning) return;
    const actions = this.metadata.bodyActions.filter((action) => action !== "0");
    const count = actions.length;
    this.currentActionIndex = (this.currentActionIndex + direction + count) % count;
    this.actionSelect.value = actions[this.currentActionIndex];
    this.playSelectedAction();
  }

  private async runActionValidation(delayMs = 140): Promise<AnimationValidationResult> {
    if (!this.metadata) throw new Error("角色尚未加载完成。");
    if (this.validationRunning) throw new Error("已有自检正在运行。");
    this.validationRunning = true;
    this.setInteractionEnabled(false);
    this.setCharacterControlsDisabled(true);
    const metadata = this.metadata;
    const definition = this.currentDefinition;
    const succeeded: string[] = [];
    const failed: AnimationValidationResult["failed"] = [];
    const actions = metadata.actions.filter((action) => action !== "0");
    this.validationOutput.textContent = `0 / ${actions.length}`;

    try {
      for (const [index, action] of actions.entries()) {
        try {
          this.renderer.playAction(action, false);
          await this.wait(Math.max(50, delayMs));
          succeeded.push(action);
        } catch (error) {
          failed.push({ action, message: this.errorMessage(error) });
        }
        this.validationOutput.textContent = `${index + 1} / ${actions.length}`;
      }
    } finally {
      this.stateMachine.configure(definition, metadata);
      this.actionSelect.value = definition.preferredAction;
      this.overlaySelect.value = definition.preferredOverlay;
      this.currentActionIndex = metadata.bodyActions
        .filter((action) => action !== "0")
        .indexOf(definition.preferredAction);
      this.validationRunning = false;
      this.setCharacterControlsDisabled(false);
      this.setInteractionEnabled(true);
    }

    const result = { attempted: actions.length, succeeded, failed };
    this.validationOutput.textContent = failed.length
      ? `${succeeded.length}/${result.attempted} 通过 · ${failed.length} 失败`
      : `${succeeded.length}/${result.attempted} 动画装载通过`;
    return result;
  }

  private async runReloadValidation(cycles = 5): Promise<ReloadResult> {
    if (this.validationRunning) throw new Error("已有自检正在运行。");
    this.validationRunning = true;
    this.setInteractionEnabled(false);
    this.setCharacterControlsDisabled(true);
    const samples: SpineRendererDiagnostics["memory"][] = [];
    const definition = this.currentDefinition;
    try {
      for (let index = 0; index < Math.max(1, cycles); index += 1) {
        this.validationOutput.textContent = `重新加载 ${index + 1}/${cycles}`;
        this.metadata = await this.renderer.loadCharacter(definition);
        await this.wait(80);
        samples.push({ ...this.renderer.getDiagnostics().memory });
      }
      if (this.metadata) this.configureAnimationOptions(this.metadata);
      if (this.metadata) this.stateMachine.configure(definition, this.metadata);
      this.syncControls();
      this.hideFeedback();
      const lastSample = samples[samples.length - 1];
      const firstSample = samples[0];
      this.validationOutput.textContent = `${cycles} 次重新加载通过 · 纹理 ${firstSample?.textures ?? 0}→${lastSample?.textures ?? 0}`;
      return { cycles, samples };
    } finally {
      this.validationRunning = false;
      this.setCharacterControlsDisabled(false);
      this.setInteractionEnabled(true);
    }
  }

  private async runExpressionValidation(delayMs = 180): Promise<ExpressionValidationResult> {
    if (!this.metadata) throw new Error("角色尚未加载完成。");
    if (this.validationRunning) throw new Error("已有自检正在运行。");
    this.validationRunning = true;
    this.setInteractionEnabled(false);
    this.setCharacterControlsDisabled(true);
    const metadata = this.metadata;
    const definition = this.currentDefinition;
    const overlays = this.userFacingOverlays(metadata);
    const succeeded: string[] = [];
    const failed: ExpressionValidationResult["failed"] = [];

    try {
      this.stateMachine.forceIdle();
      for (const [index, overlay] of overlays.entries()) {
        try {
          this.renderer.setOverlay(overlay);
          this.overlaySelect.value = overlay;
          await this.wait(Math.max(80, delayMs));
          this.renderer.setOverlay(definition.preferredOverlay);
          await this.wait(Math.max(40, Math.floor(delayMs / 2)));
          this.renderer.setPlaying(false);
          this.renderer.setOverlay(definition.preferredOverlay);
          const baselineSlots = this.renderer.getSlotFingerprint();
          this.renderer.setOverlay(overlay);
          this.renderer.setOverlay(definition.preferredOverlay);
          if (this.renderer.getSlotFingerprint() !== baselineSlots) {
            throw new Error("切回常态后槽位附件或颜色未完全恢复");
          }
          this.renderer.setPlaying(true);
          succeeded.push(overlay);
        } catch (error) {
          this.renderer.setPlaying(true);
          failed.push({ overlay, message: this.errorMessage(error) });
        }
        this.validationOutput.textContent = `${index + 1} / ${overlays.length} 表情`;
      }
    } finally {
      this.renderer.setPlaying(true);
      this.stateMachine.configure(definition, metadata);
      this.overlaySelect.value = definition.preferredOverlay;
      this.validationRunning = false;
      this.setCharacterControlsDisabled(false);
      this.setInteractionEnabled(true);
    }

    this.validationOutput.textContent = failed.length
      ? `${succeeded.length}/${overlays.length} 表情往返通过 · ${failed.length} 失败`
      : `${succeeded.length}/${overlays.length} 表情往返通过`;
    return { attempted: overlays.length, succeeded, failed };
  }

  private async runInteractionValidation(): Promise<InteractionValidationResult> {
    if (!this.metadata) throw new Error("角色尚未加载完成。");
    if (this.validationRunning) throw new Error("已有自检正在运行。");
    this.validationRunning = true;
    this.setCharacterControlsDisabled(true);
    const checks: Record<string, boolean> = {};
    const originalRestOverlay = this.stateMachine.getSnapshot().restOverlay;

    try {
      this.interactionController.reset();
      this.stateMachine.clearCooldowns();
      this.stateMachine.forceIdle();
      const hoverTestOverlay = this.userFacingOverlays(this.metadata).find(
        (overlay) =>
          overlay !== this.currentDefinition.preferredOverlay &&
          overlay !== this.currentDefinition.behavior.hoverOverlay,
      ) ?? "";
      this.stateMachine.setRestOverlay(hoverTestOverlay);
      this.stage.dispatchEvent(new PointerEvent("pointerenter", { pointerId: 41, isPrimary: true }));
      await this.wait(80);
      this.stage.dispatchEvent(new PointerEvent("pointerleave", { pointerId: 41, isPrimary: true }));
      await this.wait(340);
      let snapshot = this.stateMachine.getSnapshot();
      checks.quickHoverPreservesRestOverlay =
        snapshot.state === "idle" &&
        snapshot.overlay === hoverTestOverlay &&
        this.renderer.getDiagnostics().currentOverlay === hoverTestOverlay;

      this.stage.dispatchEvent(new PointerEvent("pointerenter", { pointerId: 42, isPrimary: true }));
      await this.wait(340);
      snapshot = this.stateMachine.getSnapshot();
      checks.manualExpressionSurvivesDwellHover =
        snapshot.state === "hover" &&
        snapshot.overlay === hoverTestOverlay &&
        this.renderer.getDiagnostics().currentOverlay === snapshot.overlay;
      this.stage.dispatchEvent(new PointerEvent("pointerleave", { pointerId: 42, isPrimary: true }));
      await this.wait(40);
      snapshot = this.stateMachine.getSnapshot();
      checks.hoverLeaveRestoresRestOverlay =
        snapshot.state === "idle" &&
        snapshot.overlay === hoverTestOverlay &&
        this.renderer.getDiagnostics().currentOverlay === hoverTestOverlay;

      const preferredRestOverlay = this.currentDefinition.preferredOverlay;
      this.stateMachine.setRestOverlay(preferredRestOverlay);
      this.stage.dispatchEvent(new PointerEvent("pointerenter", { pointerId: 43, isPrimary: true }));
      await this.wait(340);
      snapshot = this.stateMachine.getSnapshot();
      checks.defaultDwellUsesHoverOverlay =
        snapshot.state === "hover" &&
        snapshot.overlay === this.currentDefinition.behavior.hoverOverlay &&
        this.renderer.getDiagnostics().currentOverlay === snapshot.overlay;
      this.stage.dispatchEvent(new PointerEvent("pointerleave", { pointerId: 43, isPrimary: true }));
      await this.wait(40);
      checks.defaultHoverLeaveRestores =
        this.stateMachine.getSnapshot().overlay === preferredRestOverlay &&
        this.renderer.getDiagnostics().currentOverlay === preferredRestOverlay;

      this.stateMachine.setRestOverlay(originalRestOverlay);
      const beforeSingle = this.stateMachine.getSnapshot().transitionId;
      this.interactionController.simulateClick();
      await this.wait(340);
      snapshot = this.stateMachine.getSnapshot();
      checks.singleClick = snapshot.transitionId > beforeSingle && snapshot.state === "click_reaction";

      this.stateMachine.clearCooldowns();
      this.stateMachine.forceIdle();
      const transitionBeforeDouble = this.stateMachine.getSnapshot().transitionId;
      this.interactionController.simulateClick();
      await this.wait(80);
      this.interactionController.simulateClick();
      await this.wait(340);
      snapshot = this.stateMachine.getSnapshot();
      const doubleHistory = snapshot.history.filter((entry) => entry.id > transitionBeforeDouble);
      checks.doubleSuppressesSingle =
        doubleHistory.filter((entry) => entry.trigger === "doubleClick").length === 1 &&
        doubleHistory.filter((entry) => entry.trigger === "click").length === 0;

      this.stateMachine.clearCooldowns();
      this.stateMachine.forceIdle();
      const transitionBeforeRapid = this.stateMachine.getSnapshot().transitionId;
      for (let index = 0; index < 5; index += 1) {
        this.interactionController.simulateClick();
        await this.wait(45);
      }
      await this.wait(340);
      snapshot = this.stateMachine.getSnapshot();
      const rapidHistory = snapshot.history.filter((entry) => entry.id > transitionBeforeRapid);
      checks.rapidOnce = rapidHistory.filter((entry) => entry.trigger === "rapidClick").length === 1;

      this.stateMachine.clearCooldowns();
      this.stateMachine.forceIdle();
      this.renderer.startDragSway();
      this.renderer.pushDragMotion(0.3, 0, 16);
      await this.wait(32);
      const tinyMotionSway = this.renderer.getDiagnostics().dragSway;
      checks.tinyMotionDoesNotTwitch =
        Math.abs(tinyMotionSway.angleDegrees) <= 0.04 &&
        Math.abs(tinyMotionSway.velocityDegreesPerSecond) <= 0.5;
      this.renderer.endDragSway();
      await this.wait(32);

      this.stateMachine.trigger("click");
      this.interactionController.simulateDrag();
      snapshot = this.stateMachine.getSnapshot();
      checks.dragInterruptsAndDrops = snapshot.state === "dropped";
      await this.wait(80);
      const activeDragSway = this.renderer.getDiagnostics().dragSway;
      checks.dragSwayRespondsToMotion =
        activeDragSway.active &&
        !activeDragSway.dragging &&
        Math.abs(activeDragSway.angleDegrees) > 0.05;
      await this.wait(100);
      const evolvingDragSway = this.renderer.getDiagnostics().dragSway;
      checks.dragSwayInertiaEvolves =
        evolvingDragSway.active &&
        Math.abs(evolvingDragSway.angleDegrees - activeDragSway.angleDegrees) > 0.15;
      await this.wait(1220);
      const settledDragSway = this.renderer.getDiagnostics().dragSway;
      checks.dragSwaySettlesAfterRelease =
        !settledDragSway.dragging &&
        !settledDragSway.active &&
        Math.abs(settledDragSway.angleDegrees) <= 0.04;
      checks.dropRestores = ["idle", "hover"].includes(this.stateMachine.getSnapshot().state);

      const passed = Object.values(checks).every(Boolean);
      this.validationOutput.textContent = passed
        ? `${Object.keys(checks).length}/${Object.keys(checks).length} 交互状态通过`
        : `交互状态失败：${Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name).join("、")}`;
      return { passed, checks };
    } finally {
      this.interactionController.reset();
      this.stateMachine.setRestOverlay(originalRestOverlay);
      this.stateMachine.forceIdle();
      this.overlaySelect.value = originalRestOverlay;
      this.validationRunning = false;
      this.setCharacterControlsDisabled(false);
      this.setInteractionEnabled(true);
    }
  }

  private async runContextValidation(): Promise<boolean> {
    if (this.validationRunning) throw new Error("已有自检正在运行。");
    this.validationRunning = true;
    this.setInteractionEnabled(false);
    this.setCharacterControlsDisabled(true);
    this.validationOutput.textContent = "正在模拟 WebGL context loss…";
    try {
      const restored = await this.renderer.testContextRecovery();
      this.validationOutput.textContent = restored ? "WebGL context 恢复通过" : "当前环境不支持模拟恢复";
      return restored;
    } finally {
      this.validationRunning = false;
      this.setCharacterControlsDisabled(false);
      this.setInteractionEnabled(true);
    }
  }

  private installDebugApi(): void {
    window.__zzzPetDebug = {
      getState: () => ({
        metadata: this.renderer.getMetadata(),
        renderer: this.renderer.getDiagnostics(),
        behavior: this.stateMachine.getSnapshot(),
        interaction: this.interactionController.getSnapshot(),
        roaming: this.roamingController.getSnapshot(),
        coordination: this.coordinationController.getSnapshot(),
        windowLift: this.windowLiftController.getSnapshot(),
      }),
      play: (action, loop = true) => this.renderer.playAction(action, loop),
      setOverlay: (action) => this.stateMachine.setRestOverlay(action),
      setPlaying: (playing) => this.renderer.setPlaying(playing),
      getSlotFingerprint: () => this.renderer.getSlotFingerprint(),
      diagnosePixelHitTest: () => this.renderer.diagnosePixelHitTest(),
      setSkin: (skin) => this.renderer.setSkin(skin),
      setCharacterScale: (scale) => this.applyCharacterScale(scale),
      cycleAllActions: (delayMs) => this.runActionValidation(delayMs),
      cycleExpressions: (delayMs) => this.runExpressionValidation(delayMs),
      reload: (cycles) => this.runReloadValidation(cycles),
      testContextRecovery: () => this.runContextValidation(),
      simulateClick: () => this.interactionController.simulateClick(),
      simulateDoubleClick: () => this.interactionController.simulateDoubleClick(),
      simulateRapidClick: () => this.interactionController.simulateRapidClick(),
      simulateDrag: () => this.interactionController.simulateDrag(),
      simulateWalk: (distanceCssPx, direction) => this.roamingController.simulateWalk(distanceCssPx, direction),
      validateInteractions: () => this.runInteractionValidation(),
      simulateCoordinationClick: () => this.coordinationController.requestReactionEcho("click"),
      cancelCoordination: () => this.coordinationController.cancelActive("debug_cancelled"),
      arrangeCoordination: (mode) => this.coordinationController.arrange(mode, this.characterId),
    };
  }

  private handleStateChange(snapshot: PetStateSnapshot): void {
    this.petShell.dataset.petState = snapshot.state;
    this.coordinationController.gaze.setActivityAllowed(["idle", "hover", "walking"].includes(snapshot.state));
    this.stateOutput.textContent = `状态轨迹：${snapshot.history
      .slice(-4)
      .map((entry) => entry.state)
      .join(" → ")}`;
    void this.coordinationController.report(true);
  }

  private setInteractionEnabled(enabled: boolean): void {
    this.interactionEnabled = enabled;
    this.interactionController.setEnabled(enabled);
    this.roamingController.setEnabled(
      enabled && this.activeRig === "main" && (this.settings?.autoWalk ?? true),
    );
  }

  private startWalking(direction: WalkDirection): boolean {
    const walkingAction = "动作_走路";
    if (!this.stateMachine.startWalking(walkingAction, this.overlayForAction(walkingAction))) {
      return false;
    }
    this.interactionController.reset();
    this.skinBeforeWalking = this.renderer.getDiagnostics().currentSkin;
    const directionSkin = "朝左";
    if (this.metadata?.skins.includes(directionSkin)) {
      this.renderer.setSkin(directionSkin);
      this.skinSelect.value = directionSkin;
    }
    this.applyFacingDirection(direction);
    return true;
  }

  private stopWalking(): void {
    this.stateMachine.stopWalking();
    if (this.skinBeforeWalking && this.metadata?.skins.includes(this.skinBeforeWalking)) {
      this.renderer.setSkin(this.skinBeforeWalking);
      this.skinSelect.value = this.skinBeforeWalking;
    }
    this.skinBeforeWalking = "";
    this.applyFacingDirection(this.facingDirection);
  }

  private applyFacingDirection(direction: WalkDirection): void {
    this.facingDirection = direction;
    const currentSkin = this.renderer.getDiagnostics().currentSkin;
    this.renderer.setHorizontalMirror(shouldMirrorForFacingDirection(currentSkin, direction));
  }

  private async refreshRoamingPosition(): Promise<void> {
    await this.roamingController.refreshExternalPosition();
  }

  private savePetPosition(context: PetWindowContext): void {
    this.currentWindowContext = context;
    this.coordinationController.gaze.setWindowContext(context);
    this.persistPetSettings({
      lastPlacement: { x: context.x, y: context.y, monitorName: context.monitorName },
    });
    void this.coordinationController.report(true);
  }

  private applyCharacterScale(scale: number): void {
    const normalized = Math.round(Math.min(1.25, Math.max(0.6, scale)) * 100) / 100;
    this.renderer.setCharacterScale(normalized);
    this.persistPetSettings({ scale: normalized });
  }

  private persistPetSettings(patch: Parameters<typeof updatePetSettings>[1]): void {
    void updatePetSettings(this.characterId, patch).catch((error) => {
      console.warn(`${this.currentDefinition.displayName}设置保存失败`, error);
    });
  }

  private applySettings(settings: AppSettings): void {
    this.settings = settings;
    this.petShell.dataset.debugMode = String(settings.debugMode);
    if (!settings.debugMode) this.debugPanel.hidden = true;
    this.renderer.setCharacterScale(settings.pets[this.characterId].scale);
    this.renderer.setPerformance(settings.performanceMode, settings.frameRate);
    this.roamingController.setFrequency(settings.walkFrequency);
    this.roamingController.setSpeed(settings.movementSpeed);
    this.roamingController.setEnabled(
      this.interactionEnabled && this.activeRig === "main" && settings.autoWalk,
    );
    this.windowLiftController.setEnabled(settings.windowLiftEnabled);
    this.windowLiftController.setAutomaticEnabled(settings.autoWindowLiftEnabled);
    this.interactionController.setPreferences({
      clickEnabled: settings.clickEnabled,
      doubleClickEnabled: settings.doubleClickEnabled,
      hoverEnabled: settings.hoverEnabled,
    });
    this.coordinationController.setSettings(settings);
    void this.coordinationController.report(true);
  }

  private noteUserInteraction(): void {
    this.lastUserInteractionAt = Date.now();
    this.coordinationController.noteUserInteraction();
    this.stateMachine.noteUserActivity();
  }

  private buildCoordinationRuntimeState(): CoordinationRuntimeState {
    const state = this.stateMachine.getSnapshot();
    const diagnostics = this.renderer.getDiagnostics();
    const petSettings = this.settings?.pets[this.characterId];
    const context = this.currentWindowContext ?? this.roamingController.getSnapshot().context;
    return {
      sequence: 0,
      state: state.state,
      action: state.action,
      interactionReady: this.interactionEnabled && this.activeRig === "main",
      debugOpen: !this.debugPanel.hidden,
      loaded: Boolean(this.metadata && diagnostics.loaded),
      visible: petSettings?.visible ?? true,
      position: context,
      visualAnchor: context
        ? {
            x: this.stage.clientWidth / 2,
            y: this.stage.clientHeight * 0.72,
            width: this.currentDefinition.behavior.coordination.visualWidthCss,
          }
        : null,
      visualWidthCss: this.currentDefinition.behavior.coordination.visualWidthCss,
      preferredSpacingCss: this.currentDefinition.behavior.coordination.preferredSpacingCss,
      scale: petSettings?.scale ?? diagnostics.characterScale,
      lastUserInteractionAt: this.lastUserInteractionAt,
      reportedAt: Date.now(),
    };
  }

  private canAcceptCoordinationReaction(): boolean {
    if (!this.settings?.coordination.enabled || !this.settings.coordination.reactionEcho) return false;
    if (this.activeRig !== "main" || !this.interactionEnabled || !this.debugPanel.hidden || this.validationRunning) return false;
    return ["idle", "hover"].includes(this.stateMachine.getSnapshot().state);
  }

  private canAcceptCoordinationMove(): boolean {
    if (this.activeRig !== "main" || !this.settings?.coordination.enabled || !this.interactionEnabled || this.validationRunning) return false;
    return this.debugPanel.hidden
      && ["idle", "hover", "walking", "idle_random_action"].includes(this.stateMachine.getSnapshot().state);
  }

  private handleCoordinationReaction(command: CoordinationCommand): void {
    const token = { sceneId: command.sceneId, generation: command.generation };
    const delay = Math.max(0, Math.min(1000, command.delayMs ?? 0));
    const key = `${token.sceneId}:${token.generation}`;
    const timer = window.setTimeout(() => {
      this.coordinationTimers.delete(key);
      if (!this.canAcceptCoordinationReaction() || !command.triggerKind) {
        this.coordinationController.complete(token, "unsupported");
        return;
      }
      if (!this.stateMachine.triggerCoordination(command.triggerKind, token)) {
        this.coordinationController.complete(token, "unsupported");
      }
    }, delay);
    this.coordinationTimers.set(key, timer);
  }

  private handleCoordinationMove(
    target: CoordinationMoveTarget,
    token: CoordinationSceneToken,
    _mode: "gather" | "disperse",
    expiresAt: number,
  ): void {
    const state = this.stateMachine.getSnapshot().state;
    if (state === "hover") this.stateMachine.setHovered(false);
    else if (state === "idle_random_action") this.stateMachine.cancelIdleRandomAction();
    if (!this.roamingController.startCoordinatedMove(target, token, expiresAt)) {
      logCoordinationStatus(this.characterId, "move_start_failed", {
        ...token, state: this.stateMachine.getSnapshot().state, roaming: this.roamingController.getSnapshot(),
      });
      this.coordinationController.complete(token, "unsupported");
    }
  }

  private handleCoordinationCancel(token: CoordinationSceneToken, reason: string): void {
    logCoordinationStatus(this.characterId, "cancelled", { ...token, reason });
    const key = `${token.sceneId}:${token.generation}`;
    const timer = this.coordinationTimers.get(key);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      this.coordinationTimers.delete(key);
    }
    this.roamingController.cancelCoordinatedMove(token);
    const currentToken = this.stateMachine.getSnapshot().coordinationToken;
    if (currentToken?.sceneId === token.sceneId && currentToken.generation === token.generation) {
      this.stateMachine.forceIdle();
    }
    this.coordinationController.gaze.clearSceneTarget();
    this.validationOutput.textContent = `联动已取消：${reason}`;
  }

  private handleCoordinationState(snapshot: CoordinationSnapshot): void {
    const active = snapshot.activeScene;
    this.validationOutput.textContent = active
      ? `联动场景 #${active.sceneId}：${active.kind} · ${active.pendingIds.length} 个待完成`
      : `${snapshot.eventCount} 个联动事件 · 当前空闲`;
  }

  private async loadSettingsWithMigration(): Promise<AppSettings> {
    const settings = await getAppSettings();
    if (this.characterId !== "airui") return settings;
    const patch: Parameters<typeof updatePetSettings>[1] = {};
    try {
      const legacyScale = Number(localStorage.getItem("zzz-idol-character-scale-v1"));
      if (Number.isFinite(legacyScale) && legacyScale >= 0.6 && legacyScale <= 1.25 && settings.pets.airui.scale === 1) {
        patch.scale = legacyScale;
      }
      const rawPosition = localStorage.getItem("zzz-idol-pet-position-v1");
      if (rawPosition && !settings.pets.airui.lastPlacement) {
        const value = JSON.parse(rawPosition) as { x?: unknown; y?: unknown; monitorName?: unknown };
        if (typeof value.x === "number" && typeof value.y === "number") {
          patch.lastPlacement = {
            x: Math.round(value.x),
            y: Math.round(value.y),
            monitorName: typeof value.monitorName === "string" ? value.monitorName : null,
          };
        }
      }
      if (Object.keys(patch).length > 0) {
        const migrated = await updatePetSettings("airui", patch);
        localStorage.removeItem("zzz-idol-character-scale-v1");
        localStorage.removeItem("zzz-idol-pet-position-v1");
        return migrated;
      }
    } catch (error) {
      console.warn("旧设置迁移失败，将使用有效的新设置", error);
    }
    return settings;
  }

  private userFacingOverlays(metadata: SpineCharacterMetadata): string[] {
    return metadata.overlays.filter(
      (overlay) => overlay !== "表情_0" && !overlay.endsWith("_in"),
    );
  }

  private overlayForAction(action: string): string {
    if (!this.metadata) return "";
    const configured = this.currentDefinition.behavior.actionOverlays[action];
    if (configured !== undefined && (!configured || this.metadata.overlays.includes(configured))) {
      return configured;
    }
    const inferred = action.startsWith("动作_") ? `表情_${action.slice("动作_".length)}` : "";
    if (inferred && this.metadata.overlays.includes(inferred)) return inferred;
    return this.metadata.overlays.includes(this.currentDefinition.preferredOverlay)
      ? this.currentDefinition.preferredOverlay
      : "";
  }

  private setFeedback(message: string, state: "loading" | "ready" | "error"): void {
    if (this.liftNoticeTimer !== null) window.clearTimeout(this.liftNoticeTimer);
    this.liftNoticeTimer = null;
    this.feedback.dataset.state = state;
    this.requireElement<HTMLElement>("[data-feedback-text]").textContent = message;
    this.feedback.hidden = false;
  }

  private hideFeedback(): void {
    if (this.liftNoticeTimer !== null) window.clearTimeout(this.liftNoticeTimer);
    this.liftNoticeTimer = null;
    this.feedback.hidden = true;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private wait(milliseconds: number): Promise<void> {
    return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
  }

  private requireElement<T extends Element>(selector: string): T {
    const element = this.root.querySelector<T>(selector);
    if (!element) throw new Error(`界面元素不存在：${selector}`);
    return element;
  }
}

declare global {
  interface Window {
    __zzzPetDebug?: Phase4DebugApi;
  }
}
