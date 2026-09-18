import type { CharacterDefinition } from "./types";

export const QIANXIA: CharacterDefinition = {
  id: "qianxia",
  displayName: "千夏",
  assetRoot: "./characters/qianxia",
  preferredAction: "动作_待机",
  preferredOverlay: "表情_常态",
  preferredSkin: "朝左",
  flipX: true,
  fitPadding: 0.9,
  behavior: {
    hoverOverlay: "表情_正视",
    dragOverlay: "表情_皱眉",
    coordination: {
      visualWidthCss: 208,
      preferredSpacingCss: 46,
      responseDelayMs: [220, 260],
    },
    idleRandom: {
      actions: ["动作_害羞", "动作_自信"],
      delayMs: [60_000, 60_000],
      durationMs: 6_000,
    },
    dragSway: {
      maxAngleDegrees: 20,
      maxAngularVelocity: 230,
      motionDeadZoneCssPx: 1.25,
      velocitySmoothing: 15,
      accelerationToAngularVelocity: 0.13,
      velocityToAngle: 0.019,
      springStrength: 110,
      damping: 10.5,
      inputDecay: 8,
    },
    actionOverlays: {
      动作_待机: "表情_常态",
      动作_走路: "表情_常态",
      动作_哈气: "表情_哈气",
      动作_害羞: "表情_害羞",
      动作_心累: "表情_心累",
      动作_思考: "表情_思考",
      动作_生气: "表情_生气",
      动作_自信: "表情_自信",
    },
    reactions: {
      click: [
        { action: "动作_害羞", overlay: "表情_害羞", weight: 3 },
        { action: "动作_思考", overlay: "表情_思考", weight: 1 },
      ],
      doubleClick: [{ action: "动作_自信", overlay: "表情_自信", weight: 1 }],
      rapidClick: [
        { action: "动作_哈气", overlay: "表情_哈气", weight: 3 },
        { action: "动作_生气", overlay: "表情_生气", weight: 2 },
        { action: "动作_心累", overlay: "表情_心累", weight: 1 },
      ],
    },
    cooldownMs: { click: 2600, doubleClick: 4000, rapidClick: 9500 },
  },
};
