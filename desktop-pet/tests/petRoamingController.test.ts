import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { PetRoamingController, type PetWindowContext } from "../src/pet/PetRoamingController.ts";
import type { CoordinationSceneToken } from "../src/pet/coordinationTypes.ts";
import { ROAMING_DIRECTIONS, roamingFacing } from "../src/pet/roamingGeometry.ts";

const token = { sceneId: 1, generation: 1 };

async function fixture(t: TestContext, scaleFactor = 1, initial: Partial<PetWindowContext> = {}, random = () => 0.5) {
  let now = 0, nextId = 0;
  let context: PetWindowContext = {
    x: 300, y: 200, width: 520 * scaleFactor, height: 600 * scaleFactor,
    scaleFactor, monitorName: "main", workArea: { x: 0, y: 0, width: 3840, height: 2160 },
    ...initial,
  };
  const frames = new Map<number, (timestamp: number) => void>();
  const timers = new Map<number, () => void>();
  const facings: string[] = [];
  const completed: CoordinationSceneToken[] = [], cancelled: string[] = [], errors: unknown[] = [];
  const moves: Array<{ x: number; y: number }> = [];
  let nativeArea = context.workArea;
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    __TAURI_INTERNALS__: {
      async invoke(command: string, args?: { x: number; y: number; roaming?: boolean }) {
        if (command === "initialize_pet_window") return context;
        assert.equal(command, "move_pet_window");
        assert.ok(args);
        moves.push({ x: args.x, y: args.y });
        const centerY = args.y + context.height / 2;
        const preserveTop = args.roaming && context.y < nativeArea.y && args.y >= context.y
          && centerY >= nativeArea.y && centerY < nativeArea.y + nativeArea.height;
        context = { ...context, workArea: nativeArea,
          x: Math.max(nativeArea.x, Math.min(nativeArea.x + Math.max(0, nativeArea.width - context.width), args.x)),
          y: preserveTop ? args.y : Math.max(nativeArea.y, Math.min(nativeArea.y + Math.max(0, nativeArea.height - context.height), args.y)),
        };
        return context;
      },
    },
    requestAnimationFrame(callback: (timestamp: number) => void) { frames.set(++nextId, callback); return nextId; },
    cancelAnimationFrame(id: number) { frames.delete(id); },
    setTimeout(callback: () => void) { timers.set(++nextId, callback); return nextId; },
    clearTimeout(id: number) { timers.delete(id); },
  } });
  t.mock.method(performance, "now", () => now);
  const controller = new PetRoamingController({
    canStartWalking: () => true, onWalkStart: direction => { facings.push(direction); return true; },
    onWalkStop() {}, onPositionSettled() {},
    onCoordinatedMoveComplete: value => completed.push(value),
    onCoordinatedMoveCancel: (_value, reason) => cancelled.push(reason),
    onError: error => errors.push(error),
  }, random, () => now);
  t.after(() => {
    controller.dispose();
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  });
  await controller.initialize(null);
  return {
    controller, completed, cancelled, errors, moves, facings,
    fireIdleTimer() {
      const callbacks = [...timers.values()];
      timers.clear();
      callbacks.forEach(callback => callback());
    },
    getContext: () => context,
    clampY(value: number) { nativeArea = { ...nativeArea, height: value + context.height - nativeArea.y }; },
    async advance(milliseconds: number, frameMs: number) {
      const end = now + milliseconds;
      while (now < end) {
        now = Math.min(end, now + frameMs);
        const callbacks = [...frames.values()];
        frames.clear();
        callbacks.forEach(callback => callback(now));
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      assert.deepEqual(errors, []);
    },
  };
}

for (const hz of [60, 144, 240]) {
  test(`gather accumulates vertical subpixels at ${hz} Hz with automatic walking disabled`, async t => {
    const f = await fixture(t);
    f.controller.setEnabled(false);
    assert.equal(f.controller.startCoordinatedMove({ x: 300, y: 254, direction: "right" }, token), true);
    await f.advance(1500, 1000 / hz);
    assert.equal(f.getContext().y, 254);
    assert.deepEqual(f.completed, [token]);
    assert.equal(f.controller.getSnapshot().walking, false);
  });
}

test("shallow diagonal gathering keeps both axes progressing", async t => {
  const f = await fixture(t);
  f.controller.startCoordinatedMove({ x: 516, y: 220, direction: "right" }, token);
  await f.advance(2000, 1000 / 60);
  assert.ok(f.getContext().y >= 209, `vertical progress was lost: ${f.getContext().y}`);
  await f.advance(3000, 1000 / 60);
  assert.deepEqual({ x: f.getContext().x, y: f.getContext().y }, { x: 516, y: 220 });
  assert.deepEqual(f.completed, [token]);
});

test("long gathering at minimum speed completes before the eight-second scene timeout", async t => {
  const f = await fixture(t);
  f.controller.setSpeed(0.5);
  f.controller.startCoordinatedMove({ x: 2300, y: 600, direction: "right" }, token);
  await f.advance(7000, 1000 / 60);
  assert.deepEqual(f.completed, [token]);
  assert.deepEqual({ x: f.getContext().x, y: f.getContext().y }, { x: 2300, y: 600 });
});

test("gathering uses elapsed time when native moves slow the frame loop", async t => {
  const f = await fixture(t, 1.5);
  f.controller.startCoordinatedMove({ x: 1800, y: 500, direction: "right" }, token);
  await f.advance(7000, 100);
  assert.deepEqual(f.completed, [token]);
});

test("a delayed gather command respects its remaining scene lifetime", async t => {
  const f = await fixture(t);
  f.controller.startCoordinatedMove({ x: 1300, y: 400, direction: "right" }, token, 4000);
  await f.advance(3200, 1000 / 144);
  assert.deepEqual(f.completed, [token]);
  assert.deepEqual({ x: f.getContext().x, y: f.getContext().y }, { x: 1300, y: 400 });
});

test("native work-area clamping still completes a coordinated move", async t => {
  const f = await fixture(t);
  f.clampY(220);
  f.controller.startCoordinatedMove({ x: 300, y: 254, direction: "right" }, token);
  await f.advance(1500, 1000 / 60);
  assert.equal(f.getContext().y, 220);
  assert.deepEqual(f.completed, [token]);
});

test("gathering from the report's off-screen coordinates reaches the layout rather than the nearest edge", async t => {
  const f = await fixture(t, 1.25, {
    x: -15, y: 0, workArea: { x: 0, y: 30, width: 2560, height: 1410 },
  });
  f.controller.startCoordinatedMove({ x: 240, y: 423, direction: "right" }, token);
  await f.advance(7000, 1000 / 180);
  assert.deepEqual({ x: f.getContext().x, y: f.getContext().y }, { x: 240, y: 423 });
  assert.deepEqual(f.completed, [token]);
});

test("a pet dragged below the work area still moves upward to the group", async t => {
  const f = await fixture(t, 1.25, {
    x: 22, y: 700, workArea: { x: 0, y: 30, width: 2560, height: 1410 },
  });
  f.controller.startCoordinatedMove({ x: 23, y: 423, direction: "right" }, token);
  await f.advance(7000, 1000 / 180);
  assert.deepEqual({ x: f.getContext().x, y: f.getContext().y }, { x: 23, y: 423 });
  assert.deepEqual(f.completed, [token]);
});

test("user interruption cancels gathering without later movement or completion", async t => {
  const f = await fixture(t);
  f.controller.startCoordinatedMove({ x: 600, y: 250, direction: "right" }, token);
  await f.advance(300, 1000 / 60);
  f.controller.interrupt();
  const moveCount = f.moves.length;
  await f.advance(8000, 1000 / 60);
  assert.equal(f.moves.length, moveCount);
  assert.deepEqual(f.completed, []);
  assert.deepEqual(f.cancelled, ["interrupted"]);
});

test("ordinary roaming retains the configured speed and fixed vertical position", async t => {
  const f = await fixture(t, 1.5);
  f.controller.setSpeed(0.5);
  assert.equal(await f.controller.simulateWalk(120, "right"), true);
  await f.advance(1000, 1000 / 60);
  assert.ok(Math.abs(f.getContext().x - 341) <= 1);
  assert.equal(f.getContext().y, 200);
  assert.deepEqual(f.completed, []);
});

for (const direction of ROAMING_DIRECTIONS) {
  for (const hz of [60, 144, 240]) {
    test(`${direction} free roaming keeps the same speed and arrives at ${hz} Hz`, async t => {
      const f = await fixture(t, 1.5, { x: 1000, y: 600 });
      f.controller.setSpeed(0.5);
      assert.equal(await f.controller.simulateWalk(120, direction), true);
      const target = f.controller.getSnapshot();
      assert.equal(target.direction, direction);
      assert.deepEqual(f.facings, [roamingFacing(direction)]);
      assert.equal(target.currentY, 600);
      await f.advance(1000, 1000 / hz);
      const travel = Math.hypot(f.getContext().x - 1000, f.getContext().y - 600);
      assert.ok(Math.abs(travel - 40.5) <= 1, `unexpected distance: ${travel}`);
      await f.advance(4000, 1000 / hz);
      assert.deepEqual({ x: f.getContext().x, y: f.getContext().y }, { x: target.targetX, y: target.targetY });
      assert.equal(f.controller.getSnapshot().walking, false);
      assert.deepEqual(f.completed, []);
      assert.deepEqual(f.cancelled, []);
    });
  }
  test(`automatic scheduling can choose ${direction}`, async t => {
    const index = ROAMING_DIRECTIONS.indexOf(direction);
    const f = await fixture(t, 1, { x: 1000, y: 600 }, () => (index + 0.5) / 6);
    f.fireIdleTimer();
    assert.equal(f.controller.getSnapshot().walking, true);
    assert.equal(f.controller.getSnapshot().direction, direction);
  });
}

for (const mode of ["interrupt", "disable", "lift"] as const) {
  test(`${mode} stops both axes of diagonal roaming`, async t => {
    const f = await fixture(t);
    await f.controller.simulateWalk(120, "right-down");
    await f.advance(300, 1000 / 60);
    if (mode === "interrupt") f.controller.interrupt();
    if (mode === "disable") f.controller.setEnabled(false);
    if (mode === "lift") await f.controller.pauseForWindowLift();
    const count = f.moves.length;
    await f.advance(5000, 1000 / 60);
    assert.equal(f.moves.length, count);
    assert.equal(f.controller.getSnapshot().walking, false);
  });
}

test("a corner walk turns inward, keeps the requested distance and stops", async t => {
  const f = await fixture(t, 1, { x: 0, y: 0 });
  await f.controller.simulateWalk(120, "left-up");
  const target = f.controller.getSnapshot();
  assert.equal(target.direction, "right-down");
  assert.ok(Math.abs(Math.hypot(target.targetX!, target.targetY!) - 120) < 1);
  await f.advance(3000, 1000 / 144);
  assert.equal(f.controller.getSnapshot().walking, false);
  assert.ok(f.moves.every(p => p.x >= 0 && p.y >= 0));
});

test("a top-edge drag resumes diagonal roaming without a first-frame jump", async t => {
  const f = await fixture(t, 2, { x: 1000, y: -200 });
  await f.controller.simulateWalk(120, "right-down");
  await f.advance(1000, 1000 / 144);
  assert.ok(f.moves[0].y < -190);
  assert.ok(Math.abs(Math.hypot(f.getContext().x - 1000, f.getContext().y + 200) - 108) <= 1);
  await f.advance(2000, 1000 / 144);
  assert.equal(f.controller.getSnapshot().walking, false);
});

test("an undersized work area stays idle without native movement or a frame loop", async t => {
  const f = await fixture(t, 1, { x: 0, y: 0, workArea: { x: 0, y: 0, width: 400, height: 400 } });
  assert.equal(await f.controller.simulateWalk(120, "left-up"), false);
  await f.advance(1000, 1000 / 60);
  assert.deepEqual(f.moves, []);
  assert.deepEqual(f.facings, []);
  assert.equal(f.controller.getSnapshot().walking, false);
  assert.notEqual(f.controller.getSnapshot().nextWalkInMs, null);
});
