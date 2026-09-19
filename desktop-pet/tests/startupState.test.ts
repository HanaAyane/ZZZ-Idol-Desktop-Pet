import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const rust = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
const builderStart = rust.indexOf("tauri::Builder::default()");
const setupStart = rust.indexOf(".setup(|app|", builderStart);

// Configured WebViews may invoke commands before Tauri calls the setup hook.
for (const state of [
  "SettingsWriteLock",
  "SettingsWindowLock",
  "CoordinationManager",
  "LastActivePet",
  "WindowLiftManager",
]) {
  test(`${state} is registered on the builder before configured windows start`, () => {
    assert.ok(builderStart >= 0 && setupStart > builderStart, "Tauri startup builder must exist");
    const builder = rust.slice(builderStart, setupStart);
    assert.match(builder, new RegExp(`\\.manage\\(\\s*${state}\\b`));
    assert.doesNotMatch(rust.slice(setupStart), new RegExp(`app\\.manage\\(\\s*${state}\\b`));
  });
}
