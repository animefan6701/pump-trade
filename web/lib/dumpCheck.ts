export const THIN_ATH_FLOOR = 0.45;
/** Fat live book can retrace further and still be a tape, not a dead dump. */
export const LIVE_ATH_FLOOR = 0.3;
export const LIVE_BOOK_LP = 80_000;

export type DumpFields = {
  status?: string;
  exitProb?: number;
  minRatio?: number;
  athMarketCap?: number;
  marketCapUsd?: number;
  liquidityUsd?: number;
  holders?: number;
  change5m?: number;
  change1h?: number;
  change6h?: number;
};

export function isFatLiveBook(c: Pick<DumpFields, "liquidityUsd" | "holders" | "marketCapUsd">) {
  const liq = c.liquidityUsd ?? 0;
  const holders = c.holders ?? 0;
  const mc = c.marketCapUsd ?? 0;
  return liq >= LIVE_BOOK_LP || (liq >= 80 && holders >= 500 && mc >= 150_000);
}

export function athDumpFloor(c: Pick<DumpFields, "liquidityUsd" | "holders" | "marketCapUsd">) {
  return isFatLiveBook(c) ? LIVE_ATH_FLOOR : THIN_ATH_FLOOR;
}

export function isOffAth(c: DumpFields) {
  const ath = c.athMarketCap || 0;
  const mc = c.marketCapUsd || 0;
  if (!(ath > mc && ath > 0 && mc > 0)) return false;
  const book = mc / ath;
  const min = Math.min(c.minRatio ?? 1, book);
  return min < athDumpFloor(c);
}

/** Off ATH, sharp 5m/1h/6h, or EXIT. Uses book ATH even if stored minRatio is stale. */
export function isDumpedCoin(c: DumpFields) {
  if (c.status === "exit") return true;
  if ((c.exitProb ?? 0) >= 0.75) return true;
  if ((c.change5m ?? 0) <= -35) return true;
  if ((c.change1h ?? 0) <= -50) return true;
  if ((c.change6h ?? 0) <= -50) return true;
  return isOffAth(c);
}

/** Drop gecko/pumpfun ghost ATH that is tens of × the live book or lock. */
export function saneAth(ath: number | undefined, mc: number, lock?: number) {
  const peak = Math.max(mc || 0, lock || 0);
  const a = ath || 0;
  if (peak > 0 && a > peak * 40) return peak || undefined;
  return Math.max(a, peak) || undefined;
}
