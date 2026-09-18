import type { CharacterId } from "../characters/types";
import {
  COORDINATION_CHARACTER_ORDER,
  orderedCharacterIds,
  visualCenter,
} from "./coordinationPolicy.ts";
import type {
  CoordinationMoveTarget,
  CoordinationRuntimeState,
  CoordinationWorkArea,
} from "./coordinationTypes";

export interface GroupLayoutOptions {
  mode: "gather" | "disperse";
  anchorCharacterId?: CharacterId | null;
  anchorX: number | null;
  anchorY: number | null;
  workArea: CoordinationWorkArea;
  marginCss?: number;
}

export interface GroupLayoutResult {
  targets: Partial<Record<CharacterId, CoordinationMoveTarget>>;
  orderedIds: CharacterId[];
  degradedReason: string | null;
}

const DEFAULT_MARGIN_CSS = 18;
const MIN_SPACING_CSS = 42;

function physicalVisualWidth(snapshot: CoordinationRuntimeState): number {
  const scaleFactor = Math.max(1, snapshot.position?.scaleFactor ?? 1);
  const scale = Math.max(0.6, snapshot.scale || 1);
  return Math.max(
    24,
    (snapshot.visualAnchor?.width || snapshot.visualWidthCss || 220) * scaleFactor * scale,
  );
}

function visualOffsetX(snapshot: CoordinationRuntimeState): number {
  const scaleFactor = Math.max(1, snapshot.position?.scaleFactor ?? 1);
  return (snapshot.visualAnchor?.x ?? ((snapshot.position?.width ?? 520) / scaleFactor) / 2) * scaleFactor;
}

function visualOffsetY(snapshot: CoordinationRuntimeState): number {
  const scaleFactor = Math.max(1, snapshot.position?.scaleFactor ?? 1);
  return (snapshot.visualAnchor?.y ?? ((snapshot.position?.height ?? 600) / scaleFactor)) * scaleFactor;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function calculateGroupLayout(
  snapshots: Partial<Record<CharacterId, CoordinationRuntimeState>>,
  participantIds: Iterable<CharacterId>,
  options: GroupLayoutOptions,
): GroupLayoutResult {
  const orderedIds = orderedCharacterIds(participantIds).filter((id) => {
    const snapshot = snapshots[id];
    return Boolean(snapshot?.position);
  });
  if (orderedIds.length === 0) {
    return { targets: {}, orderedIds: [], degradedReason: "没有可移动的可见角色" };
  }

  const margin = Math.max(0, options.marginCss ?? DEFAULT_MARGIN_CSS)
    * Math.max(1, snapshots[orderedIds[0]]?.position?.scaleFactor ?? 1);
  const widths = orderedIds.map((id) => physicalVisualWidth(snapshots[id]!));
  const spacing = orderedIds.slice(0, -1).reduce((maximum, id) => {
    return Math.max(maximum, (snapshots[id]?.preferredSpacingCss ?? MIN_SPACING_CSS)
      * Math.max(1, snapshots[id]?.position?.scaleFactor ?? 1));
  }, MIN_SPACING_CSS);
  const totalWidth = widths.reduce((sum, width) => sum + width, 0) + spacing * Math.max(0, orderedIds.length - 1);
  const area = options.workArea;
  const minimumLeft = area.x + margin;
  const maximumLeft = area.x + area.width - margin - totalWidth;
  const idealCenter = options.anchorX ?? area.x + area.width / 2;
  const anchorIndex = options.mode === "gather" && options.anchorCharacterId
    ? orderedIds.indexOf(options.anchorCharacterId)
    : -1;
  const anchorOffsetX = anchorIndex >= 0
    ? widths.slice(0, anchorIndex).reduce((sum, width) => sum + width, 0)
      + spacing * anchorIndex
      + widths[anchorIndex] / 2
    : totalWidth / 2;
  const left = clamp(idealCenter - anchorOffsetX, minimumLeft, Math.max(minimumLeft, maximumLeft));
  const fallbackReason = totalWidth > area.width - margin * 2
    ? "工作区不足，已缩小到可用边界"
    : null;
  const targetY = options.anchorY ?? area.y + area.height - margin;
  const targets: Partial<Record<CharacterId, CoordinationMoveTarget>> = {};
  const provisionalTargets: Array<{
    id: CharacterId;
    snapshot: CoordinationRuntimeState;
    rawX: number;
    rawY: number;
  }> = [];
  let cursor = left;

  for (let index = 0; index < orderedIds.length; index += 1) {
    const id = orderedIds[index];
    const snapshot = snapshots[id];
    if (!snapshot?.position) continue;
    const center = cursor + widths[index] / 2;
    const rawX = center - visualOffsetX(snapshot);
    const rawY = targetY - visualOffsetY(snapshot);
    provisionalTargets.push({ id, snapshot, rawX, rawY });
    cursor += widths[index] + (index < orderedIds.length - 1 ? spacing : 0);
  }

  const minimumFrameX = Math.min(...provisionalTargets.map(({ rawX }) => rawX));
  const maximumFrameX = Math.max(...provisionalTargets.map(({ rawX, snapshot }) => {
    return rawX + (snapshot.position?.width ?? 0);
  }));
  const availableFrameWidth = Math.max(0, area.width - margin * 2);
  const frameWidth = maximumFrameX - minimumFrameX;
  const canShiftGroupIntact = frameWidth <= availableFrameWidth;
  const minimumShift = area.x + margin - minimumFrameX;
  const maximumShift = area.x + area.width - margin - maximumFrameX;
  const groupShiftX = canShiftGroupIntact
    ? clamp(0, minimumShift, maximumShift)
    : 0;
  const minimumFrameY = Math.min(...provisionalTargets.map(({ rawY }) => rawY));
  const maximumFrameY = Math.max(...provisionalTargets.map(({ rawY, snapshot }) => {
    return rawY + (snapshot.position?.height ?? 0);
  }));
  const availableFrameHeight = Math.max(0, area.height - margin * 2);
  const frameHeight = maximumFrameY - minimumFrameY;
  const canShiftGroupVertically = frameHeight <= availableFrameHeight;
  const minimumVerticalShift = area.y + margin - minimumFrameY;
  const maximumVerticalShift = area.y + area.height - margin - maximumFrameY;
  const groupShiftY = canShiftGroupVertically
    ? clamp(0, minimumVerticalShift, maximumVerticalShift)
    : 0;
  const degradedReason = fallbackReason ?? (canShiftGroupIntact && canShiftGroupVertically
    ? null
    : "工作区不足，无法完整保持角色间距");

  for (const { id, snapshot, rawX, rawY } of provisionalTargets) {
    const maximumX = area.x + area.width - (snapshot.position?.width ?? 0);
    const x = canShiftGroupIntact
      ? Math.round(rawX + groupShiftX)
      : clamp(Math.round(rawX), area.x, Math.max(area.x, maximumX));
    const maximumY = area.y + area.height - (snapshot.position?.height ?? 0);
    const y = canShiftGroupVertically
      ? Math.round(rawY + groupShiftY)
      : clamp(Math.round(rawY), area.y, Math.max(area.y, maximumY));
    const current = visualCenter(snapshot)?.x ?? x;
    const targetCenter = x + visualOffsetX(snapshot);
    targets[id] = { x, y, direction: targetCenter >= current ? "right" : "left" };
  }

  return { targets, orderedIds, degradedReason };
}

export function allCharacterIds(): readonly CharacterId[] {
  return COORDINATION_CHARACTER_ORDER;
}
