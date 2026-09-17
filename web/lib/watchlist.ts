export type WatchItem = {
  mint: string;
  symbol?: string;
  addedAt: string;
};

const KEY = "tape.watchlist.v1";
const MAX = 100;

export function loadWatchlist(): WatchItem[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "");
    const items = Array.isArray(raw?.items) ? raw.items : Array.isArray(raw) ? raw : [];
    return items
      .filter((x: WatchItem) => x && typeof x.mint === "string" && x.mint.length >= 32)
      .slice(0, MAX);
  } catch {
    return [];
  }
}

export function saveWatchlist(items: WatchItem[]) {
  if (typeof window === "undefined") return;
  localStorage.setItem(KEY, JSON.stringify({ items: items.slice(0, MAX) }));
}

export function isWatched(mint: string, items?: WatchItem[]) {
  const list = items || loadWatchlist();
  return list.some((x) => x.mint === mint);
}

export function syncWatchPins(items: WatchItem[]) {
  if (typeof window === "undefined") return;
  void fetch("/api/watch", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ items: items.slice(0, MAX) }),
  }).catch(() => null);
}

export function toggleWatch(mint: string, symbol?: string): WatchItem[] {
  const list = loadWatchlist();
  const next = list.some((x) => x.mint === mint)
    ? list.filter((x) => x.mint !== mint)
    : [{ mint, symbol, addedAt: new Date().toISOString() }, ...list].slice(0, MAX);
  saveWatchlist(next);
  syncWatchPins(next);
  return next;
}
