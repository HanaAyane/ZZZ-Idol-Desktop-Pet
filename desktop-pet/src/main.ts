import { isCharacterId } from "./characters";
import type { CharacterId } from "./characters/types";
import { installFrontendDiagnostics } from "./diagnostics";

type WindowMode = "pet" | "settings" | "pomodoro";

function getWindowMode(): WindowMode {
  const mode = new URLSearchParams(window.location.search).get("window");
  return mode === "pomodoro" ? "pomodoro" : mode === "settings" ? "settings" : "pet";
}

function getPetCharacter(): CharacterId {
  const id = new URLSearchParams(window.location.search).get("character");
  return isCharacterId(id) ? id : "airui";
}

installFrontendDiagnostics(getWindowMode());

async function renderPetShell(root: HTMLElement) {
  document.documentElement.dataset.window = "pet";
  document.body.dataset.window = "pet";
  document.title = "妄想天使桌宠";
  const { PetApp } = await import("./pet/PetApp");
  const app = new PetApp(root, getPetCharacter());
  window.addEventListener("beforeunload", () => app.dispose(), { once: true });
  await app.mount();
}

async function renderSettingsShell(root: HTMLElement) {
  document.documentElement.dataset.window = "settings";
  document.body.dataset.window = "settings";
  document.title = "妄想天使桌宠 · 设置";
  const { SettingsApp } = await import("./settings/SettingsApp");
  const app = new SettingsApp(root);
  window.addEventListener("beforeunload", () => app.dispose(), { once: true });
  await app.mount();
}

window.addEventListener("DOMContentLoaded", async () => {
  const root = document.querySelector<HTMLElement>("#app");
  if (!root) throw new Error("Application root was not found.");
  if (getWindowMode() === "pomodoro") {
    document.documentElement.dataset.window = "pomodoro";
    document.body.dataset.window = "pomodoro";
    const { PomodoroApp } = await import("./pomodoro/PomodoroApp");
    const app = new PomodoroApp(root);
    window.addEventListener("beforeunload", () => app.dispose(), { once: true });
    await app.mount();
  }
  else if (getWindowMode() === "settings") void renderSettingsShell(root);
  else void renderPetShell(root);
});
