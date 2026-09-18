import { AIRUI } from "./airui";
import { NANGONG } from "./nangong";
import { QIANXIA } from "./qianxia";
import type { CharacterDefinition, CharacterId } from "./types";

export const CHARACTERS = [AIRUI, NANGONG, QIANXIA] as const;

export const CHARACTER_BY_ID: Readonly<Record<CharacterId, CharacterDefinition>> = {
  airui: AIRUI,
  nangong: NANGONG,
  qianxia: QIANXIA,
};

export function isCharacterId(value: unknown): value is CharacterId {
  return typeof value === "string" && value in CHARACTER_BY_ID;
}
