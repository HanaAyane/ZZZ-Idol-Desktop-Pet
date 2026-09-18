import { invoke } from "@tauri-apps/api/core";
import type { PetWindowContext } from "./PetRoamingController";
import type { SpecialActionDefinition } from "./specialActions";
import {
  calculateWindowLiftPosition, visibleLiftFits, windowLiftAlignmentGap,
  type WindowLiftContact, type WindowLiftGeometry, type WindowLiftTargetSnapshot,
} from "./windowLiftGeometry.ts";

export interface WindowLiftControllerHost {
  getWindowContext(): PetWindowContext | null;
  getProbe(): WindowLiftContact | null;
  getLiftGeometry(): WindowLiftGeometry | null;
  canAutomaticallyAttach?(): boolean;
  onAttached(action: SpecialActionDefinition, mode: WindowLiftMode): Promise<void>;
  onDetached(reason: string): Promise<void>;
  onPosition(context: PetWindowContext): void;
  onNotice(reason: string): void;
  onError(error: unknown): void;
}

export interface WindowLiftBridge {
  native: boolean;
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  schedule(callback: () => void, milliseconds: number): number;
  cancel(timer: number): void;
  now(): number;
}

export type WindowLiftMode = "manual" | "automatic";

export interface WindowLiftControllerSnapshot {
  enabled: boolean;
  automaticEnabled: boolean;
  mode: WindowLiftMode | null;
  attached: boolean;
  dragging: boolean;
  targetRect: WindowLiftTargetSnapshot["rect"] | null;
  lastReason: string | null;
  geometry: WindowLiftGeometry | null;
}

const FOLLOW_INTERVAL_MS = 80;
const AUTOMATIC_HOLD_MS = 10_000;
const AUTOMATIC_PROBE_INTERVAL_MS = 400;
const AUTOMATIC_COOLDOWN_MS = 15_000;

export class WindowLiftController {
  private enabled = false;
  private automaticEnabled = false;
  private mode: WindowLiftMode | null = null;
  private pendingMode: WindowLiftMode | null = null;
  private pendingAttachments = 0;
  private releaseTimer: number | null = null;
  private nextAutomaticProbeAt = 0;
  private operation: Promise<unknown> = Promise.resolve();
  private attached = false;
  private dragging = false;
  private disposed = false;
  private pollTimer: number | null = null;
  private generation = 0;
  private target: WindowLiftTargetSnapshot | null = null;
  private lastReason: string | null = null;
  private readonly host: WindowLiftControllerHost;
  private readonly bridge: WindowLiftBridge;

  constructor(host: WindowLiftControllerHost, bridge?: WindowLiftBridge) {
    this.host = host;
    this.bridge = bridge ?? {
      native: typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__),
      invoke, schedule: (callback, ms) => window.setTimeout(callback, ms),
      cancel: (timer) => window.clearTimeout(timer),
      now: () => performance.now(),
    };
  }

  setEnabled(enabled: boolean): void {
    if (this.disposed || this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled && (this.pendingMode ?? this.mode) === "manual") void this.detach("settings_disabled");
  }

  setAutomaticEnabled(enabled: boolean): void {
    if (this.disposed || this.automaticEnabled === enabled) return;
    this.automaticEnabled = enabled;
    if (!enabled && (this.pendingMode ?? this.mode) === "automatic") void this.detach("automatic_disabled");
  }

  async tryAutomaticAttach(action: SpecialActionDefinition): Promise<boolean> {
    if (!this.bridge.native || !this.automaticEnabled || this.disposed || this.attached
      || this.dragging || this.pendingAttachments || this.bridge.now() < this.nextAutomaticProbeAt
      || !this.host.canAutomaticallyAttach?.()) return false;
    this.nextAutomaticProbeAt = this.bridge.now() + AUTOMATIC_PROBE_INTERVAL_MS;
    return this.requestAttach(action, "automatic");
  }

  notePetDragStart(): void {
    if (this.disposed) return;
    ++this.generation;
    this.dragging = true;
    this.clearPollTimer();
    this.clearReleaseTimer();
    this.nextAutomaticProbeAt = this.bridge.now() + AUTOMATIC_COOLDOWN_MS;
  }

  async notePetDragEnd(action: SpecialActionDefinition): Promise<boolean> {
    if (this.disposed) return false;
    this.dragging = false;
    if (!this.bridge.native) return false;
    if (!this.enabled) {
      if (this.attached || this.pendingAttachments) await this.detach("settings_disabled");
      return false;
    }
    return this.requestAttach(action, "manual");
  }

  private requestAttach(action: SpecialActionDefinition, mode: WindowLiftMode): Promise<boolean> {
    const generation = ++this.generation;
    this.clearReleaseTimer();
    this.pendingMode = mode;
    ++this.pendingAttachments;
    return this.enqueue(async () => {
      try { return await this.attach(action, mode, generation); }
      finally {
        --this.pendingAttachments;
        if (!this.pendingAttachments) this.pendingMode = null;
      }
    });
  }

  private async attach(action: SpecialActionDefinition, mode: WindowLiftMode, generation: number): Promise<boolean> {
    if (this.disposed || generation !== this.generation) return false;
    if (mode === "automatic" && !this.host.canAutomaticallyAttach?.()) return false;
    const probe = this.host.getProbe();
    if (!probe || !this.host.getWindowContext()) return false;
    try {
      const target = await this.bridge.invoke<WindowLiftTargetSnapshot | null>("attach_window_lift", {
        handXCss: probe.handXCss, handYCss: probe.handYCss, maxGapCss: action.snapDistanceCss,
        automatic: mode === "automatic",
      });
      if (this.disposed || generation !== this.generation
        || (mode === "automatic" && !this.host.canAutomaticallyAttach?.())) {
        await this.release("superseded", false);
        return false;
      }
      if (!target) {
        await this.finishDetach("no_nearby_window", mode === "manual");
        return false;
      }
      const wasAttached = this.attached;
      this.target = target;
      this.attached = true;
      this.mode = mode;
      // Load first: the main rig's visible head is for acquisition only.
      // Alignment and space checks use the lift palms and animation envelope.
      if (!wasAttached) await this.host.onAttached(action, mode);
      if (this.disposed || generation !== this.generation) {
        await this.release("superseded", false); return false;
      }
      const freshTarget = await this.bridge.invoke<WindowLiftTargetSnapshot | null>("get_window_lift_target");
      if (this.disposed || generation !== this.generation) { await this.release("superseded", false); return false; }
      if (!freshTarget) { await this.release("target_unavailable"); return false; }
      this.target = freshTarget;
      const positioned = await this.followTarget(freshTarget);
      if (this.disposed || generation !== this.generation) { await this.release("superseded", false); return false; }
      if (!positioned) { await this.release("insufficient_visible_space"); return false; }
      this.notice(mode === "automatic" ? "automatic_attached" : "attached");
      if (mode === "automatic") {
        // Start counting only after the lift rig is loaded and its palms are aligned.
        this.releaseTimer = this.bridge.schedule(() => {
          this.releaseTimer = null;
          if (generation === this.generation && this.mode === "automatic" && !this.dragging) {
            void this.detach("automatic_timeout");
          }
        }, AUTOMATIC_HOLD_MS);
      }
      this.schedulePoll();
      return true;
    } catch (error) {
      if (!this.disposed && generation === this.generation) {
        this.host.onError(error);
        await this.release("attachment_failed");
      } else {
        await this.release("superseded", false);
      }
      return false;
    }
  }

  async detach(reason = "released"): Promise<void> {
    ++this.generation;
    this.clearPollTimer();
    this.clearReleaseTimer();
    await this.enqueue(() => this.release(reason));
  }

  private async release(reason: string, notify = true): Promise<void> {
    this.clearPollTimer();
    this.clearReleaseTimer();
    if (this.bridge.native) {
      try { await this.bridge.invoke<void>("detach_window_lift"); }
      catch (error) { if (!this.disposed) this.host.onError(error); }
    }
    await this.finishDetach(reason, notify);
  }

  getSnapshot(): WindowLiftControllerSnapshot {
    return { enabled: this.enabled, automaticEnabled: this.automaticEnabled, mode: this.mode,
      attached: this.attached, dragging: this.dragging,
      targetRect: this.target ? { ...this.target.rect } : null, lastReason: this.lastReason,
      geometry: this.attached ? this.host.getLiftGeometry() : null };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    ++this.generation;
    this.clearPollTimer();
    this.clearReleaseTimer();
    void this.enqueue(() => this.release("disposed", false));
  }

  private schedulePoll(): void {
    this.clearPollTimer();
    if (!this.attached || this.dragging || this.disposed) return;
    this.pollTimer = this.bridge.schedule(() => {
      this.pollTimer = null;
      void this.enqueue(() => this.poll());
    }, FOLLOW_INTERVAL_MS);
  }

  private async poll(): Promise<void> {
    if (!this.attached || this.dragging || this.disposed) return;
    const generation = this.generation;
    try {
      const target = await this.bridge.invoke<WindowLiftTargetSnapshot | null>("get_window_lift_target");
      if (this.disposed || generation !== this.generation) return;
      if (!target) { await this.release("target_unavailable"); return; }
      this.target = target;
      const positioned = await this.followTarget(target);
      if (this.disposed || generation !== this.generation) return;
      if (!positioned) { await this.release("insufficient_visible_space"); return; }
      this.schedulePoll();
    } catch (error) {
      if (!this.disposed && generation === this.generation) {
        this.host.onError(error);
        await this.release("tracking_failed");
      }
    }
  }

  private async followTarget(target: WindowLiftTargetSnapshot): Promise<boolean> {
    const context = this.host.getWindowContext(), geometry = this.host.getLiftGeometry();
    if (!context || !geometry) throw new Error("托举手掌或可见范围尚未就绪");
    const position = calculateWindowLiftPosition(target, geometry, context);
    if (!visibleLiftFits(position, geometry, context)) return false;
    if (Math.abs(position.x - context.x) < 1 && Math.abs(position.y - context.y) < 1) return true;
    const generation = this.generation;
    const next = await this.bridge.invoke<PetWindowContext | null>("move_lift_pet_window", {
      ...position, visibleBoundsCss: geometry.visibleBounds,
    });
    if (this.disposed || generation !== this.generation) return false;
    if (!next) return false;
    this.host.onPosition(next);
    return windowLiftAlignmentGap(target, geometry, next) <= 2 * next.scaleFactor;
  }

  private async finishDetach(reason: string, notify = true): Promise<void> {
    this.clearPollTimer();
    this.clearReleaseTimer();
    const wasAttached = this.attached;
    if (wasAttached) this.nextAutomaticProbeAt = this.bridge.now() + AUTOMATIC_COOLDOWN_MS;
    this.attached = false;
    this.target = null;
    this.mode = null;
    if (wasAttached && !this.disposed) await this.host.onDetached(reason);
    if (notify && !this.disposed && (wasAttached || reason === "no_nearby_window")) this.notice(reason);
  }

  private notice(reason: string): void {
    this.lastReason = reason;
    this.host.onNotice(reason);
  }

  private clearPollTimer(): void {
    if (this.pollTimer !== null) this.bridge.cancel(this.pollTimer);
    this.pollTimer = null;
  }

  private clearReleaseTimer(): void {
    if (this.releaseTimer !== null) this.bridge.cancel(this.releaseTimer);
    this.releaseTimer = null;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation, operation);
    this.operation = result.catch(error => { if (!this.disposed) this.host.onError(error); });
    return result;
  }
}

declare global { interface Window { __TAURI_INTERNALS__?: unknown } }
