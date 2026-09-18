import {
  AtlasAttachmentLoader,
  SkeletonJson,
  TextureAtlas,
  type SkeletonData,
} from "@esotericsoftware/spine-core";
import { ThreeJsTexture } from "@esotericsoftware/spine-threejs";
import type { CharacterDefinition } from "../characters/types";

export interface LoadedSpineAsset {
  atlas: TextureAtlas;
  skeletonData: SkeletonData;
  texturePages: string[];
  version: string;
  dispose(): void;
}

interface SpineJsonDocument {
  skeleton?: {
    spine?: string;
  };
}

function abortError(): DOMException {
  return new DOMException("Spine asset loading was cancelled.", "AbortError");
}

async function fetchWithTimeout(url: string, signal: AbortSignal, kind: string): Promise<Response> {
  if (signal.aborted) throw abortError();
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  const timeout = window.setTimeout(() => controller.abort(), 15000);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await fetch(url, { signal: controller.signal });
  } catch (error) {
    if (signal.aborted) throw abortError();
    if (controller.signal.aborted) throw new Error(`${kind} 加载超时：${url}`);
    throw error;
  } finally {
    window.clearTimeout(timeout);
    signal.removeEventListener("abort", onAbort);
  }
}

async function fetchJson(url: string, signal: AbortSignal): Promise<SpineJsonDocument> {
  const response = await fetchWithTimeout(url, signal, "JSON");
  if (!response.ok) throw new Error(`JSON 加载失败：${response.status} ${url}`);
  return response.json() as Promise<SpineJsonDocument>;
}

async function fetchText(url: string, signal: AbortSignal): Promise<string> {
  const response = await fetchWithTimeout(url, signal, "atlas");
  if (!response.ok) throw new Error(`文件加载失败：${response.status} ${url}`);
  return response.text();
}

async function loadImage(url: string, signal: AbortSignal): Promise<ImageBitmap> {
  const response = await fetchWithTimeout(url, signal, "纹理");
  if (!response.ok) throw new Error(`纹理加载失败：${response.status} ${url}`);
  // spine-threejs uses straight-alpha blending (SrcAlpha / OneMinusSrcAlpha).
  // ImageBitmap may otherwise arrive premultiplied, which darkens translucent
  // overlays such as blush/shadow attachments when alpha is applied a second time.
  const bitmap = await createImageBitmap(await response.blob(), {
    premultiplyAlpha: "none",
  });
  if (signal.aborted) {
    bitmap.close();
    throw abortError();
  }
  return bitmap;
}

function textureFileName(pageName: string): string {
  return pageName.split(/[\\/]/).pop() ?? pageName;
}

export class SpineAssetLoader {
  async load(
    definition: CharacterDefinition,
    signal: AbortSignal,
    onProgress: (message: string) => void = () => undefined,
  ): Promise<LoadedSpineAsset> {
    const { id, assetRoot } = definition;
    const assetId = definition.assetId ?? id;
    onProgress("正在读取 Spine JSON 与 atlas…");
    const [json, atlasText] = await Promise.all([
      fetchJson(`${assetRoot}/json/${assetId}.json`, signal),
      fetchText(`${assetRoot}/atlas-local/${assetId}.atlas`, signal),
    ]);

    const version = json.skeleton?.spine ?? "";
    if (!version.startsWith("4.2.")) {
      throw new Error(`不支持的 Spine 版本：${version || "未知"}`);
    }

    const atlas = new TextureAtlas(atlasText);
    const images: ImageBitmap[] = [];
    try {
      if (atlas.pages.length === 0) {
        throw new Error(`atlas 没有纹理页：${assetId}`);
      }

      onProgress(`正在读取 ${atlas.pages.length} 页纹理…`);
      for (const page of atlas.pages) {
        const fileName = textureFileName(page.name);
        images.push(await loadImage(`${assetRoot}/texture/${fileName}`, signal));
      }

      if (signal.aborted) throw abortError();
      onProgress("正在解析骨骼、网格和物理约束…");
      atlas.pages.forEach((page, index) => {
        page.setTexture(new ThreeJsTexture(images[index]));
      });

      const attachmentLoader = new AtlasAttachmentLoader(atlas);
      const skeletonData = new SkeletonJson(attachmentLoader).readSkeletonData(json);
      let disposed = false;
      return {
        atlas,
        skeletonData,
        texturePages: atlas.pages.map((page) => textureFileName(page.name)),
        version,
        dispose() {
          if (disposed) return;
          disposed = true;
          atlas.dispose();
          images.forEach((image) => image.close());
        },
      };
    } catch (error) {
      atlas.dispose();
      images.forEach((image) => image.close());
      throw error;
    }
  }
}
