import { isDumpedCoin } from "./dumpCheck";
import type { CoinDoc, CoinStatus } from "./types";

export function flagsOf(c: Pick<CoinDoc, "status" | "flags" | "complete">): CoinStatus[] {
  if (c.flags && c.flags.length) return c.flags;
  if (c.status === "rejected") return ["rejected"];
  const out: CoinStatus[] = c.status === "migrated" ? [] : [c.status];
  if (c.complete || c.status === "migrated") out.push("migrated");
  if (out.length === 0) out.push("watching");
  return out;
}

export function hasFlag(c: Pick<CoinDoc, "status" | "flags" | "complete">, flag: CoinStatus) {
  return flagsOf(c).includes(flag);
}

export function isManipFlag(c: Pick<CoinDoc, "manipulated" | "manipScore">) {
  return c.manipulated === "yes" || (typeof c.manipScore === "number" && c.manipScore >= 0.7);
}

export function isDir5mFlag(c: Pick<CoinDoc, "dir5mProb">) {
  return typeof c.dir5mProb === "number" && c.dir5mProb >= 0.6;
}

export function isHit2xFlag(c: Pick<CoinDoc, "hit2xProb">) {
  return typeof c.hit2xProb === "number" && c.hit2xProb >= 0.55;
}

export function isDumpFirstFlag(c: Pick<CoinDoc, "dumpFirstProb">) {
  return typeof c.dumpFirstProb === "number" && c.dumpFirstProb >= 0.55;
}

export function isSurvive70Flag(c: Pick<CoinDoc, "survive70Prob">) {
  return typeof c.survive70Prob === "number" && c.survive70Prob >= 0.524;
}

export function isHit15xFlag(c: Pick<CoinDoc, "hit15xProb">) {
  return typeof c.hit15xProb === "number" && c.hit15xProb >= 0.52;
}

/** Still inside the 1.5× window vs the migrate lock. */
export function lockMultiple(mc?: number, lock?: number) {
  if (!(typeof mc === "number" && mc > 0 && typeof lock === "number" && lock > 0)) return null;
  return mc / lock;
}

/** Post-migrate ENTER is HOLD70 only. HIT15x is a chip, not this gate. */
export function isContinuationEnter(
  c: Pick<
    CoinDoc,
    | "complete"
    | "status"
    | "survive70Prob"
    | "marketCapUsd"
    | "migrateMc"
    | "athMarketCap"
    | "liquidityUsd"
    | "holders"
    | "change5m"
    | "change1h"
    | "change6h"
    | "exitProb"
    | "minRatio"
    | "entryProb"
    | "migrateEntryProb"
  >,
) {
  if (!c.complete) return false;
  if (c.status === "rejected" || c.status === "exit") return false;
  if (isDumpedCoin(c)) return false;
  const entry = typeof c.migrateEntryProb === "number" ? c.migrateEntryProb : c.entryProb;
  if (!(typeof entry === "number" && entry >= 0.35)) return false;
  const mult = lockMultiple(c.marketCapUsd, c.migrateMc);
  if (mult != null && mult < 0.7) return false;
  return isSurvive70Flag(c);
}

export function flagsFor(status: CoinStatus, complete?: boolean): CoinStatus[] {
  if (status === "rejected") return ["rejected"];
  const out: CoinStatus[] = [status];
  if (complete) out.push("migrated");
  return out;
}
