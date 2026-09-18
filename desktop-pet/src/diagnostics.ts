import { invoke } from "@tauri-apps/api/core";
import { error as persistError, info as persistInfo, warn as persistWarn } from "@tauri-apps/plugin-log";

export interface DiagnosticSummary {
  generatedAt: number;
  appVersion: string;
  platform: string;
  architecture: string;
  processId: number;
  logDirectory: string;
  logFileCount: number;
  petWindowCount: number;
  visiblePetCount: number;
  singleInstanceEnabled: boolean;
}

export interface DiagnosticExportResult {
  reportPath: string;
  logDirectory: string;
  includedLogFiles: number;
  bytesWritten: number;
}

let installed = false;

export function installFrontendDiagnostics(windowMode: "pet" | "settings" | "pomodoro"): void {
  if (installed || !isNativeRuntime()) return;
  installed = true;

  const originalError = console.error.bind(console);
  const originalWarn = console.warn.bind(console);
  console.error = (...values: unknown[]) => {
    originalError(...values);
    void persistError(formatLogValues(values)).catch(() => undefined);
  };
  console.warn = (...values: unknown[]) => {
    originalWarn(...values);
    void persistWarn(formatLogValues(values)).catch(() => undefined);
  };

  window.addEventListener("error", (event) => {
    const value = event.error ?? `${event.message} at ${event.filename}:${event.lineno}:${event.colno}`;
    void persistError(`window error: ${formatLogValue(value)}`).catch(() => undefined);
  });
  window.addEventListener("unhandledrejection", (event) => {
    void persistError(`unhandled rejection: ${formatLogValue(event.reason)}`).catch(() => undefined);
  });
  void persistInfo(`frontend initialized: window=${windowMode}`).catch(() => undefined);
}

export async function getDiagnosticSummary(): Promise<DiagnosticSummary> {
  return invoke<DiagnosticSummary>("get_diagnostic_summary");
}

/** Persist only low-frequency lift transitions, not each automatic window probe. */
export function logWindowLiftStatus(characterId: string, reason: string): void {
  const message = `[window-lift] ${characterId}: ${reason}`;
  console.info(message);
  if (isNativeRuntime()) void persistInfo(message).catch(() => undefined);
}

/** Record scene transitions only; never log per-frame motion or heartbeats. */
export function logCoordinationStatus(characterId: string, event: string, details: unknown): void {
  const message = `[coordination] ${characterId}: ${event} ${formatLogValue(details)}`;
  console.info(message);
  if (isNativeRuntime()) void persistInfo(message).catch(() => undefined);
}

export async function exportDiagnosticReport(): Promise<DiagnosticExportResult> {
  return invoke<DiagnosticExportResult>("export_diagnostic_report");
}

export function formatLogValue(value: unknown): string {
  let message: string;
  if (value instanceof Error) {
    message = `${value.name}: ${value.message}${value.stack ? `\n${value.stack}` : ""}`;
  } else if (typeof value === "string") {
    message = value;
  } else {
    try {
      const seen = new WeakSet<object>();
      message = JSON.stringify(value, (_key, item: unknown) => {
        if (typeof item !== "object" || item === null) return item;
        if (seen.has(item)) return "[Circular]";
        seen.add(item);
        return item;
      });
    } catch {
      message = String(value);
    }
  }
  return redactUserPaths(message).slice(0, 12_000);
}

function formatLogValues(values: unknown[]): string {
  return values.map(formatLogValue).join(" ");
}

function redactUserPaths(message: string): string {
  return message
    .replace(/\/Users\/[^/\s]+/g, "<home>")
    .replace(/\/home\/[^/\s]+/g, "<home>")
    .replace(/[A-Za-z]:\\Users\\[^\\\s]+/g, "<home>");
}

function isNativeRuntime(): boolean {
  return Boolean(window.__TAURI_INTERNALS__);
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}
