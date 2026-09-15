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
      riskLabel: scored.riskLabel,
      minRatio: scored.minRatio,
      returnRatio: scored.returnRatio,
      marketCapUsd: scored.marketCapUsd,
      features: scored.features,
      reasons: scored.reasons.slice(0, 12),
    });
  } catch {
    /* paper log must never break ingest */
  }
}
