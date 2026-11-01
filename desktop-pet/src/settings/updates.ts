export const RELEASES_URL = "https://github.com/HanaAyane/ZZZ-Idol-Desktop-Pet/releases";
export const LATEST_RELEASE_API = "https://api.github.com/repos/HanaAyane/ZZZ-Idol-Desktop-Pet/releases/latest";

export const FALLBACK_RELEASE_URL = "https://raw.githubusercontent.com/HanaAyane/ZZZ-Idol-Desktop-Pet/main/updates/latest.json";

interface Version {
  core: bigint[];
  prerelease: string[];
}

function parseVersion(value: string): Version {
  const match = /^[vV]?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/.exec(value);
  const prerelease = match?.[4]?.split(".") ?? [];
  if (!match || prerelease.some(part => /^\d+$/.test(part) && part.length > 1 && part[0] === "0")) {
    throw new Error("版本号格式无法识别，请前往 GitHub 手动查看。");
  }
  return { core: match.slice(1, 4).map(part => BigInt(part)), prerelease };
}

/** SemVer precedence: numeric components, prerelease identifiers, then stable; ignore build metadata. */
export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let i = 0; i < 3; i += 1) {
    if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i] ? 1 : -1;
  }
  if (!a.prerelease.length || !b.prerelease.length) {
    return Number(!a.prerelease.length) - Number(!b.prerelease.length);
  }
  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i += 1) {
    const x = a.prerelease[i];
    const y = b.prerelease[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const numericX = /^\d+$/.test(x);
    const numericY = /^\d+$/.test(y);
    if (numericX && numericY) return BigInt(x) > BigInt(y) ? 1 : -1;
    if (numericX !== numericY) return numericX ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

export interface UpdateResult {
  status: "available" | "current" | "ahead";
  latestVersion: string;
  releaseUrl: string;
}

export async function checkForUpdates(
  currentVersion: string,
  { signal, fetcher = fetch, timeoutMs = 10_000 }: {
    signal?: AbortSignal;
    fetcher?: typeof fetch;
    timeoutMs?: number;
  } = {},
): Promise<UpdateResult> {
  parseVersion(currentVersion);
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timeout = setTimeout(abort, timeoutMs);
  try {
    let response = await fetcher(LATEST_RELEASE_API, {
      headers: { Accept: "application/vnd.github+json" },
      cache: "no-store",
      credentials: "omit",
      signal: controller.signal,
    });
    if (response.status === 404) throw new Error("暂未找到正式 Release，请前往 GitHub 查看。");
    if (response.status === 403 || response.status === 429) {
      const limitMessage = "GitHub 请求受限，备用更新源也暂不可用，请稍后重试，或前往 GitHub 手动查看。";
      try {
        // 备用元数据由正式 Release 发布事件同步，不消耗匿名 GitHub API 额度。
        response = await fetcher(FALLBACK_RELEASE_URL, {
          cache: "no-store",
          credentials: "omit",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(limitMessage);
      } catch {
        throw new Error(limitMessage);
      }
    }
    if (!response.ok) throw new Error(`GitHub 暂时无法访问（HTTP ${response.status}），请稍后重试。`);
    const release: unknown = await response.json();
    if (!release || typeof release !== "object" || !("tag_name" in release)
      || typeof release.tag_name !== "string" || !("draft" in release) || release.draft !== false
      || !("prerelease" in release) || release.prerelease !== false) {
      throw new Error("GitHub 未返回有效的正式 Release，请前往 GitHub 手动查看。");
    }
    const latestVersion = release.tag_name.replace(/^[vV]/, "");
    // The latest endpoint excludes prereleases; also reject incorrectly labelled prerelease tags.
    if (parseVersion(latestVersion).prerelease.length) {
      throw new Error("最新 Release 的标签为预发布版本，请前往 GitHub 手动查看。");
    }
    const comparison = compareVersions(latestVersion, currentVersion);
    return {
      status: comparison > 0 ? "available" : comparison === 0 ? "current" : "ahead",
      latestVersion,
      // Construct a repository-scoped link instead of trusting URLs in the remote response.
      releaseUrl: `${RELEASES_URL}/tag/${encodeURIComponent(release.tag_name)}`,
    };
  } catch (error) {
    if (controller.signal.aborted) throw new Error("检查已取消或连接超时，请稍后重试。");
    if (error instanceof TypeError) throw new Error("无法连接 GitHub，请检查网络后重试，或手动查看 Release。");
    if (error instanceof SyntaxError) throw new Error("GitHub 返回的数据无法读取，请稍后重试。");
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}
