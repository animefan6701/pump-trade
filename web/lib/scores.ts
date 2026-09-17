import { scores } from "./mongo";
import type { CoinDoc, ScoreDoc } from "./types";

export async function logScore(
  scored: Omit<CoinDoc, "createdAt" | "updatedAt">,
  source: ScoreDoc["source"],
) {
  try {
    const col = await scores();
    await col.insertOne({
      mint: scored.mint,
      source,
      scoredAt: new Date().toISOString(),
      rugProb: scored.rugProb,
      entryProb: scored.entryProb,
      exitProb: scored.exitProb,
      status: scored.status,
      flags: scored.flags,
      complete: scored.complete,
      riskLabel: scored.riskLabel,
      minRatio: scored.minRatio,
      returnRatio: scored.returnRatio,
      marketCapUsd: scored.marketCapUsd ?? 0,
      athMarketCap: scored.athMarketCap ?? 0,
      liquidityUsd: scored.liquidityUsd ?? 0,
      volume5m: scored.volume5m ?? 0,
      volume1h: scored.volume1h ?? 0,
      holders: scored.holders ?? 0,
      change5m: scored.change5m ?? 0,
      change1h: scored.change1h ?? 0,
      launchedAt: scored.launchedAt,
      migrateMc: scored.migrateMc,
      features: scored.features,
      reasons: scored.reasons.slice(0, 12),
    });
  } catch {
    /* paper log must never break ingest */
  }
}
