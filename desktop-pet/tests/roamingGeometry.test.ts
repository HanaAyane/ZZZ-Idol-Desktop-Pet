import assert from "node:assert/strict";
import test from "node:test";
import { planRoamingTarget, ROAMING_DIRECTIONS, roamingFacing } from "../src/pet/roamingGeometry.ts";
import type { PetWindowContext } from "../src/pet/PetRoamingController.ts";

test("six directions remain bounded, equal-distance and never turn into vertical-only walks", () => {
  for (const scaleFactor of [1, 1.25, 1.5, 2]) {
    const context: PetWindowContext = {
      x: 0, y: 0, width: 520 * scaleFactor, height: 600 * scaleFactor,
      scaleFactor, monitorName: "left-monitor",
      workArea: { x: -2560, y: -1200, width: 2560, height: 1600 },
    };
    const a = context.workArea;
    const maxX = a.x + a.width - context.width;
    const maxY = a.y + a.height - context.height;
    for (const x of [a.x, a.x + 1, (a.x + maxX) / 2, maxX - 1, maxX]) {
      for (const y of [a.y, a.y + 1, (a.y + maxY) / 2, maxY - 1, maxY]) {
        for (const direction of ROAMING_DIRECTIONS) {
          const target = planRoamingTarget({ ...context, x, y }, 120, direction);
          assert.ok(target);
          assert.ok(target.x >= a.x && target.x <= maxX);
          assert.ok(target.y >= a.y && target.y <= maxY);
          const dx = target.x - x, dy = target.y - y;
          assert.ok(Math.abs(dx) >= 1);
          assert.ok(Math.hypot(dx, dy) <= 120 * scaleFactor + 1);
          assert.equal(roamingFacing(target.direction), dx < 0 ? "left" : "right");
          if (target.direction.endsWith("-up")) assert.ok(dy < 0);
          else if (target.direction.endsWith("-down")) assert.ok(dy > 0);
          else assert.equal(dy, 0);
          if (dy !== 0) assert.ok(Math.abs(Math.abs(dx) - Math.abs(dy)) <= 1);
        }
      }
    }
  }
});

test("a short work area falls back to horizontal motion without negative bounds", () => {
  const context: PetWindowContext = {
    x: 0, y: 30, width: 520, height: 600, scaleFactor: 1, monitorName: null,
    workArea: { x: 0, y: 30, width: 550, height: 500 },
  };
  const target = planRoamingTarget(context, 120, "left-up");
  assert.ok(target);
  assert.equal(target.x, 30);
  assert.equal(target.y, 30);
  assert.equal(target.direction, "right");
  for (const distance of [0, -1, NaN, Infinity]) {
    assert.equal(planRoamingTarget(context, distance, "right"), null);
  }
});
