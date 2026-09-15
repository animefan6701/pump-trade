import { writeFileSync } from "fs";
import { resolve } from "path";
import { coins, jobs, scores } from "./mongo";
import type { IngestJobDoc } from "./types";

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
    headers: { accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) return undefined;
  const body = (await r.json()) as {
    pairs?: Array<{ chainId?: string; marketCap?: number; fdv?: number; liquidity?: { usd?: number } }>;
  };
  const sol = (body.pairs || []).filter((p) => p.chainId === "solana");
  sol.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
  const p = sol[0];
  return p?.marketCap || p?.fdv;
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

export async function runCalibration(): Promise<IngestJobDoc> {
  const col = await scores();
  const coinCol = await coins();
  const cutoff = new Date(Date.now() - calibrateAgeMs()).toISOString();
  const pending = await col
    .find({ scoredAt: { $lte: cutoff }, outcomeAt: { $exists: false } })
    .sort({ scoredAt: 1 })
    .limit(80)
    .toArray();

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
      if (nowMc == null || !row.marketCapUsd && !coin?.marketCapUsd) continue;
      const startMc = row.marketCapUsd || coin?.marketCapUsd || nowMc;
      const outcomeReturn = startMc > 0 ? (nowMc - startMc) / startMc : 0;
      const peak = Math.max(startMc, coin?.marketCapUsd || 0, nowMc);
      const outcomeMinRatio = peak > 0 ? nowMc / peak : 1;
      const outcomeHigh = outcomeMinRatio < 0.4 || outcomeReturn <= -0.6;
      await col.updateOne(
        { mint: row.mint, scoredAt: row.scoredAt },
        {
          $set: {
            outcomeAt: new Date().toISOString(),
            outcomeMc: nowMc,
            outcomeMinRatio,
            outcomeReturn,
            outcomeHigh,
          },
        },
      );
      result.outcomes = (result.outcomes || 0) + 1;
    } catch (e) {
      result.errors.push(e instanceof Error ? e.message : String(e));
    }
  }

  const labeled = await col
    .find({ outcomeAt: { $exists: true }, outcomeHigh: { $exists: true } })
    .project({ rugProb: 1, outcomeHigh: 1 })
    .limit(4000)
    .toArray();
  const pairs = labeled
    .filter((r) => typeof r.rugProb === "number")
    .map((r) => ({ p: r.rugProb, y: r.outcomeHigh ? 1 : 0 }));
  if (pairs.length >= 40) {
    result.brier = Number(brier(pairs).toFixed(4));
    result.threshold = Number(bestThreshold(pairs).toFixed(3));
    result.labeled = pairs.length;
    try {
      writeFileSync(
        calPath(),
        JSON.stringify(
          {
            threshold: result.threshold,
            brier: result.brier,
            n: pairs.length,
            updatedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
      );
    } catch (e) {
      result.errors.push(e instanceof Error ? e.message : String(e));
    }
  } else {
    result.note = `need 40 labeled ${Math.round(calibrateAgeMs() / 60_000)}m outcomes, have ${pairs.length}`;
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
