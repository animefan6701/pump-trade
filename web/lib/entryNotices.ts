export type EntryNotice = {
  mint: string;
  symbol: string;
  name?: string;
  at: string;
  read: boolean;
  rugProb?: number;
  entryProb?: number;
  exitProb?: number;
};

export type NoticeStore = {
  seen: string[];
  items: EntryNotice[];
};

export type EnterRow = {
  mint?: string;
  symbol?: string;
  name?: string;
  status?: string;
  flags?: string[];
  rugProb?: number;
  entryProb?: number;
  exitProb?: number;
};

const KEY = "tape.entryNotices.v1";

export function emptyNotices(): NoticeStore {
  return { seen: [], items: [] };
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
      items: raw.items
        .filter((x: EntryNotice) => x && typeof x.mint === "string")
        .slice(0, 40),
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
      items: store.items.slice(0, 40),
    }));
  } catch {
    /* ignore quota */
  }
}

function isEnter(row: EnterRow): boolean {
  return !!row.mint && (row.status === "enter" || (Array.isArray(row.flags) && row.flags.includes("enter")));
}

function toNotice(row: EnterRow): EntryNotice {
  return {
    mint: row.mint!,
    symbol: row.symbol || row.name || row.mint!.slice(0, 6),
    name: row.name,
    at: new Date().toISOString(),
    read: false,
    rugProb: row.rugProb,
    entryProb: row.entryProb,
    exitProb: row.exitProb,
  };
}

export function pushEntries(store: NoticeStore, rows: EnterRow[]): { next: NoticeStore; fresh: EntryNotice[] } {
  const seen = new Set(store.seen);
  const items = [...store.items];
  const fresh: EntryNotice[] = [];
  const enters = rows.filter(isEnter);

  if (items.length === 0) {
    for (const row of enters) {
      seen.add(row.mint!);
      const note = toNotice(row);
      items.unshift(note);
      fresh.push(note);
    }
    return { next: { seen: [...seen].slice(-500), items: items.slice(0, 40) }, fresh };
  }

  for (const row of enters) {
    if (seen.has(row.mint!)) {
      const existing = items.find((n) => n.mint === row.mint);
      if (existing) {
        existing.rugProb = row.rugProb;
        existing.entryProb = row.entryProb;
        existing.exitProb = row.exitProb;
      }
      continue;
    }
    seen.add(row.mint!);
    const note = toNotice(row);
    items.unshift(note);
    fresh.push(note);
  }
  return { next: { seen: [...seen].slice(-500), items: items.slice(0, 40) }, fresh };
}
