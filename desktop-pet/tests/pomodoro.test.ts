import assert from "node:assert/strict";
import test from "node:test";
import { formatTime, plannedMinutes, validPreferences } from "../src/pomodoro/model.ts";
const defaults = { focusMinutes: 25, breakMinutes: 5, defaultRounds: 2, soundEnabled: true, volume: 60 };
test("pomodoro rounds include only intermediate rests", () => {
  assert.equal(plannedMinutes(defaults), 55);
  assert.equal(plannedMinutes({ ...defaults, defaultRounds: 1 }), 25);
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
