import assert from "node:assert/strict";
import test from "node:test";

import { shouldMirrorForFacingDirection } from "../src/pet/characterFacing.ts";

test("left-facing skins stay left without mirroring", () => {
  assert.equal(shouldMirrorForFacingDirection("朝左", "left"), false);
  assert.equal(shouldMirrorForFacingDirection("朝左", "right"), true);
});

test("right-facing skins are mirrored only when the pet should face left", () => {
  assert.equal(shouldMirrorForFacingDirection("朝右", "right"), false);
  assert.equal(shouldMirrorForFacingDirection("朝右", "left"), true);
});

test("default and unknown skins use the verified left-facing baseline", () => {
  assert.equal(shouldMirrorForFacingDirection("default", "left"), false);
  assert.equal(shouldMirrorForFacingDirection("default", "right"), true);
});
