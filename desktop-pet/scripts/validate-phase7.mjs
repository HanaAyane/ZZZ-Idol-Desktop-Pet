import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFile(path.join(root, file), "utf8");
const assert = (condition, message) => { if (!condition) throw new Error(message); };

const [model, settings, pet, roaming, interaction, renderer, rust, capability] = await Promise.all([
  read("src/settings/appSettings.ts"), read("src/settings/SettingsApp.ts"),
  read("src/pet/PetApp.ts"), read("src/pet/PetRoamingController.ts"),
  read("src/pet/PetInteractionController.ts"), read("src/renderer/SpineRenderer.ts"),
  read("src-tauri/src/lib.rs"), read("src-tauri/capabilities/default.json"),
]);

for (const key of ["alwaysOnTop", "autoWalk", "walkFrequency", "movementSpeed", "gazeTracking", "windowLiftEnabled", "autoWindowLiftEnabled", "performanceMode", "frameRate", "debugMode", "launchAtLogin"]) {
  assert(model.includes(key) && settings.includes(key), `设置项未完整接入：${key}`);
}
assert(rust.includes('join("settings.json")'), "缺少统一配置文件");
assert(rust.includes('AtomicWriteFile::open') && rust.includes('file.commit()'), "配置写入不是跨平台原子替换");
assert(rust.includes('SettingsWriteLock(Mutex<()>'), "多入口配置更新没有串行化");
assert(rust.includes('corrupt-'), "配置损坏时没有备份恢复");
assert(rust.includes('SETTINGS_SCHEMA_VERSION'), "配置缺少 schema 版本");
assert(rust.includes('fn migrate_settings'), "配置缺少显式迁移入口");
assert(model.includes('PetSettingsMap') && model.includes('schemaVersion: 6'), "配置没有升级为当前三角色实例模型");
assert(rust.includes('fn update_pet_instance') && rust.includes('fn update_all_pet_visibility'), "三角色设置更新不是原子操作");
assert(rust.includes('pet.visible && !currently_visible'), "角色显示同步会重复抢占设置窗口");
assert(rust.includes('if settings_was_focused'), "设置页切换角色显示时没有恢复焦点");
assert(rust.includes('fn create_or_show_settings_window'), "设置窗口没有按需创建入口");
assert(rust.includes('WebviewWindowBuilder::new('), "设置窗口关闭后无法动态重建");
assert(!rust.includes('api.prevent_close()'), "设置窗口关闭时仍被拦截为隐藏，资源不会释放");
assert(rust.includes('debug_mode: false'), "调试模式没有默认关闭");
assert(rust.includes('tauri_plugin_autostart::init'), "开机启动插件未初始化");
assert(capability.includes('autostart:allow-enable') && capability.includes('autostart:allow-disable'), "开机启动权限不完整");
assert(rust.includes('CheckMenuItem') && rust.includes('sync_tray_settings'), "托盘状态未与设置同步");
assert(settings.includes('data-pet-visible') && settings.includes('data-pet-scale'), "设置页缺少角色显示或独立缩放控制");
assert(pet.includes('loadSettingsWithMigration'), "旧缩放与位置设置没有迁移");
assert(pet.includes('if (!this.settings?.debugMode) return'), "D 键没有受调试模式保护");
assert(pet.includes('if (!settings.debugMode) this.debugPanel.hidden = true'), "关闭调试模式时面板没有立即收起");
assert(pet.includes('setPreferences') && interaction.includes('InteractionPreferences'), "交互反馈开关未应用");
assert(roaming.includes('setFrequency') && roaming.includes('setSpeed'), "漫步频率和速度未应用");
assert(renderer.includes('setPerformance(') && renderer.includes('pixelRatioLimit'), "性能与帧率模式未应用");

console.log("阶段 7 静态校验通过：统一配置、迁移/损坏恢复、设置页、托盘同步、性能模式和开机启动均已接入。");
