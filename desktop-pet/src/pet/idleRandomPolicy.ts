export function chooseIdleRandomAction(
  actions: readonly string[],
  availableActions: readonly string[],
  lastAction: string,
  random: () => number = Math.random,
): string | null {
  const available = actions.filter((action) => availableActions.includes(action));
  if (available.length === 0) return null;
  const candidates = lastAction && available.length > 1
    ? available.filter((action) => action !== lastAction)
    : available;
  const index = Math.min(candidates.length - 1, Math.floor(Math.max(0, random()) * candidates.length));
  return candidates[index] ?? null;
}

export function chooseIdleRandomDelay(
  delayMs: readonly [number, number],
  random: () => number = Math.random,
): number {
  const min = Math.max(0, Math.min(delayMs[0], delayMs[1]));
  const max = Math.max(min, Math.max(delayMs[0], delayMs[1]));
  return Math.round(min + Math.max(0, Math.min(1, random())) * (max - min));
}
