import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export async function createUpdaterManifest(directory, version, repository, notes = "") {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("更新版本必须为正式版本号");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("仓库名称无效");
  const files = await readdir(directory);
  const platforms = {};
  for (const [suffix, bundle] of [["_x64-setup.exe", "nsis"], ["_x64_en-US.msi", "msi"]]) {
    const file = files.find(name => name.endsWith(`_${version}${suffix}`));
    if (!file) throw new Error(`缺少 ${bundle} 安装包`);
    const signature = (await readFile(path.join(directory, `${file}.sig`), "utf8")).trim();
    if (!/^[A-Za-z0-9+/=]+$/.test(signature)
      || !Buffer.from(signature, "base64").toString("utf8").startsWith("untrusted comment:")) {
      throw new Error(`${bundle} 签名格式无效`);
    }
    const entry = { url: `https://github.com/${repository}/releases/download/v${version}/${encodeURIComponent(file)}`, signature };
    platforms[`windows-x86_64-${bundle}`] = entry;
    if (bundle === "nsis") platforms["windows-x86_64"] = entry;
  }
  return { version, notes, pub_date: new Date().toISOString(), platforms };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [directory, version, repository, notesFile] = process.argv.slice(2);
  const notes = notesFile ? await readFile(notesFile, "utf8") : "";
  const manifest = await createUpdaterManifest(directory, version, repository, notes);
  await writeFile(path.join(directory, "updater.json"), JSON.stringify(manifest, null, 2) + "\n");
}
