import { invoke } from "@tauri-apps/api/core";
import type { CharacterId } from "../characters/types";
import type { CoordinationSnapshot } from "../pet/coordinationTypes";

export type PerformanceMode = "quality" | "balanced" | "saving";
export type FrameRateMode = "auto" | "60" | "30";

export interface CoordinationSettings {
  enabled: boolean;
  partnerGaze: boolean;
  reactionEcho: boolean;
  automaticScenes: boolean;
}

export interface SavedPlacement {
  x: number;
  y: number;
  monitorName: string | null;
}

export interface PetInstanceSettings {
  visible: boolean;
  scale: number;
  lastPlacement: SavedPlacement | null;
}

export type PetSettingsMap = Record<CharacterId, PetInstanceSettings>;

export interface AppSettings {
  schemaVersion: number;
  pets: PetSettingsMap;
  alwaysOnTop: boolean;
  autoWalk: boolean;
  walkFrequency: number;
  movementSpeed: number;
  clickEnabled: boolean;
  doubleClickEnabled: boolean;
  hoverEnabled: boolean;
  gazeTracking: boolean;
  windowLiftEnabled: boolean;
  autoWindowLiftEnabled: boolean;
  performanceMode: PerformanceMode;
  frameRate: FrameRateMode;
  debugMode: boolean;
  launchAtLogin: boolean;
  coordination: CoordinationSettings;
}

export type AppSettingsPatch = Partial<Omit<AppSettings, "schemaVersion" | "pets">>;
export type PetInstanceSettingsPatch = Partial<PetInstanceSettings>;

export const DEFAULT_APP_SETTINGS: AppSettings = {
  schemaVersion: 6,
  pets: {
    airui: { visible: true, scale: 1, lastPlacement: null },
    nangong: { visible: true, scale: 1, lastPlacement: null },
    qianxia: { visible: true, scale: 1, lastPlacement: null },
  },
  alwaysOnTop: true,
  autoWalk: true,
  walkFrequency: 1,
  movementSpeed: 1,
  clickEnabled: true,
  doubleClickEnabled: true,
  hoverEnabled: true,
  gazeTracking: true,
  windowLiftEnabled: false,
  autoWindowLiftEnabled: false,
  performanceMode: "balanced",
  frameRate: "auto",
  debugMode: false,
  launchAtLogin: false,
  coordination: {
    enabled: true,
    partnerGaze: true,
    reactionEcho: true,
    automaticScenes: false,
  },
};

export function isNativeRuntime(): boolean {
  return Boolean(window.__TAURI_INTERNALS__);
}

export async function getAppSettings(): Promise<AppSettings> {
  if (!isNativeRuntime()) return { ...DEFAULT_APP_SETTINGS };
  return invoke<AppSettings>("get_app_settings");
}

export async function updateAppSettings(patch: AppSettingsPatch): Promise<AppSettings> {
  if (!isNativeRuntime()) {
    return {
      ...DEFAULT_APP_SETTINGS,
      ...patch,
      coordination: { ...DEFAULT_APP_SETTINGS.coordination, ...patch.coordination },
    };
  }
  return invoke<AppSettings>("update_app_settings", { patch });
}

export async function updatePetSettings(
  id: CharacterId,
  patch: PetInstanceSettingsPatch,
): Promise<AppSettings> {
  if (!isNativeRuntime()) {
    return {
      ...DEFAULT_APP_SETTINGS,
      pets: {
        ...DEFAULT_APP_SETTINGS.pets,
        [id]: { ...DEFAULT_APP_SETTINGS.pets[id], ...patch },
      },
    };
  }
  return invoke<AppSettings>("update_pet_settings", { id, patch });
}

export async function arrangePetGroup(
  mode: "gather" | "disperse",
  anchorCharacterId: CharacterId | null = null,
): Promise<CoordinationSnapshot | null> {
  if (!isNativeRuntime()) return null;
  return invoke<CoordinationSnapshot>("arrange_pet_group", { mode, anchorCharacterId });
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}
