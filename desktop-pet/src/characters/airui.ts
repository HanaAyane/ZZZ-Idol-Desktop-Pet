import type { CharacterDefinition } from "./types";

export const AIRUI: CharacterDefinition = {
  id: "airui",
  displayName: "爱芮",
  assetRoot: "./characters/airui",
  preferredAction: "动作_待机",
  preferredOverlay: "表情_常态",
  preferredSkin: "朝左",
  flipX: true,
  fitPadding: 0.9,
  behavior: {
    hoverOverlay: "表情_正视",
    dragOverlay: "表情_常态",
    coordination: {
      visualWidthCss: 214,
      preferredSpacingCss: 46,
      responseDelayMs: [180, 220],
    },
    idleRandom: {
      actions: ["动作_无奈", "动作_自信"],
      delayMs: [60_000, 60_000],
      durationMs: 6_000,
    },
    dragSway: {
      maxAngleDegrees: 18,
      maxAngularVelocity: 220,
      motionDeadZoneCssPx: 1.25,
      velocitySmoothing: 14,
      accelerationToAngularVelocity: 0.12,
      velocityToAngle: 0.018,
      springStrength: 105,
      damping: 11,
      inputDecay: 8,
    },
    actionOverlays: {
      动作_待机: "表情_常态",
      动作_走路: "表情_常态",
      动作_兴奋: "表情_兴奋",
      动作_害羞: "表情_害羞",
      动作_无奈: "表情_无奈",
      动作_生气: "表情_生气",
      动作_自信: "表情_自信",
    },
    reactions: {
      click: [
        { action: "动作_兴奋", overlay: "表情_兴奋", weight: 3 },
        { action: "动作_害羞", overlay: "表情_害羞", weight: 1 },
      ],
      doubleClick: [{ action: "动作_自信", overlay: "表情_自信", weight: 1 }],
      rapidClick: [
        { action: "动作_无奈", overlay: "表情_无奈", weight: 3 },
        { action: "动作_生气", overlay: "表情_生气", weight: 1 },
      ],
    },
    cooldownMs: { click: 2200, doubleClick: 3500, rapidClick: 8500 },
  },
};
