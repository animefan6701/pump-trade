import { existsSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { coins, jobs, outcomes } from "./mongo";
import { scoreAndUpsert } from "./upsert";
import type { CoinDoc, CurveOutcomeDoc, IngestJobDoc, LaunchSnapshot } from "./types";

const PUMP = "https://frontend-api-v3.pump.fun/coins?includeNsfw=false&limit=50";

function labelsPath() {
  const cwd = process.cwd();
  return resolve(cwd.endsWith("web") ? ".." : ".", "models", "entry_labels.json");
}

function ageMin(launchedAt?: string) {
  if (!launchedAt) return undefined;
  return Math.max(0, (Date.now() - new Date(launchedAt).getTime()) / 60_000);
}

function labelCoin(c: CoinDoc): CurveOutcomeDoc["label"] | null {
  if (c.complete) return "graduated";
  const age = ageMin(c.launchedAt);
  const bonding = c.bondingProgress ?? 0;
  if (age != null && age >= 90 && !c.complete && bonding < 0.25) return "failed";
  return null;
}

function featureRow(c: CoinDoc, label: CurveOutcomeDoc["label"]): CurveOutcomeDoc {
  return {
    mint: c.mint,
    label,
    labeledAt: new Date().toISOString(),
    ageMin: ageMin(c.launchedAt),
    bonding: c.bondingProgress,
    marketCapUsd: c.marketCapUsd,
    holders: c.holders,
    buyers5m: typeof c.features?.buyers5m === "number" ? c.features.buyers5m : undefined,
    wash: typeof c.features?.wash === "number" ? c.features.wash : undefined,
    top10: typeof c.features?.top10 === "number" ? c.features.top10 : undefined,
    sellPressure: typeof c.features?.sellPressure === "number" ? c.features.sellPressure : undefined,
    source: "live",
  };
}

async function dumpLabels() {
  const path = labelsPath();
  let existing: Array<CurveOutcomeDoc & { source?: string }> = [];
  try {
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, "utf8"));
      if (Array.isArray(raw)) existing = raw;
    }
  } catch {
    existing = [];
  }
  const byMint = new Map<string, CurveOutcomeDoc & { source?: string }>();
  for (const r of existing) {
    if (r?.mint) byMint.set(r.mint, r);
  }
  const rows = await (await outcomes()).find({}).toArray();
  for (const r of rows) {
    if (!r.mint) continue;
    const prev = byMint.get(r.mint);
    if (prev?.source === "dump" && r.source !== "dump") continue;
    byMint.set(r.mint, r);
  }
  writeFileSync(path, JSON.stringify([...byMint.values()]));
}

export async function labelCurveBook(): Promise<IngestJobDoc> {
  const result: IngestJobDoc = {
    _id: "outcomes",
    running: true,
    lastRunAt: new Date().toISOString(),
    labeled: 0,
    graduated: 0,
    failed: 0,
    errors: [],
  };
  await (await jobs()).updateOne({ _id: "outcomes" }, { $set: result }, { upsert: true });

  const col = await coins();
  const out = await outcomes();
  await out.createIndex({ mint: 1 }, { unique: true });
  const live = await col.find({ source: "live" }).toArray();
  for (const c of live) {
    const lab = labelCoin(c);
    if (!lab) continue;
    const prev = await out.findOne({ mint: c.mint }, { projection: { source: 1 } });
    if (prev?.source === "dump") continue;
    const doc = featureRow(c, lab);
    await out.updateOne({ mint: c.mint }, { $set: doc }, { upsert: true });
    result.labeled = (result.labeled || 0) + 1;
    if (lab === "graduated") result.graduated = (result.graduated || 0) + 1;
    else result.failed = (result.failed || 0) + 1;
  }

  try {
    await dumpLabels();
  } catch (e) {
    result.errors.push(e instanceof Error ? e.message : String(e));
  }

  result.running = false;
  result.nextRunAt = new Date(Date.now() + 30 * 60_000).toISOString();
  await (await jobs()).updateOne({ _id: "outcomes" }, { $set: result }, { upsert: true });
  return result;
}

function pumpSnap(row: Record<string, unknown>): LaunchSnapshot | null {
  const mint = String(row.mint || "");
  if (!mint) return null;
  const created = Number(row.created_timestamp || 0);
  return {
    mint,
    venue: "pump.fun",
    dex: "pump-fun",
    name: row.name ? String(row.name) : undefined,
    symbol: row.symbol ? String(row.symbol) : undefined,
    creator: row.creator ? String(row.creator) : undefined,
    complete: Boolean(row.complete),
    usdMarketCap: Number(row.usd_market_cap || 0),
    realSolReserves: Number(row.real_sol_reserves || row.real_quote_reserves || 0),
    launchedAt: created ? new Date(created).toISOString() : undefined,
    poolAddress: row.bonding_curve ? String(row.bonding_curve) : undefined,
  };
}

/** Older Pump.fun pages so EntryTimer can see failed curves, not only the latest 100. */
export async function backfillCurveBook(pages = 12, startOffset = 800): Promise<number> {
  let n = 0;
  for (let i = 0; i < pages; i++) {
    const offset = startOffset + i * 50;
    try {
      const rows = (await fetch(`${PUMP}&sort=created_timestamp&order=DESC&offset=${offset}`, {
        headers: { accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(15_000),
      }).then((r) => r.json())) as Record<string, unknown>[];
      if (!Array.isArray(rows) || rows.length === 0) break;
      for (const row of rows) {
        const snap = pumpSnap(row);
        if (!snap) continue;
        const wr = await scoreAndUpsert(snap, "ingest");
        if (wr) n += 1;
      }
    } catch {
      break;
    }
  }
  return n;
}

export async function runOutcomesCycle() {
  const backfilled = await backfillCurveBook().catch(() => 0);
  const labeled = await labelCurveBook();
  labeled.note = `backfilled ${backfilled} older pump rows`;
  await (await jobs()).updateOne({ _id: "outcomes" }, { $set: { note: labeled.note } });
  return labeled;
}
