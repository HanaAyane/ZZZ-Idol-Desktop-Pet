import assert from "node:assert/strict";
import test from "node:test";

import { formatLogValue } from "../src/diagnostics.ts";

test("diagnostic log formatting hides common user home paths", () => {
  const value = formatLogValue(
    "mac=/Users/hana/Desktop/app windows=C:\\Users\\hana\\Desktop\\app linux=/home/hana/app",
  );
  assert.equal(value, "mac=<home>/Desktop/app windows=<home>\\Desktop\\app linux=<home>/app");
});

test("diagnostic log formatting handles errors and circular values", () => {
  const circular: { self?: unknown } = {};
  circular.self = circular;
  assert.match(formatLogValue(new Error("boom")), /^Error: boom/);
  assert.equal(formatLogValue(circular), '{"self":"[Circular]"}');
});

test("diagnostic log formatting bounds persisted message size", () => {
  assert.equal(formatLogValue("x".repeat(20_000)).length, 12_000);
});
