import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { AppSettings } from "../settings/appSettings";
import type {
  CoordinationCancelledEvent,
  CoordinationCommand,
  CoordinationSnapshot,
} from "../pet/coordinationTypes";

export const APP_SETTINGS_STATE = "app-settings-state";
export const PET_COORDINATION_COMMAND = "pet-coordination-command";
export const PET_COORDINATION_CANCELLED = "pet-coordination-cancelled";
export const COORDINATION_STATE = "pet-coordination-state";

type EventPayloadMap = {
  [APP_SETTINGS_STATE]: AppSettings;
  [PET_COORDINATION_COMMAND]: CoordinationCommand;
  [PET_COORDINATION_CANCELLED]: CoordinationCancelledEvent;
  [COORDINATION_STATE]: CoordinationSnapshot;
};

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

function isTauriRuntime(): boolean {
  return Boolean(window.__TAURI_INTERNALS__);
}

export async function listenAppEvent<K extends keyof EventPayloadMap>(
  eventName: K,
  handler: (payload: EventPayloadMap[K]) => void,
): Promise<UnlistenFn> {
  if (isTauriRuntime()) {
    // An Any listener receives emit_to calls for OTHER windows too. Binding to
    // this label keeps per-pet commands single-delivery; app broadcasts still
    // reach every window's listener.
    return listen<EventPayloadMap[K]>(eventName, (event) => handler(event.payload), {
      target: { kind: "WebviewWindow", label: getCurrentWindow().label },
    });
  }
  const listener = (event: Event) => handler((event as CustomEvent<EventPayloadMap[K]>).detail);
  window.addEventListener(eventName, listener);
  return () => window.removeEventListener(eventName, listener);
}
