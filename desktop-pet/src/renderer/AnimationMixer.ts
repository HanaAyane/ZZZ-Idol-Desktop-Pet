import type {
  AnimationStateListener,
  TrackEntry,
} from "@esotericsoftware/spine-core";
import type { SkeletonMesh } from "@esotericsoftware/spine-threejs";

export interface PlayOptions {
  loop?: boolean;
  overlay?: string;
  resetPose?: boolean;
}

export type ActionCompleteHandler = (
  action: string,
  loopCount: number,
  playbackId: number,
) => void;

export class AnimationMixer {
  private static playbackSequence = 0;

  private readonly actions: Set<string>;
  private readonly playbackIds = new WeakMap<TrackEntry, number>();
  private readonly listener: AnimationStateListener;
  private overlay = "";
  private currentPlaybackId = 0;
  private playing = true;
  private speed = 1;

  constructor(
    private readonly mesh: SkeletonMesh,
    onComplete: ActionCompleteHandler,
  ) {
    this.actions = new Set(mesh.skeleton.data.animations.map((animation) => animation.name));
    this.listener = {
      complete: (entry: TrackEntry) => {
        if (entry.trackIndex !== 0 || !entry.animation) return;
        const playbackId = this.playbackIds.get(entry);
        if (playbackId === undefined) return;
        const duration = entry.animation.duration;
        const loopCount = duration > 0 ? Math.max(1, Math.floor(entry.trackTime / duration)) : 1;
        onComplete(entry.animation.name, loopCount, playbackId);
      },
    };
    mesh.state.addListener(this.listener);
  }

  has(action: string): boolean {
    return this.actions.has(action);
  }

  play(action: string, options: PlayOptions = {}): number {
    const animation = this.mesh.skeleton.data.findAnimation(action);
    if (!animation) throw new Error(`动画不存在：${action}`);

    const resetPose = options.resetPose ?? true;
    const overlay = options.overlay ?? this.overlay;
    if (overlay && !this.has(overlay)) throw new Error(`表情动画不存在：${overlay}`);
    if (resetPose) {
      this.mesh.skeleton.setToSetupPose();
      this.mesh.skeleton.setSlotsToSetupPose();
    }
    this.mesh.state.clearTracks();
    const shouldLoop = (options.loop ?? true) && animation.duration > 0;
    const entry = this.mesh.state.setAnimation(0, action, shouldLoop);
    const playbackId = ++AnimationMixer.playbackSequence;
    this.playbackIds.set(entry, playbackId);
    this.currentPlaybackId = playbackId;
    if (overlay && overlay !== action && this.has(overlay)) {
      const overlayDuration = this.mesh.skeleton.data.findAnimation(overlay)?.duration ?? 0;
      this.mesh.state.setAnimation(1, overlay, overlayDuration > 0);
    }
    this.overlay = overlay;
    this.mesh.state.timeScale = this.playing ? this.speed : 0;
    this.mesh.update(0);
    return playbackId;
  }

  /**
   * Replaces only the expression track while preserving track 0 and its playback id/time.
   * Resetting and reapplying the setup pose prevents slots left by the previous expression
   * from leaking into the next one without restarting the body action.
   */
  setOverlay(overlay: string): number {
    if (overlay && !this.has(overlay)) throw new Error(`表情动画不存在：${overlay}`);
    const bodyEntry = this.mesh.state.getCurrent(0);
    if (!bodyEntry?.animation || this.currentPlaybackId === 0) {
      throw new Error("没有可复用的身体动画轨道。");
    }

    const bodyTrackTime = bodyEntry.trackTime;
    this.mesh.state.clearTrack(1);
    this.mesh.skeleton.setToSetupPose();
    this.mesh.skeleton.setSlotsToSetupPose();
    bodyEntry.trackTime = bodyTrackTime;
    if (overlay && overlay !== bodyEntry.animation.name) {
      const overlayDuration = this.mesh.skeleton.data.findAnimation(overlay)?.duration ?? 0;
      this.mesh.state.setAnimation(1, overlay, overlayDuration > 0);
    }
    this.overlay = overlay;
    this.mesh.state.timeScale = this.playing ? this.speed : 0;
    this.mesh.update(0);
    return this.currentPlaybackId;
  }

  setMix(seconds: number): void {
    this.mesh.state.data.defaultMix = Math.max(0, seconds);
  }

  setSpeed(speed: number): void {
    this.speed = Math.max(0, speed);
    this.mesh.state.timeScale = this.playing ? this.speed : 0;
  }

  setPlaying(playing: boolean): void {
    this.playing = playing;
    this.mesh.state.timeScale = playing ? this.speed : 0;
  }

  dispose(): void {
    this.currentPlaybackId = 0;
    this.mesh.state.removeListener(this.listener);
    this.mesh.state.clearTracks();
    this.mesh.state.clearListenerNotifications();
  }
}
