import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const room = readFileSync(new URL("../src-tauri/src/room.rs", import.meta.url), "utf8");
const app = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");

// 防止菜单入口在 Windows GUI 回调中同步创建 WebView，或绕过窗口复用锁。
test("活动室菜单与设置页共享异步窗口创建，避免阻塞 GUI 回调", () => {
  assert.match(app, /MenuItem::with_id\(app, "room_open", "活动室"/);
  assert.match(app, /&room_open,/);
  assert.match(app, /PetContextMenu\(menu\.clone\(\)\)/);
  assert.match(app, /\.menu\(&menu\)/);
  assert.match(app, /"room_open"\s*=>\s*room::request_show_window\(app\.clone\(\)\)/);
  assert.match(room, /show_window\(window\.app_handle\(\)\.clone\(\)\)\.await/);
  assert.match(room, /pub fn request_show_window[\s\S]*?async_runtime::spawn\(async move[\s\S]*?show_window\(app\)\.await/);
  assert.match(room, /async fn show_window[\s\S]*?spawn_blocking\(move \|\|/);
  const creation = room.slice(room.indexOf("async fn show_window"), room.indexOf("fn close("));
  assert.ok(creation.indexOf("creation.0.lock()") < creation.indexOf('get_webview_window("room")'));
  assert.ok(creation.indexOf('get_webview_window("room")') < creation.indexOf("WebviewWindowBuilder::new("));
});
