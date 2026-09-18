import assert from "node:assert/strict";
import test from "node:test";

import type { CharacterId } from "../src/characters/types.ts";
import { calculateGroupLayout } from "../src/pet/groupLayout.ts";
import type { CoordinationRuntimeState } from "../src/pet/coordinationTypes.ts";

const workArea = { x: 0, y: 0, width: 3420, height: 2160 };
const visualWidths: Record<CharacterId, number> = {
  airui: 214,
  nangong: 220,
  qianxia: 208,
};

function runtimeState(id: CharacterId, x: number): CoordinationRuntimeState {
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
      y: 820,
      width: 1040,
      height: 1200,
      scaleFactor: 2,
      monitorName: "main",
      workArea,
    },
    visualAnchor: { x: 260, y: 432, width: visualWidths[id] },
    visualWidthCss: visualWidths[id],
    preferredSpacingCss: 46,
    scale: 0.6,
    lastUserInteractionAt: 0,
    reportedAt: Date.now(),
  };
}

test("gather near the right edge shifts the whole group without collapsing visual spacing", () => {
  const snapshots = {
    airui: runtimeState("airui", 1619),
    nangong: runtimeState("nangong", 1972),
    qianxia: runtimeState("qianxia", 2320),
  };
  const result = calculateGroupLayout(snapshots, ["airui", "nangong", "qianxia"], {
    mode: "gather",
    anchorCharacterId: "qianxia",
    anchorX: 2840,
    anchorY: 1684,
    workArea,
  });
  const targets = result.orderedIds.map((id) => ({ id, target: result.targets[id]! }));

  for (const { target } of targets) {
    assert.ok(target.x >= 36, `window should stay inside the left margin: ${target.x}`);
    assert.ok(target.x + 1040 <= workArea.width - 36, `window should stay inside the right margin: ${target.x}`);
  }

  for (let index = 1; index < targets.length; index += 1) {
    const previous = targets[index - 1];
    const current = targets[index];
    const previousCenter = previous.target.x + 520;
    const currentCenter = current.target.x + 520;
    const minimumGap = visualWidths[previous.id] * 1.2 / 2
      + visualWidths[current.id] * 1.2 / 2
      + 92;
    assert.ok(
      currentCenter - previousCenter >= minimumGap - 1,
      `${previous.id} and ${current.id} should keep their visual spacing`,
    );
  }
});

test("gather here keeps the selected character at its visible anchor", () => {
  const snapshots = {
    airui: runtimeState("airui", 700),
    nangong: runtimeState("nangong", 1200),
    qianxia: runtimeState("qianxia", 1800),
  };
  snapshots.nangong.position!.y = 540;
  const anchorX = snapshots.nangong.position!.x + 520;
  const anchorY = snapshots.nangong.position!.y + 864;
  const result = calculateGroupLayout(snapshots, ["airui", "nangong", "qianxia"], {
    mode: "gather",
    anchorCharacterId: "nangong",
    anchorX,
    anchorY,
    workArea,
  });

  assert.equal(result.targets.nangong?.x, snapshots.nangong.position!.x);
  assert.equal(result.targets.nangong?.y, snapshots.nangong.position!.y);
});
