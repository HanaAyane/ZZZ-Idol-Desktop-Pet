import type { CharacterId } from "../characters/types";

export type CoordinationSceneKind = "partnerGaze" | "reactionEcho" | "gather" | "disperse";
export type CoordinationTriggerKind = "click" | "doubleClick";
export type CoordinationOutcome = "completed" | "unsupported" | "interrupted" | "expired";

export interface CoordinationWorkArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CoordinationPosition {
  x: number;
  y: number;
  width: number;
  height: number;
  scaleFactor: number;
  monitorName: string | null;
  workArea: CoordinationWorkArea;
}

export interface CoordinationVisualAnchor {
  x: number;
  y: number;
  width: number;
}

export interface CoordinationRuntimeState {
  sequence: number;
  state: string;
  action: string;
  interactionReady: boolean;
  debugOpen: boolean;
  loaded: boolean;
  visible: boolean;
  position: CoordinationPosition | null;
  visualAnchor: CoordinationVisualAnchor | null;
  visualWidthCss: number;
  preferredSpacingCss: number;
  scale: number;
  lastUserInteractionAt: number;
  reportedAt: number;
}

export interface CoordinationActiveScene {
  sceneId: number;
  generation: number;
  kind: CoordinationSceneKind;
  actorId: CharacterId | null;
  participantIds: CharacterId[];
  pendingIds: CharacterId[];
  startedAt: number;
  expiresAt: number;
}

export interface CoordinationSnapshot {
  pets: Partial<Record<CharacterId, CoordinationRuntimeState>>;
  activeScene: CoordinationActiveScene | null;
  generatedAt: number;
  eventCount: number;
  rejectionCount: number;
  timeoutCount: number;
}

export interface CoordinationLayoutInstruction {
  mode: "gather" | "disperse";
  anchorX: number | null;
  anchorY: number | null;
  workArea: CoordinationWorkArea;
}

export interface CoordinationCommand {
  sceneId: number;
  generation: number;
  kind: CoordinationSceneKind;
  actorId: CharacterId | null;
  participantIds: CharacterId[];
  expiresAt: number;
  triggerKind?: CoordinationTriggerKind;
  delayMs?: number;
  layout?: CoordinationLayoutInstruction;
}

export interface CoordinationCancelledEvent {
  sceneId: number;
  generation: number;
  reason: string;
}

export interface CoordinationSceneToken {
  sceneId: number;
  generation: number;
}

export interface CoordinationMoveTarget {
  x: number;
  y: number;
  direction: "left" | "right";
}

export interface CoordinationControllerSnapshot {
  sequence: number;
  lastUserInteractionAt: number;
  latest: CoordinationSnapshot | null;
  activeToken: CoordinationSceneToken | null;
}

export function sceneTokenMatches(
  left: CoordinationSceneToken | null,
  right: CoordinationSceneToken | null,
): boolean {
  return Boolean(left && right && left.sceneId === right.sceneId && left.generation === right.generation);
}
