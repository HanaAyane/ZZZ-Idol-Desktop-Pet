import type { DownloadEvent } from "@tauri-apps/plugin-updater";

export interface InstallableUpdate {
  version: string;
  body?: string;
  download(onEvent?: (event: DownloadEvent) => void, options?: { timeout: number }): Promise<void>;
  install(options?: { restartAfterInstall: boolean }): Promise<void>;
  close(): Promise<void>;
}

export interface InstallProgress {
  phase: "downloading" | "preparing" | "installing";
  downloaded: number;
  total?: number;
}

// 下载完成并由插件验证签名后，才保存状态并启动安装器。
export async function installVerifiedUpdate(
  update: InstallableUpdate,
  beforeInstall: () => Promise<void>,
  onProgress: (progress: InstallProgress) => void,
): Promise<void> {
  let downloaded = 0;
  let total: number | undefined;
  await update.download(event => {
    if (event.event === "Started") total = event.data.contentLength;
    if (event.event === "Progress") downloaded += event.data.chunkLength;
    onProgress({ phase: "downloading", downloaded, total });
  }, { timeout: 300_000 });
  onProgress({ phase: "preparing", downloaded, total });
  await beforeInstall();
  onProgress({ phase: "installing", downloaded, total });
  await update.install({ restartAfterInstall: true });
}

// 保存失败保留待写入设置；仅在写入成功后清空，重试仍需完成计时检查点。
export async function prepareUpdateState<T extends object>(
  readPending: () => T,
  clearPending: () => void,
  save: (patch: T) => Promise<unknown>,
  checkpoint: () => Promise<unknown>,
): Promise<void> {
  const pending = readPending();
  if (Object.keys(pending).length) {
    await save(pending);
    clearPending();
  }
  await checkpoint();
}
