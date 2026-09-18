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

const [interaction, petApp, renderer, airui, nangong, qianxia] = await Promise.all([
  source("src/pet/PetInteractionController.ts"),
  source("src/pet/PetApp.ts"),
  source("src/renderer/SpineRenderer.ts"),
  source("public/characters/airui/json/airui.json"),
  source("public/characters/nangong/json/nangong.json"),
  source("public/characters/qianxia/json/qianxia.json"),
]);

assert(interaction.includes("onCursorSample?"), "交互层没有向渲染层提供全局光标采样");
assert(interaction.includes("this.host.onCursorSample?.(clientX, clientY)"), "原生逐像素轮询未复用到视线追踪");
assert(renderer.includes('GAZE_BONE_NAME = "眼部控制器"'), "渲染器没有使用三角色共享的眼部控制骨");
assert(renderer.includes("GAZE_MAX_SKELETON_UNITS"), "视线追踪没有活动范围上限");
assert(renderer.includes("Math.exp(-GAZE_SMOOTHING * delta)"), "视线追踪没有逐帧平滑");
assert(renderer.includes("controller.x -= localGazeX"), "视线叠加没有在动画求值后撤销，可能逐帧累积");
assert(renderer.includes("this.gazeController = mesh.skeleton.findBone"), "眼部控制骨没有在角色加载时缓存");
assert(renderer.includes("this.applyGazeAndUpdateGeometry(delta)"), "视线追踪没有合并到单次网格更新");
assert(!renderer.includes("this.mesh.update(delta);\n      this.applyGaze(delta);"), "视线追踪仍在完整更新后重复重建网格");
assert(renderer.includes("setGazeTarget("), "渲染器缺少视线目标接口");
assert(
  petApp.includes('["idle", "hover", "walking"].includes(state)'),
  "视线追踪没有避让点击反馈和拖拽状态",
);
for (const [id, sourceText] of [["airui", airui], ["nangong", nangong], ["qianxia", qianxia]]) {
  const skeleton = JSON.parse(sourceText);
  assert(skeleton.bones.some((bone) => bone.name === "眼部控制器"), `${id} 缺少共享眼部控制骨`);
}

console.log("阶段 6 静态校验通过：3/3 角色共享眼部控制骨、全局光标采样、平滑限幅与状态避让均已接入。");
