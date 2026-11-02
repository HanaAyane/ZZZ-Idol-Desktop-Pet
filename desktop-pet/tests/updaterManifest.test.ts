import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createUpdaterManifest } from "../scripts/updater-manifest.mjs";

const signature = Buffer.from("untrusted comment: 测试签名格式\n测试数据").toString("base64");
const repository = "example/pet";
const prefix = `https://github.com/${repository}/releases/download/v0.1.22/`;

test("更新清单区分 NSIS 与 MSI，并要求两个安装包都有签名", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zzz-manifest-"));
  try {
    for (const suffix of ["x64-setup.exe", "x64_en-US.msi"]) {
      const name = `Pet_0.1.22_${suffix}`;
      await writeFile(path.join(directory, name), "测试安装包");
      await writeFile(path.join(directory, name + ".sig"), signature);
    }
    const result = await createUpdaterManifest(directory, "0.1.22", repository, "更新说明");
    assert.equal(result.notes, "更新说明");
    assert.equal(result.platforms["windows-x86_64-nsis"].url, prefix + "Pet_0.1.22_x64-setup.exe");
    assert.equal(result.platforms["windows-x86_64-msi"].url, prefix + "Pet_0.1.22_x64_en-US.msi");
    assert.deepEqual(result.platforms["windows-x86_64"], result.platforms["windows-x86_64-nsis"]);
    await rm(path.join(directory, "Pet_0.1.22_x64_en-US.msi.sig"));
    await assert.rejects(createUpdaterManifest(directory, "0.1.22", repository));
    await assert.rejects(createUpdaterManifest(directory, "0.1.22-beta", repository));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

