import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

async function fixture(t: TestContext, userAgent = "Windows NT 10.0") {
  const originals = ["window", "navigator", "Element"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  class FakeElement extends EventTarget { matches() { return false; } }
  const surface = new FakeElement(), win = new EventTarget();
  const timers = new Map<number, () => void>();
  let nextId = 0, position = { x: 700, y: 0 };
  let finishNative!: (result: { start: { x: number; y: number }; dragged: boolean; cancelled: boolean }) => void;
  const calls: string[] = [], events: string[] = [], errors: unknown[] = [];
  Object.assign(win, {
    devicePixelRatio: 1.25,
    __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener() {} },
    setTimeout(callback: () => void) { timers.set(++nextId, callback); return nextId; },
    clearTimeout(id: number) { timers.delete(id); },
    __TAURI_INTERNALS__: {
      metadata: { currentWindow: { label: "pet-airui" } },
      transformCallback() { return ++nextId; },
      async invoke(command: string, args: Record<string, unknown>) {
        calls.push(command);
        if (command === "plugin:window|outer_position") return position;
        if (command === "plugin:window|scale_factor") return 1.25;
        if (command === "drag_pet_window") {
          assert.deepEqual(args, { grabXCss: 200, grabYCss: 250 });
          return new Promise(resolve => { finishNative = resolve; });
        }
        if (["set_pet_cursor_passthrough", "cancel_pet_drag", "plugin:event|unlisten"].includes(command)) return;
        if (command === "plugin:event|listen") return ++nextId;
        throw new Error(`Unexpected command ${command}`);
      },
    },
  });
  Object.defineProperty(globalThis, "window", { configurable: true, value: win });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { userAgent } });
  Object.defineProperty(globalThis, "Element", { configurable: true, value: FakeElement });
  const { PetInteractionController } = await import("../src/pet/PetInteractionController.ts");
  const controller = new PetInteractionController(surface as unknown as HTMLElement, {
    sampleAlphaAt: () => 1, onHover() {}, onReaction: kind => events.push(kind),
    onDragStart: () => events.push("start"), onDragMove() {},
    onDragEnd: () => events.push("end"), onError: error => errors.push(error),
  });
  await flush();
  t.after(async () => {
    controller.dispose();
    await flush();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    assert.deepEqual(errors, []);
  });
  function pointer(type: string, target: EventTarget) {
    const event = new Event(type);
    Object.assign(event, { button: 0, buttons: type === "pointerdown" ? 1 : 0,
      isPrimary: true, pointerId: 1, clientX: 200, clientY: 250 });
    target.dispatchEvent(event);
  }
  return {
    controller, calls, events,
    down() { pointer("pointerdown", surface); },
    up() { pointer("pointerup", win); },
    async finish(dragged: boolean, cancelled = false) {
      if (dragged && !cancelled) position = { x: 700, y: -233 };
      finishNative({ start: { x: 700, y: 0 }, dragged, cancelled });
      await flush();
    },
  };
}

for (const platform of ["Windows NT 10.0", "Macintosh; Intel Mac OS X 10_15_7"]) {

test(`${platform} drag waits for the final native position before ending the gesture`, async t => {
  const f = await fixture(t, platform);
  f.down();
  f.up(); // WebView mouseup precedes the worker's final move.
  assert.equal(f.controller.getSnapshot().pointerDown, true);
  assert.deepEqual(f.events, []);
  await f.finish(true);
  assert.deepEqual(f.events, ["start", "end"]);
  assert.equal(f.controller.getSnapshot().pointerDown, false);
  assert.equal(f.controller.getSnapshot().pendingClick, false);
  assert.equal(f.calls.includes("plugin:window|start_dragging"), false);
});

test(`${platform} stationary gestures still enter click recognition`, async t => {
  const f = await fixture(t, platform);
  f.down(); f.up();
  await f.finish(false);
  assert.deepEqual(f.events, []);
  assert.equal(f.controller.getSnapshot().pendingClick, true);
});

test(`${platform} reset cancels the worker and ignores its late completion`, async t => {
  const f = await fixture(t, platform);
  f.down();
  f.controller.reset();
  assert.ok(f.calls.includes("cancel_pet_drag"));
  await f.finish(true, true);
  assert.deepEqual(f.events, []);
  assert.equal(f.controller.getSnapshot().pointerDown, false);
});

}
