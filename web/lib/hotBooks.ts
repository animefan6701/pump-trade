import type { Filter } from "mongodb";
import { blacklistMints, isBlacklisted, notBlacklistedMongo } from "./blacklist";
import { isDumpedCoin, notDumpedMongo } from "./dumped";
import { enrichMeltLive } from "./meltLive";
import { coins } from "./mongo";
import { hasFlag } from "./flags";
import { liveBook, liveBooks, snapFromLiveBook } from "./liveBook";
import { attachPumpLiveTape } from "./tape";
import type { CoinDoc, LaunchSnapshot } from "./types";
import { scoreAndUpsert } from "./upsert";
import { listWatchPins } from "./watchPins";

const QUOTE_MISS_EXIT = 12;

export type DeskRefreshKind = "enter" | "watch" | "migrated" | "rejected";

const running: Partial<Record<DeskRefreshKind | "liveDesk", boolean>> = {};
const lastTapeAt: Partial<Record<DeskRefreshKind, number>> = {};

export type LiveDeskAccount = { mint: string; poolAddress?: string };

export function liveDeskRefreshMs() {
  return Math.max(750, Number(process.env.LIVE_DESK_MS || 1_000));
}

export function deskRefreshMs() {
  return Math.max(1_000, Number(process.env.ENTER_REFRESH_MS || 2_000));
}

export function enterRefreshMs() {
  return deskRefreshMs();
}

function deskTapeMs(kind: DeskRefreshKind) {
  if (kind === "enter") return Math.max(8_000, Number(process.env.ENTER_TAPE_MS || 12_000));
  return Math.max(10_000, Number(process.env.HOT_TAPE_MS || 15_000));
}

function deskQuery(kind: DeskRefreshKind): Filter<CoinDoc> {
  if (kind === "enter") return { source: "live", $or: [{ flags: "enter" }, { status: "enter" }] };
  if (kind === "watch") {
    return {
      source: "live",
      $or: [{ flags: "watching" }, { status: "watching" }],
    };
  }
  if (kind === "migrated") {
    return { source: "live", $or: [{ flags: "migrated" }, { complete: true }] };
  }
  const since = new Date(Date.now() - hotMs()).toISOString();
  return {
    source: "live",
    status: "rejected",
    launchedAt: { $gte: since },
    $and: [
      { $or: [{ complete: { $ne: true } }, { marketCapUsd: { $gte: 8_000 } }, { liquidityUsd: { $gte: 80 } }] },
      notDumpedMongo(),
    ],
  };
}

function hotMs() {
  return Math.max(30, Number(process.env.HOT_BOOK_MINUTES || 360)) * 60_000;
}

function isEnter(c: CoinDoc) {
  return c.status === "enter" || (c.flags || []).includes("enter");
}

function isWatch(c: CoinDoc) {
  return c.status === "watching" || (c.flags || []).includes("watching");
}

/** Keep ENTER / WATCH / MIGRATED books on a liveBook print. */
export async function refreshHotBooks(
  seen: Set<string>,
  opts?: { enterOnly?: boolean; kind?: DeskRefreshKind },
) {
  const kind: DeskRefreshKind = opts?.kind ?? (opts?.enterOnly ? "enter" : "rejected");
  const col = await coins();
  const q = { ...deskQuery(kind), ...(await notBlacklistedMongo()) } as Filter<CoinDoc>;
  const fast = kind === "enter" || kind === "watch" || kind === "migrated";
  const freshN = fast ? 25 : 40;
  const [fresh, stale] = fast
    ? await Promise.all([
        col.find(q).sort({ updatedAt: -1 }).limit(freshN).toArray(),
        Promise.resolve([] as CoinDoc[]),
      ])
    : await Promise.all([
        col.find(q).sort({ marketCapUsd: -1, updatedAt: -1 }).limit(40).toArray(),
        Promise.resolve([] as CoinDoc[]),
      ]);

  const hot: CoinDoc[] = [];
  const got = new Set<string>();
  for (const c of [...stale, ...fresh]) {
    if (seen.has(c.mint) || got.has(c.mint)) continue;
    if (kind === "enter" && !isEnter(c)) continue;
    if (kind !== "enter" && isEnter(c)) continue;
    if (c.status === "rejected" && isDumpedCoin(c)) continue;
    got.add(c.mint);
    hot.push(c);
    if (hot.length >= 40) break;
  }

  const tapeDue = kind !== "rejected" && Date.now() - (lastTapeAt[kind] || 0) >= deskTapeMs(kind);
  const tapeCoins: CoinDoc[] = [];
  if (tapeDue) {
    const tapeGot = new Set<string>();
    for (const c of [...fresh, ...stale]) {
      if (tapeGot.has(c.mint)) continue;
      if (kind === "watch" && !isWatch(c)) continue;
      tapeGot.add(c.mint);
      tapeCoins.push(c);
      if (tapeCoins.length >= 8) break;
    }
  }

  if (!hot.length && !tapeCoins.length) return { refreshed: 0, tape: 0, staleExit: 0 };

  const rows = [...hot, ...tapeCoins.filter((c) => !hot.some((h) => h.mint === c.mint))];
  const books = await liveBooks(
    rows.map((c) => ({
      mint: c.mint,
      bondingCurve: c.poolAddress,
      complete: Boolean(c.complete || hasFlag(c, "migrated")),
      marketCapUsd: c.marketCapUsd || c.athMarketCap,
    })),
    { maxAgeMs: fast ? deskRefreshMs() : 5_000 },
  );
  const pending: LaunchSnapshot[] = [];
  for (const c of hot) {
    const book = books.get(c.mint);
    if (!book) continue;
    seen.add(c.mint);
    pending.push(snapFromLiveBook(c, book));
  }
  const byMint = new Map(pending.map((s) => [s.mint, s]));
  const needTape: LaunchSnapshot[] = [];
  for (const c of tapeCoins) {
    let snap = byMint.get(c.mint);
    if (!snap) {
      const book = books.get(c.mint);
      if (!book) continue;
      snap = snapFromLiveBook(c, book);
      pending.push(snap);
      byMint.set(c.mint, snap);
    }
    needTape.push(snap);
  }
  if (needTape.length) {
    await attachPumpLiveTape(needTape, 8);
    lastTapeAt[kind] = Date.now();
  }
  if (!fast) {
    const needMelt = pending.filter((s) => (s.holders == null || s.holders <= 2) && s.complete);
    if (needMelt.length) await enrichMeltLive(needMelt.slice(0, 4), 2);
  }
  let refreshed = 0;
  await Promise.all(
    pending.map(async (snap) => {
      const wr = await scoreAndUpsert(snap, "live");
      if (wr) refreshed += 1;
    }),
  );
  return { refreshed, tape: needTape.length, staleExit: pending.filter((s) => (s.quoteMisses || 0) >= QUOTE_MISS_EXIT).length };
}

export async function refreshDeskBooks(kind: "enter" | "watch" | "migrated") {
  if (running[kind]) return { refreshed: 0, tape: 0, staleExit: 0 };
  running[kind] = true;
  try {
    return await refreshHotBooks(new Set(), { kind });
  } finally {
    running[kind] = false;
  }
}

export async function refreshEnterBooks() {
  return refreshDeskBooks("enter");
}

export async function listLiveDeskAccounts(): Promise<LiveDeskAccount[]> {
  const blocked = await blacklistMints();
  const col = await coins();
  const pins = await listWatchPins();
  const pinMints = pins.map((p) => p.mint).filter((m) => !blocked.has(m));
  const blockedQ = blocked.size ? { mint: { $nin: [...blocked] } } : {};
  const [enters, migrated, pinned, launchlab] = await Promise.all([
    col
      .find({ source: "live", $or: [{ flags: "enter" }, { status: "enter" }], ...blockedQ })
      .project({ mint: 1, poolAddress: 1 })
      .limit(80)
      .toArray(),
    col
      .find({ source: "live", $or: [{ flags: "migrated" }, { complete: true }], ...blockedQ })
      .sort({ updatedAt: -1 })
      .limit(40)
      .project({ mint: 1, poolAddress: 1 })
      .toArray(),
    pinMints.length ? col.find({ mint: { $in: pinMints } }).project({ mint: 1, poolAddress: 1 }).toArray() : Promise.resolve([]),
    col
      .find({ source: "live", dex: "raydium-launchlab", ...blockedQ })
      .sort({ updatedAt: -1 })
      .limit(30)
      .project({ mint: 1, poolAddress: 1 })
      .toArray(),
  ]);
  const out = new Map<string, LiveDeskAccount>();
  for (const row of [...enters, ...migrated, ...pinned, ...launchlab]) {
    out.set(row.mint, { mint: row.mint, poolAddress: row.poolAddress });
  }
  for (const mint of pinMints) {
    if (!out.has(mint)) out.set(mint, { mint });
  }
  return [...out.values()];
}

export async function refreshMints(mints: string[]) {
  const blocked = await blacklistMints();
  const keep = [...new Set(mints)].filter((m) => m && !blocked.has(m)).slice(0, 80);
  if (!keep.length) return { refreshed: 0, tape: 0, staleExit: 0 };
  const rows = await (await coins()).find({ mint: { $in: keep }, source: "live" }).toArray();
  if (!rows.length) return { refreshed: 0, tape: 0, staleExit: 0 };
  const books = await liveBooks(
    rows.map((c) => ({
      mint: c.mint,
      bondingCurve: c.poolAddress,
      complete: Boolean(c.complete || hasFlag(c, "migrated")),
      marketCapUsd: c.marketCapUsd || c.athMarketCap,
    })),
    { maxAgeMs: liveDeskRefreshMs() },
  );
  const pending = rows
    .map((c) => {
      const book = books.get(c.mint);
      return book ? snapFromLiveBook(c, book) : null;
    })
    .filter((s): s is LaunchSnapshot => Boolean(s));
  let refreshed = 0;
  await Promise.all(
    pending.map(async (snap) => {
      const wr = await scoreAndUpsert(snap, "live");
      if (wr) refreshed += 1;
    }),
  );
  return { refreshed, tape: 0, staleExit: pending.filter((s) => (s.quoteMisses || 0) >= QUOTE_MISS_EXIT).length };
}

export async function refreshLiveDeskBooks() {
  if (running.liveDesk) return { refreshed: 0, tape: 0, staleExit: 0 };
  running.liveDesk = true;
  try {
    const accounts = await listLiveDeskAccounts();
    return await refreshMints(accounts.map((a) => a.mint));
  } finally {
    running.liveDesk = false;
  }
}

/** RESCORE: liveBook with Helius vault confirm. */
export async function rescoreLiveMint(mint: string) {
  if (await isBlacklisted(mint)) return null;
  const existing = await (await coins()).findOne({ mint, source: "live" });
  if (!existing) return null;
  const book = await liveBook(mint, {
    bondingCurve: existing.poolAddress,
    vault: true,
    maxAgeMs: 0,
    marketCapUsd: existing.marketCapUsd || existing.athMarketCap,
    complete: Boolean(existing.complete || hasFlag(existing, "migrated")),
  });
  if (!book) return null;
  const snap = snapFromLiveBook(existing, book);
  const wr = await scoreAndUpsert(snap, "live");
  if (!wr) return null;
  const ts = new Date().toISOString();
  return { ...wr.scored, createdAt: existing.createdAt, updatedAt: ts };
}
