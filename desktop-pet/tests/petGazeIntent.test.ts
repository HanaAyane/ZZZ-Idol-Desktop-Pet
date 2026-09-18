import assert from "node:assert/strict";
import test from "node:test";

import type { CharacterId } from "../src/characters/types.ts";
import { PetGazeIntentController } from "../src/pet/PetGazeIntentController.ts";
import type { CoordinationRuntimeState } from "../src/pet/coordinationTypes.ts";

const now = 10_000;
const workArea = { x: 0, y: 0, width: 1920, height: 1080 };

function snapshot(id: CharacterId, x: number): CoordinationRuntimeState {
  return {
    sequence: 1,
    state: "idle",
    action: "动作_待机",
    interactionReady: true,
    debugOpen: false,
    loaded: true,
    visible: true,
    position: {
      x,
      y: 400,
      width: 520,
      height: 600,
      scaleFactor: 1,
      monitorName: "main",
      workArea,
    },
    visualAnchor: { x: 260, y: 420, width: 210 },
    visualWidthCss: 210,
    preferredSpacingCss: 46,
    scale: 1,
    lastUserInteractionAt: 0,
    reportedAt: now,
  };
}

const snapshots = {
  airui: snapshot("airui", 100),
  nangong: snapshot("nangong", 600),
  qianxia: snapshot("qianxia", 1100),
};

test("an outer gathered character can lock its gaze on the center character", () => {
  const calls: Array<{ x: number | null; y: number | null; active: boolean }> = [];
  const gaze = new PetGazeIntentController("airui", {
    setGazeTarget: (x, y, active) => calls.push({ x, y, active }),
  }, () => now);
  gaze.setWindowContext(snapshots.airui.position);
  gaze.setSnapshots(snapshots);
  gaze.setMouseTarget(120, 180, true);
  gaze.setSceneTarget("nangong");

  assert.deepEqual(calls.at(-1), { x: 760, y: 420, active: true });
});

test("the center gathered character stays idle instead of falling back to nearest-partner gaze", () => {
  const calls: Array<{ x: number | null; y: number | null; active: boolean }> = [];
  const gaze = new PetGazeIntentController("nangong", {
    setGazeTarget: (x, y, active) => calls.push({ x, y, active }),
  }, () => now);
  gaze.setWindowContext(snapshots.nangong.position);
  gaze.setSnapshots(snapshots);
  gaze.setSceneTarget(null);

  assert.deepEqual(calls.at(-1), { x: null, y: null, active: false });
});
