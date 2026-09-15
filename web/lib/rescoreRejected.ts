import { refreshDeskStats } from "./deskStats";
import { enrichMeltLive } from "./meltLive";
import { coins, jobs } from "./mongo";
import { dexQuote, pairScore, pumpCoin, type DexPair } from "./tape";
import type { CoinDoc, IngestJobDoc, LaunchSnapshot } from "./types";
import { scoreAndUpsert } from "./upsert";

const DEX_BATCH = 30;
const PUMP_CONCURRENCY = 8;
const CHUNK = 200;

type DexQuote = NonNullable<ReturnType<typeof dexQuote>>;

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function poisonedCluster(c: CoinDoc) {
  return (c.reasons || []).some((r) => /tape cluster|clustered top-10|jito/i.test(r));
}

function needsHolderRefresh(snap: LaunchSnapshot) {
  const mc = snap.usdMarketCap ?? 0;
  const liq = snap.reserveUsd ?? 0;
  const vol = snap.volume5m ?? 0;
  return Boolean(snap.complete || mc >= 15_000 || (liq >= 80 && vol >= 400) || (snap.change5m ?? 0) >= 25);
}

function coinSnap(c: CoinDoc, pump: Awaited<ReturnType<typeof pumpCoin>>, quote: DexQuote | null): LaunchSnapshot {
  const feat = c.features || {};
  const mc = pump?.usdMarketCap || quote?.marketCapUsd || c.marketCapUsd;
  const complete = pump?.complete ?? c.complete;
  const liq =
    quote?.liquidityUsd && quote.liquidityUsd >= 80 ? quote.liquidityUsd : quote?.liquidityUsd || c.liquidityUsd;
  const holders = num(feat.holders) ?? c.holders;
  const top10 = num(feat.top10);
  const dropBook = (holders ?? 0) <= 2 && (complete || (mc ?? 0) >= 15_000);
  const dropBundle = poisonedCluster(c);

  return {
    mint: c.mint,
    venue: c.venue || "pump.fun",
    dex: quote?.dex || c.dex,
    name: c.name,
    symbol: c.symbol,
    creator: c.creator,
    complete,
    usdMarketCap: mc,
    priceUsd: quote?.priceUsd || c.priceUsd,
    launchedAt: c.launchedAt,
    poolAddress: quote?.pairAddress || pump?.poolAddress || c.poolAddress,
    realSolReserves: complete ? undefined : pump?.realSolReserves,
    buyers5m: quote?.buys5m,
    sellers5m: quote?.sells5m,
    buys5m: quote?.buys5m,
    sells5m: quote?.sells5m,
    change5m: quote?.change5m ?? c.change5m,
    change1h: quote?.change1h,
    reserveUsd: liq,
    volume5m: quote?.volume5m ?? c.volume5m,
    volume1h: quote?.volume1h ?? c.volume1h,
    holders: dropBook ? undefined : holders,
    replyCount: num(feat.replies) ?? 0,
    top10HoldPct: dropBook || (top10 !== undefined && top10 > 1) ? undefined : top10,
    devHoldPct: num(feat.devHold),
    bundleHoldPct: dropBundle ? undefined : num(feat.bundle),
    curveHoldPct: dropBook ? undefined : num(feat.curveHold),
  };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) || 1 }, () => worker()));
  return out;
}

async function dexByMint(mints: string[]) {
  const best = new Map<string, DexQuote>();
  for (let i = 0; i < mints.length; i += DEX_BATCH) {
    const chunk = mints.slice(i, i + DEX_BATCH);
    try {
      const body = (await fetch(`https://api.dexscreener.com/latest/dex/tokens/${chunk.join(",")}`, {
        headers: { accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(15_000),
      }).then((r) => r.json())) as { pairs?: DexPair[] };
      const pick = new Map<string, DexPair>();
      for (const p of body.pairs || []) {
        if (p.chainId !== "solana") continue;
        const mint = p.baseToken?.address;
        if (!mint) continue;
        const prev = pick.get(mint);
        if (!prev || pairScore(p) > pairScore(prev)) pick.set(mint, p);
      }
      for (const [mint, p] of pick) {
        const q = dexQuote([p]);
        if (q) best.set(mint, q);
      }
    } catch {
      /* keep stored quote */
    }
  }
  return best;
}

export async function rescoreRejected(opts: { limit?: number } = {}) {
  const result: IngestJobDoc & { flipped: Record<string, number>; alive: number } = {
    _id: "rescore",
    running: true,
    lastRunAt: new Date().toISOString(),
    inserted: 0,
    updated: 0,
    skipped: 0,
    scored: 0,
    errors: [],
    sources: {},
    flipped: {},
    alive: 0,
  };
  const col = await coins();
  const rows = await col
    .find({ source: "live", status: "rejected" })
    .sort({ updatedAt: -1 })
    .limit(opts.limit && opts.limit > 0 ? opts.limit : 50_000)
    .toArray();
  result.sources = { rejected: rows.length };
  console.log(`[rescore] ${rows.length} rejected tokens`);

  for (let start = 0; start < rows.length; start += CHUNK) {
    const batch = rows.slice(start, start + CHUNK);
    const quotes = await dexByMint(batch.map((r) => r.mint));
    const pumps = await mapLimit(batch, PUMP_CONCURRENCY, (c) => pumpCoin(c.mint).catch(() => null));
    const snaps: LaunchSnapshot[] = [];
    const refresh: LaunchSnapshot[] = [];
    for (let i = 0; i < batch.length; i++) {
      const snap = coinSnap(batch[i], pumps[i], quotes.get(batch[i].mint) || null);
      snaps.push(snap);
      if (needsHolderRefresh(snap)) refresh.push(snap);
    }
    result.alive += refresh.length;
    await enrichMeltLive(refresh, 4);

    for (let i = 0; i < snaps.length; i++) {
      try {
        const wr = await scoreAndUpsert(snaps[i], "live");
        if (!wr) {
          result.skipped = (result.skipped || 0) + 1;
          continue;
        }
        result.scored = (result.scored || 0) + 1;
        result.updated = (result.updated || 0) + 1;
        const next = wr.scored.status;
        if (next !== "rejected") {
          result.flipped[next] = (result.flipped[next] || 0) + 1;
        }
      } catch (e) {
        result.errors.push(`${batch[i].mint}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    const done = Math.min(start + batch.length, rows.length);
    result.note = `${done}/${rows.length}`;
    await (await jobs()).updateOne({ _id: "rescore" }, { $set: { ...result } }, { upsert: true });
    console.log(
      `[rescore] ${done}/${rows.length} scored=${result.scored} alive=${result.alive} flipped=${JSON.stringify(result.flipped)}`,
    );
  }

  result.running = false;
  result.nextRunAt = new Date().toISOString();
  result.note = `rescored ${result.scored} rejected · flipped ${JSON.stringify(result.flipped)}`;
  await (await jobs()).updateOne({ _id: "rescore" }, { $set: result }, { upsert: true });
  void refreshDeskStats().catch(() => null);
  return result;
}
