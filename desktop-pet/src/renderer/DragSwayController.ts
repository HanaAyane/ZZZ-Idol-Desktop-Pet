import * as THREE from "three";
import type { DragSwayBehavior } from "../characters/types";

const SETTLED_ANGLE_DEGREES = 0.04;
const SETTLED_VELOCITY_DEGREES_PER_SECOND = 0.5;

export interface DragSwaySnapshot {
  dragging: boolean;
  active: boolean;
  angleDegrees: number;
  targetDegrees: number;
  velocityDegreesPerSecond: number;
  filteredHorizontalVelocity: number;
}

/**
 * Treats the rendered character as one hanging doll. The parent group's origin
 * is positioned at the visible top-center by SpineRenderer.fit(), so rotating
 * this group always swings the complete character around a head-top grab point.
 */
export class DragSwayController {
  private dragging = false;
  private active = false;
  private angleDegrees = 0;
  private targetDegrees = 0;
  private velocityDegreesPerSecond = 0;
  private filteredHorizontalVelocity = 0;
  private pendingDeltaX = 0;
  private pendingElapsedMs = 0;

  constructor(
    private readonly pivot: THREE.Group,
    private readonly behavior: DragSwayBehavior,
    private readonly onSettled: () => void,
  ) {}

  start(): void {
    this.dragging = true;
    this.active = true;
    this.targetDegrees = 0;
    this.filteredHorizontalVelocity = 0;
    this.pendingDeltaX = 0;
    this.pendingElapsedMs = 0;
  }

  pushMotion(deltaXCssPx: number, _deltaYCssPx: number, elapsedMs: number): void {
    if (!this.dragging || !Number.isFinite(deltaXCssPx) || !Number.isFinite(elapsedMs)) return;
    this.pendingDeltaX += deltaXCssPx;
    this.pendingElapsedMs += Math.max(1, elapsedMs);
    if (
      Math.abs(this.pendingDeltaX) < this.behavior.motionDeadZoneCssPx &&
      this.pendingElapsedMs < 48
    ) {
      return;
    }

    const seconds = Math.max(0.012, Math.min(this.pendingElapsedMs / 1000, 0.1));
    const measuredVelocity = Math.abs(this.pendingDeltaX) < this.behavior.motionDeadZoneCssPx
      ? 0
      : this.pendingDeltaX / seconds;
    const previousFilteredVelocity = this.filteredHorizontalVelocity;
    const smoothingAlpha = 1 - Math.exp(-this.behavior.velocitySmoothing * seconds);
    this.filteredHorizontalVelocity +=
      (measuredVelocity - this.filteredHorizontalVelocity) * smoothingAlpha;
    const velocityChange = this.filteredHorizontalVelocity - previousFilteredVelocity;
    this.targetDegrees = this.clamp(
      -this.filteredHorizontalVelocity * this.behavior.velocityToAngle,
      -this.behavior.maxAngleDegrees,
      this.behavior.maxAngleDegrees,
    );
    this.velocityDegreesPerSecond = this.clamp(
      this.velocityDegreesPerSecond -
        velocityChange * this.behavior.accelerationToAngularVelocity,
      -this.behavior.maxAngularVelocity,
      this.behavior.maxAngularVelocity,
    );
    this.pendingDeltaX = 0;
    this.pendingElapsedMs = 0;
  }

  end(): void {
    this.dragging = false;
    this.targetDegrees = 0;
    this.filteredHorizontalVelocity = 0;
    this.pendingDeltaX = 0;
    this.pendingElapsedMs = 0;
  }

  update(deltaSeconds: number): void {
    if (!this.dragging && this.isSettled()) {
      this.resetTransform();
      return;
    }
    this.active = true;
    if (this.dragging) {
      this.filteredHorizontalVelocity *= Math.exp(-this.behavior.inputDecay * deltaSeconds);
      if (Math.abs(this.filteredHorizontalVelocity) < 0.5) this.filteredHorizontalVelocity = 0;
      this.targetDegrees = this.clamp(
        -this.filteredHorizontalVelocity * this.behavior.velocityToAngle,
        -this.behavior.maxAngleDegrees,
        this.behavior.maxAngleDegrees,
      );
    } else {
      this.targetDegrees = 0;
    }

    const acceleration =
      (this.targetDegrees - this.angleDegrees) * this.behavior.springStrength -
      this.velocityDegreesPerSecond * this.behavior.damping;
    this.velocityDegreesPerSecond = this.clamp(
      this.velocityDegreesPerSecond + acceleration * deltaSeconds,
      -this.behavior.maxAngularVelocity,
      this.behavior.maxAngularVelocity,
    );
    this.angleDegrees = this.clamp(
      this.angleDegrees + this.velocityDegreesPerSecond * deltaSeconds,
      -this.behavior.maxAngleDegrees,
      this.behavior.maxAngleDegrees,
    );

    if (!this.dragging && this.isSettled()) {
      this.resetTransform();
      return;
    }
    this.pivot.rotation.z = THREE.MathUtils.degToRad(this.angleDegrees);
  }

  getSnapshot(): DragSwaySnapshot {
    return {
      dragging: this.dragging,
      active: this.active,
      angleDegrees: this.angleDegrees,
      targetDegrees: this.targetDegrees,
      velocityDegreesPerSecond: this.velocityDegreesPerSecond,
      filteredHorizontalVelocity: this.filteredHorizontalVelocity,
    };
  }

  dispose(): void {
    this.dragging = false;
    this.angleDegrees = 0;
    this.targetDegrees = 0;
    this.velocityDegreesPerSecond = 0;
    this.filteredHorizontalVelocity = 0;
    this.pendingDeltaX = 0;
    this.pendingElapsedMs = 0;
    this.resetTransform();
  }

  private resetTransform(): void {
    const wasActive = this.active;
    this.active = false;
    this.angleDegrees = 0;
    this.velocityDegreesPerSecond = 0;
    this.pivot.rotation.z = 0;
    if (wasActive) this.onSettled();
  }

  private isSettled(): boolean {
    return (
      Math.abs(this.angleDegrees) <= SETTLED_ANGLE_DEGREES &&
      Math.abs(this.velocityDegreesPerSecond) <= SETTLED_VELOCITY_DEGREES_PER_SECOND
    );
  }

  private clamp(value: number, minimum: number, maximum: number): number {
    return Math.min(maximum, Math.max(minimum, value));
  }
}
