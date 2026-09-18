import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { ReactionKind } from "../characters/types";
import {
  classifyNativeDrag,
  supportsCursorDrivenDrag,
  shouldSettleNativePointerRelease,
} from "./nativeDragGesture.ts";

export interface InteractionHost {
  sampleAlphaAt(clientX: number, clientY: number): number | null;
  onCursorSample?(clientX: number | null, clientY: number | null): void;
  onPixelPassthroughSample?(passthrough: boolean, alpha: number | null): void;
  onPointerIntent?(): void;
  onHover(hovered: boolean): void;
  onReaction(kind: ReactionKind): void;
  onDragStart(): void;
  onDragMove(deltaXCssPx: number, deltaYCssPx: number, elapsedMs: number): void;
  onDragEnd(): void;
  onError(error: unknown): void;
}

export interface PetInteractionSnapshot {
  pointerDown: boolean;
  dragging: boolean;
  hoverActive: boolean;
  clickCount: number;
  pendingClick: boolean;
  pendingHover: boolean;
  pixelPassthrough: boolean;
  lastSampledAlpha: number | null;
}

export interface InteractionPreferences {
  clickEnabled: boolean;
  doubleClickEnabled: boolean;
  hoverEnabled: boolean;
}

interface PhysicalPoint {
  x: number;
  y: number;
}

interface PetCursorSample {
  cursorX: number;
  cursorY: number;
  windowX: number;
  windowY: number;
  scaleFactor: number;
  primaryButtonDown: boolean;
}

type UnlistenFn = () => void;

const DOUBLE_CLICK_MS = 300;
const RAPID_CLICK_WINDOW_MS = 4000;
const RAPID_CLICK_THRESHOLD = 5;
const DRAG_THRESHOLD_CSS_PX = 4;
const NATIVE_DRAG_STABLE_MS = 650;
const HOVER_INTENT_MS = 300;
const PIXEL_HIT_TEST_INTERVAL_MS = 40;
const PIXEL_ENTER_ALPHA = 0.08;
const PIXEL_EXIT_ALPHA = 0.025;
const PIXEL_EXIT_CONFIRMATIONS = 2;

const EXCLUDED_TARGET_SELECTOR = [
  "[data-debug-panel]",
  ".pet-debug-panel",
  "button",
  "input",
  "select",
  "textarea",
  "a[href]",
  "label",
  "summary",
  "[contenteditable]:not([contenteditable='false'])",
  "[role='button']",
  "[role='link']",
  "[role='menuitem']",
  "[role='tab']",
  "[role='checkbox']",
  "[role='radio']",
  "[role='switch']",
  "[role='option']",
].join(",");

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

export class PetInteractionController {
  private readonly cursorDrivenDrag = supportsCursorDrivenDrag(navigator.userAgent);
  private readonly nativeWindow = window.__TAURI_INTERNALS__ ? getCurrentWindow() : null;
  private pointerId: number | null = null;
  private startX = 0;
  private startY = 0;
  private pointerDown = false;
  private dragging = false;
  private suppressPointerUp = false;
  private clickTimer: number | null = null;
  private hoverIntentTimer: number | null = null;
  private hoverActive = false;
  private nativeDragStableTimer: number | null = null;
  private firstClickAt = 0;
  private rapidClicks: number[] = [];
  private nativePosition: PhysicalPoint | null = null;
  private nativeDragStartPosition: PhysicalPoint | null = null;
  private nativeScaleFactor = Math.max(1, window.devicePixelRatio || 1);
  private unlistenWindowMoved: UnlistenFn | null = null;
  private gestureSequence = 0;
  private cursorDragGesture: number | null = null;
  private lastMotionAt = 0;
  private lastPointerX = 0;
  private lastPointerY = 0;
  private pixelHitTestTimer: number | null = null;
  private pixelHitTestInFlight = false;
  private pixelPassthrough = false;
  private desiredPixelPassthrough = false;
  private pixelExitConfirmations = 0;
  private lastSampledAlpha: number | null = null;
  private passthroughTransition: Promise<void> = Promise.resolve();
  private pixelFailureReported = false;
  private enabled = true;
  private preferences: InteractionPreferences = {
    clickEnabled: true,
    doubleClickEnabled: true,
    hoverEnabled: true,
  };
  private disposed = false;

  private readonly surface: HTMLElement;
  private readonly host: InteractionHost;
  private readonly now: () => number;

  constructor(surface: HTMLElement, host: InteractionHost, now: () => number = Date.now) {
    this.surface = surface;
    this.host = host;
    this.now = now;
    surface.addEventListener("pointerdown", this.handlePointerDown);
    surface.addEventListener("pointerenter", this.handlePointerEnter);
    surface.addEventListener("pointerleave", this.handlePointerLeave);
    surface.addEventListener("contextmenu", this.handleContextMenu);
    window.addEventListener("pointerdown", this.handleGlobalPointerDownFallback, true);
    window.addEventListener("pointermove", this.handlePointerMove, true);
    window.addEventListener("pointerup", this.handlePointerUp, true);
    window.addEventListener("pointercancel", this.handlePointerCancel, true);
    window.addEventListener("mouseup", this.handleMouseUpFallback, true);
    if (this.nativeWindow) void this.initializeNativeWindow();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelCursorDrag();
    this.clearClickTimer();
    this.clearHoverIntentTimer();
    this.deactivateHover();
    this.clearNativeDragStableTimer();
    this.finishPointerGesture(false);
    this.clearPixelHitTestTimer();
    void this.setPixelPassthrough(false, true);
    this.unlistenWindowMoved?.();
    this.unlistenWindowMoved = null;
    this.surface.removeEventListener("pointerdown", this.handlePointerDown);
    this.surface.removeEventListener("pointerenter", this.handlePointerEnter);
    this.surface.removeEventListener("pointerleave", this.handlePointerLeave);
    this.surface.removeEventListener("contextmenu", this.handleContextMenu);
    window.removeEventListener("pointerdown", this.handleGlobalPointerDownFallback, true);
    window.removeEventListener("pointermove", this.handlePointerMove, true);
    window.removeEventListener("pointerup", this.handlePointerUp, true);
    window.removeEventListener("pointercancel", this.handlePointerCancel, true);
    window.removeEventListener("mouseup", this.handleMouseUpFallback, true);
  }

  reset(): void {
    this.gestureSequence += 1;
    this.cancelCursorDrag();
    this.clearClickTimer();
    this.clearHoverIntentTimer();
    this.deactivateHover();
    this.clearNativeDragStableTimer();
    this.finishPointerGesture(false);
    this.rapidClicks = [];
    this.pixelExitConfirmations = 0;
    if (this.nativeWindow) void this.setPixelPassthrough(false);
  }

  setEnabled(enabled: boolean): void {
    if (this.disposed || this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) this.reset();
    else if (this.nativeWindow) this.schedulePixelHitTest(0);
  }

  setPreferences(preferences: InteractionPreferences): void {
    this.preferences = { ...preferences };
    if (!preferences.hoverEnabled) {
      this.clearHoverIntentTimer();
      this.deactivateHover();
    }
    if (!preferences.clickEnabled && !preferences.doubleClickEnabled) this.cancelAllClickRecognition();
  }

  getSnapshot(): PetInteractionSnapshot {
    return {
      pointerDown: this.pointerDown,
      dragging: this.dragging,
      hoverActive: this.hoverActive,
      clickCount: this.rapidClicks.length,
      pendingClick: this.clickTimer !== null,
      pendingHover: this.hoverIntentTimer !== null,
      pixelPassthrough: this.pixelPassthrough,
      lastSampledAlpha: this.lastSampledAlpha,
    };
  }

  simulateClick(): void {
    if (!this.enabled || this.disposed) return;
    this.registerClick(this.now());
  }

  simulateDoubleClick(): void {
    if (!this.enabled || this.disposed) return;
    this.cancelPendingClick();
    this.host.onReaction("doubleClick");
  }

  simulateRapidClick(): void {
    if (!this.enabled || this.disposed) return;
    this.cancelPendingClick();
    this.rapidClicks = [];
    this.host.onReaction("rapidClick");
  }

  simulateDrag(): void {
    if (!this.enabled || this.disposed) return;
    this.confirmDrag();
    this.host.onDragMove(24, 0, 16);
    this.host.onDragMove(-36, 0, 24);
    this.finishDrag();
  }

  private async initializeNativeWindow(): Promise<void> {
    const nativeWindow = this.nativeWindow;
    if (!nativeWindow) return;

    try {
      const unlisten = await nativeWindow.onMoved(({ payload }) => {
        this.handleNativeWindowMoved(payload);
      });
      if (this.disposed) unlisten();
      else this.unlistenWindowMoved = unlisten;
    } catch (error) {
      if (!this.disposed) this.host.onError(error);
    }

    try {
      const [position, scaleFactor] = await Promise.all([
        nativeWindow.outerPosition(),
        nativeWindow.scaleFactor(),
      ]);
      if (this.disposed) return;
      this.nativePosition = { x: position.x, y: position.y };
      this.nativeScaleFactor = Math.max(1, scaleFactor);
      this.schedulePixelHitTest(0);
    } catch (error) {
      if (!this.disposed) this.host.onError(error);
    }
  }

  private readonly handlePointerDown = (event: PointerEvent) => {
    if (this.disposed || !this.enabled) return;
    if (this.cursorDragGesture !== null) return;
    if (event.button !== 0 || !event.isPrimary || this.isExcludedEvent(event)) return;

    this.host.onPointerIntent?.();
    this.clearHoverIntentTimer();

    this.pointerId = event.pointerId;
    const gestureId = ++this.gestureSequence;
    this.startX = event.clientX;
    this.startY = event.clientY;
    this.lastPointerX = event.clientX;
    this.lastPointerY = event.clientY;
    this.lastMotionAt = this.now();
    this.pointerDown = true;
    this.dragging = false;
    this.suppressPointerUp = false;
    this.nativeDragStartPosition = this.nativePosition ? { ...this.nativePosition } : null;

    if (this.nativeWindow) {
      this.pixelExitConfirmations = 0;
      void this.setPixelPassthrough(false);
      // Native dragging must be requested directly from pointerdown. Pixel
      // hit-testing remains locked interactive until the gesture has ended.
      if (this.cursorDrivenDrag) {
        // Caption dragging clamps the transparent top margin to the monitor.
        // Windows and macOS instead follow the cursor, including negative Y.
        this.cursorDragGesture = gestureId;
        void this.startCursorDrag(event.clientX, event.clientY, gestureId);
      } else {
        void this.nativeWindow.startDragging()
          .then(() => this.reconcileNativeDrag(this.nativeDragStartPosition, gestureId))
          .catch((error) => {
            if (!this.disposed) this.host.onError(error);
          });
      }
    } else {
      this.surface.setPointerCapture?.(event.pointerId);
    }

    event.preventDefault();
  };

  private readonly handleGlobalPointerDownFallback = () => {
    // A system drag may swallow the release event from the previous gesture. Any
    // new press, including one on the debug panel, proves that gesture ended.
    if (this.pointerDown || this.dragging) this.finishPointerGesture(false);
  };

  private readonly handlePointerMove = (event: PointerEvent) => {
    if (!this.nativeWindow) this.host.onCursorSample?.(event.clientX, event.clientY);
    if (!this.pointerDown || this.pointerId !== event.pointerId) return;
    if ((event.buttons & 1) === 0) {
      this.finishPointerGesture(false);
      return;
    }
    if (this.dragging) {
      if (!this.nativeWindow) this.emitPointerMotion(event);
      return;
    }

    const distance = Math.hypot(event.clientX - this.startX, event.clientY - this.startY);
    // Native movement events are the authoritative signal, while DOM movement
    // is a useful parallel confirmation when a platform or automation driver
    // coalesces the native window move into a single event.
    if (distance >= DRAG_THRESHOLD_CSS_PX) {
      this.confirmDrag();
      if (!this.nativeWindow) this.emitPointerMotion(event);
    }
  };

  private readonly handlePointerUp = (event: PointerEvent) => {
    if (this.pointerId !== event.pointerId) return;
    this.finishPointerGesture(!this.dragging);
  };

  private readonly handlePointerCancel = (event: PointerEvent) => {
    if (this.pointerId !== event.pointerId) return;
    this.suppressPointerUp = true;
    this.finishPointerGesture(false);
  };

  private readonly handleMouseUpFallback = (event: MouseEvent) => {
    if (event.button !== 0 || (!this.pointerDown && !this.dragging)) return;
    this.finishPointerGesture(!this.dragging);
  };

  private readonly handlePointerEnter = (event: PointerEvent) => {
    if ((this.pointerDown || this.dragging) && (event.buttons & 1) === 0) {
      this.finishPointerGesture(false);
    }
    if (!this.enabled || !this.preferences.hoverEnabled || this.isExcludedEvent(event) || this.hoverActive) return;
    this.clearHoverIntentTimer();
    this.hoverIntentTimer = window.setTimeout(() => {
      this.hoverIntentTimer = null;
      if (this.disposed || !this.enabled || this.pointerDown || this.dragging) return;
      this.hoverActive = true;
      this.host.onHover(true);
    }, HOVER_INTENT_MS);
  };

  private readonly handlePointerLeave = () => {
    this.clearHoverIntentTimer();
    this.deactivateHover();
    if (!this.nativeWindow) this.host.onCursorSample?.(null, null);
  };

  private readonly handleContextMenu = (event: MouseEvent) => {
    if (this.isExcludedEvent(event)) return;
    event.preventDefault();
    if (this.disposed || !this.enabled || !this.nativeWindow) return;
    this.host.onPointerIntent?.();
    this.clearHoverIntentTimer();
    void invoke<void>("show_pet_context_menu").catch((error) => {
      if (!this.disposed) this.host.onError(error);
    });
  };

  private handleNativeWindowMoved(position: PhysicalPoint): void {
    const previousPosition = this.nativePosition;
    this.nativePosition = { x: position.x, y: position.y };
    if (!this.pointerDown) return;

    if (!this.nativeDragStartPosition) {
      // Initialization can still be pending during a very early press. The
      // first native move becomes the baseline and later moves confirm intent.
      this.nativeDragStartPosition = { ...this.nativePosition };
      return;
    }

    const distance = Math.hypot(
      position.x - this.nativeDragStartPosition.x,
      position.y - this.nativeDragStartPosition.y,
    );
    if (!this.dragging && distance >= DRAG_THRESHOLD_CSS_PX * this.nativeScaleFactor) {
      this.confirmDrag();
    }
    if (this.dragging) {
      if (previousPosition) {
        const now = this.now();
        this.host.onDragMove(
          (position.x - previousPosition.x) / this.nativeScaleFactor,
          (position.y - previousPosition.y) / this.nativeScaleFactor,
          Math.max(1, now - this.lastMotionAt),
        );
        this.lastMotionAt = now;
      }
      if (!this.cursorDrivenDrag) this.scheduleNativeDragStableEnd();
    }
  }

  private async reconcileNativeDrag(
    startPosition: PhysicalPoint | null,
    gestureId: number,
  ): Promise<void> {
    if (
      this.disposed ||
      gestureId !== this.gestureSequence ||
      !this.nativeWindow ||
      !this.pointerDown ||
      !startPosition
    ) {
      return;
    }
    try {
      const position = await this.nativeWindow.outerPosition();
      if (this.disposed || gestureId !== this.gestureSequence) return;
      this.nativePosition = { x: position.x, y: position.y };
      const outcome = classifyNativeDrag(
        startPosition,
        position,
        this.nativeScaleFactor,
        DRAG_THRESHOLD_CSS_PX,
      );
      if (!this.dragging && outcome === "drag") {
        // Some hosts coalesce or defer moved events until the native drag call
        // returns. A measured position change is still required before
        // confirming drag.
        this.confirmDrag();
        const now = this.now();
        this.host.onDragMove(
          (position.x - startPosition.x) / this.nativeScaleFactor,
          (position.y - startPosition.y) / this.nativeScaleFactor,
          Math.max(1, now - this.lastMotionAt),
        );
        this.lastMotionAt = now;
      }
      if (!this.cursorDrivenDrag && this.dragging) {
        // Other platforms still use the system drag path, whose return does
        // not always prove release. Keep a bounded stable-position fallback.
        this.scheduleNativeDragStableEnd();
      }
    } catch (error) {
      if (!this.disposed) this.host.onError(error);
    }
  }

  private confirmDrag(): void {
    if (this.dragging || this.disposed) return;
    this.dragging = true;
    this.clearHoverIntentTimer();
    this.suppressPointerUp = true;
    this.cancelAllClickRecognition();
    this.lastMotionAt = this.now();
    this.host.onDragStart();
  }

  private async startCursorDrag(grabXCss: number, grabYCss: number, gestureId: number): Promise<void> {
    let registerClick = false;
    try {
      const result = await invoke<{ start: PhysicalPoint; dragged: boolean; cancelled: boolean }>(
        "drag_pet_window", { grabXCss, grabYCss },
      );
      if (this.disposed || gestureId !== this.gestureSequence) return;
      await this.reconcileNativeDrag(result.start, gestureId);
      if (this.disposed || gestureId !== this.gestureSequence) return;
      if (result.dragged) this.confirmDrag();
      registerClick = !result.cancelled && !result.dragged;
    } catch (error) {
      if (!this.disposed) this.host.onError(error);
    } finally {
      if (this.cursorDragGesture === gestureId) {
        // Wait for the worker's final native move before persisting placement
        // or probing for lift targets. DOM mouseup can arrive before that move.
        this.cursorDragGesture = null;
        this.finishPointerGesture(registerClick);
      }
    }
  }

  private cancelCursorDrag(): void {
    if (this.cursorDragGesture === null) return;
    this.cursorDragGesture = null;
    void invoke<void>("cancel_pet_drag").catch(error => {
      if (!this.disposed) this.host.onError(error);
    });
  }

  private emitPointerMotion(event: PointerEvent): void {
    const now = this.now();
    this.host.onDragMove(
      event.clientX - this.lastPointerX,
      event.clientY - this.lastPointerY,
      Math.max(1, now - this.lastMotionAt),
    );
    this.lastPointerX = event.clientX;
    this.lastPointerY = event.clientY;
    this.lastMotionAt = now;
  }

  private finishPointerGesture(registerClick: boolean): void {
    if (this.cursorDragGesture !== null) return;
    const pointerId = this.pointerId;
    if (pointerId !== null && !this.nativeWindow && this.surface.hasPointerCapture?.(pointerId)) {
      this.surface.releasePointerCapture?.(pointerId);
    }

    const completedDrag = this.dragging;
    const shouldRegisterClick = registerClick && !completedDrag && !this.suppressPointerUp;
    if (completedDrag) this.finishDrag();
    this.clearNativeDragStableTimer();
    this.pointerId = null;
    this.pointerDown = false;
    this.suppressPointerUp = false;
    this.nativeDragStartPosition = null;
    if (shouldRegisterClick && !this.disposed) this.registerClick(this.now());
  }

  private finishDrag(): void {
    if (!this.dragging) return;
    this.dragging = false;
    this.host.onDragEnd();
    this.pixelExitConfirmations = 0;
  }

  private scheduleNativeDragStableEnd(): void {
    this.clearNativeDragStableTimer();
    this.nativeDragStableTimer = window.setTimeout(() => {
      this.nativeDragStableTimer = null;
      // The system drag fallback may suppress button-release events. Cursor-
      // driven macOS/Windows gestures instead wait for the native worker.
      this.finishPointerGesture(false);
    }, NATIVE_DRAG_STABLE_MS);
  }

  private registerClick(timestamp: number): void {
    this.rapidClicks = this.rapidClicks.filter((time) => timestamp - time <= RAPID_CLICK_WINDOW_MS);
    this.rapidClicks.push(timestamp);

    if (this.rapidClicks.length >= RAPID_CLICK_THRESHOLD) {
      this.cancelPendingClick();
      this.rapidClicks = [];
      if (this.preferences.clickEnabled) this.host.onReaction("rapidClick");
      return;
    }

    if (this.clickTimer !== null && timestamp - this.firstClickAt <= DOUBLE_CLICK_MS) {
      this.cancelPendingClick();
      if (this.preferences.doubleClickEnabled) this.host.onReaction("doubleClick");
      return;
    }

    this.firstClickAt = timestamp;
    this.clearClickTimer();
    this.clickTimer = window.setTimeout(() => {
      this.clickTimer = null;
      if (this.preferences.clickEnabled) this.host.onReaction("click");
    }, DOUBLE_CLICK_MS);
  }

  private cancelAllClickRecognition(): void {
    this.cancelPendingClick();
    this.rapidClicks = [];
  }

  private cancelPendingClick(): void {
    this.clearClickTimer();
    this.firstClickAt = 0;
  }

  private clearClickTimer(): void {
    if (this.clickTimer === null) return;
    window.clearTimeout(this.clickTimer);
    this.clickTimer = null;
  }

  private clearHoverIntentTimer(): void {
    if (this.hoverIntentTimer === null) return;
    window.clearTimeout(this.hoverIntentTimer);
    this.hoverIntentTimer = null;
  }

  private deactivateHover(): void {
    if (!this.hoverActive) return;
    this.hoverActive = false;
    this.host.onHover(false);
  }

  private clearNativeDragStableTimer(): void {
    if (this.nativeDragStableTimer === null) return;
    window.clearTimeout(this.nativeDragStableTimer);
    this.nativeDragStableTimer = null;
  }

  private schedulePixelHitTest(delayMs = PIXEL_HIT_TEST_INTERVAL_MS): void {
    if (!this.nativeWindow || this.disposed || this.pixelHitTestTimer !== null) return;
    this.pixelHitTestTimer = window.setTimeout(() => {
      this.pixelHitTestTimer = null;
      void this.runPixelHitTest();
    }, delayMs);
  }

  private clearPixelHitTestTimer(): void {
    if (this.pixelHitTestTimer === null) return;
    window.clearTimeout(this.pixelHitTestTimer);
    this.pixelHitTestTimer = null;
  }

  private async runPixelHitTest(): Promise<void> {
    if (!this.nativeWindow || this.disposed || this.pixelHitTestInFlight) return;
    this.pixelHitTestInFlight = true;
    try {
      const sample = await invoke<PetCursorSample>("sample_pet_cursor");
      if (this.disposed) return;
      this.pixelFailureReported = false;
      this.nativePosition = { x: sample.windowX, y: sample.windowY };
      this.nativeScaleFactor = Math.max(1, sample.scaleFactor);
      this.settleNativePointerRelease(sample);

      const clientX = (sample.cursorX - sample.windowX) / this.nativeScaleFactor;
      const clientY = (sample.cursorY - sample.windowY) / this.nativeScaleFactor;
      this.host.onCursorSample?.(clientX, clientY);
      const element = document.elementFromPoint(clientX, clientY);
      const domInteractive = Boolean(element?.closest(EXCLUDED_TARGET_SELECTOR));
      const lockedInteractive = !this.enabled || this.pointerDown || this.dragging || domInteractive;

      if (lockedInteractive) {
        if (domInteractive) {
          this.clearHoverIntentTimer();
          this.deactivateHover();
        }
        this.lastSampledAlpha = null;
        this.pixelExitConfirmations = 0;
        await this.setPixelPassthrough(false);
        this.host.onPixelPassthroughSample?.(this.pixelPassthrough, null);
        return;
      }

      const alpha = this.host.sampleAlphaAt(clientX, clientY);
      this.lastSampledAlpha = alpha;
      if (alpha === null) {
        this.pixelExitConfirmations = 0;
        await this.setPixelPassthrough(false);
        this.host.onPixelPassthroughSample?.(this.pixelPassthrough, null);
        return;
      }

      if (this.pixelPassthrough) {
        if (alpha >= PIXEL_ENTER_ALPHA) {
          this.pixelExitConfirmations = 0;
          await this.setPixelPassthrough(false);
        } else {
          this.clearHoverIntentTimer();
          this.deactivateHover();
        }
        this.host.onPixelPassthroughSample?.(this.pixelPassthrough, alpha);
        return;
      }

      if (alpha <= PIXEL_EXIT_ALPHA) {
        this.pixelExitConfirmations += 1;
        this.clearHoverIntentTimer();
        this.deactivateHover();
      } else this.pixelExitConfirmations = 0;
      if (this.pixelExitConfirmations >= PIXEL_EXIT_CONFIRMATIONS) {
        await this.setPixelPassthrough(true);
      }
      this.host.onPixelPassthroughSample?.(this.pixelPassthrough, alpha);
    } catch (error) {
      this.pixelExitConfirmations = 0;
      await this.setPixelPassthrough(false);
      if (!this.disposed && !this.pixelFailureReported) {
        this.pixelFailureReported = true;
        this.host.onError(error);
      }
    } finally {
      this.pixelHitTestInFlight = false;
      this.schedulePixelHitTest();
    }
  }

  private settleNativePointerRelease(sample: PetCursorSample): void {
    if (!shouldSettleNativePointerRelease(
      this.cursorDrivenDrag,
      this.pointerDown,
      sample.primaryButtonDown,
    )) return;

    const endPosition = { x: sample.windowX, y: sample.windowY };
    const outcome = this.nativeDragStartPosition
      ? classifyNativeDrag(
          this.nativeDragStartPosition,
          endPosition,
          this.nativeScaleFactor,
          DRAG_THRESHOLD_CSS_PX,
        )
      : this.dragging ? "drag" : "click";

    if (!this.dragging && outcome === "drag" && this.nativeDragStartPosition) {
      this.confirmDrag();
      const now = this.now();
      this.host.onDragMove(
        (endPosition.x - this.nativeDragStartPosition.x) / this.nativeScaleFactor,
        (endPosition.y - this.nativeDragStartPosition.y) / this.nativeScaleFactor,
        Math.max(1, now - this.lastMotionAt),
      );
      this.lastMotionAt = now;
    }

    // Native dragging can swallow DOM pointerup/mouseup. The OS button
    // state is authoritative: only settle after the physical left button is up.
    this.finishPointerGesture(outcome === "click" && !this.dragging);
  }

  private setPixelPassthrough(enabled: boolean, force = false): Promise<void> {
    if (!this.nativeWindow) return Promise.resolve();
    const desired = force ? enabled : enabled && this.enabled && !this.pointerDown && !this.dragging;
    this.desiredPixelPassthrough = desired;
    const operation = async () => {
      if (this.desiredPixelPassthrough !== desired || this.pixelPassthrough === desired) return;
      await invoke<void>("set_pet_cursor_passthrough", { enabled: desired });
      // Record what the operating system actually applied even if a newer
      // request arrived during IPC. The queued newer request can then correct
      // the native state instead of mistaking stale local state for reality.
      this.pixelPassthrough = desired;
    };
    const result = this.passthroughTransition.then(operation, operation);
    this.passthroughTransition = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private isExcludedEvent(event: Event): boolean {
    return event.composedPath().some(
      (target) => target instanceof Element && target.matches(EXCLUDED_TARGET_SELECTOR),
    );
  }

}
