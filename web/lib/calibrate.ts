import { writeFileSync } from "fs";
import { resolve } from "path";
import { coins, jobs, scores } from "./mongo";
import { catchOffbookMigrates, labelMigrate20 } from "./migrateSeries";
import { attachGeckoToPairs, fetchGeckoPools, isVirtualBook, pickRealPair, type DexPair } from "./tape";
import type { IngestJobDoc } from "./types";
import { invalidateCalCache } from "./xgb";

/** MELT: ~73% of migrants lose >60% within 20m. 1h misses coins that are already dead. */
export function calibrateAgeMs() {
  const n = Number(process.env.CALIBRATE_AGE_MS);
  if (Number.isFinite(n)) return Math.max(5 * 60_000, Math.min(2 * 60 * 60_000, n));
  return 20 * 60_000;
}

export function calibrateIntervalMs() {
  return Math.max(120_000, Number(process.env.CALIBRATE_INTERVAL_MS || 5 * 60_000));
}

function calPath() {
  const cwd = process.cwd();
  return resolve(cwd.endsWith("web") ? ".." : ".", "models", "rug_cal.json");
}

async function currentMc(mint: string): Promise<number | undefined> {
  const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
    headers: {
      accept: "application/json",
      "user-agent": "Mozilla/5.0 (compatible; pump-trade-desk/1.0)",
    },
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) return undefined;
  const body = (await r.json()) as { pairs?: DexPair[] };
  const pairs = body.pairs || [];
  attachGeckoToPairs(pairs, await fetchGeckoPools(mint));
  const p = pickRealPair(pairs);
  if (!p || isVirtualBook(p)) return undefined;
  return p.marketCap || p.fdv;
}

function brier(rows: Array<{ p: number; y: number }>) {
  if (!rows.length) return 1;
  return rows.reduce((s, r) => s + (r.p - r.y) ** 2, 0) / rows.length;
}

function bestThreshold(rows: Array<{ p: number; y: number }>) {
  let best = { t: 0.55, f1: -1 };
  for (let t = 0.35; t <= 0.8; t += 0.01) {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (const r of rows) {
      const pred = r.p >= t;
      if (pred && r.y) tp += 1;
      else if (pred && !r.y) fp += 1;
      else if (!pred && r.y) fn += 1;
    }
    const prec = tp / (tp + fp || 1);
    const rec = tp / (tp + fn || 1);
    const f1 = prec + rec ? (2 * prec * rec) / (prec + rec || 1) : 0;
    if (f1 > best.f1) best = { t, f1 };
  }
  return Math.max(0.45, Math.min(0.75, best.t));
}

function logit(p: number) {
  const q = Math.min(1 - 1e-6, Math.max(1e-6, p));
  return Math.log(q / (1 - q));
}

function sigmoid(z: number) {
  if (z >= 0) {
    const e = Math.exp(-z);
    return 1 / (1 + e);
  }
  const e = Math.exp(z);
  return e / (1 + e);
}

function fitPlatt(rows: Array<{ p: number; y: number }>) {
  let a = 1;
  let b = 0;
  const lr = 0.08;
  for (let iter = 0; iter < 250; iter++) {
    let ga = 0;
    let gb = 0;
    for (const r of rows) {
      const z = logit(r.p);
      const pred = sigmoid(a * z + b);
      const err = pred - r.y;
      ga += err * z;
      gb += err;
    }
    a -= (lr * ga) / rows.length;
    b -= (lr * gb) / rows.length;
  }
  return { a, b };
}

const CONT_LOOKBACK_MS = 7 * 24 * 60 * 60_000;
const CAL_BATCH = 120;

function pendingFilter(cutoff: string, floor: string) {
  return {
    scoredAt: { $lte: cutoff, $gte: floor },
    outcomeAt: { $exists: false },
    marketCapUsd: { $gt: 0 },
  };
}

export async function runCalibration(): Promise<IngestJobDoc> {
  const col = await scores();
  const coinCol = await coins();
  void col.createIndex({ scoredAt: -1, outcomeAt: 1, marketCapUsd: 1 }).catch(() => null);
  const cutoff = new Date(Date.now() - calibrateAgeMs()).toISOString();
  const floor = new Date(Date.now() - CONT_LOOKBACK_MS).toISOString();
  const base = pendingFilter(cutoff, floor);
  const migrated = await col
    .find({
      ...base,
      $or: [{ complete: true }, { flags: "migrated" }, { "features.complete": 1 }],
    })
    .sort({ scoredAt: -1 })
    .limit(CAL_BATCH)
    .toArray();
  let pending = migrated;
  if (pending.length < CAL_BATCH) {
    const seen = new Set(pending.map((r) => `${r.mint}:${r.scoredAt}`));
    const extra = await col
      .find(base)
      .sort({ scoredAt: -1 })
      .limit(CAL_BATCH)
      .toArray();
    for (const row of extra) {
      const k = `${row.mint}:${row.scoredAt}`;
      if (seen.has(k)) continue;
      pending.push(row);
      if (pending.length >= CAL_BATCH) break;
    }
  }

  const result: IngestJobDoc = {
    _id: "calibrate",
    running: true,
    lastRunAt: new Date().toISOString(),
    outcomes: 0,
    errors: [],
  };
  await (await jobs()).updateOne({ _id: "calibrate" }, { $set: result }, { upsert: true });

  for (const row of pending) {
    try {
      const live = await currentMc(row.mint);
      const coin = await coinCol.findOne({ mint: row.mint });
      const nowMc = live ?? coin?.marketCapUsd;
      const startMc = row.marketCapUsd;
      if (nowMc == null || startMc == null || startMc <= 0) {
        const attempts = (row.calAttempts || 0) + 1;
        await col.updateOne(
          { mint: row.mint, scoredAt: row.scoredAt },
          {
            $set: {
              calAttempts: attempts,
              ...(attempts >= 3
                ? { outcomeAt: new Date().toISOString(), outcomeKind: "skip" }
                : {}),
            },
          },
        );
        continue;
      }
      const outcomeReturn = (nowMc - startMc) / startMc;
      const outcomeMinRatio = nowMc / startMc;
      const complete = Boolean(row.complete ?? coin?.complete ?? row.features?.complete === 1);
      await col.updateOne(
        { mint: row.mint, scoredAt: row.scoredAt },
        {
          $set: {
            outcomeAt: new Date().toISOString(),
            outcomeMc: nowMc,
            outcomeMinRatio,
            outcomeReturn,
            outcomeHigh: nowMc <= startMc * 0.5,
            outcomeSurvive70: nowMc >= startMc * 0.7,
            outcomeHit15x: nowMc >= startMc * 1.5,
            outcomeKind: "mc50",
            complete,
            flags: row.flags?.length ? row.flags : coin?.flags,
            liquidityUsd: row.liquidityUsd ?? coin?.liquidityUsd,
            holders: row.holders ?? coin?.holders,
            volume5m: row.volume5m ?? coin?.volume5m,
            athMarketCap: row.athMarketCap ?? coin?.athMarketCap,
          },
        },
      );
      result.outcomes = (result.outcomes || 0) + 1;
    } catch (e) {
      result.errors.push(e instanceof Error ? e.message : String(e));
    }
  }

  const labeled = await col
    .find({
      outcomeKind: "mc50",
      outcomeHigh: { $exists: true },
      "features.model": "xgb-live",
    })
    .project({ rugProb: 1, outcomeHigh: 1 })
    .limit(4000)
    .toArray();
  const pairs = labeled
    .filter((r) => typeof r.rugProb === "number")
    .map((r) => ({ p: r.rugProb, y: r.outcomeHigh ? 1 : 0 }));
  if (pairs.length >= 40) {
    const platt = fitPlatt(pairs);
    const calibrated = pairs.map((r) => ({
      p: sigmoid(platt.a * logit(r.p) + platt.b),
      y: r.y,
    }));
    result.brier = Number(brier(calibrated).toFixed(4));
    result.threshold = Number(bestThreshold(calibrated).toFixed(3));
    result.labeled = pairs.length;
    const contN = await col.countDocuments({ outcomeKind: "mc50", complete: true });
    await catchOffbookMigrates(24);
    const migrateN = await labelMigrate20(80);
    result.note = `xgb-live mc50 n=${pairs.length} brier=${result.brier}; continuation migrated mc50 n=${contN}; migrate20 +${migrateN}`;
    try {
      writeFileSync(
        calPath(),
        JSON.stringify(
          {
            slice: "xgb-live",
            label: "mc50_20m",
            threshold: result.threshold,
            brier: result.brier,
            n: pairs.length,
            plattA: Number(platt.a.toFixed(4)),
            plattB: Number(platt.b.toFixed(4)),
            updatedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
      );
      invalidateCalCache();
    } catch (e) {
      result.errors.push(e instanceof Error ? e.message : String(e));
    }
  } else {
    const contN = await col.countDocuments({ outcomeKind: "mc50", complete: true });
    await catchOffbookMigrates(24);
    const migrateN = await labelMigrate20(80);
    result.note = `need 40 labeled xgb-live 20m MC-drop outcomes, have ${pairs.length}; continuation migrated mc50 n=${contN}; migrate20 +${migrateN}`;
    result.labeled = pairs.length;
  }

  result.running = false;
  result.nextRunAt = new Date(Date.now() + calibrateIntervalMs()).toISOString();
  await (await jobs()).updateOne({ _id: "calibrate" }, { $set: result }, { upsert: true });
  return result;
}

export async function getCalibrateStatus() {
  return (await jobs()).findOne({ _id: "calibrate" });
}
