import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const [packageJson, cargo, rust, diagnostics, main, settings, capability] = await Promise.all([
  read("package.json"),
  read("src-tauri/Cargo.toml"),
  read("src-tauri/src/lib.rs"),
  read("src-tauri/src/diagnostics.rs"),
  read("src/main.ts"),
  read("src/settings/SettingsApp.ts"),
  read("src-tauri/capabilities/default.json"),
]);

assert(packageJson.includes('"@tauri-apps/plugin-log": "2.9.0"'), "前端日志插件没有锁定版本");
assert(cargo.includes('tauri-plugin-single-instance = "2.4.3"'), "缺少单实例 Rust 插件");
assert(cargo.includes('tauri-plugin-log = "2.9.0"'), "缺少日志 Rust 插件");
const singleInstanceIndex = rust.indexOf("tauri_plugin_single_instance::init");
const logPluginIndex = rust.indexOf("tauri_plugin_log::Builder::new");
const autostartIndex = rust.indexOf("tauri_plugin_autostart::init");
assert(singleInstanceIndex >= 0, "Tauri Builder 没有注册单实例插件");
assert(singleInstanceIndex < logPluginIndex && singleInstanceIndex < autostartIndex, "单实例插件没有最先注册");
assert(rust.includes("request_settings_window(app.clone())"), "重复启动没有唤起现有设置窗口");
assert(rust.includes("get_diagnostic_summary") && rust.includes("export_diagnostic_report"), "Rust 缺少诊断命令");
assert(rust.includes("RotationStrategy::KeepSome(3)"), "日志没有限制保留数量");
assert(diagnostics.includes("MAX_LOG_TAIL_BYTES") && diagnostics.includes("<home>"), "诊断报告没有限制日志尾部或隐藏用户目录");
assert(diagnostics.includes("single_instance_enabled: true"), "诊断摘要没有报告单实例状态");
assert(main.includes("installFrontendDiagnostics(getWindowMode())"), "前端入口没有安装异常捕获");
assert(settings.includes("data-diagnostics-action=\"export\""), "设置页缺少诊断导出入口");
assert(settings.includes("report.reportPath"), "设置页没有显示诊断报告路径");
assert(capability.includes('"log:default"'), "窗口 capability 没有开放受控日志命令");

console.log("单实例与故障诊断静态校验通过：重复启动复用、滚动日志、前端异常捕获和诊断导出均已接入。");
