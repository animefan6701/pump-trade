export type NoticeKind = "enter" | "dump";

export type EntryNotice = {
  mint: string;
  symbol: string;
  name?: string;
  at: string;
  read: boolean;
  kind?: NoticeKind;
  rugProb?: number;
  entryProb?: number;
  exitProb?: number;
  minRatio?: number;
  change5m?: number;
  marketCapUsd?: number;
  athMarketCap?: number;
};

export type NoticeStore = {
  seen: string[];
  dumpSeen: string[];
  items: EntryNotice[];
};

import { isDumpedCoin } from "./dumpCheck";

export type EnterRow = {
  mint?: string;
  symbol?: string;
  name?: string;
  status?: string;
  flags?: string[];
  rugProb?: number;
  entryProb?: number;
  exitProb?: number;
  minRatio?: number;
  athMarketCap?: number;
  marketCapUsd?: number;
  change5m?: number;
  change1h?: number;
  change6h?: number;
  updatedAt?: string;
  reasons?: string[];
  complete?: boolean;
  launchedAt?: string;
  volume5m?: number;
};

const ENTER_FRESH_MS = 12 * 60_000;

const KEY = "tape.entryNotices.v1";

export function emptyNotices(): NoticeStore {
  return { seen: [], dumpSeen: [], items: [] };
}

export function scorePct(value: unknown): string {
  const n = Number(value);
  return Number.isFinite(n) ? `${Math.round(100 * n)}%` : "—";
}

export function unreadCount(items: EntryNotice[]): number {
  return items.filter((n) => !n.read).length;
}

export function loadNotices(): NoticeStore {
  if (typeof window === "undefined") return emptyNotices();
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "");
    if (!raw || !Array.isArray(raw.seen) || !Array.isArray(raw.items)) return emptyNotices();
    return {
      seen: raw.seen.filter((x: unknown) => typeof x === "string").slice(-500),
      dumpSeen: (Array.isArray(raw.dumpSeen) ? raw.dumpSeen : []).filter((x: unknown) => typeof x === "string").slice(-500),
      items: raw.items
        .filter((x: EntryNotice) => x && typeof x.mint === "string")
        .slice(0, 50),
    };
  } catch {
    return emptyNotices();
  }
}

export function saveNotices(store: NoticeStore): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(KEY, JSON.stringify({
      seen: store.seen.slice(-500),
      dumpSeen: (store.dumpSeen || []).slice(-500),
      items: store.items.slice(0, 50),
    }));
  } catch {
    /* ignore quota */
  }
}

export function isLiveEnter(row: EnterRow): boolean {
  if (!row.mint) return false;
  if (!(row.status === "enter" || (Array.isArray(row.flags) && row.flags.includes("enter")))) return false;
  if (isDumpedCoin(row)) return false;
  if ((row.reasons || []).some((r) => /held enter|creator already sold|insider graph/i.test(r))) {
    return false;
  }
  if (row.updatedAt) {
    const age = Date.now() - new Date(row.updatedAt).getTime();
    if (Number.isFinite(age) && age > ENTER_FRESH_MS) return false;
  }
  const launched = row.launchedAt ? Date.now() - new Date(row.launchedAt).getTime() : 0;
  if (row.complete && Number.isFinite(launched) && launched > 90 * 60_000 && (row.volume5m ?? 0) < 50) {
    return false;
  }
  return true;
}

function toNotice(row: EnterRow, kind: NoticeKind = "enter"): EntryNotice {
  return {
    mint: row.mint!,
    symbol: row.symbol || row.name || row.mint!.slice(0, 6),
    name: row.name,
    at: new Date().toISOString(),
    read: false,
    kind,
    rugProb: row.rugProb,
    entryProb: row.entryProb,
    exitProb: row.exitProb,
    minRatio: row.minRatio,
    change5m: row.change5m,
    marketCapUsd: row.marketCapUsd,
    athMarketCap: row.athMarketCap,
  };
}

export function dumpLine(n: EntryNotice): string {
  const bits: string[] = [];
  if (typeof n.change5m === "number") bits.push(`5m ${Math.round(n.change5m)}%`);
  if (typeof n.minRatio === "number") bits.push(`${Math.round(100 * n.minRatio)}% ATH`);
  bits.push(`EXIT ${scorePct(n.exitProb)}`);
  return bits.join(" · ");
}

export function pushEntries(store: NoticeStore, rows: EnterRow[]): { next: NoticeStore; fresh: EntryNotice[] } {
  const seen = new Set(store.seen);
  const items = [...store.items];
  const fresh: EntryNotice[] = [];
  const enters = rows.filter(isLiveEnter);

  if (items.length === 0) {
    for (const row of enters) seen.add(row.mint!);
    return { next: { seen: [...seen].slice(-500), dumpSeen: store.dumpSeen || [], items }, fresh: [] };
  }

  for (const row of enters) {
    if (seen.has(row.mint!)) {
      const existing = items.find((n) => n.mint === row.mint && (n.kind || "enter") === "enter");
      if (existing) {
        existing.rugProb = row.rugProb;
        existing.entryProb = row.entryProb;
        existing.exitProb = row.exitProb;
      }
      continue;
    }
    seen.add(row.mint!);
    const note = toNotice(row, "enter");
    items.unshift(note);
    fresh.push(note);
  }
  return { next: { seen: [...seen].slice(-500), dumpSeen: store.dumpSeen || [], items: items.slice(0, 50) }, fresh };
}

export function pushDumps(store: NoticeStore, rows: EnterRow[]): { next: NoticeStore; fresh: EntryNotice[] } {
  const dumpSeen = new Set(store.dumpSeen || []);
  const items = [...store.items];
  const fresh: EntryNotice[] = [];
  for (const row of rows) {
    if (!row.mint || !isDumpedCoin(row)) continue;
    if (dumpSeen.has(row.mint)) continue;
    dumpSeen.add(row.mint);
    const note = toNotice(row, "dump");
    items.unshift(note);
    fresh.push(note);
  }
  return {
    next: { seen: store.seen || [], dumpSeen: [...dumpSeen].slice(-500), items: items.slice(0, 50) },
    fresh,
  };
}
