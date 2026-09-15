import { hasFlag } from "./flags";
import { coins } from "./mongo";
import { fetchDexQuotes } from "./tape";
import type { CoinDoc, LaunchSnapshot } from "./types";
import { scoreAndUpsert } from "./upsert";

function hotMs() {
  return Math.max(30, Number(process.env.HOT_BOOK_MINUTES || 360)) * 60_000;
}

function featNum(c: CoinDoc, key: string) {
  const v = c.features?.[key];
  return typeof v === "number" ? v : undefined;
}

function snapFromQuote(
  c: CoinDoc,
  quote: {
    priceUsd?: number;
    pairAddress?: string;
    liquidityUsd?: number;
    volume5m?: number;
    volume1h?: number;
    change5m?: number;
    change1h?: number;
    buys5m?: number;
    sells5m?: number;
    marketCapUsd?: number;
    dex?: string;
  },
): LaunchSnapshot {
  const mc = quote.marketCapUsd || c.marketCapUsd || 0;
  const ath = Math.max(c.athMarketCap || 0, c.marketCapUsd || 0, mc);
  let top10 = featNum(c, "top10");
  if (typeof top10 === "number" && top10 >= 0.98 && (c.holders ?? 0) >= 80) top10 = undefined;
  const dump = ath > 0 && mc > 0 ? Math.min(1, Math.max(0, 1 - mc / ath)) : 0;
  return {
    mint: c.mint,
    venue: c.venue,
    dex: quote.dex || c.dex,
    name: c.name,
    symbol: c.symbol,
    creator: c.creator,
    complete: Boolean(c.complete || quote.dex === "pumpswap" || quote.dex === "raydium"),
    twitter: c.twitter,
    website: c.website,
    usdMarketCap: quote.marketCapUsd || c.marketCapUsd,
    priceUsd: quote.priceUsd || c.priceUsd,
    athMarketCap: ath || undefined,
    launchedAt: c.launchedAt,
    holders: c.holders,
    buyers5m: quote.buys5m,
    sellers5m: quote.sells5m,
    buys5m: quote.buys5m,
    sells5m: quote.sells5m,
    change5m: quote.change5m,
    change1h: quote.change1h,
    reserveUsd: quote.liquidityUsd,
    volume5m: quote.volume5m,
    volume1h: quote.volume1h,
    poolAddress: quote.pairAddress || c.poolAddress,
    top10HoldPct: top10,
    devHoldPct: featNum(c, "devHold"),
    curveHoldPct: featNum(c, "curveHold"),
    replyCount: featNum(c, "replies") ?? 0,
    tape: {
      dumpRatio: dump,
      buyCount: quote.buys5m,
      sellCount: quote.sells5m,
    },
  };
}

/** Keep ENTER / watching books on a Dex quote after they leave Pump latest-50. */
export async function refreshHotBooks(seen: Set<string>) {
  const col = await coins();
  const since = new Date(Date.now() - hotMs()).toISOString();
  const rows = await col
    .find({
      source: "live",
      launchedAt: { $gte: since },
      $or: [{ flags: "enter" }, { status: "enter" }, { flags: "watching" }, { status: "watching" }],
    })
    .limit(80)
    .toArray();

  const hot = rows
    .filter((c) => !seen.has(c.mint))
    .sort((a, b) => {
      const ae = hasFlag(a, "enter") ? 0 : 1;
      const be = hasFlag(b, "enter") ? 0 : 1;
      if (ae !== be) return ae - be;
      return (a.updatedAt || "").localeCompare(b.updatedAt || "");
    })
    .slice(0, 30);

  if (!hot.length) return { refreshed: 0 };

  const quotes = await fetchDexQuotes(hot.map((c) => c.mint));
  let refreshed = 0;
  for (const c of hot) {
    const quote = quotes.get(c.mint);
    if (!quote?.marketCapUsd && !quote?.priceUsd) continue;
    seen.add(c.mint);
    const wr = await scoreAndUpsert(snapFromQuote(c, quote!), "live");
    if (wr) refreshed += 1;
  }
  return { refreshed };
}
