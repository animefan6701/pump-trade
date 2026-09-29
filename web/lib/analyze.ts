import {
  ANALYZE_FLOOR,
  ANALYZE_LIVE_LP,
  ANALYZE_TARGETS,
  ANALYZE_TZ_OFFSET_H,
  type AnalyzeBoard,
  type AnalyzeTargetKey,
  type AnalyzeTokenDetail,
  type AnalyzeTokenRow,
  type DayPrint,
  type HourBucket,
  type TargetHit,
} from "./analyzeTypes";
import { coins, migrateSeries, ohlcvCache, scores } from "./mongo";
import { fetchGeckoPools } from "./tape";
import type { CoinDoc, OhlcvBar, OhlcvCacheDoc } from "./types";

export { ANALYZE_FLOOR, ANALYZE_LIVE_LP, ANALYZE_TARGETS } from "./analyzeTypes";
export type {
  AnalyzeBoard,
  AnalyzeTargetKey,
  AnalyzeTokenDetail,
  AnalyzeTokenRow,
  DayPrint,
  HourBucket,
  TargetHit,
} from "./analyzeTypes";

const CACHE_MS = 20 * 60_000;
const SCORE_CAP = 600;

type McPoint = { t: number; mc: number; h?: number; l?: number };

function peakOf(c: Pick<CoinDoc, "athMarketCap" | "migrateMaxMc" | "marketCapUsd">) {
  return Math.max(c.athMarketCap || 0, c.migrateMaxMc || 0, c.marketCapUsd || 0);
}

function supplyOf(c: Pick<CoinDoc, "marketCapUsd" | "priceUsd">) {
  const mc = c.marketCapUsd || 0;
  const px = c.priceUsd || 0;
  if (mc > 0 && px > 0) return mc / px;
  return 1_000_000_000;
}

function gmt5(t: number) {
  return new Date(t + ANALYZE_TZ_OFFSET_H * 3_600_000);
}

function dayKey(t: number) {
  return gmt5(t).toISOString().slice(0, 10);
}

function hourOf(t: number) {
  return gmt5(t).getUTCHours();
}

function emptyHours(): HourBucket[] {
  return Array.from({ length: 24 }, (_, hour) => ({
    hour,
    minHits: 0,
    maxHits: 0,
    changeTokens: 0,
    changeSum: 0,
    changeN: 0,
    avgChangePct: 0,
  }));
}

function mergeHours(into: HourBucket[], add: HourBucket[]) {
  for (const h of add) {
    const row = into[h.hour];
    row.minHits += h.minHits;
    row.maxHits += h.maxHits;
    row.changeTokens += h.changeTokens;
    row.changeSum += h.changeSum;
    row.changeN += h.changeN;
  }
}

function finishHours(hours: HourBucket[]) {
  for (const h of hours) {
    h.avgChangePct = h.changeN ? h.changeSum / h.changeN : 0;
  }
  return hours;
}

function firstHits(points: McPoint[], launchedAt?: string, peak = 0): TargetHit[] {
  const t0 = launchedAt ? new Date(launchedAt).getTime() : points[0]?.t;
  const sorted = [...points].sort((a, b) => a.t - b.t);
  return ANALYZE_TARGETS.map((tg) => {
    const hitByPeak = peak >= tg.usd;
    const pt = sorted.find((p) => (p.h ?? p.mc) >= tg.usd);
    if (!pt) return { key: tg.key, usd: tg.usd, hit: hitByPeak };
    const durationMs = t0 != null && Number.isFinite(t0) ? Math.max(0, pt.t - t0) : undefined;
    return {
      key: tg.key,
      usd: tg.usd,
      hit: true,
      at: new Date(pt.t).toISOString(),
      durationMs,
    };
  });
}

function maxTargetOf(hits: TargetHit[]): AnalyzeTargetKey | undefined {
  let last: AnalyzeTargetKey | undefined;
  for (const h of hits) if (h.hit) last = h.key;
  return last;
}

function athAtOf(points: McPoint[], peak: number) {
  if (!(peak > 0) || !points.length) return undefined;
  const floor = peak * 0.98;
  const pt = [...points].sort((a, b) => a.t - b.t).find((p) => (p.h ?? p.mc) >= floor);
  return pt ? new Date(pt.t).toISOString() : undefined;
}

function daysFromPoints(points: McPoint[]): DayPrint[] {
  const byDay = new Map<string, McPoint[]>();
  for (const p of points) {
    if (!(p.mc > 0) && !(p.h || 0)) continue;
    const key = dayKey(p.t);
    const rows = byDay.get(key) || [];
    rows.push(p);
    byDay.set(key, rows);
  }
  return [...byDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, rows]) => {
      const sorted = [...rows].sort((a, b) => a.t - b.t);
      let min = Infinity;
      let max = 0;
      let minAt = "";
      let maxAt = "";
      const hours: DayPrint["hours"] = Array.from({ length: 24 }, (_, hour) => ({ hour }));
      const hourPts: McPoint[][] = Array.from({ length: 24 }, () => []);
      for (const p of sorted) {
        const lo = p.l ?? p.mc;
        const hi = p.h ?? p.mc;
        if (lo > 0 && lo < min) {
          min = lo;
          minAt = new Date(p.t).toISOString();
        }
        if (hi > max) {
          max = hi;
          maxAt = new Date(p.t).toISOString();
        }
        hourPts[hourOf(p.t)].push(p);
      }
      for (let h = 0; h < 24; h++) {
        const pts = hourPts[h];
        if (!pts.length) continue;
        const open = pts[0].mc;
        const close = pts[pts.length - 1].mc;
        const high = Math.max(...pts.map((p) => p.h ?? p.mc));
        const low = Math.min(...pts.map((p) => p.l ?? p.mc).filter((n) => n > 0));
        hours[h] = {
          hour: h,
          open,
          high,
          low: Number.isFinite(low) ? low : undefined,
          close,
          changePct:
          pts.length >= 2 && open > 0
            ? Math.max(-250, Math.min(250, ((close - open) / open) * 100))
            : undefined,
        };
      }
      return {
        date,
        min: Number.isFinite(min) ? min : 0,
        max,
        minAt: minAt || undefined,
        maxAt: maxAt || undefined,
        hours,
      };
    });
}

function hoursFromDays(days: DayPrint[]): HourBucket[] {
  const hours = emptyHours();
  for (const d of days) {
    if (d.minAt) hours[hourOf(new Date(d.minAt).getTime())].minHits += 1;
    if (d.maxAt) hours[hourOf(new Date(d.maxAt).getTime())].maxHits += 1;
    for (const h of d.hours) {
      if (h.changePct == null) continue;
      hours[h.hour].changeTokens += 1;
      hours[h.hour].changeSum += h.changePct;
      hours[h.hour].changeN += 1;
    }
  }
  return finishHours(hours);
}

function uniqueHourSets() {
  return {
    min: Array.from({ length: 24 }, () => new Set<string>()),
    max: Array.from({ length: 24 }, () => new Set<string>()),
    pct: Array.from({ length: 24 }, () => new Set<string>()),
    changeSum: Array.from({ length: 24 }, () => 0),
    changeN: Array.from({ length: 24 }, () => 0),
  };
}

function addUniqueHours(
  sets: ReturnType<typeof uniqueHourSets>,
  days: DayPrint[],
  mint: string,
) {
  for (const d of days) {
    if (d.minAt) sets.min[hourOf(new Date(d.minAt).getTime())].add(mint);
    if (d.maxAt) sets.max[hourOf(new Date(d.maxAt).getTime())].add(mint);
    for (const h of d.hours) {
      if (h.changePct == null) continue;
      sets.pct[h.hour].add(mint);
      sets.changeSum[h.hour] += h.changePct;
      sets.changeN[h.hour] += 1;
    }
  }
}

function hoursFromUnique(sets: ReturnType<typeof uniqueHourSets>): HourBucket[] {
  return Array.from({ length: 24 }, (_, hour) => ({
    hour,
    minHits: sets.min[hour].size,
    maxHits: sets.max[hour].size,
    changeTokens: sets.pct[hour].size,
    changeSum: sets.changeSum[hour],
    changeN: sets.changeN[hour],
    avgChangePct: sets.changeN[hour] ? sets.changeSum[hour] / sets.changeN[hour] : 0,
  }));
}

async function geckoJson(url: string, timeout = 10_000) {
  const r = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "Mozilla/5.0 (compatible; pump-trade-desk/1.0)",
    },
    cache: "no-store",
    signal: AbortSignal.timeout(timeout),
  });
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}

function parseOhlcv(list: number[][] | undefined): OhlcvBar[] {
  const out: OhlcvBar[] = [];
  for (const row of list || []) {
    const [t, o, h, l, c, v] = row;
    const ts = t > 2_000_000_000 ? t : t * 1000;
    if (!(c > 0)) continue;
    out.push({ t: ts, o, h, l, c, v });
  }
  return out.sort((a, b) => a.t - b.t);
}

async function fetchGeckoOhlcv(pool: string, tf: "hour" | "day", limit = 1000) {
  const body = (await geckoJson(
    `https://api.geckoterminal.com/api/v2/networks/solana/pools/${pool}/ohlcv/${tf}?aggregate=1&limit=${limit}`,
  )) as { data?: { attributes?: { ohlcv_list?: number[][] } } };
  return parseOhlcv(body.data?.attributes?.ohlcv_list);
}

async function resolvePool(mint: string, hint?: string) {
  const rows = await fetchGeckoPools(mint);
  const addr = (id?: string) => (id || "").replace(/^solana_/, "");
  const hinted = hint ? rows.find((r) => addr(r.id) === hint) : undefined;
  const ranked = [...rows].sort(
    (a, b) => Number(b.attributes?.reserve_in_usd || 0) - Number(a.attributes?.reserve_in_usd || 0),
  );
  const pick = hinted || ranked[0];
  return addr(pick?.id) || hint;
}

async function loadCachedOhlcv(mint: string, tf: "hour" | "day") {
  const row = await (await ohlcvCache()).findOne({ mint, tf });
  if (!row?.bars?.length) return null;
  if (Date.now() - new Date(row.fetchedAt).getTime() > CACHE_MS) return row;
  return row;
}

async function storeOhlcv(doc: OhlcvCacheDoc) {
  await (await ohlcvCache()).updateOne({ mint: doc.mint, tf: doc.tf }, { $set: doc }, { upsert: true });
}

async function warmHourOhlcv(c: CoinDoc): Promise<OhlcvCacheDoc | null> {
  const hit = await loadCachedOhlcv(c.mint, "hour");
  if (hit && Date.now() - new Date(hit.fetchedAt).getTime() <= CACHE_MS) return hit;
  try {
    const pool = await resolvePool(c.mint, c.poolAddress);
    if (!pool) return hit;
    const bars = await fetchGeckoOhlcv(pool, "hour", 1000);
    if (!bars.length) return hit;
    const doc: OhlcvCacheDoc = {
      mint: c.mint,
      pool,
      tf: "hour",
      bars,
      supply: supplyOf(c),
      fetchedAt: new Date().toISOString(),
    };
    await storeOhlcv(doc);
    return doc;
  } catch {
    return hit;
  }
}

function ohlcvToPoints(bars: OhlcvBar[], supply: number): McPoint[] {
  if (!(supply > 0)) return [];
  return bars.map((b) => ({
    t: b.t,
    mc: b.c * supply,
    h: b.h * supply,
    l: b.l * supply,
  }));
}

async function firstHitAt(mints: string[]) {
  const out = new Map<string, Map<string, number>>();
  if (!mints.length) return out;
  const col = await scores();
  const field = (key: string) => `t_${key.replace(/[^a-zA-Z0-9]+/g, "_")}`;
  const group: Record<string, unknown> = { _id: "$mint" };
  for (const tg of ANALYZE_TARGETS) {
    group[field(tg.key)] = {
      $min: { $cond: [{ $gte: ["$marketCapUsd", tg.usd] }, "$scoredAt", "9999-12-31"] },
    };
  }
  const chunk = 50;
  for (let i = 0; i < mints.length; i += chunk) {
    const part = mints.slice(i, i + chunk);
    const rows = await col
      .aggregate<{ _id: string } & Record<string, string>>([
        { $match: { mint: { $in: part }, marketCapUsd: { $gte: ANALYZE_FLOOR } } },
        { $group: group },
      ])
      .toArray();
    for (const row of rows) {
      const hits = new Map<string, number>();
      for (const tg of ANALYZE_TARGETS) {
        const at = row[field(tg.key)];
        if (typeof at === "string" && !at.startsWith("9999")) hits.set(tg.key, new Date(at).getTime());
      }
      out.set(row._id, hits);
    }
  }
  return out;
}

async function recentScorePoints(mint: string) {
  const rows = await (await scores())
    .find({ mint, marketCapUsd: { $gt: 0 } }, { projection: { scoredAt: 1, marketCapUsd: 1 } })
    .sort({ scoredAt: -1 })
    .limit(SCORE_CAP)
    .toArray();
  return rows
    .reverse()
    .map((row) => ({ t: new Date(row.scoredAt).getTime(), mc: row.marketCapUsd || 0 }));
}

async function barPoints(mints: string[]) {
  const byMint = new Map<string, McPoint[]>();
  if (!mints.length) return byMint;
  const rows = await (await migrateSeries())
    .find({ mint: { $in: mints } }, { projection: { mint: 1, bars: 1 } })
    .toArray();
  for (const row of rows) {
    byMint.set(
      row.mint,
      (row.bars || [])
        .filter((b) => b.mc > 0 && b.t > 0)
        .map((b) => ({ t: b.t, mc: b.mc })),
    );
  }
  return byMint;
}

function mergePoints(...lists: McPoint[][]) {
  const byT = new Map<number, McPoint>();
  for (const list of lists) {
    for (const p of list) {
      if (!Number.isFinite(p.t) || p.t <= 0) continue;
      const prev = byT.get(p.t);
      if (!prev) byT.set(p.t, { ...p });
      else {
        byT.set(p.t, {
          t: p.t,
          mc: Math.max(prev.mc, p.mc),
          h: Math.max(prev.h || prev.mc, p.h || p.mc),
          l: Math.min(prev.l || prev.mc || Infinity, p.l || p.mc || Infinity),
        });
      }
    }
  }
  return [...byT.values()].sort((a, b) => a.t - b.t);
}

function applyHitTimes(hits: TargetHit[], launchedAt: string | undefined, atByKey?: Map<string, number>) {
  if (!atByKey?.size) return hits;
  const t0 = launchedAt ? new Date(launchedAt).getTime() : undefined;
  return hits.map((h) => {
    const t = atByKey.get(h.key);
    if (t == null) return h;
    return {
      ...h,
      hit: true,
      at: new Date(t).toISOString(),
      durationMs: t0 != null && Number.isFinite(t0) ? Math.max(0, t - t0) : h.durationMs,
    };
  });
}

function hitsFromDoc(c: CoinDoc) {
  const out = new Map<string, number>();
  for (const [key, row] of Object.entries(c.analyzeHits || {})) {
    if (row?.at) out.set(key, new Date(row.at).getTime());
  }
  return out.size ? out : undefined;
}

function rowFromCoin(c: CoinDoc, points: McPoint[], atByKey?: Map<string, number>): AnalyzeTokenRow {
  const ath = peakOf(c);
  const hits = applyHitTimes(firstHits(points, c.launchedAt, ath), c.launchedAt, atByKey || hitsFromDoc(c));
  const hit500 = hits.find((h) => h.key === "500k");
  return {
    mint: c.mint,
    symbol: c.symbol,
    name: c.name,
    launchedAt: c.launchedAt,
    marketCapUsd: c.marketCapUsd || 0,
    athMarketCap: ath,
    liquidityUsd: c.liquidityUsd,
    migrateMc: c.migrateMc,
    complete: c.complete,
    status: c.status,
    flags: c.flags,
    hits,
    maxTarget: maxTargetOf(hits),
    athAt: athAtOf(points, ath),
    timeTo500kMs: hit500?.durationMs,
  };
}

function hitQuery(usd: number) {
  return {
    liquidityUsd: { $gte: ANALYZE_LIVE_LP },
    marketCapUsd: { $gt: 0 },
    $or: [
      { athMarketCap: { $gte: usd } },
      { migrateMaxMc: { $gte: usd } },
      { marketCapUsd: { $gte: usd } },
    ],
  };
}

function isAliveBook(c: Pick<CoinDoc, "liquidityUsd" | "marketCapUsd">) {
  return (c.liquidityUsd || 0) >= ANALYZE_LIVE_LP && (c.marketCapUsd || 0) > 0;
}

export async function loadSurvivorCoins() {
  const col = await coins();
  return col.find(hitQuery(ANALYZE_FLOOR)).sort({ athMarketCap: -1, updatedAt: -1 }).limit(400).toArray();
}

export async function buildAnalyzeBoard(): Promise<AnalyzeBoard> {
  const rows = await loadSurvivorCoins();
  const mints = rows.map((c) => c.mint);
  const [barMap, caches] = await Promise.all([
    barPoints(mints),
    mints.length
      ? (await ohlcvCache()).find({ mint: { $in: mints }, tf: "hour" }).toArray()
      : Promise.resolve([] as OhlcvCacheDoc[]),
  ]);
  const cacheByMint = new Map(caches.map((c) => [c.mint, c]));

  const hourSets = uniqueHourSets();
  const tokens: AnalyzeTokenRow[] = [];
  for (const c of rows) {
    const cache = cacheByMint.get(c.mint);
    const ohlcvPts = cache?.bars?.length ? ohlcvToPoints(cache.bars, cache.supply || supplyOf(c)) : [];
    const points = mergePoints(barMap.get(c.mint) || [], ohlcvPts, [
      { t: Date.now(), mc: c.marketCapUsd || 0 },
    ]);
    const token = rowFromCoin(c, points);
    tokens.push(token);
    addUniqueHours(hourSets, daysFromPoints(points), c.mint);
  }
  const hours = hoursFromUnique(hourSets);

  const col = await coins();
  const counted = await Promise.all(
    ANALYZE_TARGETS.map(async (tg) => {
      const matched = tokens.filter((t) => t.hits.find((h) => h.key === tg.key)?.hit);
      const timed = matched.map((t) => t.hits.find((h) => h.key === tg.key)?.durationMs).filter((n): n is number => n != null);
      const count = await col.countDocuments(hitQuery(tg.usd));
      return {
        key: tg.key,
        usd: tg.usd,
        count,
        avgDurationMs: timed.length ? timed.reduce((a, b) => a + b, 0) / timed.length : null,
        timed: timed.length,
      };
    }),
  );
  const targets = counted;

  return {
    asOf: new Date().toISOString(),
    tokenCount: targets[0]?.count ?? tokens.length,
    targets,
    hours,
    tokens,
  };
}

export async function buildAnalyzeToken(mint: string): Promise<AnalyzeTokenDetail | null> {
  const coin = await (await coins()).findOne({ mint });
  if (!coin) return null;
  if (peakOf(coin) < ANALYZE_FLOOR || !isAliveBook(coin)) return null;
  const [hitMap, recent, barMap, cache] = await Promise.all([
    firstHitAt([mint]),
    recentScorePoints(mint),
    barPoints([mint]),
    warmHourOhlcv(coin),
  ]);
  const ohlcvPts = cache?.bars?.length ? ohlcvToPoints(cache.bars, cache.supply || supplyOf(coin)) : [];
  const points = mergePoints(recent, barMap.get(mint) || [], ohlcvPts, [
    { t: Date.now(), mc: coin.marketCapUsd || 0 },
  ]);
  const row = rowFromCoin(coin, points, hitMap.get(mint));
  const days = daysFromPoints(points);
  return {
    coin: {
      ...row,
      venue: coin.venue,
      poolAddress: coin.poolAddress,
      priceUsd: coin.priceUsd,
      liquidityUsd: coin.liquidityUsd,
    },
    hits: row.hits,
    maxTarget: row.maxTarget,
    athAt: row.athAt,
    days,
    hours: hoursFromDays(days),
    source: {
      scores: recent.length,
      bars: barMap.get(mint)?.length || 0,
      ohlcv: ohlcvPts.length,
    },
  };
}
