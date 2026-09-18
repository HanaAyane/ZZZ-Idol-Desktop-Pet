import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { PomodoroSnapshot, Preferences } from "./model";
export const native = () => Boolean(window.__TAURI_INTERNALS__);
export const getState = () => invoke<PomodoroSnapshot>("get_pomodoro_state");
export const setVisible = (visible: boolean) => invoke<void>("set_pomodoro_visible", { visible });
export const action = (action: string, sessionId: string, preferences?: Preferences) =>
  invoke<PomodoroSnapshot>("pomodoro_action", { action, sessionId, preferences: preferences ?? null });
export async function subscribe(handler: (state: PomodoroSnapshot) => void): Promise<UnlistenFn> {
  return listen<PomodoroSnapshot>("pomodoro-state", event => handler(event.payload), {
    target: { kind: "WebviewWindow", label: getCurrentWindow().label },
  });
}
