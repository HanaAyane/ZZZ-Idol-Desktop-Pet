import type { CharacterDefinition } from "./types";

export const NANGONG: CharacterDefinition = {
  id: "nangong",
  displayName: "南宫",
  assetRoot: "./characters/nangong",
  preferredAction: "动作_待机",
  preferredOverlay: "表情_常态",
  preferredSkin: "朝左",
  flipX: true,
  fitPadding: 0.9,
  behavior: {
    hoverOverlay: "表情_正视",
    dragOverlay: "表情_常态",
    coordination: {
      visualWidthCss: 220,
      preferredSpacingCss: 46,
      responseDelayMs: [200, 240],
    },
    idleRandom: {
      actions: ["动作_思考", "动作_害羞", "动作_自信", "动作_认真"],
      delayMs: [60_000, 60_000],
      durationMs: 6_000,
    },
    dragSway: {
      maxAngleDegrees: 16,
      maxAngularVelocity: 200,
      motionDeadZoneCssPx: 1.25,
      velocitySmoothing: 13,
      accelerationToAngularVelocity: 0.11,
      velocityToAngle: 0.016,
      springStrength: 100,
      damping: 12,
      inputDecay: 8,
    },
    actionOverlays: {
      动作_待机: "表情_常态",
      动作_走路: "表情_走路",
      动作_害羞: "表情_害羞",
      动作_思考: "表情_思考",
      动作_生气: "表情_生气",
      动作_自信: "表情_自信",
      动作_认真: "表情_认真",
      动作_哭: "表情_假哭",
    },
    reactions: {
      click: [
        { action: "动作_思考", overlay: "表情_思考", weight: 3 },
        { action: "动作_害羞", overlay: "表情_害羞", weight: 1 },
      ],
      doubleClick: [
        { action: "动作_认真", overlay: "表情_认真", weight: 3 },
        { action: "动作_自信", overlay: "表情_自信", weight: 2 },
      ],
      rapidClick: [
        { action: "动作_生气", overlay: "表情_生气", weight: 3 },
        { action: "动作_哭", overlay: "表情_假哭", weight: 1 },
      ],
    },
    cooldownMs: { click: 3000, doubleClick: 4200, rapidClick: 9000 },
  },
};
