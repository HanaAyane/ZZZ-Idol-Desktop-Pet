import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(projectRoot, "public/characters/checksums.sha256");
const definitions = [
  { id: "airui", actions: 25, physics: 56 },
  { id: "nangong", actions: 21, physics: 55 },
  { id: "qianxia", actions: 29, physics: 68 },
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

async function sha256(filePath) {
  const bytes = await readFile(filePath);
  return createHash("sha256").update(bytes).digest("hex");
}

async function validateManifest() {
  const manifest = await readFile(manifestPath, "utf8");
  const entries = manifest.trim().split(/\r?\n/);
  assert(entries.length === 22, `资源校验清单应有 22 项，实际为 ${entries.length} 项。`);
  for (const entry of entries) {
    const match = entry.match(/^([a-f0-9]{64})\s{2}(.+)$/);
    assert(match, `无效的 SHA-256 记录：${entry}`);
    const [, expected, relativePath] = match;
    const actual = await sha256(path.join(projectRoot, relativePath));
    assert(actual === expected, `资源校验失败：${relativePath}`);
  }
}

async function validateCharacter({ id, actions, physics }) {
  const root = path.join(projectRoot, "public/characters", id);
  const jsonPath = path.join(root, "json", `${id}.json`);
  const atlasPath = path.join(root, "atlas-local", `${id}.atlas`);
  const [jsonText, atlasText] = await Promise.all([
    readFile(jsonPath, "utf8"),
    readFile(atlasPath, "utf8"),
  ]);
  const json = JSON.parse(jsonText);
  const skins = json.skins.map((skin) => skin.name);
  const animationNames = Object.keys(json.animations);
  const pages = atlasPages(atlasText);

  assert(json.skeleton.spine === "4.2.42", `${id} Spine 版本不匹配。`);
  assert(animationNames.length === actions, `${id} 动画数量不匹配。`);
  assert(Object.keys(json.physics ?? {}).length === physics, `${id} 物理约束数量不匹配。`);
  assert(["default", "朝右", "朝左"].every((skin) => skins.includes(skin)), `${id} 缺少方向皮肤。`);
  assert(pages.length === 2, `${id} 应包含两页纹理，实际为 ${pages.length} 页。`);
  assert(animationNames.includes("动作_待机"), `${id} 缺少待机动画。`);
  assert(animationNames.includes("动作_走路"), `${id} 缺少走路动画。`);
  assert(animationNames.includes("表情_常态"), `${id} 缺少常态表情。`);
  for (const page of pages) await access(path.join(root, "texture", page));

  return { id, actions: animationNames.length, skins: skins.length, pages: pages.length, physics };
}

await validateManifest();
const results = [];
for (const definition of definitions) results.push(await validateCharacter(definition));
console.log(JSON.stringify({ manifest: "22/22", characters: results }, null, 2));
