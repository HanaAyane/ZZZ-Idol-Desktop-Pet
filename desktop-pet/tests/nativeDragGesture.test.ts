import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyNativeDrag,
  supportsCursorDrivenDrag,
  shouldSettleNativePointerRelease,
} from "../src/pet/nativeDragGesture.ts";

test("a stable native window position is classified as a click", () => {
  assert.equal(classifyNativeDrag({ x: 100, y: 200 }, { x: 100, y: 200 }, 1.25, 4), "click");
});

test("movement below the DPI-adjusted threshold remains a click", () => {
  assert.equal(classifyNativeDrag({ x: 0, y: 0 }, { x: 4, y: 0 }, 1.25, 4), "click");
});

test("movement at the DPI-adjusted threshold is classified as a drag", () => {
  assert.equal(classifyNativeDrag({ x: 0, y: 0 }, { x: 5, y: 0 }, 1.25, 4), "drag");
});

test("scale factors below one cannot shrink the physical drag threshold", () => {
  assert.equal(classifyNativeDrag({ x: 0, y: 0 }, { x: 3.9, y: 0 }, 0.8, 4), "click");
  assert.equal(classifyNativeDrag({ x: 0, y: 0 }, { x: 4, y: 0 }, 0.8, 4), "drag");
});

test("Windows and macOS select cursor-driven drag completion", () => {
  assert.equal(supportsCursorDrivenDrag("Mozilla/5.0 (Windows NT 10.0; Win64; x64)"), true);
  assert.equal(supportsCursorDrivenDrag("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"), true);
  assert.equal(supportsCursorDrivenDrag("Mozilla/5.0 (X11; Linux x86_64)"), false);
});

test("cursor-driven native gestures settle only after the physical button is released", () => {
  assert.equal(shouldSettleNativePointerRelease(true, true, true), false);
  assert.equal(shouldSettleNativePointerRelease(true, true, false), true);
  assert.equal(shouldSettleNativePointerRelease(true, false, false), false);
  assert.equal(shouldSettleNativePointerRelease(false, true, false), false);
});
