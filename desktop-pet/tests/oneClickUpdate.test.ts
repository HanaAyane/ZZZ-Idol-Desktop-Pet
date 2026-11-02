import assert from "node:assert/strict";
import test from "node:test";
import { installVerifiedUpdate, prepareUpdateState, type InstallableUpdate, type InstallProgress } from "../src/settings/oneClickUpdate.ts";

test("签名验证完成后保存状态，再启动安装并要求重启", async () => {
  const order: string[] = [];
  const progress: InstallProgress[] = [];
  const update: InstallableUpdate = {
    version: "0.1.23",
    async download(onEvent, options) {
      assert.equal(options?.timeout, 300_000);
      onEvent?.({ event: "Started", data: { contentLength: 10 } });
      onEvent?.({ event: "Progress", data: { chunkLength: 4 } });
      onEvent?.({ event: "Progress", data: { chunkLength: 6 } });
      onEvent?.({ event: "Finished" });
      order.push("签名已验证");
    },
    async install(options) { assert.equal(options?.restartAfterInstall, true); order.push("安装"); },
    async close() {},
  };
  await installVerifiedUpdate(update, async () => { order.push("保存状态"); }, p => progress.push(p));
  assert.deepEqual(order, ["签名已验证", "保存状态", "安装"]);
  assert.equal(progress.at(-1)?.phase, "installing");
  assert.equal(progress.at(-1)?.downloaded, 10);
  assert.equal(progress.at(-1)?.total, 10);
});

test("下载或签名验证失败时不执行保存和安装，保存失败时不安装", async () => {
  for (const failure of ["下载失败", "签名无效", "保存失败"]) {
    let installed = false;
    let prepared = false;
    const update: InstallableUpdate = {
      version: "0.1.23",
      async download() { if (failure !== "保存失败") throw new Error(failure); },
      async install() { installed = true; },
      async close() {},
    };
    await assert.rejects(installVerifiedUpdate(update, async () => {
      prepared = true;
      throw new Error(failure);
    }, () => {}), new RegExp(failure));
    assert.equal(installed, false);
    assert.equal(prepared, failure === "保存失败");
  }
});

test("服务器未提供包大小时仍能报告已下载字节", async () => {
  const progress: InstallProgress[] = [];
  await installVerifiedUpdate({ version: "0.1.23", async download(onEvent) {
    onEvent?.({ event: "Started", data: {} });
    onEvent?.({ event: "Progress", data: { chunkLength: 1234 } });
  }, async install() {}, async close() {} }, async () => {}, p => progress.push(p));
  assert.equal(progress.at(-1)?.downloaded, 1234);
  assert.equal(progress.at(-1)?.total, undefined);
});

test("设置保存失败后重新检查并重试，仍保存原设置且成功后才安装", async () => {
  let pending = { volume: 42 };
  let attempts = 0;
  let checkpoints = 0;
  let installs = 0;
  let closes = 0;
  const checkedUpdate = (): InstallableUpdate => ({
    version: "0.1.23",
    async download() {},
    async install() { installs++; },
    async close() { closes++; },
  });
  const prepare = () => prepareUpdateState(
    () => pending,
    () => { pending = {} as typeof pending; },
    async patch => {
      assert.deepEqual(patch, { volume: 42 });
      if (++attempts === 1) throw new Error("设置写入失败");
    },
    async () => { checkpoints++; },
  );
  const first = checkedUpdate();
  await assert.rejects(installVerifiedUpdate(first, prepare, () => {}), /设置写入失败/);
  await first.close();
  assert.deepEqual(pending, { volume: 42 });
  assert.equal(checkpoints, 0);
  assert.equal(installs, 0);
  const retry = checkedUpdate();
  await installVerifiedUpdate(retry, prepare, () => {});
  await retry.close();
  assert.equal(attempts, 2);
  assert.deepEqual(pending, {});
  assert.equal(checkpoints, 1);
  assert.equal(installs, 1);
  assert.equal(closes, 2);
});

test("计时持久化失败阻止安装，重试时再次保存计时状态", async () => {
  let attempts = 0;
  let installs = 0;
  const prepare = () => prepareUpdateState(() => ({}), () => {}, async () => {}, async () => {
    if (++attempts === 1) throw new Error("计时进度保存失败");
  });
  const update: InstallableUpdate = {
    version: "0.1.23", async download() {}, async install() { installs++; }, async close() {},
  };
  await assert.rejects(installVerifiedUpdate(update, prepare, () => {}), /计时进度保存失败/);
  assert.equal(installs, 0);
  await installVerifiedUpdate(update, prepare, () => {});
  assert.equal(attempts, 2);
  assert.equal(installs, 1);
});
