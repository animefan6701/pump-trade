import { notBlacklistedMongo } from "./blacklist";
import { coins, migrateSeries, scores } from "./mongo";
import type { CoinDoc, LaunchSnapshot, MigrateBar, MigrateSeriesDoc } from "./types";

const SERIES_MS = 60 * 60_000;
const BAR_GAP_MS = 45_000;
const MAX_BARS = 80;

export function trueTop10(top10?: number, group4?: number) {
  const t = typeof top10 === "number" && top10 >= 0 ? top10 : 0;
  const g = typeof group4 === "number" && group4 > 0 ? group4 : 0;
  return Math.min(1, Math.max(t, t + Math.max(0, g - 0.12) * 0.6));
}

export function scoreManipProxy(bars: MigrateBar[], migrateMc: number) {
  if (bars.length < 6 || !(migrateMc > 0)) return { score: 0, hit: false, why: "" };
  const mcs = bars.map((b) => b.mc).filter((n) => n > 0);
  if (mcs.length < 6) return { score: 0, hit: false, why: "" };
  const minMc = Math.min(...mcs);
  const ratio = minMc / migrateMc;
  if (ratio < 0.5) return { score: 0.12, hit: false, why: "dump bucket" };
  const peak = Math.max(...mcs);
  const last = mcs[mcs.length - 1];
  const mid = mcs[Math.floor(mcs.length / 2)];
  if (peak > migrateMc * 1.4 && last > migrateMc * 0.85 && mid < migrateMc * 0.7) {
    return { score: 0.82, hit: true, why: "held-up cycles after dip" };
  }
  if (ratio > 0.7 && last >= migrateMc * 0.9) return { score: 0.35, hit: false, why: "held near lock" };
  return { score: 0.2, hit: false, why: "" };
}

export async function appendMigrateBar(
  mint: string,
  migrateAt: string,
  migrateMc: number,
  bar: MigrateBar,
): Promise<MigrateSeriesDoc | null> {
  if (!(migrateMc > 0) || !(bar.mc > 0)) return null;
  const col = await migrateSeries();
  const existing = await col.findOne({ mint });
  const start = Date.parse(migrateAt);
  if (Number.isFinite(start) && bar.t - start > SERIES_MS) {
    return existing || null;
  }
  const bars = [...(existing?.bars || [])];
  const last = bars[bars.length - 1];
  if (last && bar.t - last.t < BAR_GAP_MS) {
    last.mc = bar.mc;
    last.vol = bar.vol ?? last.vol;
    last.buy = bar.buy ?? last.buy;
    last.sell = bar.sell ?? last.sell;
    last.tx = bar.tx ?? last.tx;
  } else {
    bars.push(bar);
  }
  const trimmed = bars.slice(-MAX_BARS);
  const mcs = trimmed.map((b) => b.mc).filter((n) => n > 0);
  const doc: MigrateSeriesDoc = {
    mint,
    migrateAt: existing?.migrateAt || migrateAt,
    migrateMc: existing?.migrateMc || migrateMc,
    bars: trimmed,
    minMc: mcs.length ? Math.min(...mcs) : bar.mc,
    maxMc: mcs.length ? Math.max(...mcs) : bar.mc,
    updatedAt: new Date().toISOString(),
  };
  await col.updateOne({ mint }, { $set: doc }, { upsert: true });
  return doc;
}

function clampEntry(n: number) {
  return Math.min(1, Math.max(0, n));
}

/** Post-migrate smash (0.08 / 0.28 cap) is not a held on-curve EntryTimer. */
function isHeldEntry(n: number | undefined) {
  return typeof n === "number" && Number.isFinite(n) && n > 0.28;
}

/** Last on-curve EntryTimer. Held after PumpSwap until a continuation model exists. */
export async function resolveMigrateEntryProb(
  existing: CoinDoc | null | undefined,
  complete: boolean,
): Promise<number | undefined> {
  if (!complete) return undefined;
  if (isHeldEntry(existing?.migrateEntryProb)) return clampEntry(existing!.migrateEntryProb!);
  if (existing && !existing.complete && isHeldEntry(existing.entryProb)) {
    return clampEntry(existing.entryProb);
  }
  if (existing?.mint) {
    try {
      const row = await (await scores())
        .find({ mint: existing.mint, complete: { $ne: true }, entryProb: { $gt: 0.28 } })
        .sort({ scoredAt: -1 })
        .limit(1)
        .next();
      if (isHeldEntry(row?.entryProb)) return clampEntry(row!.entryProb);
    } catch {
      /* keep going */
    }
  }
  if (isHeldEntry(existing?.entryProb)) return clampEntry(existing!.entryProb!);
  return undefined;
}

export function migrateLockFields(
  existing: CoinDoc | null | undefined,
  scored: Pick<CoinDoc, "complete" | "features" | "marketCapUsd">,
  liveMc: number,
  ts: string,
  migrateEntryProb?: number,
): {
  migrateAt?: string;
  migrateMc?: number;
  migrateFeatures?: Record<string, number | string | boolean>;
  migrateEntryProb?: number;
} {
  const held = isHeldEntry(migrateEntryProb)
    ? clampEntry(migrateEntryProb!)
    : isHeldEntry(existing?.migrateEntryProb)
      ? clampEntry(existing!.migrateEntryProb!)
      : undefined;
  if (existing?.migrateAt && existing.migrateMc) {
    return {
      migrateAt: existing.migrateAt,
      migrateMc: existing.migrateMc,
      migrateFeatures: existing.migrateFeatures,
      ...(held != null ? { migrateEntryProb: held } : {}),
    };
  }
  const mc = liveMc > 0 ? liveMc : Number(existing?.marketCapUsd || scored.marketCapUsd || 0);
  if (!scored.complete || !(mc > 0)) return {};
  return {
    migrateAt: ts,
    migrateMc: mc,
    migrateFeatures: scored.features,
    ...(held != null ? { migrateEntryProb: held } : {}),
  };
}

async function pumpMigrateHint(mint: string): Promise<{ complete: boolean; mc?: number } | null> {
  try {
    const r = await fetch(`https://frontend-api-v3.pump.fun/coins/${mint}`, {
      headers: {
        accept: "application/json",
        "user-agent": "Mozilla/5.0 (compatible; pump-trade-desk/1.0)",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
    if (!r.ok) return null;
    const row = (await r.json()) as Record<string, unknown>;
    return {
      complete: Boolean(row.complete),
      mc: Number(row.usd_market_cap || 0) || undefined,
    };
  } catch {
    return null;
  }
}

export async function catchOffbookMigrates(limit = 16) {
  const col = await coins();
  const rows = await col
    .find({
      source: "live",
      complete: { $ne: true },
      $or: [{ bondingProgress: { $gte: 0.85 } }, { marketCapUsd: { $gte: 40_000 } }],
      ...(await notBlacklistedMongo()),
    })
    .sort({ updatedAt: -1 })
    .limit(limit)
    .toArray();
  let locked = 0;
  let bars = 0;
  for (const c of rows) {
    const hint = await pumpMigrateHint(c.mint);
    if (!hint?.complete) continue;
    const wr = await col.updateOne(
      { mint: c.mint, complete: { $ne: true } },
      {
        $set: {
          complete: true,
          migrateAt: c.migrateAt || new Date().toISOString(),
          migrateMc: c.migrateMc || hint.mc || c.marketCapUsd,
        },
      },
    );
    if (wr.modifiedCount) locked += 1;
    const lockMc = c.migrateMc || hint.mc || c.marketCapUsd || 0;
    if (lockMc > 0) {
      const series = await appendMigrateBar(c.mint, c.migrateAt || new Date().toISOString(), lockMc, {
        t: Date.now(),
        mc: hint.mc || c.marketCapUsd || lockMc,
      });
      if (series) bars += 1;
    }
  }
  return { locked, bars };
}

export async function labelMigrate20(limit = 80) {
  const col = await coins();
  const seriesCol = await migrateSeries();
  const rows = await col
    .find({
      source: "live",
      complete: true,
      migrateAt: { $exists: true },
      migrateOutcomeAt: { $exists: false },
      ...(await notBlacklistedMongo()),
    })
    .sort({ migrateAt: 1 })
    .limit(limit)
    .toArray();
  let n = 0;
  const now = Date.now();
  for (const c of rows) {
    const start = Date.parse(c.migrateAt || "");
    if (!Number.isFinite(start) || now - start < 20 * 60_000) continue;
    const series = await seriesCol.findOne({ mint: c.mint });
    const lock = c.migrateMc || series?.migrateMc || 0;
    const minMc = series?.minMc || c.marketCapUsd || 0;
    const maxMc = series?.maxMc || c.athMarketCap || c.marketCapUsd || 0;
    const minRatio = lock > 0 ? minMc / lock : c.minRatio || 1;
    await col.updateOne(
      { mint: c.mint },
      {
        $set: {
          migrateOutcomeAt: new Date().toISOString(),
          migrateMinMc: minMc,
          migrateMinRatio: minRatio,
          migrateMaxMc: maxMc,
          migrateHigh: maxMc >= lock * 1.5,
          migrateSurvive70: minRatio >= 0.7,
          migrateHit15x: lock > 0 && maxMc >= lock * 1.5,
          migrateHit2x: lock > 0 && maxMc >= lock * 2,
          migrateHit5x: lock > 0 && maxMc >= lock * 5,
        },
      },
    );
    n += 1;
  }
  return n;
}

export function featuresFromSnap(_snap: LaunchSnapshot): Record<string, number | string | boolean> {
  return {};
}
