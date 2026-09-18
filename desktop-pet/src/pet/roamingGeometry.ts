import type { FacingDirection } from "./characterFacing";
import type { PetWindowContext } from "./PetRoamingController";

export const ROAMING_DIRECTIONS = ["left", "right", "left-up", "left-down", "right-up", "right-down"] as const;
export type RoamingDirection = typeof ROAMING_DIRECTIONS[number];

export const ROAMING_DIRECTION_LABELS: Record<RoamingDirection, string> = {
  left: "左", right: "右", "left-up": "左上", "left-down": "左下", "right-up": "右上", "right-down": "右下",
};

export function roamingFacing(direction: RoamingDirection): FacingDirection {
  return direction.startsWith("left") ? "left" : "right";
}

export interface RoamingTarget {
  x: number;
  y: number;
  direction: RoamingDirection;
}

export function planRoamingTarget(
  context: PetWindowContext,
  distanceCss: number,
  preferred: RoamingDirection,
): RoamingTarget | null {
  if (!Number.isFinite(distanceCss) || distanceCss <= 0) return null;
  const { workArea: area } = context;
  const scale = context.scaleFactor;
  const maxX = area.x + Math.max(0, area.width - context.width);
  const maxY = area.y + Math.max(0, area.height - context.height);
  // A reachable top-edge drag may leave transparent canvas above the work
  // area. Permit horizontal motion and a gradual return downward from there.
  // The native free-roaming clamp applies the same rule.
  const centerX = context.x + context.width / 2;
  const centerY = context.y + context.height / 2;
  const reachable = centerX >= area.x && centerX < area.x + area.width
    && centerY >= area.y && centerY < area.y + area.height;
  const minY = reachable ? Math.min(area.y, context.y) : area.y;
  const originX = Math.max(area.x, Math.min(maxX, context.x));
  const originY = Math.max(minY, Math.min(maxY, context.y));
  const requestedDistance = distanceCss * scale;
  const minimumDistance = Math.min(requestedDistance, 40 * scale);
  const preferredIndex = ROAMING_DIRECTIONS.indexOf(preferred);
  if (preferredIndex < 0) return null;
  let longest: (RoamingTarget & { distance: number }) | null = null;
  for (let offset = 0; offset < ROAMING_DIRECTIONS.length; offset += 1) {
    const direction = ROAMING_DIRECTIONS[(preferredIndex + offset) % ROAMING_DIRECTIONS.length];
    const vertical = direction.endsWith("-up") ? -1 : direction.endsWith("-down") ? 1 : 0;
    const unitX = (roamingFacing(direction) === "left" ? -1 : 1) / Math.hypot(1, vertical);
    const unitY = vertical / Math.hypot(1, vertical);
    // Clip the whole ray, not each axis separately: diagonals stay at 45° and
    // cover the same total distance as horizontal walks at the same speed.
    const roomX = (unitX > 0 ? maxX - originX : originX - area.x) / Math.abs(unitX);
    const roomY = unitY === 0 ? Infinity
      : (unitY > 0 ? maxY - originY : originY - minY) / Math.abs(unitY);
    const distance = Math.min(requestedDistance, roomX, roomY);
    const x = Math.round(originX + unitX * distance);
    const y = Math.round(originY + unitY * distance);
    if (x === originX || (vertical !== 0 && y === originY)) continue;
    const target = { x, y, direction, distance };
    if (distance >= minimumDistance) return target;
    if (!longest || distance > longest.distance) longest = target;
  }
  // A small work area can allow only a short horizontal walk, or no walk at all.
  return longest;
}
