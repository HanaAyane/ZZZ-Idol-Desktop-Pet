import type { CharacterDefinition, CharacterId } from "../characters/types";

export interface SpecialActionDefinition {
  id: "lift";
  displayName: string;
  characterId: CharacterId;
  assetId: string;
  assetRoot: string;
  bodyAction: string;
  overlay: string;
  skin: string;
  loop: boolean;
  recoveryAction: string;
  recoveryOverlay: string;
  contactSlots: string[];
  snapDistanceCss: number;
}

interface SpecialActionCatalog {
  schemaVersion: number;
  actions: SpecialActionDefinition[];
}

let catalogPromise: Promise<SpecialActionCatalog> | null = null;

async function loadCatalog(): Promise<SpecialActionCatalog> {
  const response = await fetch("./characters/special-actions.json");
  if (!response.ok) throw new Error(`特殊动作清单加载失败：${response.status}`);
  const catalog = await response.json() as SpecialActionCatalog;
  if (catalog.schemaVersion !== 2 || !Array.isArray(catalog.actions)) {
    throw new Error("特殊动作清单格式不受支持");
  }
  for (const action of catalog.actions) {
    if (
      action.id !== "lift"
      || !action.assetId
      || !action.assetRoot
      || !action.bodyAction
      || !action.overlay
      || !Array.isArray(action.contactSlots)
      || action.contactSlots.length !== 2
      || !action.contactSlots.every((name) => typeof name === "string" && name.length > 0)
      || !Number.isFinite(action.snapDistanceCss)
      || action.snapDistanceCss < 8
    ) {
      throw new Error(`特殊动作定义无效：${action.characterId ?? "未知角色"}`);
    }
  }
  return catalog;
}

export async function getLiftAction(characterId: CharacterId): Promise<SpecialActionDefinition> {
  catalogPromise ??= loadCatalog();
  const catalog = await catalogPromise;
  const action = catalog.actions.find(
    (candidate) => candidate.id === "lift" && candidate.characterId === characterId,
  );
  if (!action) throw new Error(`缺少 ${characterId} 的托举动作定义`);
  return action;
}

export function liftCharacterDefinition(
  base: CharacterDefinition,
  action: SpecialActionDefinition,
): CharacterDefinition {
  return {
    ...base,
    assetId: action.assetId,
    assetRoot: action.assetRoot,
    preferredAction: action.bodyAction,
    preferredOverlay: action.overlay,
    preferredSkin: action.skin,
    flipX: false,
    windowLiftContactSlots: action.contactSlots,
  };
}
