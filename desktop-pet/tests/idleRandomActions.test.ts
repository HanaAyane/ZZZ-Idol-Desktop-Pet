import assert from "node:assert/strict";
import test from "node:test";

import { AIRUI } from "../src/characters/airui.ts";
import { NANGONG } from "../src/characters/nangong.ts";
import { QIANXIA } from "../src/characters/qianxia.ts";
import type { SpineCharacterMetadata } from "../src/renderer/SpineRenderer.ts";
import { chooseIdleRandomAction, chooseIdleRandomDelay } from "../src/pet/idleRandomPolicy.ts";
import { PetStateMachine } from "../src/pet/PetStateMachine.ts";

test("each character uses the requested idle random action pool", () => {
  assert.deepEqual(AIRUI.behavior.idleRandom.actions, ["动作_无奈", "动作_自信"]);
  assert.deepEqual(QIANXIA.behavior.idleRandom.actions, ["动作_害羞", "动作_自信"]);
  assert.deepEqual(NANGONG.behavior.idleRandom.actions, [
    "动作_思考",
    "动作_害羞",
    "动作_自信",
    "动作_认真",
  ]);
});

test("all characters wait one minute and play idle random actions for six seconds", () => {
  for (const character of [AIRUI, QIANXIA, NANGONG]) {
    assert.deepEqual(character.behavior.idleRandom.delayMs, [60_000, 60_000]);
    assert.equal(character.behavior.idleRandom.durationMs, 6_000);
  }
});

test("idle random actions are restricted to animations available on the character", () => {
  assert.equal(
    chooseIdleRandomAction(["动作_无奈", "动作_不存在"], ["动作_待机", "动作_无奈"], "", () => 0.9),
    "动作_无奈",
  );
});

test("idle random actions avoid immediately repeating when another choice exists", () => {
  assert.equal(
    chooseIdleRandomAction(["动作_害羞", "动作_自信"], ["动作_害羞", "动作_自信"], "动作_害羞", () => 0),
    "动作_自信",
  );
});

test("idle random delay stays within the configured range", () => {
  assert.equal(chooseIdleRandomDelay([60_000, 60_000], () => 0), 60_000);
  assert.equal(chooseIdleRandomDelay([60_000, 60_000], () => 0.5), 60_000);
  assert.equal(chooseIdleRandomDelay([60_000, 60_000], () => 1), 60_000);
});

test("idle random playback starts after one minute, loops for six seconds, then returns to idle", () => {
  let now = 0;
  let nextTimerId = 1;
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const originalWindow = globalThis.window;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      setTimeout: (callback: () => void, delay: number) => {
        const id = nextTimerId++;
        timers.set(id, { callback, delay });
        return id;
      },
      clearTimeout: (id: number) => timers.delete(id),
    },
  });

  const plays: Array<{ action: string; loop: boolean; overlay: string }> = [];
  const stateMachine = new PetStateMachine({
    play: (action, loop, overlay) => {
      plays.push({ action, loop, overlay });
      return plays.length;
    },
    setOverlay: () => undefined,
    onStateChange: () => undefined,
    canPlayIdleRandomAction: () => true,
  }, () => 0, () => now);
  const metadata = {
    bodyActions: ["动作_待机", "动作_无奈", "动作_自信"],
    overlays: ["表情_常态", "表情_无奈", "表情_自信"],
  } as SpineCharacterMetadata;

  try {
    stateMachine.configure(AIRUI, metadata);
    const dueTimer = [...timers.entries()].find(([, timer]) => timer.delay === 60_000);
    assert.ok(dueTimer);
    timers.delete(dueTimer[0]);
    now = 60_000;
    dueTimer[1].callback();

    assert.equal(stateMachine.getSnapshot().state, "idle_random_action");
    assert.deepEqual(plays.at(-1), { action: "动作_无奈", loop: true, overlay: "表情_无奈" });
    const playbackTimer = [...timers.entries()].find(([, timer]) => timer.delay === 6_000);
    assert.ok(playbackTimer);
    timers.delete(playbackTimer[0]);
    now = 66_000;
    playbackTimer[1].callback();

    assert.equal(stateMachine.getSnapshot().state, "idle");
    assert.deepEqual(plays.at(-1), { action: "动作_待机", loop: true, overlay: "表情_常态" });
    assert.ok([...timers.values()].some((timer) => timer.delay === 54_000));
  } finally {
    stateMachine.dispose();
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  }
});
