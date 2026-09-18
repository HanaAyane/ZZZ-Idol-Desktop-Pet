import type { CharacterDefinition, ReactionKind, WeightedReaction } from "../characters/types";
import type { SpineCharacterMetadata } from "../renderer/SpineRenderer";
import type { CoordinationSceneToken } from "./coordinationTypes";
import { chooseIdleRandomAction, chooseIdleRandomDelay } from "./idleRandomPolicy.ts";

export type PetState =
  | "idle"
  | "walking"
  | "hover"
  | "idle_random_action"
  | "click_reaction"
  | "double_click_reaction"
  | "rapid_click_reaction"
  | "coordination_reaction"
  | "window_lifting"
  | "dragging"
  | "dropped";

export interface PetTransition {
  id: number;
  state: PetState;
  action: string;
  overlay: string;
  trigger: ReactionKind | "idle_random" | "coordination" | "window_lift" | "hover" | "walk" | "drag" | "drop" | "restore";
  at: number;
}

export interface PetStateSnapshot {
  state: PetState;
  action: string;
  overlay: string;
  restAction: string;
  restOverlay: string;
  hovered: boolean;
  transitionId: number;
  cooldownRemainingMs: Record<ReactionKind, number>;
  history: PetTransition[];
  coordinationToken: CoordinationSceneToken | null;
}

export interface PetStateHost {
  play(action: string, loop: boolean, overlay: string): number;
  setOverlay(overlay: string): void;
  onStateChange(snapshot: PetStateSnapshot): void;
  canPlayIdleRandomAction?(): boolean;
  onCoordinationComplete?(token: CoordinationSceneToken): void;
  onCoordinationCancel?(token: CoordinationSceneToken, reason: string): void;
}

interface OneShotPlayback {
  action: string;
  playbackId: number;
  coordinationToken: CoordinationSceneToken | null;
}

const STATE_PRIORITY: Readonly<Record<PetState, number>> = {
  idle: 10,
  walking: 20,
  hover: 30,
  idle_random_action: 40,
  click_reaction: 60,
  double_click_reaction: 70,
  rapid_click_reaction: 75,
  coordination_reaction: 50,
  dropped: 80,
  dragging: 90,
  window_lifting: 100,
};

const REACTION_STATE: Readonly<Record<ReactionKind, PetState>> = {
  click: "click_reaction",
  doubleClick: "double_click_reaction",
  rapidClick: "rapid_click_reaction",
};

const HISTORY_LIMIT = 40;
const DROP_RECOVERY_MS = 360;
const IDLE_RANDOM_RETRY_MS = 5000;

export class PetStateMachine {
  private readonly host: PetStateHost;
  private readonly random: () => number;
  private readonly now: () => number;
  private definition: CharacterDefinition | null = null;
  private metadata: SpineCharacterMetadata | null = null;
  private state: PetState = "idle";
  private currentAction = "";
  private currentOverlay = "";
  private restAction = "";
  private restOverlay = "";
  private currentOneShot: OneShotPlayback | null = null;
  private coordinationToken: CoordinationSceneToken | null = null;
  private hovered = false;
  private transitionId = 0;
  private history: PetTransition[] = [];
  private lastReactionAction = "";
  private sameReactionCount = 0;
  private lastIdleRandomAction = "";
  private dropTimer: number | null = null;
  private idleRandomTimer: number | null = null;
  private idleRandomPlaybackTimer: number | null = null;
  private nextIdleRandomAt: number | null = null;
  private readonly cooldownUntil: Record<ReactionKind, number> = {
    click: 0,
    doubleClick: 0,
    rapidClick: 0,
  };

  constructor(
    host: PetStateHost,
    random: () => number = Math.random,
    now: () => number = Date.now,
  ) {
    this.host = host;
    this.random = random;
    this.now = now;
  }

  configure(definition: CharacterDefinition, metadata: SpineCharacterMetadata): void {
    this.clearDropTimer();
    this.clearIdleRandomTimer();
    this.clearIdleRandomPlaybackTimer();
    this.definition = definition;
    this.metadata = metadata;
    this.currentOneShot = null;
    this.hovered = false;
    this.restAction = this.validBodyAction(definition.preferredAction);
    this.restOverlay = this.validOverlay(definition.preferredOverlay);
    this.lastReactionAction = "";
    this.sameReactionCount = 0;
    this.lastIdleRandomAction = "";
    this.nextIdleRandomAt = null;
    this.cooldownUntil.click = 0;
    this.cooldownUntil.doubleClick = 0;
    this.cooldownUntil.rapidClick = 0;
    this.enterRestState("restore");
  }

  setHovered(hovered: boolean): void {
    this.hovered = hovered;
    if (!this.definition || !this.metadata) return;
    if (this.state !== "idle" && this.state !== "hover") return;

    const nextState: PetState = hovered ? "hover" : "idle";
    const overlay = this.restStateOverlay();
    if (this.state === nextState && this.currentOverlay === overlay) return;
    this.host.setOverlay(overlay);
    this.currentOverlay = overlay;
    this.commit(nextState, hovered ? "hover" : "restore");
  }

  setRestOverlay(overlay: string): void {
    if (!this.definition || !this.metadata) return;
    this.restOverlay = this.validOverlay(overlay);
    if (this.state !== "idle" && this.state !== "hover") return;
    const displayOverlay = this.restStateOverlay();
    if (this.currentOverlay === displayOverlay) return;
    this.host.setOverlay(displayOverlay);
    this.currentOverlay = displayOverlay;
    this.commit(this.hovered ? "hover" : "idle", "restore");
  }

  setRestPose(action: string, overlay: string): void {
    if (!this.definition || !this.metadata) return;
    this.clearDropTimer();
    this.cancelCoordination("debug_override");
    this.currentOneShot = null;
    this.restAction = this.validBodyAction(action);
    this.restOverlay = this.validOverlay(overlay);
    this.currentAction = this.restAction;
    this.currentOverlay = this.restStateOverlay();
    this.host.play(this.currentAction, true, this.currentOverlay);
    this.commit(this.hovered ? "hover" : "idle", "restore");
  }

  startWalking(action = "动作_走路", overlay = ""): boolean {
    if (!this.definition || !this.metadata || this.state !== "idle" || this.hovered) return false;
    const walkingAction = this.validBodyAction(action);
    if (walkingAction !== action) return false;
    this.clearDropTimer();
    this.currentOneShot = null;
    this.currentAction = walkingAction;
    this.currentOverlay = this.validOverlay(overlay);
    this.host.play(this.currentAction, true, this.currentOverlay);
    this.commit("walking", "walk");
    return true;
  }

  stopWalking(): boolean {
    if (this.state !== "walking") return false;
    this.enterRestState("restore");
    return true;
  }

  trigger(kind: ReactionKind): boolean {
    if (!this.definition || !this.metadata) return false;
    const nextState = REACTION_STATE[kind];
    if (STATE_PRIORITY[this.state] >= STATE_PRIORITY[nextState]) return false;
    const now = this.now();
    if (this.cooldownUntil[kind] > now) return false;

    const reaction = this.chooseReaction(this.definition.behavior.reactions[kind]);
    if (!reaction) return false;
    this.cancelCoordination("direct_interaction");
    this.clearDropTimer();
    this.cooldownUntil[kind] = now + this.definition.behavior.cooldownMs[kind];
    this.currentOneShot = null;
    this.currentAction = reaction.action;
    this.currentOverlay = reaction.overlay;
    const playbackId = this.host.play(reaction.action, false, reaction.overlay);
    this.currentOneShot = { action: reaction.action, playbackId, coordinationToken: null };
    this.trackRepeatedReaction(reaction.action);
    this.commit(nextState, kind);
    return true;
  }

  triggerCoordination(kind: "click" | "doubleClick", token: CoordinationSceneToken): boolean {
    if (!this.definition || !this.metadata || this.coordinationToken) return false;
    if (STATE_PRIORITY[this.state] >= STATE_PRIORITY.coordination_reaction) return false;
    const reaction = this.chooseReaction(this.definition.behavior.reactions[kind]);
    if (!reaction) return false;
    this.clearDropTimer();
    this.currentOneShot = null;
    this.currentAction = reaction.action;
    this.currentOverlay = reaction.overlay;
    const playbackId = this.host.play(reaction.action, false, reaction.overlay);
    this.coordinationToken = token;
    this.currentOneShot = { action: reaction.action, playbackId, coordinationToken: token };
    this.trackRepeatedReaction(reaction.action);
    this.commit("coordination_reaction", "coordination");
    return true;
  }

  triggerIdleRandomAction(): boolean {
    if (!this.definition || !this.metadata || this.state !== "idle" || this.hovered) return false;
    if (this.host.canPlayIdleRandomAction && !this.host.canPlayIdleRandomAction()) return false;
    const action = chooseIdleRandomAction(
      this.definition.behavior.idleRandom.actions,
      this.metadata.bodyActions,
      this.lastIdleRandomAction,
      this.random,
    );
    if (!action) return false;
    const overlay = this.validOverlay(this.definition.behavior.actionOverlays[action] ?? "");
    this.clearDropTimer();
    this.clearIdleRandomTimer();
    this.clearIdleRandomPlaybackTimer();
    this.currentOneShot = null;
    this.currentAction = action;
    this.currentOverlay = overlay;
    this.host.play(action, true, overlay);
    this.lastIdleRandomAction = action;
    this.nextIdleRandomAt = this.now() + chooseIdleRandomDelay(
      this.definition.behavior.idleRandom.delayMs,
      this.random,
    );
    this.idleRandomPlaybackTimer = window.setTimeout(() => {
      this.idleRandomPlaybackTimer = null;
      if (this.state === "idle_random_action") this.enterRestState("restore");
    }, Math.max(0, this.definition.behavior.idleRandom.durationMs));
    this.commit("idle_random_action", "idle_random");
    return true;
  }

  cancelIdleRandomAction(): boolean {
    if (this.state !== "idle_random_action") return false;
    this.currentOneShot = null;
    this.enterRestState("restore");
    return true;
  }

  noteUserActivity(): void {
    if (!this.definition) return;
    this.nextIdleRandomAt = this.now() + chooseIdleRandomDelay(
      this.definition.behavior.idleRandom.delayMs,
      this.random,
    );
    if (this.state === "idle") this.scheduleIdleRandomAction();
  }

  startDragging(): boolean {
    if (!this.definition || !this.metadata || this.state === "dragging") return false;
    this.clearDropTimer();
    this.cancelCoordination("dragging");
    this.currentOneShot = null;
    this.currentAction = this.restAction;
    this.currentOverlay = this.validOverlay(this.definition.behavior.dragOverlay);
    this.host.play(this.currentAction, true, this.currentOverlay);
    this.commit("dragging", "drag");
    return true;
  }

  endDragging(): boolean {
    if (!this.definition || this.state !== "dragging") return false;
    this.currentOneShot = null;
    this.currentAction = this.restAction;
    this.currentOverlay = this.restOverlay;
    this.host.play(this.currentAction, true, this.currentOverlay);
    this.commit("dropped", "drop");
    this.dropTimer = window.setTimeout(() => {
      this.dropTimer = null;
      this.enterRestState("restore");
    }, DROP_RECOVERY_MS);
    return true;
  }

  startWindowLift(action: string, overlay: string): boolean {
    if (!this.definition || !this.metadata) return false;
    this.clearDropTimer();
    this.clearIdleRandomTimer();
    this.clearIdleRandomPlaybackTimer();
    this.cancelCoordination("window_lift");
    this.currentOneShot = null;
    this.hovered = false;
    this.currentAction = action;
    this.currentOverlay = overlay;
    this.host.play(action, true, overlay);
    this.commit("window_lifting", "window_lift");
    return true;
  }

  handleActionComplete(action: string, _loopCount: number, playbackId: number): boolean {
    if (
      !this.currentOneShot ||
      action !== this.currentOneShot.action ||
      playbackId !== this.currentOneShot.playbackId
    ) {
      return false;
    }
    const coordinationToken = this.currentOneShot.coordinationToken;
    this.currentOneShot = null;
    this.coordinationToken = null;
    if (coordinationToken) this.host.onCoordinationComplete?.(coordinationToken);
    this.enterRestState("restore");
    return true;
  }

  forceIdle(): void {
    if (!this.definition || !this.metadata) return;
    this.clearDropTimer();
    this.cancelCoordination("forced_idle");
    this.currentOneShot = null;
    this.enterRestState("restore");
  }

  clearCooldowns(): void {
    this.cooldownUntil.click = 0;
    this.cooldownUntil.doubleClick = 0;
    this.cooldownUntil.rapidClick = 0;
  }

  getSnapshot(): PetStateSnapshot {
    const now = this.now();
    return {
      state: this.state,
      action: this.currentAction,
      overlay: this.currentOverlay,
      restAction: this.restAction,
      restOverlay: this.restOverlay,
      hovered: this.hovered,
      transitionId: this.transitionId,
      cooldownRemainingMs: {
        click: Math.max(0, this.cooldownUntil.click - now),
        doubleClick: Math.max(0, this.cooldownUntil.doubleClick - now),
        rapidClick: Math.max(0, this.cooldownUntil.rapidClick - now),
      },
      history: this.history.map((entry) => ({ ...entry })),
      coordinationToken: this.coordinationToken,
    };
  }

  dispose(): void {
    this.clearDropTimer();
    this.clearIdleRandomTimer();
    this.clearIdleRandomPlaybackTimer();
    this.cancelCoordination("disposed");
    this.nextIdleRandomAt = null;
    this.definition = null;
    this.metadata = null;
  }

  private enterRestState(trigger: PetTransition["trigger"]): void {
    if (!this.definition || !this.metadata) return;
    this.currentOneShot = null;
    const nextState: PetState = this.hovered ? "hover" : "idle";
    this.currentAction = this.restAction;
    this.currentOverlay = this.restStateOverlay();
    this.host.play(this.currentAction, true, this.currentOverlay);
    this.commit(nextState, trigger);
  }

  private cancelCoordination(reason: string): void {
    const token = this.coordinationToken;
    if (!token) return;
    this.coordinationToken = null;
    this.currentOneShot = null;
    this.host.onCoordinationCancel?.(token, reason);
  }

  private chooseReaction(pool: WeightedReaction[]): WeightedReaction | null {
    const available = pool.filter(
      (reaction) =>
        this.metadata?.bodyActions.includes(reaction.action) &&
        (!reaction.overlay || this.metadata?.overlays.includes(reaction.overlay)),
    );
    if (available.length === 0) return null;
    const candidates =
      this.sameReactionCount >= 2 && available.some((reaction) => reaction.action !== this.lastReactionAction)
        ? available.filter((reaction) => reaction.action !== this.lastReactionAction)
        : available;
    const totalWeight = candidates.reduce((total, reaction) => total + Math.max(0, reaction.weight), 0);
    if (totalWeight <= 0) return candidates[0] ?? null;
    let cursor = this.random() * totalWeight;
    for (const reaction of candidates) {
      cursor -= Math.max(0, reaction.weight);
      if (cursor <= 0) return reaction;
    }
    return candidates[candidates.length - 1] ?? null;
  }

  private trackRepeatedReaction(action: string): void {
    if (action === this.lastReactionAction) this.sameReactionCount += 1;
    else {
      this.lastReactionAction = action;
      this.sameReactionCount = 1;
    }
  }

  private validBodyAction(action: string): string {
    if (this.metadata?.bodyActions.includes(action)) return action;
    return this.metadata?.bodyActions.includes("动作_待机")
      ? "动作_待机"
      : this.metadata?.bodyActions[0] ?? action;
  }

  private validOverlay(overlay: string): string {
    return overlay && this.metadata?.overlays.includes(overlay) ? overlay : "";
  }

  private restStateOverlay(): string {
    if (!this.definition || !this.hovered) return this.restOverlay;
    const preferredOverlay = this.validOverlay(this.definition.preferredOverlay);
    // A non-default selection is an explicit inspection choice. Hover may
    // update the state, but it must not replace the expression being checked.
    if (this.restOverlay !== preferredOverlay) return this.restOverlay;
    return this.validOverlay(this.definition.behavior.hoverOverlay);
  }

  private commit(state: PetState, trigger: PetTransition["trigger"]): void {
    this.state = state;
    if (state !== "idle") this.clearIdleRandomTimer();
    if (state !== "idle_random_action") this.clearIdleRandomPlaybackTimer();
    const transition: PetTransition = {
      id: ++this.transitionId,
      state,
      action: this.currentAction,
      overlay: this.currentOverlay,
      trigger,
      at: this.now(),
    };
    this.history.push(transition);
    if (this.history.length > HISTORY_LIMIT) this.history.splice(0, this.history.length - HISTORY_LIMIT);
    this.host.onStateChange(this.getSnapshot());
    if (state === "idle") this.scheduleIdleRandomAction();
  }

  private clearDropTimer(): void {
    if (this.dropTimer === null) return;
    window.clearTimeout(this.dropTimer);
    this.dropTimer = null;
  }

  private scheduleIdleRandomAction(retryDelayMs?: number): void {
    this.clearIdleRandomTimer();
    if (!this.definition || !this.metadata || this.state !== "idle" || this.hovered) return;
    if (this.definition.behavior.idleRandom.actions.length === 0) return;
    if (this.nextIdleRandomAt === null) {
      this.nextIdleRandomAt = this.now() + chooseIdleRandomDelay(
        this.definition.behavior.idleRandom.delayMs,
        this.random,
      );
    }
    const delay = retryDelayMs ?? Math.max(0, this.nextIdleRandomAt - this.now());
    this.idleRandomTimer = window.setTimeout(() => {
      this.idleRandomTimer = null;
      if (!this.triggerIdleRandomAction()) this.scheduleIdleRandomAction(IDLE_RANDOM_RETRY_MS);
    }, delay);
  }

  private clearIdleRandomTimer(): void {
    if (this.idleRandomTimer === null) return;
    window.clearTimeout(this.idleRandomTimer);
    this.idleRandomTimer = null;
  }

  private clearIdleRandomPlaybackTimer(): void {
    if (this.idleRandomPlaybackTimer === null) return;
    window.clearTimeout(this.idleRandomPlaybackTimer);
    this.idleRandomPlaybackTimer = null;
  }
}
