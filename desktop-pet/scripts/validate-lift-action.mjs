import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AtlasAttachmentLoader, SkeletonJson, TextureAtlas } from "@esotericsoftware/spine-core";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const charactersRoot = path.join(projectRoot, "public", "characters");
const catalogPath = path.join(charactersRoot, "special-actions.json");
const specs = [
  { characterId: "airui", assetId: "airui_lift", sourceTexture: "airui_tui.png", bones: 133, physics: 18, duration: 1 },
  { characterId: "nangong", assetId: "nangong_lift", sourceTexture: "nangong_tui.png", bones: 143, physics: 28, duration: 1.0667 },
  { characterId: "qianxia", assetId: "qianxia_lift", sourceTexture: "qianxia_tui.png", bones: 150, physics: 24, duration: 1.0667 },
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function atlasPages(atlasText) {
  return atlasText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.toLowerCase().endsWith(".png"))
    .map((line) => path.basename(line));
}

function animationDuration(value) {
  if (Array.isArray(value)) {
    return value.reduce((maximum, entry) => Math.max(maximum, animationDuration(entry)), 0);
  }
  if (!value || typeof value !== "object") return 0;
  const ownTime = typeof value.time === "number" ? value.time : 0;
  return Object.values(value).reduce(
    (maximum, entry) => Math.max(maximum, animationDuration(entry)),
    ownTime,
  );
}

const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
assert(catalog.schemaVersion === 2, "特殊动作清单版本应为 2。");
assert(Array.isArray(catalog.actions) && catalog.actions.length === specs.length, "托举动作清单应覆盖三名角色。");

const results = [];
for (const spec of specs) {
  const root = path.join(charactersRoot, spec.assetId);
  const jsonPath = path.join(root, "json", `${spec.assetId}.json`);
  const atlasPath = path.join(root, "atlas-local", `${spec.assetId}.atlas`);
  const [jsonText, atlasText] = await Promise.all([readFile(jsonPath, "utf8"), readFile(atlasPath, "utf8")]);
  const json = JSON.parse(jsonText);
  const animations = Object.keys(json.animations ?? {});
  const pages = atlasPages(atlasText);
  const runtimeAtlas = new TextureAtlas(atlasText);
  const skeletonData = new SkeletonJson(new AtlasAttachmentLoader(runtimeAtlas)).readSkeletonData(json);
  const catalogEntry = catalog.actions.find(
    (entry) => entry.characterId === spec.characterId && entry.id === "lift",
  );

  assert(json.skeleton?.spine === "4.2.42", `${spec.assetId} Spine 版本不匹配。`);
  assert(json.bones?.length === spec.bones, `${spec.assetId} 骨骼数量不匹配。`);
  assert(Object.keys(json.physics ?? {}).length === spec.physics, `${spec.assetId} 物理约束数量不匹配。`);
  assert((json.skins ?? []).some((skin) => skin.name === "default"), `${spec.assetId} 缺少 default 皮肤。`);
  assert(
    animations.length === 2 && animations.includes("动作_托举") && animations.includes("表情_使劲"),
    `${spec.assetId} 应只保留动作_托举与表情_使劲。`,
  );
  assert(!animations.includes("动作_待机"), `${spec.assetId} 仍含来源动作名动作_待机。`);
  assert(
    Math.abs(animationDuration(json.animations["动作_托举"]) - spec.duration) < 0.0001,
    `${spec.assetId} 托举动作时长不匹配。`,
  );
  assert(animationDuration(json.animations["表情_使劲"]) > 0, `${spec.assetId} 使劲表情没有有效时间轴。`);
  assert(
    Math.abs((skeletonData.findAnimation("动作_托举")?.duration ?? 0) - spec.duration) < 0.0001,
    `${spec.assetId} 无法由 Spine Runtime 正确解析托举动作。`,
  );
  assert(
    (skeletonData.findAnimation("表情_使劲")?.duration ?? 0) > 0,
    `${spec.assetId} 无法由 Spine Runtime 正确解析使劲表情。`,
  );
  assert(pages.length === 1 && pages[0] === spec.sourceTexture, `${spec.assetId} atlas 纹理页不匹配。`);
  await access(path.join(root, "texture", spec.sourceTexture));
  assert(catalogEntry?.assetId === spec.assetId, `${spec.assetId} 未登记到特殊动作清单。`);
  assert(catalogEntry?.assetRoot === `./characters/${spec.assetId}`, `${spec.assetId} 资源根路径错误。`);
  assert(catalogEntry?.bodyAction === "动作_托举", `${spec.assetId} 身体动作映射错误。`);
  assert(catalogEntry?.overlay === "表情_使劲", `${spec.assetId} 表情映射错误。`);
  assert(catalogEntry?.skin === "default" && catalogEntry?.loop === true, `${spec.assetId} 播放参数错误。`);
  assert(
    catalogEntry?.contactSlots?.length === 2
      && catalogEntry.contactSlots.every((name) => skeletonData.findSlot(name))
      && Number.isFinite(catalogEntry.snapDistanceCss),
    `${spec.assetId} 缺少有效的手掌网格或吸附距离。`,
  );

  results.push({
    characterId: spec.characterId,
    assetId: spec.assetId,
    animations,
    duration: spec.duration,
    pages,
    bones: spec.bones,
    physics: spec.physics,
  });
}

console.log(JSON.stringify({ schemaVersion: catalog.schemaVersion, action: "lift", characters: results }, null, 2));
