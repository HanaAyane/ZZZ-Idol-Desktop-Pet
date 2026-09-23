import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Static guards for the Windows WebView2 deadlock. Native installed-app checks
// are still required: a timer-model test cannot exercise the GUI event loop.
const pomodoro = readFileSync(new URL("../src-tauri/src/pomodoro.rs", import.meta.url), "utf8");
const app = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");

test("settings and menu opening never build the Pomodoro WebView on the GUI callback", () => {
  assert.match(pomodoro, /pub async fn set_pomodoro_visible\(/);
  assert.match(pomodoro, /show_window\(app\)\.await/);
  assert.match(app, /"pomodoro_open"\s*=>\s*pomodoro::request_show_window\(app\.clone\(\)\)/);
  assert.match(pomodoro, /pub fn request_show_window[\s\S]*?async_runtime::spawn\(async move[\s\S]*?show_window\(app\)\.await/);
  assert.match(pomodoro, /async fn show_window[\s\S]*?spawn_blocking\(move \|\| create_or_show_window\(&app\)\)/);
  assert.doesNotMatch(app, /pomodoro::show_window\(/);
});

test("concurrent open requests serialize creation without holding the timer state mutex", () => {
  const creation = pomodoro.slice(pomodoro.indexOf("fn create_or_show_window("), pomodoro.indexOf("#[cfg(test)]"));
  // rustfmt may split chained calls across lines; keep checking lock order.
  const creationLock = creation.search(/window_creation\s*\.\s*lock\(\)/);
  assert.ok(creationLock >= 0);
  assert.ok(creationLock < creation.indexOf('get_webview_window("pomodoro")'));
  assert.ok(creation.indexOf('get_webview_window("pomodoro")') < creation.indexOf("WebviewWindowBuilder::new("));
  assert.match(creation, /let saved = manager\.snapshot\(\);/);
  assert.doesNotMatch(creation.split(".build()")[0], /inner\s*\.\s*lock\(/);
});
