import type { PetWindowContext } from "./PetRoamingController";

export interface WindowLiftRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowLiftTargetSnapshot {
  rect: WindowLiftRect;
  anchorRatioX: number;
}

export interface WindowLiftContact {
  handXCss: number;
  handYCss: number;
}

export interface WindowLiftGeometry extends WindowLiftContact {
  visibleBounds: WindowLiftRect;
}

/** Initial drop is judged by the visible head, before changing to the lift rig. */
export function probeFromVisibleBounds(bounds: WindowLiftRect): WindowLiftContact {
  return { handXCss: bounds.x + bounds.width / 2, handYCss: bounds.y };
}

export function visibleLiftFits(
  position: { x: number; y: number }, geometry: WindowLiftGeometry, context: PetWindowContext,
): boolean {
  const s = context.scaleFactor;
  const b = geometry.visibleBounds, w = context.workArea;
  return position.x + b.x * s >= w.x - 1
    && position.y + b.y * s >= w.y - 1
    && position.x + (b.x + b.width) * s <= w.x + w.width + 1
    && position.y + (b.y + b.height) * s <= w.y + w.height + 1;
}

export function calculateWindowLiftPosition(
  target: WindowLiftTargetSnapshot,
  contact: WindowLiftContact,
  context: PetWindowContext,
): { x: number; y: number } {
  const scale = context.scaleFactor;
  const targetHandX = target.rect.x + target.rect.width * target.anchorRatioX;
  return {
    x: Math.round(targetHandX - contact.handXCss * scale),
    y: Math.round(target.rect.y + target.rect.height - contact.handYCss * scale),
  };
}

export function windowLiftAlignmentGap(
  target: WindowLiftTargetSnapshot,
  contact: WindowLiftContact,
  context: PetWindowContext,
): number {
  const handY = context.y + contact.handYCss * context.scaleFactor;
  return Math.abs(handY - (target.rect.y + target.rect.height));
}
