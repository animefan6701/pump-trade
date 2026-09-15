import type { CoinStatus } from "./types";

export type DeskStats = {
  total: number;
  rejected: number;
  watching: number;
  enter: number;
  exit: number;
  migrated: number;
  live: number;
  paper: number;
  asOf: string;
};

export function emptyDeskStats(): DeskStats {
  return {
    total: 0,
    rejected: 0,
    watching: 0,
    enter: 0,
    exit: 0,
    migrated: 0,
    live: 0,
    paper: 0,
    asOf: new Date(0).toISOString(),
  };
}

export function bumpDeskStats(
  prev: DeskStats | null,
  from: CoinStatus | undefined,
  to: CoinStatus,
  inserted = false,
): DeskStats | null {
  if (!prev) return prev;
  const next = { ...prev, asOf: new Date().toISOString() };
  if (inserted) {
    next.total += 1;
    next.live += 1;
    next[to] += 1;
    return next;
  }
  if (from && from !== to) {
    next[from] = Math.max(0, next[from] - 1);
    next[to] += 1;
  }
  return next;
}
