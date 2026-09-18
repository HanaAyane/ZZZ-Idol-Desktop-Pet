import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function source(relativePath) {
  return readFile(path.join(projectRoot, relativePath), "utf8");
}

const [roaming, stateMachine, petApp, renderer, settings, events, tauriLib, config] = await Promise.all([
  source("src/pet/PetRoamingController.ts"),
  source("src/pet/PetStateMachine.ts"),
  source("src/pet/PetApp.ts"),
  source("src/renderer/SpineRenderer.ts"),
  source("src/settings/SettingsApp.ts"),
  source("src/characters/events.ts"),
  source("src-tauri/src/lib.rs"),
  source("src-tauri/tauri.conf.json"),
]);

assert(stateMachine.includes('| "walking"'), "状态机缺少 walking 状态");
assert(stateMachine.includes("startWalking("), "状态机缺少开始漫步入口");
assert(stateMachine.includes("stopWalking()"), "状态机缺少结束漫步恢复");
assert(roaming.includes("MIN_IDLE_MS = 5000"), "自动漫步没有最小停留时间");
assert(roaming.includes("MAX_IDLE_MS = 11000"), "自动漫步没有随机停留上限");
assert(roaming.includes("WALK_SPEED_CSS_PX_PER_SECOND"), "漫步速度没有使用 CSS 像素语义");
assert(roaming.includes("requestAnimationFrame"), "漫步仍未按显示帧平滑移动");
assert(roaming.includes("preciseX"), "漫步缺少亚像素位置累计，会在不同缩放比下抖动");
assert(roaming.includes('invoke<PetWindowContext>("move_pet_window"'), "前端没有调用原生窗口移动");
assert(roaming.includes('invoke<PetWindowContext>("restore_pet_window"'), "启动时没有恢复/回退窗口位置");
assert(roaming.includes("walkGeneration"), "点击中断后旧移动请求没有代次保护");
// The native clamp can correct an off-screen START, so it must not replace the
// destination with that intermediate position. Motion tests cover both cases.
assert(roaming.includes("this.targetX = Math.max(context.workArea.x")
  && roaming.includes("this.targetY = Math.max(context.workArea.y"), "目标位置没有按实际工作区边界夹取");
assert(roaming.includes("this.host.canStartWalking()"), "自动漫步没有交互互斥检查");
assert(petApp.includes('const directionSkin = "朝左"'), "漫步没有统一使用已验证的朝左资源");
assert(petApp.includes("applyFacingDirection(direction)"), "漫步开始没有记录并应用行走方向");
assert(petApp.includes("applyFacingDirection(this.facingDirection)"), "漫步结束没有保持最后行走方向");
const stopWalkingBlock = petApp.slice(petApp.indexOf("private stopWalking()"), petApp.indexOf("private async refreshRoamingPosition"));
assert(!stopWalkingBlock.includes("setHorizontalMirror(false)"), "漫步结束仍会强制翻回默认方向");
assert(petApp.includes('this.facingDirection = "left"'), "切换角色没有恢复默认朝向状态");
assert(renderer.includes("mirroredFromDefault"), "渲染器缺少相对默认方向的镜像状态");
assert(renderer.includes("setCharacterScale(scale: number)"), "渲染器缺少人物缩放接口");
assert(renderer.includes("* this.characterScale"), "人物比例未应用到自适应渲染尺寸");
assert(settings.includes('min="60" max="125"'), "设置页缺少安全范围的人物缩放滑杆");
assert(events.includes('APP_SETTINGS_STATE'), "设置窗口与桌宠窗口缺少统一设置同步事件");
assert(petApp.includes('this.persistPetSettings({ scale: normalized })'), "人物独立缩放未持久化");
assert(
  petApp.includes("onPointerIntent: () => {") && petApp.includes("this.roamingController?.interrupt();"),
  "鼠标按下没有立即中断漫步",
);
assert(petApp.includes("getSnapshot().walking) return"), "窗口自己经过鼠标时会被伪悬停中断");
assert(petApp.includes("this.debugPanel.hidden"), "调试面板打开时仍可能自动漫步");
assert(petApp.includes('lastPlacement:'), "稳定位置没有保存");
assert(tauriLib.includes("fn move_pet_window"), "Rust 缺少主动移动窗口命令");
assert(tauriLib.includes("fn restore_pet_window"), "Rust 缺少断屏位置恢复命令");
assert(tauriLib.includes("fn initialize_pet_window"), "三个桌宠缺少分散初始位置");
assert(tauriLib.includes("fn show_settings_window"), "人物缩放缺少快捷设置窗口入口");
assert(tauriLib.includes("fn clamped_position"), "Rust 缺少工作区边界夹取");
assert(tauriLib.includes("fn pet_window_context_at"), "原生移动缺少目标位置上下文，macOS 异步定位可能回滚");
assert(tauriLib.includes("pet_window_context_at(&window, position)"), "原生漫步仍可能读取尚未生效的旧窗口位置");
assert(tauriLib.includes("available_monitors()"), "Rust 未枚举多显示器");
assert(tauriLib.includes("work_area()"), "窗口边界没有避开菜单栏/Dock/任务栏");
assert(tauriLib.includes("current_monitor()"), "窗口移动没有跟踪当前显示器");

const tauriConfig = JSON.parse(config);
const petWindows = tauriConfig.app.windows.filter((window) => window.label.startsWith("pet-"));
assert(petWindows.length === 3, "漫步阶段没有覆盖三个桌宠窗口");
assert(petWindows.every((window) => window.width === 520 && window.height === 600), "漫步阶段改变了固定透明安全画布");

console.log("阶段 5 静态校验通过：自动漫步、方向皮肤、工作区夹取、位置恢复与拖拽互斥均已接入。");
