import { notBlacklistedMongo } from "./blacklist";
import { refreshDeskStats } from "./deskStats";
import { enrichMeltLive } from "./meltLive";
import type { Filter } from "mongodb";
import { coins, jobs } from "./mongo";
import { isDumpedCoin, notDumpedMongo } from "./dumped";
import { altQuoteReserveUsd, dexQuote, fetchDexQuotes, pumpCoin } from "./tape";
import type { CoinDoc, IngestJobDoc, LaunchSnapshot } from "./types";
import { scoreAndUpsert } from "./upsert";

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
  const quoteLiq = quote != null && (quote.liquidityUsd ?? 0) > 0 ? quote.liquidityUsd : undefined;
  const curveLiq =
    altQuoteReserveUsd({
      quoteMint: pump?.quoteMint,
      quoteDecimals: pump?.quoteDecimals,
      realQuote: pump?.realQuoteReserves,
      virtualQuote: pump?.virtualQuoteReserves,
      quoteUsd: quote?.solUsd,
    }) ?? pump?.curveReserveUsd;
  const dustQuote = quote != null && quoteLiq == null && curveLiq == null;
  const mc = pump?.usdMarketCap || quote?.marketCapUsd || (dustQuote ? 0 : c.marketCapUsd);
  const complete = pump?.complete ?? c.complete;
  const staleLiq =
    c.liquidityUsd && (mc ?? 0) > 0 && c.liquidityUsd > (mc ?? 0) * 8 ? undefined : c.liquidityUsd;
  const liq = quoteLiq ?? curveLiq ?? staleLiq;
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
    athMarketCap: Math.max(c.athMarketCap || 0, pump?.athMarketCap || 0, mc || 0) || undefined,
    launchedAt: c.launchedAt,
    poolAddress: quote?.pairAddress || pump?.poolAddress || c.poolAddress,
    realSolReserves: complete ? undefined : pump?.realSolReserves,
    buyers5m: quote?.buys5m,
    sellers5m: quote?.sells5m,
    buys5m: quote?.buys5m,
    sells5m: quote?.sells5m,
    change5m: quote?.change5m ?? c.change5m,
    change1h: quote?.change1h,
    change6h: quote?.change6h,
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

export function rescoreIntervalMs() {
  return Math.max(3 * 60_000, Number(process.env.RESCORE_INTERVAL_MS || 3 * 60_000));
}

export function fullRescoreIntervalMs() {
  return Math.max(10 * 60_000, Number(process.env.FULL_RESCORE_INTERVAL_MS || 30 * 60_000));
}

function hotWindowMs() {
  return Math.max(30, Number(process.env.HOT_BOOK_MINUTES || 360)) * 60_000;
}

function hotLimit() {
  return Math.max(50, Number(process.env.RESCORE_HOT_LIMIT || 600));
}

export type RescoreMode = "hot" | "full";

let hotRunning = false;
let fullRunning = false;

export async function getRescoreStatus() {
  return (await jobs()).findOne({ _id: "rescore" });
}

export async function getFullRescoreStatus() {
  return (await jobs()).findOne({ _id: "rescoreFull" });
}

function rejectQuery(mode: RescoreMode) {
  const clauses: Filter<CoinDoc>[] = [notDumpedMongo()];
  if (mode === "hot") {
    const since = new Date(Date.now() - hotWindowMs()).toISOString();
    clauses.push({ launchedAt: { $gte: since } });
    clauses.push({
      $or: [{ complete: { $ne: true } }, { marketCapUsd: { $gte: 8_000 } }, { liquidityUsd: { $gte: 80 } }],
    });
  }
  return {
    source: "live" as const,
    status: "rejected" as const,
    $and: clauses,
  };
}

export async function rescoreRejected(opts: { limit?: number; mode?: RescoreMode } = {}) {
  const mode: RescoreMode = opts.mode || "hot";
  const jobId = mode === "full" ? "rescoreFull" : "rescore";
  const interval = mode === "full" ? fullRescoreIntervalMs() : rescoreIntervalMs();
  const cap = opts.limit && opts.limit > 0 ? opts.limit : mode === "full" ? 50_000 : hotLimit();
  const result: IngestJobDoc & { flipped: Record<string, number>; alive: number } = {
    _id: jobId,
    running: true,
    lastRunAt: new Date().toISOString(),
    inserted: 0,
    updated: 0,
    skipped: 0,
    scored: 0,
    errors: [],
    sources: { mode: 1 },
    flipped: {},
    alive: 0,
  };
  if (mode === "hot" ? hotRunning : fullRunning || hotRunning) {
    result.running = false;
    result.errors.push(mode === "full" && hotRunning ? "hot pass running" : "already running");
    result.nextRunAt = new Date(Date.now() + interval).toISOString();
    return result;
  }
  if (mode === "hot") hotRunning = true;
  else fullRunning = true;
  try {
    const col = await coins();
    const found = await col
      .find({ ...rejectQuery(mode), ...(await notBlacklistedMongo()) })
      .sort({ marketCapUsd: -1, updatedAt: -1 })
      .limit(cap)
      .toArray();
    const rows = found.filter((c) => !isDumpedCoin(c));
    result.sources = {
      rejected: rows.length,
      [mode]: rows.length,
      dumped: found.length - rows.length,
    };
    console.log(`[rescore] ${mode} ${rows.length} rejected tokens (skipped ${found.length - rows.length} dumped)`);

    for (let start = 0; start < rows.length; start += CHUNK) {
      const batch = rows.slice(start, start + CHUNK);
      const quotes = await fetchDexQuotes(batch.map((r) => r.mint));
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
      result.note = `${mode} ${done}/${rows.length}`;
      await (await jobs()).updateOne({ _id: jobId }, { $set: { ...result } }, { upsert: true });
      console.log(
        `[rescore] ${mode} ${done}/${rows.length} scored=${result.scored} alive=${result.alive} flipped=${JSON.stringify(result.flipped)}`,
      );
      await new Promise((r) => setTimeout(r, 400));
    }
  } catch (e) {
    result.errors.push(e instanceof Error ? e.message : String(e));
  }

  result.running = false;
  result.nextRunAt = new Date(Date.now() + interval).toISOString();
  result.note = `${mode} rescored ${result.scored} rejected · flipped ${JSON.stringify(result.flipped)}`;
  await (await jobs()).updateOne({ _id: jobId }, { $set: result }, { upsert: true });
  void refreshDeskStats().catch(() => null);
  if (mode === "hot") hotRunning = false;
  else fullRunning = false;
  return result;
}
