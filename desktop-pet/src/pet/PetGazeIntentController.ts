import type { CharacterId } from "../characters/types";
import { selectNearestCharacter, visualCenter } from "./coordinationPolicy.ts";
import type {
  CoordinationPosition,
  CoordinationRuntimeState,
} from "./coordinationTypes";

export interface PetGazeIntentHost {
  setGazeTarget(clientX: number | null, clientY: number | null, active: boolean): void;
}

interface MouseIntent {
  x: number | null;
  y: number | null;
  lastMovedAt: number;
  direct: boolean;
}

const MOUSE_QUIET_AFTER_MS = 2500;
const TARGET_MAX_AGE_MS = 1800;

export class PetGazeIntentController {
  private readonly selfId: CharacterId;
  private readonly host: PetGazeIntentHost;
  private readonly now: () => number;
  private readonly snapshots: Partial<Record<CharacterId, CoordinationRuntimeState>> = {};
  private selfSnapshot: CoordinationRuntimeState | null = null;
  private windowContext: CoordinationPosition | null = null;
  private readonly mouse: MouseIntent = { x: null, y: null, lastMovedAt: 0, direct: false };
  private sceneTarget: CharacterId | null = null;
  private sceneTargetLocked = false;
  private enabled = true;
  private activityAllowed = true;
  private partnerGazeEnabled = true;
  private disposed = false;

  constructor(
    selfId: CharacterId,
    host: PetGazeIntentHost,
    now: () => number = Date.now,
  ) {
    this.selfId = selfId;
    this.host = host;
    this.now = now;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.recompute();
  }

  setPartnerGazeEnabled(enabled: boolean): void {
    this.partnerGazeEnabled = enabled;
    this.recompute();
  }

  setActivityAllowed(allowed: boolean): void {
    this.activityAllowed = allowed;
    this.recompute();
  }

  setWindowContext(context: CoordinationPosition | null): void {
    this.windowContext = context;
    this.recompute();
  }

  setSelfSnapshot(snapshot: CoordinationRuntimeState | null): void {
    this.selfSnapshot = snapshot;
    if (snapshot) this.snapshots[this.selfId] = snapshot;
    this.windowContext = snapshot?.position ?? this.windowContext;
    this.recompute();
  }

  setSnapshots(snapshots: Partial<Record<CharacterId, CoordinationRuntimeState>>): void {
    for (const id of Object.keys(this.snapshots) as CharacterId[]) delete this.snapshots[id];
    Object.assign(this.snapshots, snapshots);
    this.selfSnapshot = this.snapshots[this.selfId] ?? this.selfSnapshot;
    this.windowContext = this.selfSnapshot?.position ?? this.windowContext;
    this.recompute();
  }

  setMouseTarget(clientX: number | null, clientY: number | null, direct = false): void {
    this.mouse.x = clientX;
    this.mouse.y = clientY;
    this.mouse.direct = direct;
    if (clientX !== null && clientY !== null) this.mouse.lastMovedAt = this.now();
    this.recompute();
  }

  setDirectInteraction(active: boolean): void {
    this.mouse.direct = active;
    this.recompute();
  }

  setSceneTarget(targetId: CharacterId | null): void {
    this.sceneTarget = targetId;
    this.sceneTargetLocked = true;
    this.recompute();
  }

  clearSceneTarget(): void {
    this.sceneTarget = null;
    this.sceneTargetLocked = false;
    this.recompute();
  }

  hasSceneTargetLock(): boolean {
    return this.sceneTargetLocked;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.host.setGazeTarget(null, null, false);
  }

  private recompute(): void {
    if (this.disposed || !this.enabled || !this.activityAllowed) {
      this.host.setGazeTarget(null, null, false);
      return;
    }
    if (this.sceneTargetLocked) {
      const sceneTarget = this.partnerGazeEnabled ? this.resolveTarget(this.sceneTarget) : null;
      if (sceneTarget) this.host.setGazeTarget(sceneTarget.x, sceneTarget.y, true);
      else this.host.setGazeTarget(null, null, false);
      return;
    }
    if (this.mouse.direct && this.mouse.x !== null && this.mouse.y !== null) {
      this.host.setGazeTarget(this.mouse.x, this.mouse.y, true);
      return;
    }
    const mouseIsRecent = this.mouse.x !== null && this.mouse.y !== null
      && this.now() - this.mouse.lastMovedAt <= MOUSE_QUIET_AFTER_MS;
    if (mouseIsRecent) {
      this.host.setGazeTarget(this.mouse.x, this.mouse.y, true);
      return;
    }
    if (this.partnerGazeEnabled) {
      const nearestId = selectNearestCharacter(this.selfId, this.snapshots, this.now());
      const nearest = this.resolveTarget(nearestId);
      if (nearest) {
        this.host.setGazeTarget(nearest.x, nearest.y, true);
        return;
      }
    }
    this.host.setGazeTarget(null, null, false);
  }

  private resolveTarget(targetId: CharacterId | null): { x: number; y: number } | null {
    if (!targetId || !this.windowContext) return null;
    const target = this.snapshots[targetId];
    if (!target?.position || !target.loaded || !target.visible) return null;
    if (this.now() - target.reportedAt > TARGET_MAX_AGE_MS) return null;
    const targetCenter = visualCenter(target);
    if (!targetCenter) return null;
    const scaleFactor = Math.max(1, this.windowContext.scaleFactor);
    return {
      x: (targetCenter.x - this.windowContext.x) / scaleFactor,
      y: (targetCenter.y - this.windowContext.y) / scaleFactor,
    };
  }
}
