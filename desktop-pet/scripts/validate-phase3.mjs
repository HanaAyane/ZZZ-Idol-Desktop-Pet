import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const specs = [
  { id: "airui", displayName: "爱芮", animations: 25, bodyActions: 8, physics: 56 },
  { id: "nangong", displayName: "南宫", animations: 21, bodyActions: 9, physics: 55 },
  { id: "qianxia", displayName: "千夏", animations: 29, bodyActions: 9, physics: 68 },
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

for (const spec of specs) {
  const assetRoot = path.join(projectRoot, "public", "characters", spec.id);
  const json = JSON.parse(await readFile(path.join(assetRoot, "json", `${spec.id}.json`), "utf8"));
  const atlas = await readFile(path.join(assetRoot, "atlas-local", `${spec.id}.atlas`), "utf8");
  const definition = await readFile(path.join(projectRoot, "src", "characters", `${spec.id}.ts`), "utf8");
  const actions = Object.keys(json.animations ?? {});
  const bodyActions = actions.filter((action) => action === "0" || action.startsWith("动作_"));
  const overlays = actions.filter((action) => action.startsWith("表情_"));
  const skins = (json.skins ?? []).map((skin) => skin.name);
  const texturePages = atlas.match(new RegExp(`^(?:\\.\\.\\/textures\\/)?${spec.id}(?:_2)?\\.png$`, "gm")) ?? [];

  assert(json.skeleton?.spine === "4.2.42", `${spec.displayName} Spine 版本错误`);
  assert(actions.length === spec.animations, `${spec.displayName} 动画数错误：${actions.length}`);
  assert(bodyActions.length === spec.bodyActions, `${spec.displayName} 身体动作数错误：${bodyActions.length}`);
  assert(overlays.includes("表情_常态"), `${spec.displayName} 缺少表情_常态`);
  assert(bodyActions.includes("动作_待机"), `${spec.displayName} 缺少动作_待机`);
  assert(skins.includes("朝左") && skins.includes("朝右"), `${spec.displayName} 缺少左右皮肤`);
  assert(texturePages.length === 2, `${spec.displayName} atlas 纹理页不是 2 页`);
  assert((json.physics ?? []).length === spec.physics, `${spec.displayName} 物理约束数错误`);
  assert(definition.includes(`id: "${spec.id}"`), `${spec.displayName} 角色定义 id 错误`);
  assert(definition.includes(`displayName: "${spec.displayName}"`), `${spec.displayName} 显示名错误`);
  assert(definition.includes(`assetRoot: "./characters/${spec.id}"`), `${spec.displayName} 资源路径错误`);
}

const petApp = await readFile(path.join(projectRoot, "src", "pet", "PetApp.ts"), "utf8");
const renderer = await readFile(path.join(projectRoot, "src", "renderer", "SpineRenderer.ts"), "utf8");
const settings = await readFile(path.join(projectRoot, "src", "settings", "SettingsApp.ts"), "utf8");
const rustShell = await readFile(path.join(projectRoot, "src-tauri", "src", "lib.rs"), "utf8");
const tauriConfig = JSON.parse(await readFile(path.join(projectRoot, "src-tauri", "tauri.conf.json"), "utf8"));

assert(petApp.includes("metadata.bodyActions"), "动作选择器未限制为身体动作");
assert(petApp.includes("private readonly characterId: CharacterId"), "桌宠实例没有绑定固定角色");
assert(petApp.includes("CHARACTER_BY_ID[characterId]"), "桌宠实例没有按窗口角色加载定义");
assert(renderer.includes("this.disposeLoadedCharacter();\n      this.asset = asset;"), "角色切换不是加载成功后替换");
assert(renderer.includes("mixer.setOverlay(action)"), "表情切换未通过独立表情轨道复位槽位");
assert(settings.includes("data-pet-visible") && settings.includes("data-pet-scale"), "设置页未接入三角色显示与缩放");
for (const spec of specs) {
  assert(rustShell.includes(`show_${spec.id}`), `托盘缺少${spec.displayName}显示项`);
  const window = tauriConfig.app.windows.find((candidate) => candidate.label === `pet-${spec.id}`);
  assert(window?.url.includes(`character=${spec.id}`), `${spec.displayName}缺少独立桌宠窗口`);
}

console.log("阶段 3 静态校验通过：3/3 角色定义、资源、独立窗口、设置页与托盘显示控制均已接入。");
