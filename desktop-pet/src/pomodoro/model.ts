export type TimerMode = "pomodoro" | "custom";
export interface Preferences {
  mode: TimerMode; customMinutes: number; reminderMinutes: number[];
  focusMinutes: number; breakMinutes: number; defaultRounds: number; soundEnabled: boolean; volume: number;
}
export interface PomodoroSnapshot {
  version: number; mode: TimerMode; reminderMinutes: number[]; nextReminderIndex: number;
  sessionId: string; revision: number; phase: string; paused: boolean;
  remainingMs: number; durationMs: number; completedRounds: number; totalRounds: number;
  focusMs: number; breakMs: number; preferences: Preferences; notice: string;
  windowVisible: boolean; persistenceError: string | null; audioError: string | null;
}
export function formatTime(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
}
export function isActive(s: PomodoroSnapshot): boolean { return ["focus", "break", "custom"].includes(s.phase); }
export function phaseLabel(s: PomodoroSnapshot): string {
  if (isActive(s)) return `${s.phase === "custom" ? "计时" : s.phase === "focus" ? "专注" : "休息"}${s.paused ? "已暂停" : "中"}`;
  return ({ idle: s.preferences.mode === "custom" ? "准备计时" : "准备专注", completed: "全部完成", stopped: "本次已结束" })[s.phase] ?? "准备专注";
}
export function reminderError(total: number, reminders: number[]): string {
  if (!Number.isInteger(total) || total < 1 || total > 720) return "总时长须为 1～720 分钟。";
  if (reminders.length > 64) return "最多设置 64 个提醒时间点。";
  if (reminders.some(m => !Number.isInteger(m) || m <= 0 || m >= total)) return "提醒须为大于 0 且小于总时长的整数分钟；结束时会自动提醒。";
  if (new Set(reminders).size !== reminders.length) return "提醒时间点不可重复。";
  return "";
}
export function preferencesError(p: Preferences): string {
  if (p.mode !== "pomodoro" && p.mode !== "custom") return "请选择计时模式。";
  if (![[p.focusMinutes, 1, 180], [p.breakMinutes, 1, 60], [p.defaultRounds, 1, 99], [p.volume, 0, 100]]
    .every(([v, min, max]) => Number.isInteger(v) && v >= min && v <= max)) return "个数 1～99，专注 1～180 分钟，休息 1～60 分钟，音量 0～100。";
  return reminderError(p.customMinutes, p.reminderMinutes);
}
export function validPreferences(p: Preferences): boolean { return !preferencesError(p); }
export function plannedMinutes(p: Preferences): number {
  return p.mode === "custom" ? p.customMinutes : p.defaultRounds * p.focusMinutes + (p.defaultRounds - 1) * p.breakMinutes;
}
export function customSummary(s: PomodoroSnapshot): string {
  const elapsed = Math.max(0, s.durationMs - s.remainingMs);
  const next = s.reminderMinutes[s.nextReminderIndex];
  if (s.phase === "completed" || s.phase === "stopped") return `已用 ${formatTime(elapsed)} · 已提醒 ${s.nextReminderIndex} 次`;
  return next === undefined ? `已用 ${formatTime(elapsed)} · 结束时提醒` : `已用 ${formatTime(elapsed)} · 第 ${next} 分钟提醒\n还有 ${formatTime(Math.max(0, next * 60_000 - elapsed))}`;
}
