export interface Preferences { focusMinutes: number; breakMinutes: number; defaultRounds: number; soundEnabled: boolean; volume: number }
export interface PomodoroSnapshot {
  version: number; sessionId: string; revision: number; phase: string; paused: boolean;
  remainingMs: number; durationMs: number; completedRounds: number; totalRounds: number;
  focusMs: number; breakMs: number; preferences: Preferences; notice: string;
  windowVisible: boolean; persistenceError: string | null; audioError: string | null;
}
export function formatTime(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
}
export function isActive(s: PomodoroSnapshot): boolean { return s.phase === "focus" || s.phase === "break"; }
export function phaseLabel(s: PomodoroSnapshot): string {
  if (isActive(s)) return `${s.phase === "focus" ? "专注" : "休息"}${s.paused ? "已暂停" : "中"}`;
  return ({ idle: "准备专注", completed: "全部完成", stopped: "本组已结束" })[s.phase] ?? "准备专注";
}
export function validPreferences(p: Preferences): boolean {
  return [[p.focusMinutes, 1, 180], [p.breakMinutes, 1, 60], [p.defaultRounds, 1, 99], [p.volume, 0, 100]]
    .every(([v, min, max]) => Number.isInteger(v) && v >= min && v <= max);
}
export function plannedMinutes(p: Preferences): number { return p.defaultRounds * p.focusMinutes + (p.defaultRounds - 1) * p.breakMinutes; }
