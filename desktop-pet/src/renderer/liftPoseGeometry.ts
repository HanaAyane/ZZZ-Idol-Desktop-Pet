import {
  AnimationState, AnimationStateData, MeshAttachment, Physics, RegionAttachment,
  Skeleton, type SkeletonData,
} from "@esotericsoftware/spine-core";

export interface PoseBounds { x: number; y: number; width: number; height: number }
export interface PosePoint { x: number; y: number }
export interface LiftPoseProfile { contact: PosePoint; bounds: PoseBounds }

/** Bounds of drawable attachments, in Spine's y-up skeleton coordinate space. */
export function drawableBounds(skeleton: Skeleton, names?: readonly string[]): PoseBounds | null {
  let left = Infinity, bottom = Infinity, right = -Infinity, top = -Infinity;
  for (const slot of skeleton.slots) {
    if (!slot.bone.active || slot.color.a <= 0.01 || (names && !names.includes(slot.data.name))) continue;
    const attachment = slot.getAttachment();
    let vertices: number[];
    if (attachment instanceof RegionAttachment) {
      if (attachment.color.a <= 0.01) continue;
      vertices = new Array<number>(8);
      attachment.computeWorldVertices(slot, vertices, 0, 2);
    } else if (attachment instanceof MeshAttachment) {
      if (attachment.color.a <= 0.01) continue;
      vertices = new Array<number>(attachment.worldVerticesLength);
      attachment.computeWorldVertices(slot, 0, vertices.length, vertices, 0, 2);
    } else continue;
    for (let i = 0; i < vertices.length; i += 2) {
      left = Math.min(left, vertices[i]); right = Math.max(right, vertices[i]);
      bottom = Math.min(bottom, vertices[i + 1]); top = Math.max(top, vertices[i + 1]);
    }
  }
  return Number.isFinite(left) ? { x: left, y: bottom, width: right - left, height: top - bottom } : null;
}

/** The upper surface of both palm meshes, not the transparent canvas or wrist bones. */
export function palmContact(skeleton: Skeleton, slots: readonly string[]): PosePoint {
  const palms = slots.map((name) => {
    const bounds = drawableBounds(skeleton, [name]);
    if (!bounds) throw new Error(`托举手掌网格不可用：${name}`);
    return bounds;
  });
  if (palms.length !== 2) throw new Error("托举动作必须定义两个手掌网格");
  return {
    x: palms.reduce((sum, b) => sum + b.x + b.width / 2, 0) / palms.length,
    // Contact with the higher palm prevents either hand penetrating the bottom edge.
    y: Math.max(...palms.map((b) => b.y + b.height)),
  };
}

/** Sample two cycles, including physics, to reserve visible motion space only. */
export function measureLiftProfile(
  data: SkeletonData, action: string, overlay: string, skin: string, slots: readonly string[],
): LiftPoseProfile {
  const skeleton = new Skeleton(data);
  skeleton.setSkinByName(skin);
  skeleton.setToSetupPose();
  const state = new AnimationState(new AnimationStateData(data));
  const entry = state.setAnimation(0, action, true);
  if (overlay) state.setAnimation(1, overlay, true);
  state.apply(skeleton);
  skeleton.updateWorldTransform(Physics.update);
  const contact = palmContact(skeleton, slots);
  let left = Infinity, bottom = Infinity, right = -Infinity, top = -Infinity;
  const count = Math.ceil(Math.max(entry.animation?.duration ?? 1, 1) * 120);
  for (let i = 0; i <= count; i++) {
    const point = palmContact(skeleton, slots);
    const b = drawableBounds(skeleton);
    if (!b) throw new Error("托举动作没有可见网格");
    const x = b.x + contact.x - point.x;
    const y = b.y + contact.y - point.y;
    left = Math.min(left, x); bottom = Math.min(bottom, y);
    right = Math.max(right, x + b.width); top = Math.max(top, y + b.height);
    state.update(1 / 60); state.apply(skeleton); skeleton.update(1 / 60);
    skeleton.updateWorldTransform(Physics.update);
  }
  return { contact, bounds: { x: left, y: bottom, width: right - left, height: top - bottom } };
}

/** Same centered fit used by SpineRenderer; character scale is independent of native DPI. */
export function projectLiftProfile(
  profile: LiftPoseProfile, fit: PoseBounds, width: number, height: number,
  characterScale: number, padding: number,
): { handXCss: number; handYCss: number; visibleBounds: PoseBounds } {
  const scale = Math.min(Math.min(width, 360) * padding / fit.width,
    Math.min(height, 480) * padding / fit.height) * characterScale;
  const point = (x: number, y: number) => ({
    x: width / 2 + (x - fit.x - fit.width / 2) * scale,
    y: height / 2 - (y - fit.y - fit.height / 2) * scale,
  });
  const hand = point(profile.contact.x, profile.contact.y);
  const topLeft = point(profile.bounds.x, profile.bounds.y + profile.bounds.height);
  // Small raster/physics safety margin; do not include the transparent 520x600 canvas.
  const margin = 4;
  return {
    handXCss: hand.x, handYCss: hand.y,
    visibleBounds: { x: topLeft.x - margin, y: topLeft.y - margin,
      width: profile.bounds.width * scale + margin * 2,
      height: profile.bounds.height * scale + margin * 2 },
  };
}
