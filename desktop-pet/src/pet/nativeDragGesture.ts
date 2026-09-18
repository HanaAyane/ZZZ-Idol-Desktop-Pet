export interface NativeDragPoint {
  x: number;
  y: number;
}

export type NativeDragOutcome = "click" | "drag";

export function classifyNativeDrag(
  start: NativeDragPoint,
  end: NativeDragPoint,
  scaleFactor: number,
  dragThresholdCssPx: number,
): NativeDragOutcome {
  const distance = Math.hypot(end.x - start.x, end.y - start.y);
  const physicalThreshold = dragThresholdCssPx * Math.max(1, scaleFactor);
  return distance >= physicalThreshold ? "drag" : "click";
}

export function supportsCursorDrivenDrag(userAgent: string): boolean {
  return /Windows|Macintosh|Mac OS X/i.test(userAgent);
}

export function shouldSettleNativePointerRelease(
  cursorDrivenDrag: boolean,
  pointerDown: boolean,
  primaryButtonDown: boolean,
): boolean {
  return cursorDrivenDrag && pointerDown && !primaryButtonDown;
}
