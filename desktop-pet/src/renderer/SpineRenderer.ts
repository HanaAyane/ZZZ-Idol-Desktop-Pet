import * as THREE from "three";
import { Physics, Vector2, type Bone } from "@esotericsoftware/spine-core";
import { SkeletonMesh } from "@esotericsoftware/spine-threejs";
import type { CharacterDefinition } from "../characters/types";
import { AnimationMixer, type ActionCompleteHandler } from "./AnimationMixer";
import { SpineAssetLoader, type LoadedSpineAsset } from "./SpineAssetLoader";
import { DragSwayController, type DragSwaySnapshot } from "./DragSwayController";
import { drawableBounds, measureLiftProfile, palmContact, projectLiftProfile,
  type LiftPoseProfile, type PoseBounds } from "./liftPoseGeometry";
import type { WindowLiftGeometry } from "../pet/windowLiftGeometry";

const PET_VISUAL_WIDTH = 360;
const PET_VISUAL_HEIGHT = 480;
const HIT_TEST_PROBE_SIZE = 3;
const GAZE_BONE_NAME = "眼部控制器";
const GAZE_MAX_SKELETON_UNITS = 11;
const GAZE_SMOOTHING = 11;

export interface SpineCharacterMetadata {
  id: CharacterDefinition["id"];
  displayName: string;
  version: string;
  actions: string[];
  bodyActions: string[];
  overlays: string[];
  skins: string[];
  texturePages: string[];
  bones: number;
  physicsConstraints: number;
  sourceSize: {
    width: number;
    height: number;
  };
}

export interface SpineRendererDiagnostics {
  loaded: boolean;
  running: boolean;
  contextLost: boolean;
  currentAction: string;
  currentOverlay: string;
  currentSkin: string;
  mirroredFromDefault: boolean;
  characterScale: number;
  gaze: {
    active: boolean;
    x: number;
    y: number;
  };
  framesRendered: number;
  completedActions: number;
  dragSway: DragSwaySnapshot;
  memory: {
    geometries: number;
    textures: number;
  };
}

interface StableFitBounds {
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
}

export interface PixelHitTestDiagnostics {
  transparentAlpha: number | null;
  characterAlpha: number | null;
  characterPoint: { x: number; y: number } | null;
}

export interface SpineRendererEvents {
  onActionComplete?: ActionCompleteHandler;
  onContextChange?: (state: "lost" | "restored") => void;
  onLoadProgress?: (message: string) => void;
  onDragSwaySettled?: () => void;
}

export class SpineRenderer {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 1000);
  private readonly webgl: THREE.WebGLRenderer;
  private readonly hitTestTarget = new THREE.WebGLRenderTarget(
    HIT_TEST_PROBE_SIZE,
    HIT_TEST_PROBE_SIZE,
    { depthBuffer: false, stencilBuffer: false },
  );
  private readonly hitTestPixels = new Uint8Array(HIT_TEST_PROBE_SIZE * HIT_TEST_PROBE_SIZE * 4);
  private readonly loader = new SpineAssetLoader();
  private readonly resizeObserver: ResizeObserver;
  private asset: LoadedSpineAsset | null = null;
  private mesh: SkeletonMesh | null = null;
  private swayPivot: THREE.Group | null = null;
  private mixer: AnimationMixer | null = null;
  private dragSway: DragSwayController | null = null;
  private definition: CharacterDefinition | null = null;
  private metadata: SpineCharacterMetadata | null = null;
  private stableFitBounds: StableFitBounds | null = null;
  private liftProfile: LiftPoseProfile | null = null;
  private readonly liftBasePosition = new THREE.Vector3();
  private abortController: AbortController | null = null;
  private animationFrame = 0;
  private lastFrame = performance.now();
  private running = false;
  private contextLost = false;
  private resumeAfterContextRestore = false;
  private disposed = false;
  private currentAction = "";
  private currentOverlay = "";
  private currentSkin = "";
  private mirroredFromDefault = false;
  private characterScale = 1;
  private gazeTargetX = 0;
  private gazeTargetY = 0;
  private gazeX = 0;
  private gazeY = 0;
  private gazeActive = false;
  private gazeController: Bone | null = null;
  private readonly gazeWorldOrigin = new Vector2();
  private readonly gazeWorldTarget = new Vector2();
  private pixelRatioLimit = 2;
  private frameIntervalMs = 0;
  private framesRendered = 0;
  private completedActions = 0;

  constructor(
    private readonly container: HTMLElement,
    private readonly events: SpineRendererEvents = {},
  ) {
    this.camera.position.z = 10;
    this.webgl = new THREE.WebGLRenderer({
      alpha: true,
      antialias: true,
      powerPreference: "high-performance",
      premultipliedAlpha: true,
    });
    this.webgl.setClearColor(0x000000, 0);
    this.webgl.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.webgl.outputColorSpace = THREE.SRGBColorSpace;
    this.webgl.domElement.className = "spine-canvas";
    this.webgl.domElement.setAttribute("aria-label", "爱芮 Spine 动画画布");
    this.webgl.domElement.addEventListener("webglcontextlost", this.handleContextLost);
    this.webgl.domElement.addEventListener("webglcontextrestored", this.handleContextRestored);
    this.container.appendChild(this.webgl.domElement);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.container);
    document.addEventListener("visibilitychange", this.handleVisibilityChange);
    this.resize();
  }

  async loadCharacter(definition: CharacterDefinition): Promise<SpineCharacterMetadata> {
    this.assertActive();
    this.abortController?.abort();
    const abortController = new AbortController();
    this.abortController = abortController;

    let asset: LoadedSpineAsset;
    try {
      asset = await this.loader.load(
        definition,
        abortController.signal,
        (message) => this.events.onLoadProgress?.(message),
      );
    } catch (error) {
      if (this.abortController === abortController) this.abortController = null;
      throw error;
    }
    if (abortController.signal.aborted || this.disposed) {
      asset.dispose();
      throw new DOMException("Spine asset loading was cancelled.", "AbortError");
    }

    let mesh: SkeletonMesh | null = null;
    let mixer: AnimationMixer | null = null;
    try {
      mesh = new SkeletonMesh(asset.skeletonData);
      mesh.frustumCulled = false;
      mesh.position.z = 0;
      const actions = asset.skeletonData.animations.map((animation) => animation.name);
      const skins = asset.skeletonData.skins.map((skin) => skin.name);
      const bodyActions = actions.filter((action) => action.startsWith("动作_") || action === "0");
      const overlays = actions.filter((action) => action.startsWith("表情_"));
      const preferredSkin = skins.includes(definition.preferredSkin)
        ? definition.preferredSkin
        : skins.includes("default")
          ? "default"
          : skins[0] ?? "";
      const preferredOverlay = overlays.includes(definition.preferredOverlay)
        ? definition.preferredOverlay
        : "";
      const preferredAction = bodyActions.includes(definition.preferredAction)
        ? definition.preferredAction
        : bodyActions[0] ?? "";
      if (!preferredAction) throw new Error(`${definition.displayName} 没有可播放的身体动作。`);

      const metadata: SpineCharacterMetadata = {
        id: definition.id,
        displayName: definition.displayName,
        version: asset.version,
        actions,
        bodyActions,
        overlays,
        skins,
        texturePages: asset.texturePages,
        bones: asset.skeletonData.bones.length,
        physicsConstraints: asset.skeletonData.physicsConstraints.length,
        sourceSize: {
          width: asset.skeletonData.width,
          height: asset.skeletonData.height,
        },
      };

      mixer = new AnimationMixer(mesh, (action, loopCount, playbackId) => {
        this.completedActions += 1;
        this.events.onActionComplete?.(action, loopCount, playbackId);
      });
      const swayPivot = new THREE.Group();
      swayPivot.name = `${definition.id}-head-top-drag-pivot`;
      swayPivot.add(mesh);
      const dragSway = new DragSwayController(
        swayPivot,
        definition.behavior.dragSway,
        () => this.events.onDragSwaySettled?.(),
      );
      mixer.setMix(0.3);
      if (preferredSkin) mesh.skeleton.setSkinByName(preferredSkin);
      mesh.skeleton.setSlotsToSetupPose();
      mixer.play(preferredAction, { loop: true, overlay: preferredOverlay });
      const liftProfile = definition.windowLiftContactSlots
        ? measureLiftProfile(asset.skeletonData, preferredAction, preferredOverlay,
          preferredSkin, definition.windowLiftContactSlots)
        : null;

      if (abortController.signal.aborted || this.disposed) {
        throw new DOMException("Spine asset loading was cancelled.", "AbortError");
      }
      this.abortController = null;
      this.disposeLoadedCharacter();
      this.asset = asset;
      this.mesh = mesh;
      this.gazeController = mesh.skeleton.findBone(GAZE_BONE_NAME);
      this.swayPivot = swayPivot;
      this.mixer = mixer;
      this.dragSway = dragSway;
      this.definition = definition;
      this.metadata = metadata;
      this.stableFitBounds = this.measureCurrentBounds();
      this.liftProfile = liftProfile;
      this.currentAction = preferredAction;
      this.currentOverlay = preferredOverlay;
      this.currentSkin = preferredSkin;
      this.webgl.domElement.setAttribute("aria-label", `${definition.displayName} Spine 动画画布`);
      this.scene.add(swayPivot);
    } catch (error) {
      if (this.abortController === abortController) this.abortController = null;
      mixer?.dispose();
      mesh?.dispose();
      asset.dispose();
      throw error;
    }

    this.fit();
    this.start();
    return { ...this.metadata };
  }

  playAction(action: string, loop = true, overlay = this.currentOverlay): number {
    const { mixer } = this.requireCharacter();
    const nextOverlay = action.startsWith("动作_") ? overlay : "";
    const playbackId = mixer.play(action, { loop, overlay: nextOverlay });
    this.currentAction = action;
    this.currentOverlay = nextOverlay;
    this.fit();
    return playbackId;
  }

  setOverlay(action: string): number {
    const { mixer } = this.requireCharacter();
    if (action && !mixer.has(action)) throw new Error(`表情动画不存在：${action}`);
    const playbackId = mixer.setOverlay(action);
    this.currentOverlay = action;
    return playbackId;
  }

  setSkin(skin: string): void {
    const { mesh, mixer, metadata } = this.requireCharacter();
    if (!metadata.skins.includes(skin)) throw new Error(`皮肤不存在：${skin}`);
    mesh.skeleton.setSkinByName(skin);
    mesh.skeleton.setSlotsToSetupPose();
    mixer.setOverlay(this.currentOverlay);
    this.currentSkin = skin;
    this.fit();
  }

  setHorizontalMirror(mirroredFromDefault: boolean): void {
    this.requireCharacter();
    if (this.mirroredFromDefault === mirroredFromDefault) return;
    this.mirroredFromDefault = mirroredFromDefault;
    this.fit();
  }

  setCharacterScale(scale: number): void {
    const nextScale = Math.min(1.25, Math.max(0.6, scale));
    if (Math.abs(this.characterScale - nextScale) < 0.001) return;
    this.characterScale = nextScale;
    this.fit();
  }

  getVisibleBounds(): PoseBounds | null {
    if (!this.mesh) return null;
    const b = drawableBounds(this.mesh.skeleton);
    if (!b) return null;
    this.mesh.updateWorldMatrix(true, false);
    const rect = this.container.getBoundingClientRect();
    const points = [[b.x, b.y], [b.x + b.width, b.y],
      [b.x, b.y + b.height], [b.x + b.width, b.y + b.height]].map(([x, y]) => {
      const p = this.mesh!.localToWorld(new THREE.Vector3(x, y, 0));
      return { x: rect.width / 2 + p.x, y: rect.height / 2 - p.y };
    });
    const x = Math.min(...points.map(p => p.x)), y = Math.min(...points.map(p => p.y));
    return { x, y, width: Math.max(...points.map(p => p.x)) - x,
      height: Math.max(...points.map(p => p.y)) - y };
  }

  getWindowLiftGeometry(): WindowLiftGeometry | null {
    const fit = this.stableFitBounds;
    if (!fit || !this.liftProfile || !this.definition) return null;
    const rect = this.container.getBoundingClientRect();
    return projectLiftProfile(this.liftProfile,
      { x: fit.offsetX, y: fit.offsetY, width: fit.width, height: fit.height },
      rect.width, rect.height, this.characterScale, this.definition.fitPadding);
  }

  setGazeTarget(clientX: number | null, clientY: number | null, active = true): void {
    if (clientX === null || clientY === null || !active) {
      this.gazeTargetX = 0;
      this.gazeTargetY = 0;
      this.gazeActive = false;
      return;
    }
    const rect = this.webgl.domElement.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height * 0.42;
    const normalizedX = (clientX - centerX) / Math.max(rect.width * 0.55, 1);
    const normalizedY = (centerY - clientY) / Math.max(rect.height * 0.55, 1);
    const length = Math.hypot(normalizedX, normalizedY);
    const limit = Math.max(1, length);
    this.gazeTargetX = normalizedX / limit;
    this.gazeTargetY = normalizedY / limit;
    this.gazeActive = length > 0.001;
  }

  setPlaying(playing: boolean): void {
    const { mixer } = this.requireCharacter();
    mixer.setPlaying(playing);
  }

  setSpeed(speed: number): void {
    const { mixer } = this.requireCharacter();
    mixer.setSpeed(speed);
  }

  setPerformance(mode: "quality" | "balanced" | "saving", frameRate: "auto" | "60" | "30"): void {
    this.pixelRatioLimit = mode === "quality" ? 2 : mode === "balanced" ? 1.5 : 1;
    const targetFps = frameRate === "60" ? 60 : frameRate === "30" ? 30 : mode === "saving" ? 30 : 60;
    this.frameIntervalMs = 1000 / targetFps;
    this.resize();
  }

  startDragSway(): void {
    this.dragSway?.start();
  }

  pushDragMotion(deltaXCssPx: number, deltaYCssPx: number, elapsedMs: number): void {
    this.dragSway?.pushMotion(deltaXCssPx, deltaYCssPx, elapsedMs);
  }

  endDragSway(): void {
    this.dragSway?.end();
  }

  getMetadata(): SpineCharacterMetadata | null {
    return this.metadata ? { ...this.metadata } : null;
  }

  getDiagnostics(): SpineRendererDiagnostics {
    return {
      loaded: Boolean(this.mesh),
      running: this.running,
      contextLost: this.contextLost,
      currentAction: this.currentAction,
      currentOverlay: this.currentOverlay,
      currentSkin: this.currentSkin,
      mirroredFromDefault: this.mirroredFromDefault,
      characterScale: this.characterScale,
      gaze: {
        active: this.gazeActive,
        x: this.gazeX,
        y: this.gazeY,
      },
      framesRendered: this.framesRendered,
      completedActions: this.completedActions,
      dragSway: this.dragSway?.getSnapshot() ?? {
        dragging: false,
        active: false,
        angleDegrees: 0,
        targetDegrees: 0,
        velocityDegreesPerSecond: 0,
        filteredHorizontalVelocity: 0,
      },
      memory: {
        geometries: this.webgl.info.memory.geometries,
        textures: this.webgl.info.memory.textures,
      },
    };
  }

  getSlotFingerprint(): string {
    const { mesh } = this.requireCharacter();
    return mesh.skeleton.slots
      .map((slot) => {
        const color = slot.color;
        return [
          slot.data.name,
          slot.getAttachment()?.name ?? "",
          color.r.toFixed(6),
          color.g.toFixed(6),
          color.b.toFixed(6),
          color.a.toFixed(6),
        ].join(":");
      })
      .join("|");
  }

  sampleAlphaAt(clientX: number, clientY: number): number | null {
    if (this.disposed || this.contextLost || !this.mesh) return null;
    const rect = this.webgl.domElement.getBoundingClientRect();
    const localX = clientX - rect.left;
    const localY = clientY - rect.top;
    if (localX < 0 || localY < 0 || localX >= rect.width || localY >= rect.height) return 0;

    const fullWidth = Math.max(1, Math.floor(rect.width));
    const fullHeight = Math.max(1, Math.floor(rect.height));
    const probeWidth = Math.min(HIT_TEST_PROBE_SIZE, fullWidth);
    const probeHeight = Math.min(HIT_TEST_PROBE_SIZE, fullHeight);
    const offsetX = Math.min(
      Math.max(0, Math.floor(localX) - Math.floor(probeWidth / 2)),
      fullWidth - probeWidth,
    );
    const offsetY = Math.min(
      Math.max(0, Math.floor(localY) - Math.floor(probeHeight / 2)),
      fullHeight - probeHeight,
    );
    const previousTarget = this.webgl.getRenderTarget();

    try {
      this.camera.setViewOffset(
        fullWidth,
        fullHeight,
        offsetX,
        offsetY,
        probeWidth,
        probeHeight,
      );
      this.webgl.setRenderTarget(this.hitTestTarget);
      this.webgl.clear(true, true, true);
      this.webgl.render(this.scene, this.camera);
      this.webgl.readRenderTargetPixels(
        this.hitTestTarget,
        0,
        0,
        probeWidth,
        probeHeight,
        this.hitTestPixels,
      );
      let maximumAlpha = 0;
      for (let index = 3; index < probeWidth * probeHeight * 4; index += 4) {
        maximumAlpha = Math.max(maximumAlpha, this.hitTestPixels[index] ?? 0);
      }
      return maximumAlpha / 255;
    } catch (error) {
      console.warn("WebGL Alpha 命中探针读取失败", error);
      return null;
    } finally {
      this.camera.clearViewOffset();
      this.webgl.setRenderTarget(previousTarget);
    }
  }

  diagnosePixelHitTest(): PixelHitTestDiagnostics {
    const rect = this.webgl.domElement.getBoundingClientRect();
    const transparentAlpha = this.sampleAlphaAt(rect.left + 2, rect.top + 2);
    let characterAlpha: number | null = null;
    let characterPoint: PixelHitTestDiagnostics["characterPoint"] = null;
    const startX = Math.max(20, rect.width * 0.2);
    const endX = Math.min(rect.width - 20, rect.width * 0.8);
    const startY = Math.max(20, rect.height * 0.18);
    const endY = Math.min(rect.height - 20, rect.height * 0.82);

    for (let y = startY; y <= endY; y += 24) {
      for (let x = startX; x <= endX; x += 24) {
        const alpha = this.sampleAlphaAt(rect.left + x, rect.top + y);
        if (alpha !== null && (characterAlpha === null || alpha > characterAlpha)) {
          characterAlpha = alpha;
          characterPoint = { x, y };
        }
        if ((characterAlpha ?? 0) >= 0.95) break;
      }
      if ((characterAlpha ?? 0) >= 0.95) break;
    }
    return { transparentAlpha, characterAlpha, characterPoint };
  }

  async testContextRecovery(delayMs = 250): Promise<boolean> {
    this.requireCharacter();
    const context = this.webgl.getContext();
    const extension = context.getExtension("WEBGL_lose_context");
    if (!extension) return false;

    return new Promise<boolean>((resolve) => {
      const timeout = window.setTimeout(() => resolve(false), 4000);
      const restored = () => {
        window.clearTimeout(timeout);
        this.webgl.domElement.removeEventListener("webglcontextrestored", restored);
        resolve(true);
      };
      this.webgl.domElement.addEventListener("webglcontextrestored", restored);
      extension.loseContext();
      window.setTimeout(() => extension.restoreContext(), Math.max(50, delayMs));
    });
  }

  disposeCharacter(): void {
    this.abortController?.abort();
    this.abortController = null;
    this.disposeLoadedCharacter();
  }

  private disposeLoadedCharacter(): void {
    this.dragSway?.dispose();
    if (this.mixer) this.mixer.dispose();
    if (this.mesh) {
      if (this.swayPivot) {
        this.scene.remove(this.swayPivot);
        this.swayPivot.remove(this.mesh);
      } else {
        this.scene.remove(this.mesh);
      }
      this.mesh.dispose();
    }
    if (this.asset) this.asset.dispose();
    this.asset = null;
    this.mesh = null;
    this.swayPivot = null;
    this.mixer = null;
    this.dragSway = null;
    this.definition = null;
    this.metadata = null;
    this.stableFitBounds = null;
    this.liftProfile = null;
    this.currentAction = "";
    this.currentOverlay = "";
    this.currentSkin = "";
    this.mirroredFromDefault = false;
    this.gazeTargetX = 0;
    this.gazeTargetY = 0;
    this.gazeX = 0;
    this.gazeY = 0;
    this.gazeActive = false;
    this.gazeController = null;
    this.webgl.renderLists.dispose();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
    this.disposeCharacter();
    this.resizeObserver.disconnect();
    document.removeEventListener("visibilitychange", this.handleVisibilityChange);
    this.webgl.domElement.removeEventListener("webglcontextlost", this.handleContextLost);
    this.webgl.domElement.removeEventListener("webglcontextrestored", this.handleContextRestored);
    this.hitTestTarget.dispose();
    this.webgl.dispose();
    this.webgl.domElement.remove();
  }

  private readonly tick = (timestamp: number) => {
    if (!this.running || this.disposed) return;
    if (timestamp - this.lastFrame < this.frameIntervalMs - 1) {
      this.animationFrame = requestAnimationFrame(this.tick);
      return;
    }
    const delta = Math.min(Math.max((timestamp - this.lastFrame) / 1000, 0), 0.1);
    this.lastFrame = timestamp;
    this.dragSway?.update(delta);
    if (this.mesh) {
      this.updateMesh(delta);
      this.stabilizeLiftContact();
    }
    this.webgl.render(this.scene, this.camera);
    this.framesRendered += 1;
    this.animationFrame = requestAnimationFrame(this.tick);
  };

  private start(): void {
    if (this.running || this.contextLost || this.disposed || document.hidden) return;
    this.running = true;
    this.lastFrame = performance.now();
    this.animationFrame = requestAnimationFrame(this.tick);
  }

  private stop(): void {
    if (!this.running) return;
    this.running = false;
    cancelAnimationFrame(this.animationFrame);
    this.animationFrame = 0;
  }

  private resize(): void {
    if (this.disposed) return;
    const rect = this.container.getBoundingClientRect();
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));
    this.webgl.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.pixelRatioLimit));
    this.webgl.setSize(width, height, false);
    this.camera.left = -width / 2;
    this.camera.right = width / 2;
    this.camera.top = height / 2;
    this.camera.bottom = -height / 2;
    this.camera.updateProjectionMatrix();
    this.fit();
  }

  private fit(): void {
    if (!this.mesh || !this.swayPivot || !this.definition) return;
    const rect = this.container.getBoundingClientRect();
    const bounds = this.stableFitBounds ?? this.measureCurrentBounds();
    if (!bounds) return;
    const sourceWidth = bounds.width;
    const sourceHeight = bounds.height;
    // The native window is deliberately larger than the original 360x480
    // visual canvas. Keep character scale based on that visual canvas so the
    // extra pixels remain transparent swing safety space instead of enlarging
    // the character back into the window edges.
    const visualWidth = Math.min(rect.width, PET_VISUAL_WIDTH);
    const visualHeight = Math.min(rect.height, PET_VISUAL_HEIGHT);
    const usableWidth = Math.max(visualWidth * this.definition.fitPadding, 40);
    const usableHeight = Math.max(visualHeight * this.definition.fitPadding, 40);
    const scale = Math.min(usableWidth / sourceWidth, usableHeight / sourceHeight) * this.characterScale;
    const flipX = this.definition.flipX !== this.mirroredFromDefault ? -1 : 1;
    this.mesh.scale.set(scale * flipX, scale, scale);
    const centeredX = -(bounds.offsetX + sourceWidth / 2) * scale * flipX;
    const centeredY = -(bounds.offsetY + sourceHeight / 2) * scale;
    const headTopY = centeredY + (bounds.offsetY + sourceHeight) * scale;
    this.swayPivot.position.set(0, headTopY, 0);
    this.mesh.position.set(centeredX, centeredY - headTopY, 0);
    this.liftBasePosition.copy(this.mesh.position);
    this.stabilizeLiftContact();
  }

  private stabilizeLiftContact(): void {
    const slots = this.definition?.windowLiftContactSlots;
    if (!this.mesh || !slots || !this.liftProfile) return;
    const current = palmContact(this.mesh.skeleton, slots);
    this.mesh.position.copy(this.liftBasePosition);
    this.mesh.position.x += (this.liftProfile.contact.x - current.x) * this.mesh.scale.x;
    this.mesh.position.y += (this.liftProfile.contact.y - current.y) * this.mesh.scale.y;
  }

  private measureCurrentBounds(): StableFitBounds | null {
    if (!this.mesh) return null;
    const offset = new Vector2();
    const size = new Vector2();
    this.mesh.skeleton.getBounds(offset, size);
    return {
      offsetX: offset.x,
      offsetY: offset.y,
      width: Math.max(size.x, 1),
      height: Math.max(size.y, 1),
    };
  }

  private updateMesh(delta: number): void {
    const mesh = this.mesh;
    if (!mesh) return;
    if (!this.gazeActive && Math.abs(this.gazeX) < 0.0001 && Math.abs(this.gazeY) < 0.0001) {
      mesh.update(delta);
      return;
    }
    mesh.state.update(delta);
    mesh.state.apply(mesh.skeleton);
    mesh.skeleton.update(delta);
    mesh.skeleton.updateWorldTransform(Physics.update);
    this.applyGazeAndUpdateGeometry(delta);
  }

  private applyGazeAndUpdateGeometry(delta: number): void {
    const mesh = this.mesh;
    if (!mesh) return;
    const blend = 1 - Math.exp(-GAZE_SMOOTHING * delta);
    this.gazeX += (this.gazeTargetX - this.gazeX) * blend;
    this.gazeY += (this.gazeTargetY - this.gazeY) * blend;
    if (Math.abs(this.gazeX) < 0.0001 && Math.abs(this.gazeY) < 0.0001) {
      this.gazeX = 0;
      this.gazeY = 0;
      this.updateMeshGeometry(mesh);
      return;
    }

    const controller = this.gazeController;
    if (!controller?.parent) {
      this.updateMeshGeometry(mesh);
      return;
    }
    const horizontalFlip = mesh.scale.x < 0 ? -1 : 1;
    const worldOrigin = controller.parent.worldToLocal(this.gazeWorldOrigin.set(0, 0));
    const localTarget = controller.parent.worldToLocal(this.gazeWorldTarget.set(
      this.gazeX * GAZE_MAX_SKELETON_UNITS * horizontalFlip,
      this.gazeY * GAZE_MAX_SKELETON_UNITS,
    ));
    const localGazeX = localTarget.x - worldOrigin.x;
    const localGazeY = localTarget.y - worldOrigin.y;
    controller.x += localGazeX;
    controller.y += localGazeY;
    mesh.skeleton.updateWorldTransform(Physics.pose);
    this.updateMeshGeometry(mesh);
    controller.x -= localGazeX;
    controller.y -= localGazeY;
  }

  private updateMeshGeometry(mesh: SkeletonMesh): void {
    (mesh as unknown as { updateGeometry(): void }).updateGeometry();
  }

  private readonly handleVisibilityChange = () => {
    if (document.hidden) this.stop();
    else this.start();
  };

  private readonly handleContextLost = (event: Event) => {
    event.preventDefault();
    this.contextLost = true;
    this.resumeAfterContextRestore = this.running;
    this.stop();
    this.events.onContextChange?.("lost");
  };

  private readonly handleContextRestored = () => {
    this.contextLost = false;
    this.resize();
    if (this.mesh) this.mesh.update(0);
    if (this.resumeAfterContextRestore) this.start();
    this.resumeAfterContextRestore = false;
    this.events.onContextChange?.("restored");
  };

  private assertActive(): void {
    if (this.disposed) throw new Error("SpineRenderer 已销毁。");
  }

  private requireCharacter(): {
    mesh: SkeletonMesh;
    mixer: AnimationMixer;
    metadata: SpineCharacterMetadata;
  } {
    this.assertActive();
    if (!this.mesh || !this.mixer || !this.metadata) {
      throw new Error("角色尚未加载完成。");
    }
    return { mesh: this.mesh, mixer: this.mixer, metadata: this.metadata };
  }
}
