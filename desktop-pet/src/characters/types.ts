export type CharacterId = "airui" | "nangong" | "qianxia";

export type ReactionKind = "click" | "doubleClick" | "rapidClick";

export interface WeightedReaction {
  action: string;
  overlay: string;
  weight: number;
}

export interface CharacterCoordinationBehavior {
  visualWidthCss: number;
  preferredSpacingCss: number;
  responseDelayMs: [number, number];
}

export interface IdleRandomBehavior {
  actions: string[];
  delayMs: [number, number];
  durationMs: number;
}

export interface DragSwayBehavior {
  maxAngleDegrees: number;
  maxAngularVelocity: number;
  motionDeadZoneCssPx: number;
  velocitySmoothing: number;
  accelerationToAngularVelocity: number;
  velocityToAngle: number;
  springStrength: number;
  damping: number;
  inputDecay: number;
}

export interface CharacterBehavior {
  hoverOverlay: string;
  dragOverlay: string;
  dragSway: DragSwayBehavior;
  coordination: CharacterCoordinationBehavior;
  idleRandom: IdleRandomBehavior;
  actionOverlays: Record<string, string>;
  reactions: Record<ReactionKind, WeightedReaction[]>;
  cooldownMs: Record<ReactionKind, number>;
}

export interface CharacterDefinition {
  id: CharacterId;
  assetId?: string;
  windowLiftContactSlots?: string[];
  displayName: string;
  assetRoot: string;
  preferredAction: string;
  preferredOverlay: string;
  preferredSkin: string;
  flipX: boolean;
  fitPadding: number;
  behavior: CharacterBehavior;
}
