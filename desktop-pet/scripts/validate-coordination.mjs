import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFile(path.join(root, file), "utf8");
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const [packageJson, settings, events, pet, state, roaming, policy, layout, gaze, controller, rust, capability] = await Promise.all([
  read("package.json"),
  read("src/settings/appSettings.ts"),
  read("src/characters/events.ts"),
  read("src/pet/PetApp.ts"),
  read("src/pet/PetStateMachine.ts"),
  read("src/pet/PetRoamingController.ts"),
  read("src/pet/coordinationPolicy.ts"),
  read("src/pet/groupLayout.ts"),
  read("src/pet/PetGazeIntentController.ts"),
  read("src/pet/PetCoordinationController.ts"),
  read("src-tauri/src/lib.rs"),
  read("src-tauri/capabilities/default.json"),
]);

assert(settings.includes("schemaVersion: 6") && settings.includes("automaticScenes: false"), "TypeScript 联动设置默认值或 Schema 6 缺失");
assert(events.includes('"pet-coordination-command"') && events.includes('"pet-coordination-state"'), "联动事件名称未集中定义");
assert(policy.includes("selectReactionParticipants") && policy.includes("selectNearestCharacter"), "联动策略未覆盖回应选择和最近角色");
assert(layout.includes("calculateGroupLayout") && layout.includes("orderedCharacterIds"), "集合布局未保持固定角色顺序");
assert(gaze.includes("MOUSE_QUIET_AFTER_MS") && gaze.includes("setPartnerGazeEnabled"), "视线意图层未接入鼠标静止与角色目标");
assert(controller.includes("report_pet_runtime_state") && controller.includes("complete_coordination_scene"), "前端协调控制器未接入快照和令牌回执");
assert(pet.includes("buildCoordinationRuntimeState") && pet.includes("requestReactionEcho"), "PetApp 未接入联动上报和点击回应");
assert(state.includes("coordination_reaction") && state.includes("coordinationToken"), "状态机缺少联动状态或令牌");
assert(roaming.includes("startCoordinatedMove") && roaming.includes("onCoordinatedMoveCancel"), "漫步控制器缺少可取消的联动移动");
assert(rust.includes("CoordinationManager") && rust.includes("report_pet_runtime_state"), "Rust 唯一仲裁器或快照命令缺失");
for (const command of ["request_coordination_scene", "complete_coordination_scene", "cancel_coordination_scene", "arrange_pet_group"]) {
  assert(rust.includes(command), `Rust 未注册联动命令：${command}`);
}
assert(rust.includes("pet_id_from_window_label") && rust.includes("PET_IDS"), "Rust 未以固定桌宠窗口标签确定角色身份");
assert(capability.includes("pet-airui") && capability.includes("settings"), "联动事件 capability 窗口范围不完整");
assert(packageJson.includes('"validate:coordination"'), "package.json 未声明联动静态校验入口");

console.log("三角色联动静态校验通过：协议、状态令牌、视线层、布局、设置 Schema 6 和 Rust 仲裁命令均已接入。");
