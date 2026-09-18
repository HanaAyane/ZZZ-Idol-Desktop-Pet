import { invoke } from "@tauri-apps/api/core";
import { logCoordinationStatus } from "../diagnostics";
import type { UnlistenFn } from "@tauri-apps/api/event";
import type { AppSettings } from "../settings/appSettings";
import { COORDINATION_STATE, PET_COORDINATION_CANCELLED, PET_COORDINATION_COMMAND, listenAppEvent } from "../characters/events";
import type { CharacterId, ReactionKind } from "../characters/types";
import { isNativeRuntime } from "../settings/appSettings";
import { calculateGroupLayout } from "./groupLayout";
import { orderedCharacterIds } from "./coordinationPolicy";
import { PetGazeIntentController } from "./PetGazeIntentController";
import {
  sceneTokenMatches,
  type CoordinationCancelledEvent,
  type CoordinationCommand,
  type CoordinationControllerSnapshot,
  type CoordinationMoveTarget,
  type CoordinationOutcome,
  type CoordinationRuntimeState,
  type CoordinationSceneToken,
  type CoordinationSnapshot,
} from "./coordinationTypes";

export interface PetCoordinationHost {
  getRuntimeState(): CoordinationRuntimeState;
  setGazeTarget(clientX: number | null, clientY: number | null, active: boolean): void;
  canAcceptCoordinationReaction(): boolean;
  canAcceptCoordinationMove(): boolean;
  onCoordinationReaction(command: CoordinationCommand): void;
  onCoordinationMove(target: CoordinationMoveTarget, token: CoordinationSceneToken, mode: "gather" | "disperse", expiresAt: number): void;
  onCoordinationCancel(token: CoordinationSceneToken, reason: string): void;
  onCoordinationState(snapshot: CoordinationSnapshot): void;
  onError(error: unknown): void;
}

export class PetCoordinationController {
  readonly gaze: PetGazeIntentController;
  private readonly unlisteners: UnlistenFn[] = [];
  private readonly native = isNativeRuntime();
  private sequence = 0;
  private lastUserInteractionAt = 0;
  private latest: CoordinationSnapshot | null = null;
  private activeToken: CoordinationSceneToken | null = null;
  private disposed = false;
  private heartbeatTimer: number | null = null;
  private enabled = true;
  private reactionEchoEnabled = true;
  private partnerGazeEnabled = true;
  private lastReportSignature = "";

  constructor(
    private readonly characterId: CharacterId,
    private readonly host: PetCoordinationHost,
  ) {
    this.gaze = new PetGazeIntentController(characterId, {
      setGazeTarget: (clientX, clientY, active) => host.setGazeTarget(clientX, clientY, active),
    });
  }

  async mount(): Promise<void> {
    if (this.disposed) return;
    this.unlisteners.push(
      await listenAppEvent(PET_COORDINATION_COMMAND, (command) => this.handleCommand(command)),
      await listenAppEvent(PET_COORDINATION_CANCELLED, (event) => this.handleCancelled(event)),
      await listenAppEvent(COORDINATION_STATE, (snapshot) => this.handleState(snapshot)),
    );
    if (!this.native) return;
    this.heartbeatTimer = window.setInterval(() => {
      void this.report(true);
    }, 1000);
    try {
      const snapshot = await invoke<CoordinationSnapshot>("get_coordination_snapshot");
      this.handleState(snapshot);
    } catch (error) {
      this.host.onError(error);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unlisteners.splice(0).forEach((unlisten) => unlisten());
    if (this.heartbeatTimer !== null) window.clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.gaze.dispose();
  }

  setSettings(settings: AppSettings): void {
    this.enabled = settings.coordination.enabled;
    this.reactionEchoEnabled = settings.coordination.reactionEcho;
    this.partnerGazeEnabled = settings.coordination.partnerGaze;
    this.gaze.setEnabled(this.enabled && settings.gazeTracking);
    this.gaze.setPartnerGazeEnabled(this.partnerGazeEnabled);
    if (!this.enabled || !this.partnerGazeEnabled) this.gaze.clearSceneTarget();
    if (!this.enabled) void this.cancelActive("settings_disabled");
  }

  noteUserInteraction(): void {
    this.lastUserInteractionAt = Date.now();
    this.gaze.clearSceneTarget();
    void this.report(true);
  }

  async report(force = false): Promise<void> {
    if (this.disposed) return;
    const state = this.createRuntimeState();
    const signature = JSON.stringify({
      state: state.state,
      action: state.action,
      interactionReady: state.interactionReady,
      debugOpen: state.debugOpen,
      loaded: state.loaded,
      visible: state.visible,
      position: state.position,
      visualAnchor: state.visualAnchor,
      scale: state.scale,
      lastUserInteractionAt: state.lastUserInteractionAt,
    });
    if (!force && signature === this.lastReportSignature) return;
    this.lastReportSignature = signature;
    state.sequence = ++this.sequence;
    this.gaze.setSelfSnapshot(state);
    if (!this.native) return;
    try {
      const snapshot = await invoke<CoordinationSnapshot>("report_pet_runtime_state", { snapshot: state });
      this.handleState(snapshot);
    } catch (error) {
      this.host.onError(error);
    }
  }

  requestReactionEcho(kind: ReactionKind): void {
    if (!this.native || !this.enabled || !this.reactionEchoEnabled) return;
    if (kind !== "click" && kind !== "doubleClick") return;
    void invoke<CoordinationSnapshot>("request_coordination_scene", {
      kind: "reactionEcho",
      triggerKind: kind,
    }).then((snapshot) => this.handleState(snapshot)).catch((error) => this.host.onError(error));
  }

  arrange(mode: "gather" | "disperse", anchorCharacterId: CharacterId | null = null): void {
    if (!this.native || !this.enabled) return;
    void invoke<CoordinationSnapshot>("arrange_pet_group", {
      mode,
      anchorCharacterId,
    }).then((snapshot) => this.handleState(snapshot)).catch((error) => this.host.onError(error));
  }

  complete(token: CoordinationSceneToken, outcome: CoordinationOutcome): void {
    logCoordinationStatus(this.characterId, "complete", { ...token, outcome, activeToken: this.activeToken });
    if (!sceneTokenMatches(this.activeToken, token)) return;
    this.activeToken = null;
    if (!this.native) return;
    void invoke<CoordinationSnapshot>("complete_coordination_scene", {
      sceneId: token.sceneId,
      generation: token.generation,
      outcome,
    }).then((snapshot) => this.handleState(snapshot)).catch((error) => this.host.onError(error));
  }

  cancelActive(reason: string): Promise<void> {
    return this.cancelActiveInternal(reason);
  }

  getSnapshot(): CoordinationControllerSnapshot {
    return {
      sequence: this.sequence,
      lastUserInteractionAt: this.lastUserInteractionAt,
      latest: this.latest,
      activeToken: this.activeToken,
    };
  }

  private async cancelActiveInternal(reason: string): Promise<void> {
    const token = this.activeToken;
    if (!token) return;
    this.activeToken = null;
    this.host.onCoordinationCancel(token, reason);
    if (!this.native) return;
    try {
      const snapshot = await invoke<CoordinationSnapshot>("cancel_coordination_scene", {
        sceneId: token.sceneId,
        generation: token.generation,
        reason,
      });
      this.handleState(snapshot);
    } catch (error) {
      this.host.onError(error);
    }
  }

  private handleState(snapshot: CoordinationSnapshot): void {
    if (this.disposed || !snapshot) return;
    this.latest = snapshot;
    this.gaze.setSnapshots(snapshot.pets);
    this.host.onCoordinationState(snapshot);
    const active = snapshot.activeScene;
    if (active && active.pendingIds.includes(this.characterId)) {
      this.activeToken = { sceneId: active.sceneId, generation: active.generation };
    } else if (!active && this.activeToken) {
      this.activeToken = null;
    }
  }

  private handleCommand(command: CoordinationCommand): void {
    if (this.disposed || !command.participantIds.includes(this.characterId)) return;
    const token = { sceneId: command.sceneId, generation: command.generation };
    this.activeToken = token;
    if (command.kind === "reactionEcho") {
      if (this.enabled && this.reactionEchoEnabled && this.host.canAcceptCoordinationReaction()) {
        this.host.onCoordinationReaction(command);
      } else {
        this.complete(token, "unsupported");
      }
      return;
    }
    if ((command.kind === "gather" || command.kind === "disperse") && command.layout) {
      if (!this.enabled || !this.host.canAcceptCoordinationMove()) {
        logCoordinationStatus(this.characterId, "move_rejected", { ...token, enabled: this.enabled, runtime: this.createRuntimeState() });
        this.complete(token, "unsupported");
        return;
      }
      const layout = calculateGroupLayout(
        this.latest?.pets ?? { [this.characterId]: this.createRuntimeState() },
        command.participantIds,
        {
          ...command.layout,
          anchorCharacterId: command.kind === "gather" ? command.actorId : null,
        },
      );
      if (command.kind === "gather") this.applyGatherGaze(command.participantIds);
      else this.gaze.clearSceneTarget();
      const target = layout.targets[this.characterId];
      logCoordinationStatus(this.characterId, "move_requested", {
        ...token, mode: command.kind, actorId: command.actorId, participantIds: command.participantIds,
        from: this.host.getRuntimeState().position, target, degradedReason: layout.degradedReason,
      });
      if (!target) this.complete(token, "unsupported");
      else this.host.onCoordinationMove(target, token, command.kind, command.expiresAt);
    }
  }

  private handleCancelled(event: CoordinationCancelledEvent): void {
    const token = { sceneId: event.sceneId, generation: event.generation };
    if (!sceneTokenMatches(this.activeToken, token)) return;
    this.activeToken = null;
    this.host.onCoordinationCancel(token, event.reason);
  }

  private applyGatherGaze(participantIds: CharacterId[]): void {
    const orderedIds = orderedCharacterIds(participantIds);
    const selfIndex = orderedIds.indexOf(this.characterId);
    if (selfIndex < 0 || orderedIds.length === 0) {
      this.gaze.clearSceneTarget();
      return;
    }
    if (orderedIds.length === 1) {
      this.gaze.setSceneTarget(null);
      return;
    }
    if (orderedIds.length === 2) {
      this.gaze.setSceneTarget(orderedIds[selfIndex === 0 ? 1 : 0]);
      return;
    }
    const centerId = orderedIds[Math.floor(orderedIds.length / 2)];
    this.gaze.setSceneTarget(this.characterId === centerId ? null : centerId);
  }

  private createRuntimeState(): CoordinationRuntimeState {
    const state = this.host.getRuntimeState();
    return {
      ...state,
      sequence: this.sequence,
      lastUserInteractionAt: Math.max(state.lastUserInteractionAt, this.lastUserInteractionAt),
      reportedAt: Date.now(),
    };
  }
}
