import assert from "node:assert/strict";
import test from "node:test";
import { customSummary, formatTime, plannedMinutes, validPreferences, type Preferences, type PomodoroSnapshot } from "../src/pomodoro/model.ts";
const defaults: Preferences = { mode: "pomodoro", customMinutes: 120, reminderMinutes: [25, 45], focusMinutes: 25, breakMinutes: 5, defaultRounds: 2, soundEnabled: true, volume: 60 };
test("pomodoro rounds include only intermediate rests", () => {
  assert.equal(plannedMinutes(defaults), 55);
  assert.equal(plannedMinutes({ ...defaults, defaultRounds: 1 }), 25);
});
test("custom reminders use cumulative minutes and allow no intermediate reminders", () => {
  const custom: Preferences = { ...defaults, mode: "custom" };
  assert.equal(plannedMinutes(custom), 120);
  assert.ok(validPreferences(custom));
  assert.ok(validPreferences({ ...custom, reminderMinutes: [] }));
  assert.ok(validPreferences({ ...custom, reminderMinutes: [45, 25] }));
  for (const reminderMinutes of [[0], [120], [121], [25, 25], [1.5], [NaN]]) {
    assert.equal(validPreferences({ ...custom, reminderMinutes }), false);
  }
  assert.equal(validPreferences({ ...custom, customMinutes: 721 }), false);
  assert.equal(validPreferences({ ...custom, reminderMinutes: Array.from({ length: 65 }, (_, i) => i + 1) }), false);
});
test("next reminder display follows elapsed time and persisted reminder progress", () => {
  const state = { phase: "custom", durationMs: 120 * 60_000, remainingMs: 88 * 60_000,
    reminderMinutes: [25, 45], nextReminderIndex: 1 } as PomodoroSnapshot;
  assert.equal(customSummary(state), "已用 32:00 · 第 45 分钟提醒\n还有 13:00");
  assert.equal(customSummary({ ...state, nextReminderIndex: 2 }), "已用 32:00 · 结束时提醒");
  assert.equal(customSummary({ ...state, phase: "completed", remainingMs: 0, nextReminderIndex: 2 }), "已用 120:00 · 已提醒 2 次");
});
test("remaining display rounds up until actual expiry, including long sessions", () => {
  assert.equal(formatTime(1), "00:01"); assert.equal(formatTime(0), "00:00");
  assert.equal(formatTime(59_999), "01:00"); assert.equal(formatTime(10_800_000), "180:00");
});
test("invalid form inputs cannot start a session", () => {
  assert.ok(validPreferences(defaults));
  for (const value of [NaN, 0, 100, 1.5]) assert.equal(validPreferences({ ...defaults, defaultRounds: value }), false);
  assert.equal(validPreferences({ ...defaults, breakMinutes: 0 }), false);
});
