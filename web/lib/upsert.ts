import { applyStatusChange } from "./deskStats";
import { flagsFor, hasFlag } from "./flags";
import { coins } from "./mongo";
import { scoreLaunch } from "./predict";
import { logScore } from "./scores";
import { maybeAutoTrade } from "./trader";
import type { CoinDoc, LaunchSnapshot, ScoreDoc } from "./types";

const GRADUATE_SOL = 85_000_000_000;

export async function scoreAndUpsert(
  snap: LaunchSnapshot,
  source: ScoreDoc["source"],
): Promise<{ inserted: boolean; scored: Omit<CoinDoc, "createdAt" | "updatedAt"> } | null> {
  const col = await coins();
  const existing = await col.findOne({ mint: snap.mint });
  if (existing?.source === "melt") return null;

  if (typeof existing?.bondingProgress === "number" && typeof snap.realSolReserves === "number") {
    const hours = existing.bondingAt
      ? Math.max(1 / 60, (Date.now() - new Date(existing.bondingAt).getTime()) / 3_600_000)
      : 1;
    const nextBond = Math.min(1, snap.realSolReserves / GRADUATE_SOL);
    snap.bondingVelocity = (nextBond - existing.bondingProgress) / hours;
  }

  const scored = scoreLaunch(snap);
  // Thin Pump snap has no tape. Hold reject only when the book is still dead —
  // a live/migrated book (HUHCAT) is allowed to come back to ENTER.
  if (
    existing &&
    source !== "tape" &&
    !snap.tape &&
    (existing.status === "rejected" || hasFlag(existing, "rejected")) &&
    scored.status === "enter"
  ) {
    const mc = scored.marketCapUsd || snap.usdMarketCap || 0;
    const liveBook = Boolean(scored.complete || (snap.reserveUsd ?? 0) >= 80 || mc >= 15_000);
    if (!liveBook) {
      scored.status = "rejected";
      scored.flags = flagsFor("rejected", scored.complete);
      scored.entryProb = Math.min(scored.entryProb, 0.08);
      scored.reasons = [`held rejected — thin ${source} snap, no live book`, ...(scored.reasons || []).slice(0, 8)];
    }
  }
  const athMarketCap =
    Math.max(
      existing?.athMarketCap || 0,
      snap.athMarketCap || 0,
      snap.usdMarketCap || 0,
      scored.marketCapUsd || 0,
    ) || undefined;
  scored.athMarketCap = athMarketCap;
  void logScore(scored, source);
  const ts = new Date().toISOString();
  const wr = await col.updateOne(
    { mint: snap.mint },
    {
      $set: {
        ...scored,
        athMarketCap,
        updatedAt: ts,
        prevBonding: existing?.bondingProgress,
        bondingAt: ts,
        bondingVelocity: snap.bondingVelocity,
      },
      $setOnInsert: { createdAt: existing?.createdAt || ts },
    },
    { upsert: true },
  );
  const inserted = Boolean(wr.upsertedCount) || !existing;
  applyStatusChange(existing?.status, scored.status, inserted);
  void maybeAutoTrade(existing, scored);
  return { inserted, scored };
}
