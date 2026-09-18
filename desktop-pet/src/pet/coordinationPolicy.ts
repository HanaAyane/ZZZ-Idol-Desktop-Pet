import type { CharacterId } from "../characters/types";
import type {
  CoordinationRuntimeState,
  CoordinationSceneKind,
  CoordinationTriggerKind,
} from "./coordinationTypes";

export const COORDINATION_CHARACTER_ORDER: readonly CharacterId[] = ["airui", "nangong", "qianxia"];
export const SNAPSHOT_MAX_AGE_MS = 1800;
export const PARTNER_GAZE_MAX_DISTANCE_PX = 900;

const SAFE_REACTION_STATES = new Set(["idle", "hover"]);

export function isSnapshotFresh(snapshot: CoordinationRuntimeState, now = Date.now()): boolean {
  return snapshot.sequence > 0 && snapshot.loaded && snapshot.visible && snapshot.position !== null
    && snapshot.reportedAt > 0
    && now - snapshot.reportedAt <= SNAPSHOT_MAX_AGE_MS;
}

export function isReactionEligible(snapshot: CoordinationRuntimeState, now = Date.now()): boolean {
  return isSnapshotFresh(snapshot, now)
    && snapshot.interactionReady
    && !snapshot.debugOpen
    && SAFE_REACTION_STATES.has(snapshot.state);
}

export function sameWorkArea(
  left: CoordinationRuntimeState,
  right: CoordinationRuntimeState,
): boolean {
  if (!left.position || !right.position) return false;
  const a = left.position;
  const b = right.position;
  return a.monitorName === b.monitorName
    && a.workArea.x === b.workArea.x
    && a.workArea.y === b.workArea.y
    && a.workArea.width === b.workArea.width
    && a.workArea.height === b.workArea.height;
}

export function visualCenter(snapshot: CoordinationRuntimeState): { x: number; y: number } | null {
  const position = snapshot.position;
  if (!position) return null;
  const anchor = snapshot.visualAnchor;
  const scale = Math.max(1, position.scaleFactor);
  return {
    x: position.x + (anchor?.x ?? position.width / scale / 2) * scale,
    y: position.y + (anchor?.y ?? position.height / scale / 2) * scale,
  };
}

export function orderedCharacterIds(ids: Iterable<CharacterId>): CharacterId[] {
  const allowed = new Set(ids);
  return COORDINATION_CHARACTER_ORDER.filter((id) => allowed.has(id));
}

export function selectNearestCharacter(
  selfId: CharacterId,
  snapshots: Partial<Record<CharacterId, CoordinationRuntimeState>>,
  now = Date.now(),
): CharacterId | null {
  const self = snapshots[selfId];
  if (!self || !isSnapshotFresh(self, now)) return null;
  const selfCenter = visualCenter(self);
  if (!selfCenter) return null;
  let best: { id: CharacterId; distance: number } | null = null;
  for (const id of COORDINATION_CHARACTER_ORDER) {
    if (id === selfId) continue;
    const candidate = snapshots[id];
    if (!candidate || !isSnapshotFresh(candidate, now) || !sameWorkArea(self, candidate)) continue;
    const center = visualCenter(candidate);
    if (!center) continue;
    const distance = Math.hypot(center.x - selfCenter.x, center.y - selfCenter.y);
    const next = { id, distance };
    if (!best || distance < best.distance - 0.5) best = next;
  }
  return best && best.distance <= PARTNER_GAZE_MAX_DISTANCE_PX ? best.id : null;
}

export function selectReactionParticipants(
  actorId: CharacterId,
  triggerKind: CoordinationTriggerKind,
  snapshots: Partial<Record<CharacterId, CoordinationRuntimeState>>,
  now = Date.now(),
): CharacterId[] {
  if (triggerKind !== "click" && triggerKind !== "doubleClick") return [];
  const actor = snapshots[actorId];
  if (!actor || !isSnapshotFresh(actor, now)) return [];
  const candidates = COORDINATION_CHARACTER_ORDER.filter((id) => {
    const candidate = snapshots[id];
    return id !== actorId && candidate !== undefined
      && isReactionEligible(candidate, now)
      && sameWorkArea(actor, candidate);
  });
  return candidates.slice(0, triggerKind === "doubleClick" ? 2 : 1);
}

export function canStartScene(
  kind: CoordinationSceneKind,
  snapshots: Partial<Record<CharacterId, CoordinationRuntimeState>>,
  now = Date.now(),
): boolean {
  if (kind === "reactionEcho") {
    return Object.values(snapshots).some((snapshot) => snapshot && isReactionEligible(snapshot, now));
  }
  if (kind === "gather" || kind === "disperse") {
    return Object.values(snapshots).some((snapshot) => snapshot && isSnapshotFresh(snapshot, now));
  }
  return true;
}
