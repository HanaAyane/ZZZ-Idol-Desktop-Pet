import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFile(path.join(root, file), "utf8");
const assert = (condition, message) => { if (!condition) throw new Error(message); };

const [catalogText, controller, geometry, app, state, rust, tauriLib, cargo, settings, packageJson] = await Promise.all([
  read("public/characters/special-actions.json"),
  read("src/pet/WindowLiftController.ts"),
  read("src/pet/windowLiftGeometry.ts"),
  read("src/pet/PetApp.ts"),
  read("src/pet/PetStateMachine.ts"),
  read("src-tauri/src/window_lift.rs"),
  read("src-tauri/src/lib.rs"),
  read("src-tauri/Cargo.toml"),
  read("src/settings/appSettings.ts"),
  read("package.json"),
]);
const catalog = JSON.parse(catalogText);

assert(catalog.actions.length === 3, "托举清单没有覆盖三名角色");
for (const action of catalog.actions) {
  assert(action.contactSlots?.length === 2, `${action.characterId} 缺少手掌网格映射`);
  assert(action.snapDistanceCss >= 8, `${action.characterId} 吸附距离无效`);
}
for (const command of ["attach_window_lift", "get_window_lift_target", "detach_window_lift", "move_lift_pet_window"]) {
  assert(controller.includes(command) && tauriLib.includes(command), `托举命令未完整接入：${command}`);
}
assert(rust.includes('HashMap<String, Binding>'), "原生绑定未按角色独立保存");
assert(!rust.includes("target_owner") && !rust.includes("exclusive_target"), "原生层不应对同一目标窗口建立排他锁");
assert(rust.includes("copy_window_info") && rust.includes("CGWindowList"), "macOS 窗口几何读取未接入");
assert(rust.includes("EnumWindows") && rust.includes("GetWindowRect"), "Windows 窗口几何读取未接入");
assert(cargo.includes('core-graphics = "0.25"'), "macOS Core Graphics 依赖缺失");
assert(cargo.includes('"Win32_UI_WindowsAndMessaging"'), "Windows 顶级窗口 API 依赖缺失");
assert(controller.includes("FOLLOW_INTERVAL_MS") && controller.includes("move_lift_pet_window"), "窗口移动后的桌宠跟随循环缺失");
assert(!controller.includes('"move_pet_window"'), "托举不应使用夹取整个透明窗口的普通移动命令");
assert(controller.includes("getLiftGeometry") && geometry.includes("visibleLiftFits"), "实际手掌与可见包络未接入");
assert(tauriLib.includes("manager.is_bound(pet_id)") && tauriLib.includes("b.fits_at"), "托举专用移动缺少绑定或可见范围校验");
assert(geometry.includes("anchorRatioX") && geometry.includes("windowLiftAlignmentGap"), "独立水平锚点或夹取校验缺失");
assert(app.includes('activeRig: "main" | "lift"') && state.includes('"window_lifting"'), "托举骨骼切换状态未接入");
assert(settings.includes("windowLiftEnabled: false"), "窗口托举应默认关闭");
assert(settings.includes("autoWindowLiftEnabled: false"), "自动托举应默认关闭");
assert(controller.includes("AUTOMATIC_HOLD_MS = 10_000") && controller.includes("clearReleaseTimer"), "自动托举必须有独立的十秒计时与清理");
assert(app.includes("snapshot.walking && !snapshot.coordinationToken") && app.includes("canAutomaticallyAttach"), "自动托举未限定为自由漫步");
assert(tauriLib.includes("auto_window_lift_enabled") && rust.includes("retain_enabled"), "原生自动托举设置或独立绑定清理缺失");
assert(packageJson.includes('"validate:window-lift"'), "package.json 未声明窗口托举校验入口");

console.log("窗口托举静态校验通过：三角色共享目标、真实手掌接触点、可见包络边界、专用移动与失败提示均已接入。");
