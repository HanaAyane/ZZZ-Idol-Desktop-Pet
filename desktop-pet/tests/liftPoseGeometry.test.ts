import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { AtlasAttachmentLoader, SkeletonJson, TextureAtlas, Skeleton, AnimationState,
  AnimationStateData, Physics, Vector2 } from "@esotericsoftware/spine-core";
import { measureLiftProfile, palmContact, projectLiftProfile, drawableBounds } from "../src/renderer/liftPoseGeometry.ts";

const catalog = JSON.parse(readFileSync(new URL("../public/characters/special-actions.json", import.meta.url), "utf8"));
for (const spec of catalog.actions) {
  test(`${spec.characterId}: real palm geometry scales and stays anchored over a full animation`, () => {
    const root = new URL(`../public/characters/${spec.assetId}/`, import.meta.url);
    const atlas = new TextureAtlas(readFileSync(new URL(`atlas-local/${spec.assetId}.atlas`, root), "utf8"));
    const data = new SkeletonJson(new AtlasAttachmentLoader(atlas)).readSkeletonData(
      JSON.parse(readFileSync(new URL(`json/${spec.assetId}.json`, root), "utf8")));
    const profile = measureLiftProfile(data, spec.bodyAction, spec.overlay, spec.skin, spec.contactSlots);
    const skeleton = new Skeleton(data);
    skeleton.setSkinByName(spec.skin);
    const state = new AnimationState(new AnimationStateData(data));
    state.setAnimation(0, spec.bodyAction, true); state.setAnimation(1, spec.overlay, true);
    state.apply(skeleton); skeleton.updateWorldTransform(Physics.update);
    const offset = new Vector2(), size = new Vector2();
    skeleton.getBounds(offset, size);
    const fit = { x: offset.x, y: offset.y, width: size.x, height: size.y };
    const small = projectLiftProfile(profile, fit, 520, 600, 0.6, 0.9);
    const large = projectLiftProfile(profile, fit, 520, 600, 1.25, 0.9);
    assert.ok(small.handYCss > 170, "60% palms must not use the old y=96 canvas point");
    assert.ok(small.handYCss > large.handYCss, "increasing scale moves the palms up");
    assert.ok(large.visibleBounds.height > small.visibleBounds.height);
    assert.ok(small.visibleBounds.height < 400, "transparent canvas is not the body envelope");
    for (let frame = 0; frame < 130; frame++) {
      const current = palmContact(skeleton, spec.contactSlots);
      const shift = { x: profile.contact.x - current.x, y: profile.contact.y - current.y };
      assert.ok(Math.abs(current.y + shift.y - profile.contact.y) < 1e-7);
      assert.ok(Math.abs(current.x + shift.x - profile.contact.x) < 1e-7);
      const b = drawableBounds(skeleton)!;
      assert.ok(b.y + shift.y >= profile.bounds.y - 2);
      assert.ok(b.y + b.height + shift.y <= profile.bounds.y + profile.bounds.height + 2);
      state.update(1 / 60); state.apply(skeleton); skeleton.update(1 / 60);
      skeleton.updateWorldTransform(Physics.update);
    }
    console.log(`${spec.characterId}: 60% palm y=${small.handYCss.toFixed(1)}, visible height=${small.visibleBounds.height.toFixed(1)}`);
  });
}
