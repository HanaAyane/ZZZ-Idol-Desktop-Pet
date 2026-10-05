import assert from "node:assert/strict";
import test from "node:test";

import {
  clampPetScale,
  isPetScaleInRange,
  normalizePetScale,
  PET_SCALE_MAX,
  PET_SCALE_MIN,
} from "../src/petScale.ts";

test("桌宠缩放允许在 20% 到 125% 之间调节", () => {
  assert.equal(PET_SCALE_MIN, 0.2);
  assert.equal(PET_SCALE_MAX, 1.25);
  assert.equal(clampPetScale(0.1), 0.2);
  assert.equal(clampPetScale(2), 1.25);
  assert.equal(normalizePetScale(0.337), 0.34);
  assert.equal(isPetScaleInRange(0.3), true);
  assert.equal(isPetScaleInRange(1.25), true);
  assert.equal(isPetScaleInRange(0.2), true);
  assert.equal(isPetScaleInRange(0.19), false);
});
