import { heliusCurves, heliusLiveBook, heliusOwnerQuoteUsd, heliusReserveUsd, type HeliusCurve } from "./heliusBook";
import { fetchDexQuotes, fetchGeckoQuote, fetchLaunchMint, fetchLaunchMints, fetchSolUsd, pumpCoin, quoteIsSol, stableQuoteUsd } from "./tape";
import type { CoinDoc, DexBook, LaunchSnapshot, LiveBook, PumpBook } from "./types";

export type LiveBookHint = {
  mint: string;
  bondingCurve?: string;
  complete?: boolean;
  marketCapUsd?: number;
};

function featNum(c: CoinDoc, key: string) {
  const v = c.features?.[key];
  return typeof v === "number" ? v : undefined;
}

function asPumpBook(mint: string, raw: Awaited<ReturnType<typeof pumpCoin>>): PumpBook | null {
  if (!raw) return null;
  return {
    mint,
    name: raw.name,
    symbol: raw.symbol,
    complete: Boolean(raw.complete),
    bondingCurve: raw.bondingCurve,
    swapPool: raw.swapPool,
    poolAddress: raw.poolAddress,
    quoteMint: raw.quoteMint,
    quoteDecimals: raw.quoteDecimals ?? (quoteIsSol(raw.quoteMint) ? 9 : 6),
    usdMarketCap: raw.usdMarketCap,
    athMarketCap: raw.athMarketCap,
    solUsd: raw.solUsd,
    twitter: raw.twitter,
    website: raw.website,
    realQuoteReserves: raw.realQuoteReserves,
    realSolReserves: raw.realSolReserves,
  };
}

function asDexBook(q: {
  pairAddress?: string;
  dex?: string;
  name?: string;
  symbol?: string;
  twitter?: string;
  priceUsd?: number;
  marketCapUsd?: number;
  liquidityUsd?: number;
  solUsd?: number;
  volume5m?: number;
  volume1h?: number;
  change5m?: number;
  change1h?: number;
  change6h?: number;
  buys5m?: number;
  sells5m?: number;
}): DexBook {
  return {
    pairAddress: q.pairAddress,
    dex: q.dex,
    name: q.name,
    symbol: q.symbol,
    twitter: q.twitter,
    priceUsd: q.priceUsd,
    marketCapUsd: q.marketCapUsd,
    liquidityUsd: q.liquidityUsd,
    solUsd: q.solUsd,
    volume5m: q.volume5m,
    volume1h: q.volume1h,
    change5m: q.change5m,
    change1h: q.change1h,
    change6h: q.change6h,
    buys5m: q.buys5m,
    sells5m: q.sells5m,
  };
}

/** On-curve LP = real quote × 2. Virtual k is never LP. */
function curveLp(pump: PumpBook | null, curve?: HeliusCurve): { reserveUsd: number; source: LiveBook["lpSource"]; raw: number } {
  const quoteMint = curve?.quoteMint || pump?.quoteMint;
  const dec = curve?.quoteDecimals ?? pump?.quoteDecimals ?? (quoteIsSol(quoteMint) ? 9 : 6);
  const raw = curve?.realQuote ?? pump?.realQuoteReserves ?? pump?.realSolReserves;
  if (raw == null) return { reserveUsd: 0, source: curve ? "helius" : pump ? "pump" : "none", raw: 0 };
  if (curve) {
    const usd = heliusReserveUsd({
      realQuote: raw,
      quoteMint,
      quoteDecimals: dec,
      solUsd: pump?.solUsd,
    });
    if (usd !== undefined) return { reserveUsd: usd, source: "helius", raw };
  }
  if (quoteIsSol(quoteMint)) {
    const px = pump?.solUsd;
    const sol = raw / 1e9;
    return { reserveUsd: px && px >= 10 && px <= 5_000 && sol > 0 ? sol * 2 * px : 0, source: pump ? "pump" : "none", raw };
  }
  const px = stableQuoteUsd(quoteMint);
  if (!px) return { reserveUsd: 0, source: pump ? "pump" : "none", raw };
  const units = raw / 10 ** dec;
  return { reserveUsd: units > 0 ? units * 2 * px : 0, source: pump ? "pump" : "none", raw };
}

function offCurve(pump: PumpBook | null, hintComplete?: boolean) {
  return Boolean(pump?.complete || pump?.swapPool || hintComplete);
}

function mergeBook(
  mint: string,
  pump: PumpBook | null,
  curve: HeliusCurve | undefined,
  dex: DexBook | undefined,
  lastMc?: number,
  hintComplete?: boolean,
): LiveBook {
  const complete = Boolean(pump?.complete || pump?.swapPool || hintComplete || curve?.complete);
  const onCurve = Boolean(pump) && !offCurve(pump, hintComplete);
  const liveMc = pump?.usdMarketCap || dex?.marketCapUsd;
  const mc = liveMc || lastMc || 0;
  const lp = onCurve
    ? curveLp(pump, curve)
    : {
        reserveUsd: dex?.liquidityUsd && dex.liquidityUsd > 0 ? dex.liquidityUsd : 0,
        source: (dex?.liquidityUsd && dex.liquidityUsd > 0 ? "dex" : "none") as LiveBook["lpSource"],
        raw: 0,
      };
  const priceUsd =
    (!onCurve ? dex?.priceUsd : undefined) ||
    (mc > 0 ? mc / 1_000_000_000 : undefined);
  return {
    mint,
    complete,
    onCurve,
    usdMarketCap: mc,
    priceUsd,
    athMarketCap: Math.max(pump?.athMarketCap || 0, mc) || undefined,
    reserveUsd: lp.reserveUsd,
    realQuoteReserves: curve?.realQuote ?? pump?.realQuoteReserves,
    realSolReserves: onCurve && quoteIsSol(pump?.quoteMint || curve?.quoteMint) ? (curve?.realQuote ?? pump?.realSolReserves) : undefined,
    quoteMint: curve?.quoteMint || pump?.quoteMint,
    quoteDecimals: curve?.quoteDecimals ?? pump?.quoteDecimals,
    bondingCurve: pump?.bondingCurve || curve?.bondingCurve,
    poolAddress: onCurve
      ? pump?.bondingCurve || curve?.bondingCurve || pump?.poolAddress
      : dex?.pairAddress || pump?.swapPool || pump?.poolAddress,
    name: pump?.name || dex?.name,
    symbol: pump?.symbol || dex?.symbol,
    creator: pump?.creator,
    twitter: pump?.twitter || dex?.twitter,
    website: pump?.website,
    dex: onCurve ? "pumpfun" : dex?.dex,
    volume5m: onCurve ? undefined : dex?.volume5m,
    volume1h: onCurve ? undefined : dex?.volume1h,
    change5m: onCurve ? undefined : dex?.change5m,
    change1h: onCurve ? undefined : dex?.change1h,
    change6h: onCurve ? undefined : dex?.change6h,
    buys5m: onCurve ? undefined : dex?.buys5m,
    sells5m: onCurve ? undefined : dex?.sells5m,
    lpSource: lp.source,
    mcSource: pump?.usdMarketCap ? "pump" : dex?.marketCapUsd ? "dex" : "none",
  };
}

/** One mint. Vault confirm on Helius when `vault` (RESCORE / accordion). */
export async function liveBook(
  mint: string,
  hint?: { bondingCurve?: string; vault?: boolean; maxAgeMs?: number; marketCapUsd?: number; complete?: boolean },
): Promise<LiveBook | null> {
  const pump = asPumpBook(mint, await pumpCoin(mint, { maxAgeMs: hint?.maxAgeMs ?? 0 }).catch(() => null));
  const migrated = offCurve(pump, hint?.complete);
  const bonding = pump?.bondingCurve || hint?.bondingCurve;
  let dex: DexBook | undefined;
  if (migrated || !pump) {
    const quotes = await fetchDexQuotes([mint], { maxAgeMs: hint?.maxAgeMs ?? 0 }).catch(() => new Map());
    const q = quotes.get(mint);
    if (q) dex = asDexBook(q);
    if (!dex) {
      const launch = await fetchLaunchMint(mint, { maxAgeMs: hint?.maxAgeMs ?? 0 }).catch(() => null);
      if (launch) {
        let liq = launch.liquidityUsd;
        if (launch.pairAddress) {
          const solUsd = await fetchSolUsd({ maxAgeMs: hint?.maxAgeMs ?? 0 }).catch(() => undefined);
          liq = (await heliusOwnerQuoteUsd(launch.pairAddress, { quoteMint: launch.quoteMint, solUsd }).catch(() => undefined)) ?? liq;
        }
        dex = asDexBook({ ...launch, liquidityUsd: liq });
      }
    }
    if (!dex) {
      const g = await fetchGeckoQuote(mint, hint?.bondingCurve, { maxAgeMs: hint?.maxAgeMs ?? 0 }).catch(() => null);
      if (g) dex = asDexBook(g);
    }
  }
  let curve: HeliusCurve | undefined;
  if (!migrated && bonding) {
    curve = hint?.vault
      ? (await heliusLiveBook({
          bondingCurve: bonding,
          quoteMint: pump?.quoteMint,
          quoteDecimals: pump?.quoteDecimals,
          solUsd: pump?.solUsd,
        }).catch(() => null)) || undefined
      : (await heliusCurves([bonding]).catch(() => new Map())).get(bonding);
  }
  if (!pump && !curve && !dex && hint?.marketCapUsd == null) return null;
  return mergeBook(mint, pump, curve, dex, hint?.marketCapUsd, hint?.complete);
}

/** Batch book for the 1s loop / rejected rescore. Dex/Gecko when migrated or Pump miss. */
export async function liveBooks(
  hints: LiveBookHint[],
  opts?: { maxAgeMs?: number },
): Promise<Map<string, LiveBook>> {
  const out = new Map<string, LiveBook>();
  const uniq = [...new Map(hints.map((h) => [h.mint, h])).values()];
  if (!uniq.length) return out;
  const age = { maxAgeMs: opts?.maxAgeMs ?? 1_000 };
  const pumps = new Map<string, PumpBook | null>();
  await Promise.all(
    uniq.map(async (h) => {
      pumps.set(h.mint, asPumpBook(h.mint, await pumpCoin(h.mint, age).catch(() => null)));
    }),
  );
  const needDex = uniq.filter((h) => offCurve(pumps.get(h.mint) || null, h.complete) || !pumps.get(h.mint));
  const quotes = needDex.length
    ? await fetchDexQuotes(needDex.map((h) => h.mint), age).catch(() => new Map())
    : new Map();
  const launchNeed = needDex.filter((h) => !quotes.get(h.mint)).map((h) => h.mint);
  const launches = launchNeed.length ? await fetchLaunchMints(launchNeed, age).catch(() => new Map()) : new Map();
  for (const [mint, q] of launches) quotes.set(mint, q);
  const needLp = [...launches.values()].filter((q) => q.pairAddress && !(q.liquidityUsd && q.liquidityUsd > 0)).slice(0, 4);
  if (needLp.length) {
    const solUsd = await fetchSolUsd(age).catch(() => undefined);
    await Promise.all(
      needLp.map(async (q) => {
        const liq = await heliusOwnerQuoteUsd(q.pairAddress, { quoteMint: q.quoteMint, solUsd }).catch(() => undefined);
        if (liq && liq > 0) quotes.set(q.mint, { ...q, liquidityUsd: liq });
      }),
    );
  }
  const geckoNeed = needDex.filter((h) => !quotes.get(h.mint)).slice(0, 1);
  await Promise.all(
    geckoNeed.map(async (h) => {
      const g = await fetchGeckoQuote(h.mint, h.bondingCurve, age).catch(() => null);
      if (g) quotes.set(h.mint, g);
    }),
  );
  const curveKeys = uniq
    .map((h) => {
      const p = pumps.get(h.mint);
      if (offCurve(p || null, h.complete)) return "";
      return p?.bondingCurve || h.bondingCurve || "";
    })
    .filter(Boolean);
  const onChain = await heliusCurves(curveKeys).catch(() => new Map());
  for (const h of uniq) {
    const pump = pumps.get(h.mint) || null;
    const key = pump?.bondingCurve || h.bondingCurve;
    const migratedMint = offCurve(pump, h.complete);
    const curve = !migratedMint && key ? onChain.get(key) : undefined;
    const q = quotes.get(h.mint);
    const dex = q && (migratedMint || !pump) ? asDexBook(q) : undefined;
    out.set(h.mint, mergeBook(h.mint, pump, curve, dex, h.marketCapUsd, h.complete));
  }
  return out;
}

export function snapFromLiveBook(c: CoinDoc, book: LiveBook): LaunchSnapshot {
  let top10 = featNum(c, "top10");
  if (typeof top10 === "number" && top10 >= 0.98 && (c.holders ?? 0) >= 80) top10 = undefined;
  const quoted = book.mcSource !== "none" || book.lpSource !== "none";
  return {
    mint: c.mint,
    venue: c.venue || "pump.fun",
    dex: book.dex || c.dex,
    name: book.name || c.name,
    symbol: book.symbol || c.symbol,
    creator: book.creator || c.creator,
    complete: book.complete,
    twitter: book.twitter || c.twitter,
    website: book.website || c.website,
    usdMarketCap: book.usdMarketCap > 0 ? book.usdMarketCap : c.marketCapUsd || 0,
    priceUsd: book.priceUsd || c.priceUsd,
    athMarketCap: Math.max(book.athMarketCap || 0, c.athMarketCap || 0, book.usdMarketCap) || undefined,
    launchedAt: c.launchedAt,
    holders: c.holders,
    buyers5m: book.buys5m,
    sellers5m: book.sells5m,
    buys5m: book.buys5m,
    sells5m: book.sells5m,
    change5m: book.change5m,
    change1h: book.change1h,
    change6h: book.change6h,
    reserveUsd: book.reserveUsd >= 1 ? book.reserveUsd : undefined,
    volume5m: book.volume5m,
    volume1h: book.volume1h,
    realSolReserves: book.realSolReserves,
    poolAddress: book.poolAddress || c.poolAddress,
    quoteMint: book.quoteMint,
    top10HoldPct: top10,
    devHoldPct: featNum(c, "devHold"),
    curveHoldPct: featNum(c, "curveHold"),
    bundleHoldPct: featNum(c, "bundle"),
    replyCount: featNum(c, "replies") ?? 0,
    launchSnipers: c.launchSnipers,
    quoteMisses: quoted ? 0 : (c.quoteMisses || 0) + 1,
    tape: {
      buyCount: book.buys5m,
      sellCount: book.sells5m,
    },
    melt: {
      insiderGraph: featNum(c, "insiderGraph"),
      bundleHoldPct: featNum(c, "bundle") ?? null,
    },
  };
}
