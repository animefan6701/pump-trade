import type { Filter } from "mongodb";
import { blacklistMints, notBlacklistedMongo } from "./blacklist";
import { isDumpedCoin, notDumpedMongo } from "./dumped";
import { enrichMeltLive } from "./meltLive";
import { coins } from "./mongo";
import { altQuoteReserveUsd, attachPumpLiveTape, curveReserveUsd, fetchDexQuotes, pumpCoin } from "./tape";
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

function featNum(c: CoinDoc, key: string) {
  const v = c.features?.[key];
  return typeof v === "number" ? v : undefined;
}

function hasQuote(quote?: {
  marketCapUsd?: number;
  priceUsd?: number;
  liquidityUsd?: number;
}) {
  return quote != null && (quote.marketCapUsd != null || quote.priceUsd != null || (quote.liquidityUsd ?? 0) > 0);
}

function isEnter(c: CoinDoc) {
  return c.status === "enter" || (c.flags || []).includes("enter");
}

function isWatch(c: CoinDoc) {
  return c.status === "watching" || (c.flags || []).includes("watching");
}

function snapFromBook(
  c: CoinDoc,
  quote?: {
    priceUsd?: number;
    pairAddress?: string;
    liquidityUsd?: number;
    solUsd?: number;
    volume5m?: number;
    volume1h?: number;
    change5m?: number;
    change1h?: number;
    change6h?: number;
    buys5m?: number;
    sells5m?: number;
    marketCapUsd?: number;
    dex?: string;
  } | null,
  pump?: Awaited<ReturnType<typeof pumpCoin>>,
): LaunchSnapshot {
  const onCurve = !c.complete && !pump?.complete;
  const quoteLiq = !onCurve && (quote?.liquidityUsd ?? 0) > 0 ? quote?.liquidityUsd : undefined;
  const curveLiq =
    pump && onCurve
      ? altQuoteReserveUsd({
          quoteMint: pump.quoteMint,
          quoteDecimals: pump.quoteDecimals,
          realQuote: pump.realQuoteReserves,
          virtualQuote: pump.virtualQuoteReserves,
          quoteUsd: quote?.solUsd,
        }) ??
        pump.curveReserveUsd ??
        curveReserveUsd({
          realSolLamports: pump.realSolReserves,
          virtualSolLamports: pump.virtualSolReserves,
          solUsd: quote?.solUsd,
        })
      : undefined;
  const pumpMc = pump?.usdMarketCap;
  const mc = pumpMc || (!onCurve ? quote?.marketCapUsd : undefined) || c.marketCapUsd || 0;
  const ath = Math.max(c.athMarketCap || 0, c.marketCapUsd || 0, mc);
  let top10 = featNum(c, "top10");
  if (typeof top10 === "number" && top10 >= 0.98 && (c.holders ?? 0) >= 80) top10 = undefined;
  const insiderGraph = featNum(c, "insiderGraph");
  const quoted = hasQuote(quote || undefined) || pumpMc != null;
  return {
    mint: c.mint,
    venue: c.venue,
    dex: quote?.dex || c.dex,
    name: c.name,
    symbol: c.symbol,
    creator: c.creator,
    complete: Boolean(c.complete || pump?.complete || quote?.dex === "pumpswap" || quote?.dex === "raydium"),
    twitter: pump?.twitter || c.twitter,
    website: pump?.website || c.website,
    usdMarketCap: mc,
    priceUsd: quote?.priceUsd || (mc > 0 ? mc / 1_000_000_000 : undefined) || c.priceUsd,
    athMarketCap: ath || undefined,
    launchedAt: c.launchedAt,
    holders: c.holders,
    buyers5m: quote?.buys5m,
    sellers5m: quote?.sells5m,
    buys5m: quote?.buys5m,
    sells5m: quote?.sells5m,
    change5m: quote?.change5m ?? (onCurve ? undefined : c.change5m),
    change1h: quote?.change1h ?? (onCurve ? undefined : c.change1h),
    change6h: quote?.change6h ?? (onCurve ? undefined : c.change6h),
    reserveUsd: (onCurve ? curveLiq : quoteLiq) ?? quoteLiq ?? curveLiq ?? ((c.liquidityUsd ?? 0) > 0 ? c.liquidityUsd : undefined),
    volume5m: quote?.volume5m,
    volume1h: quote?.volume1h,
    realSolReserves: pump?.realSolReserves,
    poolAddress: quote?.pairAddress || pump?.poolAddress || c.poolAddress,
    top10HoldPct: top10,
    devHoldPct: featNum(c, "devHold"),
    curveHoldPct: featNum(c, "curveHold"),
    bundleHoldPct: featNum(c, "bundle"),
    replyCount: featNum(c, "replies") ?? 0,
    launchSnipers: c.launchSnipers,
    quoteMisses: quoted ? 0 : (c.quoteMisses || 0) + 1,
    tape: {
      buyCount: quote?.buys5m,
      sellCount: quote?.sells5m,
    },
    melt: {
      insiderGraph: insiderGraph,
      bundleHoldPct: featNum(c, "bundle") ?? null,
    },
  };
}

/** Keep ENTER / WATCH / MIGRATED books on a fresh Dex quote. */
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

  const quoteAge = fast ? { maxAgeMs: deskRefreshMs() } : undefined;
  const quotes = await fetchDexQuotes(
    [...new Set([...hot, ...tapeCoins].map((c) => c.mint))],
    quoteAge,
  );
  const needPump = hot;
  const pumps = new Map<string, Awaited<ReturnType<typeof pumpCoin>>>();
  await Promise.all(
    needPump.map(async (c) => {
      pumps.set(c.mint, await pumpCoin(c.mint, quoteAge).catch(() => null));
    }),
  );
  const pending: LaunchSnapshot[] = [];
  for (const c of hot) {
    const quote = quotes.get(c.mint);
    const quoted = hasQuote(quote);
    seen.add(c.mint);
    pending.push(snapFromBook(c, quoted ? quote : null, pumps.get(c.mint) || null));
  }
  const byMint = new Map(pending.map((s) => [s.mint, s]));
  const needTape: LaunchSnapshot[] = [];
  for (const c of tapeCoins) {
    let snap = byMint.get(c.mint);
    if (!snap) {
      snap = snapFromBook(c, hasQuote(quotes.get(c.mint)) ? quotes.get(c.mint) : null, null);
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
  const [enters, migrated, pinned] = await Promise.all([
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
  ]);
  const out = new Map<string, LiveDeskAccount>();
  for (const row of [...enters, ...migrated, ...pinned]) {
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
  const quoteAge = { maxAgeMs: liveDeskRefreshMs() };
  const quotes = await fetchDexQuotes(rows.map((c) => c.mint), quoteAge);
  const pumps = new Map<string, Awaited<ReturnType<typeof pumpCoin>>>();
  await Promise.all(
    rows.map(async (c) => {
      pumps.set(c.mint, await pumpCoin(c.mint, quoteAge).catch(() => null));
    }),
  );
  const pending = rows.map((c) => snapFromBook(c, hasQuote(quotes.get(c.mint)) ? quotes.get(c.mint) : null, pumps.get(c.mint) || null));
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
