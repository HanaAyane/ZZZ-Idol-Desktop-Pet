import assert from "node:assert/strict";
import test from "node:test";
import { checkForUpdates, compareVersions, LATEST_RELEASE_API, FALLBACK_RELEASE_URL, RELEASES_URL } from "../src/settings/updates.ts";

const release = (tag_name = "v0.1.1") => ({ tag_name, draft: false, prerelease: false });
const respond = (body: unknown, status = 200): typeof fetch => async () =>
  new Response(JSON.stringify(body), { status });

test("version comparison uses numeric SemVer ordering and ignores v prefix/build metadata", () => {
  assert.equal(compareVersions("v0.1.1", "0.1.1"), 0);
  assert.equal(compareVersions("V1.0.0+build.2", "1.0.0+build.1"), 0);
  assert.equal(compareVersions("0.10.0", "0.9.9"), 1);
  assert.equal(compareVersions("1.0.0", "0.99.99"), 1);
  assert.equal(compareVersions("0.1.9", "0.1.10"), -1);
});

test("prerelease ordering follows SemVer, including numeric identifiers", () => {
  const versions = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta",
    "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0"];
  for (let i = 1; i < versions.length; i += 1) {
    assert.equal(compareVersions(versions[i], versions[i - 1]), 1);
    assert.equal(compareVersions(versions[i - 1], versions[i]), -1);
  }
  assert.equal(compareVersions("1.0.0-rc.1", "1.0.0-rc.1"), 0);
});

test("invalid versions are rejected rather than reported as up to date", () => {
  for (const version of ["release-next", "1.2", "01.2.3", "1.2.3.4", "1.2.3-01", "<script>"]) {
    assert.throws(() => compareVersions(version, "0.1.1"), /版本号格式/);
  }
});

test("update checks distinguish newer, equal, and older releases", async () => {
  for (const [current, status] of [["0.1.0", "available"], ["0.1.1", "current"], ["0.2.0", "ahead"],
    ["0.1.1-beta.1", "available"]] as const) {
    const result = await checkForUpdates(current, { fetcher: respond(release()) });
    assert.deepEqual(result, { status, latestVersion: "0.1.1", releaseUrl: `${RELEASES_URL}/tag/v0.1.1` });
  }
});

test("checks use the public latest endpoint and a repository-scoped URL", async () => {
  let called = false;
  const result = await checkForUpdates("0.1.0", { fetcher: async (url, options) => {
    called = true;
    assert.equal(url, LATEST_RELEASE_API);
    assert.equal(options?.cache, "no-store");
    assert.equal(options?.credentials, "omit");
    assert.ok(options?.signal);
    return new Response(JSON.stringify({ ...release(), html_url: "https://untrusted.example/download" }));
  } });
  assert.ok(called);
  assert.equal(result.releaseUrl, `${RELEASES_URL}/tag/v0.1.1`);
});

test("drafts, prereleases, malformed tags and invalid responses are rejected", async () => {
  for (const body of [null, {}, { ...release(), draft: true }, { ...release(), prerelease: true },
    release("v1.0.0-beta.1"), release("latest"), release("../../other-repo")]) {
    await assert.rejects(checkForUpdates("0.1.0", { fetcher: respond(body) }));
  }
});

test("HTTP and network failures provide actionable messages", async () => {
  for (const [status, message] of [[404, /暂未找到/], [403, /请求受限/], [429, /请求受限/], [503, /HTTP 503/]] as const) {
    await assert.rejects(checkForUpdates("0.1.1", { fetcher: respond({}, status) }), message);
  }
  await assert.rejects(checkForUpdates("0.1.1", { fetcher: async () => { throw new TypeError("offline"); } }), /检查网络/);
  await assert.rejects(checkForUpdates("0.1.1", { fetcher: async () => new Response("not json") }), /数据无法读取/);
});

const waitForAbort: typeof fetch = async (_url, options) => new Promise((_resolve, reject) => {
  const signal = options!.signal!;
  const abort = () => reject(new DOMException("Aborted", "AbortError"));
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
});

test("a stalled request times out so the user can retry", async () => {
  await assert.rejects(checkForUpdates("0.1.1", { fetcher: waitForAbort, timeoutMs: 10 }), /连接超时/);
});

test("closing settings can cancel the request, including an already-aborted signal", async () => {
  const controller = new AbortController();
  const pending = checkForUpdates("0.1.1", { fetcher: waitForAbort, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, /已取消/);
  await assert.rejects(checkForUpdates("0.1.1", { fetcher: waitForAbort, signal: controller.signal }), /已取消/);
});


test("API 限流时使用备用源并限定下载链接", async () => {
  for (const status of [403, 429]) {
    const urls: unknown[] = [];
    const result = await checkForUpdates("0.1.2", { fetcher: async (url, options) => {
      urls.push(url);
      if (url === LATEST_RELEASE_API) return new Response("{}", { status });
      assert.equal(url, FALLBACK_RELEASE_URL);
      assert.equal(options?.credentials, "omit");
      assert.equal(options?.cache, "no-store");
      assert.ok(options?.signal);
      return new Response(JSON.stringify({ ...release("v0.1.21"), html_url: "https://untrusted.example" }));
    } });
    assert.deepEqual(urls, [LATEST_RELEASE_API, FALLBACK_RELEASE_URL]);
    assert.deepEqual(result, { status: "available", latestVersion: "0.1.21", releaseUrl: `${RELEASES_URL}/tag/v0.1.21` });
  }
});

test("备用源失败或元数据无效时不会误报已是最新版本", async () => {
  for (const body of [null, {}, release("v1.0.0-beta.1"), { ...release(), draft: true },
    { ...release(), prerelease: true }, release("../../outside")]) {
    await assert.rejects(checkForUpdates("0.1.2", { fetcher: async (url) => {
      if (url === LATEST_RELEASE_API) return new Response("{}", { status: 403 });
      return new Response(JSON.stringify(body));
    } }));
  }
  await assert.rejects(checkForUpdates("0.1.2", { fetcher: async (url) => {
    if (url === LATEST_RELEASE_API) return new Response("{}", { status: 429 });
    throw new TypeError("offline");
  } }), /备用更新源/);
});

test("备用源请求支持取消与超时", async () => {
  const fetcher: typeof fetch = async (url, options) => {
    if (url === LATEST_RELEASE_API) return new Response("{}", { status: 429 });
    return waitForAbort(url, options);
  };
  await assert.rejects(checkForUpdates("0.1.2", { fetcher, timeoutMs: 10 }), /超时/);
  const controller = new AbortController();
  const pending = checkForUpdates("0.1.2", { fetcher, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, /已取消/);
});
