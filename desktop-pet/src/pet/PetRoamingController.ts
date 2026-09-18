import { invoke } from "@tauri-apps/api/core";
import type { CoordinationMoveTarget, CoordinationSceneToken } from "./coordinationTypes";
import { planRoamingTarget, ROAMING_DIRECTIONS, roamingFacing, type RoamingDirection } from "./roamingGeometry.ts";

export type WalkDirection = "left" | "right";

export interface WorkArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PetWindowContext {
  x: number;
  y: number;
  width: number;
  height: number;
  scaleFactor: number;
  monitorName: string | null;
  workArea: WorkArea;
}

export interface PetRoamingSnapshot {
  enabled: boolean;
  walking: boolean;
  direction: RoamingDirection | null;
  targetX: number | null;
  targetY: number | null;
  currentX: number | null;
  currentY: number | null;
  monitorName: string | null;
  nextWalkInMs: number | null;
  context: PetWindowContext | null;
  coordinationToken: CoordinationSceneToken | null;
}

export interface PetRoamingHost {
  canStartWalking(): boolean;
  onWalkStart(direction: WalkDirection): boolean;
  onWalkStop(): void;
  onPositionSettled(context: PetWindowContext): void;
  onCoordinatedMoveComplete?(token: CoordinationSceneToken): void;
  onCoordinatedMoveCancel?(token: CoordinationSceneToken, reason: string): void;
  onSnapshot?(snapshot: PetRoamingSnapshot): void;
  onError(error: unknown): void;
}

const MIN_IDLE_MS = 5000;
const MAX_IDLE_MS = 11000;
const WALK_SPEED_CSS_PX_PER_SECOND = 54;
const MIN_WALK_DISTANCE_CSS_PX = 80;
const MAX_WALK_DISTANCE_CSS_PX = 240;
const MAX_WALK_FRAME_DELTA_MS = 50;
// Leave room for native positioning and completion reports within the 8s scene.
const MAX_COORDINATED_MOVE_MS = 6000;
const COORDINATION_COMPLETION_MARGIN_MS = 1000;
const SNAPSHOT_INTERVAL_MS = 200;

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

export class PetRoamingController {
  private readonly native = Boolean(window.__TAURI_INTERNALS__);
  private idleTimer: number | null = null;
  private walkAnimationFrame: number | null = null;
  private context: PetWindowContext | null = null;
  private targetX: number | null = null;
  private targetY: number | null = null;
  private direction: RoamingDirection | null = null;
  private preciseX: number | null = null;
  private preciseY: number | null = null;
  private coordinatedMoveDeadline: number | null = null;
  private lastWalkFrameAt: number | null = null;
  private lastSnapshotAt = 0;
  private nextWalkAt: number | null = null;
  private enabled = true;
  private frequency = 1;
  private speed = 1;
  private walking = false;
  private disposed = false;
  private operation: Promise<void> = Promise.resolve();
  private walkGeneration = 0;
  private coordinationToken: CoordinationSceneToken | null = null;
  private readonly host: PetRoamingHost;
  private readonly random: () => number;
  private readonly now: () => number;

  constructor(
    host: PetRoamingHost,
    random: () => number = Math.random,
    now: () => number = Date.now,
  ) {
    this.host = host;
    this.random = random;
    this.now = now;
  }

  async initialize(savedPosition: { x: number; y: number } | null = this.readSavedPosition()): Promise<void> {
    if (!this.native || this.disposed || this.context) return;
    try {
      this.context = savedPosition
        ? await invoke<PetWindowContext>("restore_pet_window", savedPosition)
        : await invoke<PetWindowContext>("initialize_pet_window");
      if (this.disposed) return;
      this.host.onPositionSettled(this.context);
      this.scheduleNextWalk();
    } catch (error) {
      if (!this.disposed) this.host.onError(error);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelWalking(false);
    this.clearIdleTimer();
  }

  setEnabled(enabled: boolean): void {
    if (this.disposed || this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) {
      this.cancelWalking(true);
      this.clearIdleTimer();
    } else this.scheduleNextWalk();
  }

  setFrequency(multiplier: number): void {
    this.frequency = Math.min(2, Math.max(0.5, multiplier));
    if (!this.walking) this.scheduleNextWalk();
  }

  setSpeed(multiplier: number): void {
    this.speed = Math.min(2, Math.max(0.5, multiplier));
  }

  interrupt(): void {
    this.cancelWalking(true);
    this.scheduleNextWalk();
  }

  async pauseForWindowLift(): Promise<void> {
    this.setEnabled(false);
    // Drain an already-dispatched native walk move before lift alignment begins.
    await this.operation;
  }

  noteExternalPosition(context: PetWindowContext): void {
    this.context = context;
    this.emitSnapshot();
    if (!this.walking) this.host.onPositionSettled(context);
  }

  async refreshExternalPosition(): Promise<PetWindowContext | null> {
    if (!this.native || this.disposed) return null;
    try {
      const context = await invoke<PetWindowContext>("get_pet_window_context");
      if (this.disposed) return null;
      this.noteExternalPosition(context);
      this.scheduleNextWalk();
      return context;
    } catch (error) {
      if (!this.disposed) this.host.onError(error);
      return null;
    }
  }

  async simulateWalk(distanceCssPx = 120, direction: RoamingDirection = "right"): Promise<boolean> {
    if (!this.native || this.disposed || this.walking || !this.context) return false;
    return this.startWalk(distanceCssPx, true, direction);
  }

  startCoordinatedMove(target: CoordinationMoveTarget, token: CoordinationSceneToken, expiresAt?: number): boolean {
    if (this.disposed || !this.native || !this.context) return false;
    if (this.coordinationToken) return false;
    if (this.walking) this.cancelWalking(true, "replaced_by_coordination");
    const direction: WalkDirection = target.x >= this.context.x ? "right" : "left";
    const durationMs = expiresAt === undefined ? MAX_COORDINATED_MOVE_MS : Math.min(
      MAX_COORDINATED_MOVE_MS,
      Math.max(0, expiresAt - this.now() - COORDINATION_COMPLETION_MARGIN_MS),
    );
    return this.beginMovement(target.x, target.y, direction, token, durationMs);
  }

  cancelCoordinatedMove(token?: CoordinationSceneToken): void {
    if (!this.coordinationToken) return;
    if (token && (token.sceneId !== this.coordinationToken.sceneId || token.generation !== this.coordinationToken.generation)) return;
    this.cancelWalking(true, "coordination_cancelled");
  }

  getSnapshot(): PetRoamingSnapshot {
    return {
      enabled: this.enabled,
      walking: this.walking,
      direction: this.direction,
      targetX: this.targetX,
      targetY: this.targetY,
      currentX: this.context?.x ?? null,
      currentY: this.context?.y ?? null,
      monitorName: this.context?.monitorName ?? null,
      nextWalkInMs: this.nextWalkAt === null ? null : Math.max(0, this.nextWalkAt - this.now()),
      context: this.context,
      coordinationToken: this.coordinationToken,
    };
  }

  private scheduleNextWalk(delayMs?: number): void {
    this.clearIdleTimer();
    if (!this.native || this.disposed || !this.enabled || this.walking) return;
    const delay = delayMs ?? (MIN_IDLE_MS + this.random() * (MAX_IDLE_MS - MIN_IDLE_MS)) / this.frequency;
    this.nextWalkAt = this.now() + delay;
    this.idleTimer = window.setTimeout(() => {
      this.idleTimer = null;
      this.nextWalkAt = null;
      if (!this.host.canStartWalking()) {
        this.scheduleNextWalk(1800);
        return;
      }
      void this.startWalk();
    }, delay);
  }

  private async startWalk(
    forcedDistanceCssPx?: number,
    force = false,
    forcedDirection?: RoamingDirection,
  ): Promise<boolean> {
    if (!this.context || this.walking || !this.enabled || (!force && !this.host.canStartWalking())) return false;
    const distanceCss = forcedDistanceCssPx
      ?? MIN_WALK_DISTANCE_CSS_PX + this.random() * (MAX_WALK_DISTANCE_CSS_PX - MIN_WALK_DISTANCE_CSS_PX);
    const direction = forcedDirection ?? ROAMING_DIRECTIONS[Math.floor(this.random() * ROAMING_DIRECTIONS.length)];
    const target = planRoamingTarget(this.context, distanceCss, direction);
    if (!target) {
      this.scheduleNextWalk();
      return false;
    }
    return this.beginMovement(target.x, target.y, target.direction, null);
  }

  private beginMovement(
    targetX: number,
    targetY: number,
    direction: RoamingDirection,
    coordinationToken: CoordinationSceneToken | null,
    durationMs = MAX_COORDINATED_MOVE_MS,
  ): boolean {
    if (!this.context || this.walking || !this.host.onWalkStart(roamingFacing(direction))) {
      if (!this.walking) this.scheduleNextWalk(1800);
      return false;
    }
    this.walking = true;
    this.walkGeneration += 1;
    this.direction = direction;
    this.targetX = targetX;
    this.targetY = targetY;
    this.coordinationToken = coordinationToken;
    this.preciseX = this.context.x;
    this.preciseY = this.context.y;
    this.lastWalkFrameAt = performance.now();
    this.coordinatedMoveDeadline = coordinationToken ? this.lastWalkFrameAt + durationMs : null;
    this.emitSnapshot(true);
    this.clearIdleTimer();
    this.scheduleWalkStep(this.walkGeneration);
    return true;
  }

  private scheduleWalkStep(generation: number): void {
    this.clearWalkFrame();
    this.walkAnimationFrame = window.requestAnimationFrame((timestamp) => {
      this.walkAnimationFrame = null;
      void this.queueOperation(() => this.stepWalk(generation, timestamp));
    });
  }

  private async stepWalk(generation: number, timestamp: number): Promise<void> {
    if (
      generation !== this.walkGeneration
      || !this.walking
      || !this.context
      || this.targetX === null
      || this.targetY === null
      || this.preciseX === null
      || this.preciseY === null
      || this.disposed
    ) return;
    if (!this.host.canStartWalking()) {
      this.cancelWalking(true);
      this.scheduleNextWalk();
      return;
    }
    const previousFrameAt = this.lastWalkFrameAt ?? timestamp;
    const frameDeltaMs = Math.max(1, timestamp - previousFrameAt);
    const elapsedMs = this.coordinatedMoveDeadline === null
      ? Math.min(MAX_WALK_FRAME_DELTA_MS, frameDeltaMs)
      : frameDeltaMs;
    this.lastWalkFrameAt = timestamp;
    const deltaX = this.targetX - this.preciseX;
    const deltaY = this.targetY - this.preciseY;
    let step = WALK_SPEED_CSS_PX_PER_SECOND * this.speed * this.context.scaleFactor * elapsedMs / 1000;
    const distance = Math.hypot(deltaX, deltaY);
    if (this.coordinatedMoveDeadline !== null) {
      // Long moves and slow IPC must still arrive before the scene expires.
      const remainingMs = Math.max(1, this.coordinatedMoveDeadline - previousFrameAt);
      step = Math.max(step, distance * Math.min(1, elapsedMs / remainingMs));
    }
    const ratio = distance <= step || distance < 0.01 ? 1 : step / distance;
    const nextX = ratio === 1 ? this.targetX : this.preciseX + deltaX * ratio;
    const nextY = ratio === 1 ? this.targetY : this.preciseY + deltaY * ratio;
    // Keep subpixel progress on both axes; round only when crossing into native
    // coordinates. High refresh rates otherwise leave vertical moves walking
    // in place forever, and shallow diagonals lose their vertical component.
    this.preciseX = nextX;
    this.preciseY = nextY;
    const x = Math.round(this.preciseX);
    const y = Math.round(nextY);
    if (x === this.context.x && y === this.context.y && (x !== this.targetX || y !== this.targetY)) {
      this.scheduleWalkStep(generation);
      return;
    }
    const context = await invoke<PetWindowContext>("move_pet_window", { x, y, roaming: this.coordinationToken === null });
    this.context = context;
    if (generation !== this.walkGeneration || !this.walking) return;
    if (context.x !== x) {
      // Dragging can leave the starting frame outside the work area. Native
      // clamping of an intermediate step is not arrival at the group target.
      // Keep a reachable destination, adjusting only for the actual bounds.
      this.preciseX = context.x;
      this.targetX = Math.max(context.workArea.x, Math.min(
        context.workArea.x + context.workArea.width - context.width, this.targetX,
      ));
    }
    if (context.y !== y) {
      this.preciseY = context.y;
      this.targetY = Math.max(context.workArea.y, Math.min(
        context.workArea.y + context.workArea.height - context.height, this.targetY,
      ));
    }
    this.emitSnapshot();
    if (generation !== this.walkGeneration || !this.walking) return;
    if (context.x === this.targetX && context.y === this.targetY) {
      this.finishWalk();
      return;
    }
    this.scheduleWalkStep(generation);
  }

  private finishWalk(): void {
    const coordinationToken = this.coordinationToken;
    this.walking = false;
    this.targetX = null;
    this.targetY = null;
    this.direction = null;
    this.coordinationToken = null;
    this.preciseX = null;
    this.preciseY = null;
    this.coordinatedMoveDeadline = null;
    this.lastWalkFrameAt = null;
    this.emitSnapshot(true);
    this.host.onWalkStop();
    if (coordinationToken) this.host.onCoordinatedMoveComplete?.(coordinationToken);
    if (this.context) this.host.onPositionSettled(this.context);
    this.scheduleNextWalk();
  }

  private cancelWalking(notify: boolean, reason = "interrupted"): void {
    const wasWalking = this.walking;
    const coordinationToken = this.coordinationToken;
    this.walkGeneration += 1;
    this.walking = false;
    this.targetX = null;
    this.targetY = null;
    this.direction = null;
    this.coordinationToken = null;
    this.preciseX = null;
    this.preciseY = null;
    this.coordinatedMoveDeadline = null;
    this.lastWalkFrameAt = null;
    this.emitSnapshot(true);
    this.clearWalkFrame();
    if (notify && wasWalking) this.host.onWalkStop();
    if (notify && wasWalking && coordinationToken) this.host.onCoordinatedMoveCancel?.(coordinationToken, reason);
    if (wasWalking && this.context) this.host.onPositionSettled(this.context);
  }

  private queueOperation(operation: () => Promise<void>): Promise<void> {
    const result = this.operation.then(operation, operation);
    this.operation = result.catch((error) => {
      if (!this.disposed) this.host.onError(error);
      this.cancelWalking(true);
      this.scheduleNextWalk();
    });
    return this.operation;
  }

  private readSavedPosition(): { x: number; y: number } | null {
    try {
      const raw = localStorage.getItem("zzz-idol-pet-position-v1");
      if (!raw) return null;
      const value = JSON.parse(raw) as { x?: unknown; y?: unknown };
      return typeof value.x === "number" && typeof value.y === "number"
        ? { x: Math.round(value.x), y: Math.round(value.y) }
        : null;
    } catch {
      return null;
    }
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== null) window.clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.nextWalkAt = null;
  }

  private clearWalkFrame(): void {
    if (this.walkAnimationFrame !== null) window.cancelAnimationFrame(this.walkAnimationFrame);
    this.walkAnimationFrame = null;
  }

  private emitSnapshot(force = false): void {
    const timestamp = this.now();
    if (!force && timestamp - this.lastSnapshotAt < SNAPSHOT_INTERVAL_MS) return;
    this.lastSnapshotAt = timestamp;
    this.host.onSnapshot?.(this.getSnapshot());
  }
}
