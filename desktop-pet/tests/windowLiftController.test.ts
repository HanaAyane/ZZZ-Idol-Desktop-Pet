import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { WindowLiftController, type WindowLiftBridge } from "../src/pet/WindowLiftController.ts";
import type { PetWindowContext } from "../src/pet/PetRoamingController.ts";
import type { WindowLiftGeometry, WindowLiftTargetSnapshot } from "../src/pet/windowLiftGeometry.ts";

const action = JSON.parse(readFileSync(new URL("../public/characters/special-actions.json", import.meta.url), "utf8")).actions[0];
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

function fixture(ratio = 0.5) {
  let context: PetWindowContext = { x: 200, y: 400, width: 520, height: 600, scaleFactor: 1,
    monitorName: "main", workArea: { x: 0, y: 0, width: 1440, height: 900 } };
  let target: WindowLiftTargetSnapshot | null = { rect: { x: 200, y: 100, width: 900, height: 550 }, anchorRatioX: ratio };
  let geometry: WindowLiftGeometry = { handXCss: 260, handYCss: 220,
    visibleBounds: { x: 160, y: 180, width: 200, height: 240 } };
  const events: string[] = [], notices: string[] = [], errors: unknown[] = [];
  const timers = new Map<number, { callback: () => void; at: number }>();
  const attachModes: boolean[] = [];
  let now = 0, eligible = true;
  let timerId = 0, loaded = false, failLoad = false, rejectMove = false;
  let loadGate: Promise<void> | null = null;
  let attachGate: Promise<void> | null = null;
  const bridge: WindowLiftBridge = {
    native: true,
    async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
      events.push(command);
      if (command === "attach_window_lift") {
        assert.equal(args?.handYCss, loaded ? 220 : 195);
        attachModes.push(args?.automatic === true);
        if (attachGate) await attachGate;
        return target as T;
      }
      if (command === "get_window_lift_target") return target as T;
      if (command === "detach_window_lift") return undefined as T;
      if (command === "move_lift_pet_window") {
        assert.ok(loaded, "must load lift geometry before positioning");
        assert.deepEqual(args?.visibleBoundsCss, geometry.visibleBounds);
        if (rejectMove) return null as T;
        return { ...context, x: args?.x, y: args?.y } as T;
      }
      throw new Error(`Unexpected native mutation: ${command}`);
    },
    now: () => now,
    schedule(callback, ms) { timers.set(++timerId, { callback, at: now + ms }); return timerId; },
    cancel(id) { timers.delete(id); },
  };
  const controller = new WindowLiftController({
    getWindowContext: () => context,
    getProbe: () => loaded ? geometry : { handXCss: 260, handYCss: 195 },
    getLiftGeometry: () => loaded ? geometry : null,
    canAutomaticallyAttach: () => eligible && !loaded,
    async onAttached() {
      events.push("load_lift");
      if (loadGate) await loadGate;
      if (failLoad) throw new Error("load failed");
      loaded = true;
    },
    async onDetached() { events.push("restore_main"); loaded = false; },
    onPosition(next) { context = next; },
    onNotice(reason) { notices.push(reason); },
    onError(error) { errors.push(error); },
  }, bridge);
  controller.setEnabled(true);
  return { controller, events, notices, errors, timers, attachModes, getContext: () => context,
    setEligible(value: boolean) { eligible = value; },
    setTarget(next: WindowLiftTargetSnapshot | null) { target = next; },
    moveTarget(dx: number, dy: number) { target = target && { ...target,
      rect: { ...target.rect, x: target.rect.x + dx, y: target.rect.y + dy } }; },
    setGeometry(next: WindowLiftGeometry) { geometry = next; },
    failLoad() { failLoad = true; }, rejectMove() { rejectMove = true; },
    gateLoad(gate: Promise<void>) { loadGate = gate; },
    gateAttach(gate: Promise<void>) { attachGate = gate; },
    async tick() { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(t => t.callback()); await flush(); },
    async advance(ms: number) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now && timers.has(id)) { timers.delete(id); timer.callback(); }
      }
      await flush();
    },
  };
}

test("loads actual lift geometry before aligning, and allows transparent overflow", async () => {
  const f = fixture();
  assert.equal(await f.controller.notePetDragEnd(action), true);
  assert.deepEqual(f.events.slice(0, 4), ["attach_window_lift", "load_lift", "get_window_lift_target", "move_lift_pet_window"]);
  assert.equal(f.getContext().y, 430);
  assert.ok(f.getContext().y + 600 > 900);
  assert.equal(f.controller.getSnapshot().lastReason, "attached");
  f.controller.dispose();
});

test("three pets retain independent ratios while following the same window", async () => {
  const fixtures = [0.25, 0.5, 0.75].map(fixture);
  for (const f of fixtures) assert.equal(await f.controller.notePetDragEnd(action), true);
  assert.deepEqual(fixtures.map(f => f.getContext().x), [165, 390, 615]);
  for (const f of fixtures) { f.moveTarget(30, 20); await f.tick(); }
  assert.deepEqual(fixtures.map(f => f.getContext().x), [195, 420, 645]);
  assert.deepEqual(fixtures.map(f => f.getContext().y), [450, 450, 450]);
  fixtures.forEach(f => f.controller.dispose());
});

test("near miss reports why without changing rigs", async () => {
  const f = fixture(); f.setTarget(null);
  assert.equal(await f.controller.notePetDragEnd(action), false);
  assert.deepEqual(f.notices, ["no_nearby_window"]);
  assert.ok(!f.events.includes("load_lift"));
});

test("actual visible overflow restores main rig instead of silently clamping hands", async () => {
  const f = fixture(); f.moveTarget(0, 150);
  assert.equal(await f.controller.notePetDragEnd(action), false);
  assert.ok(f.events.includes("restore_main"));
  assert.ok(!f.events.includes("move_lift_pet_window"));
  assert.equal(f.controller.getSnapshot().lastReason, "insufficient_visible_space");
});

test("native rejection and resource failure both clean up bindings", async () => {
  for (const kind of ["move", "load"]) {
    const f = fixture(); if (kind === "move") f.rejectMove(); else f.failLoad();
    assert.equal(await f.controller.notePetDragEnd(action), false);
    assert.ok(f.events.includes("detach_window_lift"));
    assert.ok(f.events.includes("restore_main"));
    assert.equal(f.controller.getSnapshot().attached, false);
  }
});

test("target disappearance releases the pet and cancels polling", async () => {
  const f = fixture(); await f.controller.notePetDragEnd(action);
  f.setTarget(null); await f.tick();
  assert.equal(f.controller.getSnapshot().attached, false);
  assert.equal(f.notices.at(-1), "target_unavailable");
  assert.equal(f.timers.size, 0);
});

test("rescaling recalculates hand alignment; dragging suspends following", async () => {
  const f = fixture(); await f.controller.notePetDragEnd(action);
  f.setGeometry({ handXCss: 260, handYCss: 180,
    visibleBounds: { x: 130, y: 140, width: 260, height: 270 } });
  await f.tick();
  assert.equal(f.getContext().y, 470);
  f.controller.notePetDragStart();
  f.moveTarget(50, 0); await f.tick();
  assert.equal(f.getContext().x, 390);
  f.controller.dispose();
});

test("disabling while the rig loads prevents a stale follow operation", async () => {
  const f = fixture(); let release!: () => void;
  f.gateLoad(new Promise<void>(resolve => { release = resolve; }));
  const pending = f.controller.notePetDragEnd(action); await flush();
  f.controller.setEnabled(false); await flush(); release();
  assert.equal(await pending, false);
  assert.ok(!f.events.includes("move_lift_pet_window"));
  assert.equal(f.controller.getSnapshot().attached, false);
});

test("automatic lift is independent of manual setting and releases after 10 aligned seconds", async () => {
  const f = fixture(); f.controller.setEnabled(false); f.controller.setAutomaticEnabled(true);
  assert.equal(await f.controller.tryAutomaticAttach(action), true);
  assert.equal(f.controller.getSnapshot().mode, "automatic");
  assert.deepEqual(f.attachModes, [true]);
  await f.advance(9999);
  assert.equal(f.controller.getSnapshot().attached, true);
  await f.advance(1);
  assert.equal(f.controller.getSnapshot().attached, false);
  assert.equal(f.notices.at(-1), "automatic_timeout");
  assert.equal(f.timers.size, 0);
  assert.ok(f.events.includes("restore_main"));
  assert.equal(await f.controller.tryAutomaticAttach(action), false);
  await f.advance(15000);
  assert.equal(await f.controller.tryAutomaticAttach(action), true);
  f.controller.dispose();
});

test("manual drag takeover cancels automatic deadline and remains attached", async () => {
  const f = fixture(); f.controller.setAutomaticEnabled(true);
  await f.controller.tryAutomaticAttach(action);
  await f.advance(9000);
  f.controller.notePetDragStart();
  await f.controller.notePetDragEnd(action);
  assert.equal(f.controller.getSnapshot().mode, "manual");
  assert.deepEqual(f.attachModes, [true, false]);
  f.controller.setAutomaticEnabled(false);
  await f.advance(60000);
  assert.equal(f.controller.getSnapshot().attached, true);
  assert.ok(!f.events.includes("restore_main"));
  f.controller.dispose();
});

test("automatic acquisition is opt-in, walking-only, throttled and quiet on misses", async () => {
  const f = fixture();
  assert.equal(await f.controller.tryAutomaticAttach(action), false);
  f.controller.setAutomaticEnabled(true); f.setEligible(false);
  assert.equal(await f.controller.tryAutomaticAttach(action), false);
  f.setEligible(true); f.setTarget(null);
  assert.equal(await f.controller.tryAutomaticAttach(action), false);
  await f.advance(399); await f.controller.tryAutomaticAttach(action);
  assert.equal(f.attachModes.length, 1);
  await f.advance(1); await f.controller.tryAutomaticAttach(action);
  assert.equal(f.attachModes.length, 2);
  assert.deepEqual(f.notices, []);
  f.controller.notePetDragStart(); await f.advance(20000);
  assert.equal(await f.controller.tryAutomaticAttach(action), false);
  assert.equal(f.attachModes.length, 2);
});

test("settings disable, target loss, explicit release and disposal clear automatic timers", async () => {
  for (const cause of ["setting", "target", "escape", "dispose"]) {
    const f = fixture(); f.controller.setAutomaticEnabled(true);
    await f.controller.tryAutomaticAttach(action);
    if (cause === "setting") f.controller.setAutomaticEnabled(false);
    if (cause === "target") f.setTarget(null);
    if (cause === "escape") await f.controller.detach("escape_key");
    if (cause === "dispose") f.controller.dispose();
    await f.advance(80);
    assert.equal(f.controller.getSnapshot().attached, false, cause);
    assert.equal(f.timers.size, 0, cause);
    await f.advance(20000);
    assert.ok(!f.notices.includes("automatic_timeout"), cause);
  }
});

test("automatic hold time starts after loading, not when the nearby window is detected", async () => {
  const f = fixture(); f.controller.setAutomaticEnabled(true);
  let release!: () => void;
  f.gateLoad(new Promise<void>(resolve => { release = resolve; }));
  const pending = f.controller.tryAutomaticAttach(action); await flush();
  await f.advance(5000); release(); await pending;
  await f.advance(9999);
  assert.equal(f.controller.getSnapshot().attached, true);
  await f.advance(1);
  assert.equal(f.notices.at(-1), "automatic_timeout");
});

test("automatic loading cancellation drains cleanup before a later manual bind", async () => {
  const f = fixture(); f.controller.setAutomaticEnabled(true);
  let release!: () => void;
  f.gateAttach(new Promise<void>(resolve => { release = resolve; }));
  const automatic = f.controller.tryAutomaticAttach(action); await flush();
  assert.equal(await f.controller.tryAutomaticAttach(action), false, "no overlapping automatic requests");
  f.controller.notePetDragStart();
  const manual = f.controller.notePetDragEnd(action);
  release();
  assert.equal(await automatic, false);
  assert.equal(await manual, true);
  assert.equal(f.controller.getSnapshot().mode, "manual");
  assert.deepEqual(f.events.slice(0, 3), ["attach_window_lift", "detach_window_lift", "attach_window_lift"]);
  await f.advance(20000);
  assert.equal(f.controller.getSnapshot().attached, true);
  f.controller.dispose();
});

test("a walking stop during automatic lookup discards the candidate without loading", async () => {
  const f = fixture(); f.controller.setAutomaticEnabled(true);
  let release!: () => void;
  f.gateAttach(new Promise<void>(resolve => { release = resolve; }));
  const pending = f.controller.tryAutomaticAttach(action); await flush();
  f.setEligible(false); release();
  assert.equal(await pending, false);
  assert.ok(!f.events.includes("load_lift"));
  assert.equal(f.timers.size, 0);
});

test("three pets sharing a window have independent automatic and manual lifetimes", async () => {
  const pets = [0.25, 0.5, 0.75].map(fixture);
  for (const p of pets) p.controller.setAutomaticEnabled(true);
  await pets[0].controller.tryAutomaticAttach(action);
  await pets[1].controller.notePetDragEnd(action);
  await pets[2].advance(5000); await pets[2].controller.tryAutomaticAttach(action);
  await pets[0].advance(10000); await pets[1].advance(10000); await pets[2].advance(5000);
  assert.deepEqual(pets.map(p => p.controller.getSnapshot().attached), [false, true, true]);
  await pets[2].advance(5000);
  assert.deepEqual(pets.map(p => p.controller.getSnapshot().attached), [false, true, false]);
  pets.forEach(p => p.controller.dispose());
});

test("turning manual lift off does not end an active automatic lift", async () => {
  const f = fixture(); f.controller.setAutomaticEnabled(true);
  await f.controller.tryAutomaticAttach(action);
  f.controller.setEnabled(false); await flush();
  assert.equal(f.controller.getSnapshot().mode, "automatic");
  await f.advance(10000);
  assert.equal(f.notices.at(-1), "automatic_timeout");
});

test("dragging an automatic lift with manual lift disabled releases it on drop", async () => {
  const f = fixture(); f.controller.setEnabled(false); f.controller.setAutomaticEnabled(true);
  await f.controller.tryAutomaticAttach(action);
  f.controller.notePetDragStart(); await f.advance(10000);
  assert.equal(f.controller.getSnapshot().attached, true);
  assert.equal(await f.controller.notePetDragEnd(action), false);
  assert.equal(f.controller.getSnapshot().attached, false);
  assert.equal(f.timers.size, 0);
});

test("automatic loading disabled in flight restores the main rig and never starts its timer", async () => {
  const f = fixture(); f.controller.setAutomaticEnabled(true);
  let release!: () => void;
  f.gateLoad(new Promise<void>(resolve => { release = resolve; }));
  const pending = f.controller.tryAutomaticAttach(action); await flush();
  f.controller.setAutomaticEnabled(false); release();
  assert.equal(await pending, false); await flush();
  assert.equal(f.controller.getSnapshot().attached, false);
  assert.equal(f.timers.size, 0);
  assert.ok(f.events.includes("restore_main"));
  assert.ok(!f.events.includes("move_lift_pet_window"));
});

test("automatic space rejection restores the main rig without starting a hold timer", async () => {
  const f = fixture(); f.moveTarget(0, 150); f.controller.setAutomaticEnabled(true);
  assert.equal(await f.controller.tryAutomaticAttach(action), false);
  assert.equal(f.timers.size, 0);
  assert.ok(f.events.includes("restore_main"));
  assert.equal(await f.controller.tryAutomaticAttach(action), false, "rejection cooldown prevents reload loops");
});
