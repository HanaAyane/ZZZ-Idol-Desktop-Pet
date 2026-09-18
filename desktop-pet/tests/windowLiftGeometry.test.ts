import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateWindowLiftPosition,
  probeFromVisibleBounds,
  visibleLiftFits,
  windowLiftAlignmentGap,
  type WindowLiftTargetSnapshot,
} from "../src/pet/windowLiftGeometry.ts";
import type { PetWindowContext } from "../src/pet/PetRoamingController.ts";

const context: PetWindowContext = {
  x: 100,
  y: 200,
  width: 1040,
  height: 1200,
  scaleFactor: 2,
  monitorName: "main",
  workArea: { x: 0, y: 0, width: 2880, height: 1800 },
};
const target: WindowLiftTargetSnapshot = {
  rect: { x: 400, y: 120, width: 1200, height: 480 },
  anchorRatioX: 0.5,
};

test("acquisition uses the visible head instead of an invisible canvas point", () => {
  assert.deepEqual(
    probeFromVisibleBounds({ x: 160, y: 190, width: 200, height: 240 }),
    { handXCss: 260, handYCss: 190 },
  );
});

test("keeps the pet hand anchor on the target bottom edge", () => {
  const contact = { handXCss: 260, handYCss: 220 };
  const position = calculateWindowLiftPosition(target, contact, context);
  assert.deepEqual(position, { x: 480, y: 160 });
  assert.equal(windowLiftAlignmentGap(target, contact, { ...context, ...position }), 0);
});

test("each pet can keep an independent horizontal ratio on the same target", () => {
  const contact = { handXCss: 260, handYCss: 220 };
  const left = calculateWindowLiftPosition({ ...target, anchorRatioX: 0.25 }, contact, context);
  const center = calculateWindowLiftPosition(target, contact, context);
  const right = calculateWindowLiftPosition({ ...target, anchorRatioX: 0.75 }, contact, context);
  assert.deepEqual([left.x, center.x, right.x], [180, 480, 780]);
  assert.equal(left.y, right.y);
});

test("visible character fits near the bottom even when the transparent window overflows", () => {
  const geometry = { handXCss: 260, handYCss: 220,
    visibleBounds: { x: 160, y: 180, width: 200, height: 240 } };
  const lower = { ...target, rect: { ...target.rect, y: 820 } }; // bottom = 1300 physical
  const position = calculateWindowLiftPosition(lower, geometry, context);
  assert.equal(position.y, 860);
  assert.ok(position.y + context.height > context.workArea.height);
  assert.equal(visibleLiftFits(position, geometry, context), true);
  assert.equal(visibleLiftFits({ ...position, y: 1000 }, geometry, context), false);
});

test("DPI and negative-coordinate monitors preserve contact", () => {
  for (const scaleFactor of [1, 1.5, 2]) {
    const c = { ...context, scaleFactor, workArea: { x: -2880, y: 200, width: 2880, height: 1800 } };
    const t = { rect: { x: -1800, y: 300, width: 1000, height: 400 }, anchorRatioX: 0.5 };
    const geometry = { handXCss: 260, handYCss: 221,
      visibleBounds: { x: 160, y: 180, width: 200, height: 240 } };
    const p = calculateWindowLiftPosition(t, geometry, c);
    assert.ok(windowLiftAlignmentGap(t, geometry, { ...c, ...p }) <= 0.5);
    assert.ok(visibleLiftFits(p, geometry, c));
  }
});
