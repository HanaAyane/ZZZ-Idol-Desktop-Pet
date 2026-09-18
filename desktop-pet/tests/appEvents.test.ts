import assert from "node:assert/strict";
import test from "node:test";
import { APP_SETTINGS_STATE, PET_COORDINATION_COMMAND, listenAppEvent } from "../src/characters/events.ts";

test("targeted coordination is delivered once per pet while settings broadcasts reach every window", async t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  const callbacks = new Map<number, (event: unknown) => void>();
  const listeners: Array<{ event: string; target: { kind: string; label?: string }; handler: number }> = [];
  let nextId = 0;
  const metadata = { currentWindow: { label: "pet-airui" } };
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    __TAURI_INTERNALS__: {
      metadata,
      transformCallback(callback: (event: unknown) => void) { callbacks.set(++nextId, callback); return nextId; },
      async invoke(command: string, args: typeof listeners[number]) {
        assert.equal(command, "plugin:event|listen");
        listeners.push(args);
        return args.handler;
      },
    },
  } });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "window", original);
    else Reflect.deleteProperty(globalThis, "window");
  });
  const moves = { airui: 0, nangong: 0, qianxia: 0 }, settings = { airui: 0, nangong: 0, qianxia: 0 };
  for (const id of ["airui", "nangong", "qianxia"] as const) {
    metadata.currentWindow.label = `pet-${id}`;
    await listenAppEvent(PET_COORDINATION_COMMAND, command => {
      if (command.participantIds.includes(id)) moves[id]++;
    });
    await listenAppEvent(APP_SETTINGS_STATE, () => { settings[id]++; });
  }
  // Tauri's global Any listener receives even events emitted to another label.
  // Match its routing rule so three directed sends expose accidental broadcasts.
  function emit(event: string, target: string | null, payload: unknown) {
    for (const listener of listeners) {
      if (listener.event === event && (target === null || listener.target.kind === "Any" || listener.target.label === target)) {
        callbacks.get(listener.handler)!({ payload });
      }
    }
  }
  for (const id of Object.keys(moves)) emit(PET_COORDINATION_COMMAND, `pet-${id}`, { participantIds: Object.keys(moves) });
  emit(APP_SETTINGS_STATE, null, {});
  assert.deepEqual(moves, { airui: 1, nangong: 1, qianxia: 1 });
  assert.deepEqual(settings, { airui: 1, nangong: 1, qianxia: 1 });
});
