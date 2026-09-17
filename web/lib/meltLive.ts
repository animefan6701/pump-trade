import { config as loadEnv } from "dotenv";
import { resolve } from "path";
import { heliusRpc } from "./heliusKeys";
import type { LaunchSnapshot, MeltLiveFeatures, TapeTrade } from "./types";

loadEnv({ path: resolve(process.cwd(), "../.env") });
loadEnv({ path: resolve(process.cwd(), ".env") });

/** RugCheck `pct` is always 0–100, including values like 0.74 (0.74%, not 74%). */
function asFrac(p: number) {
  if (!Number.isFinite(p)) return 0;
  return Math.min(1, Math.max(0, p / 100));
}

export function gini(values: number[]): number {
  const arr = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (arr.length === 0) return 0;
  const n = arr.length;
  let cum = 0;
  let weighted = 0;
  for (const v of arr) {
    cum += v;
    weighted += cum;
  }
  if (cum <= 0) return 0;
  return (n + 1 - (2 * weighted) / cum) / n;
}

type RugTop = {
  address?: string;
  owner?: string;
  pct?: number;
  amount?: number;
  uiAmount?: number;
  insider?: boolean;
};

type RugReport = {
  mint?: string;
  token?: {
    mintAuthority?: string | null;
    freezeAuthority?: string | null;
    supply?: number | string;
    decimals?: number;
    tokenProgram?: string;
  };
  markets?: Array<{ lp?: { address?: string }; pubkey?: string; address?: string }>;
  topHolders?: RugTop[];
  creator?: string;
  creatorBalance?: number;
  totalHolders?: number;
  total_holders?: number;
  holderCount?: number;
  graphInsidersDetected?: number;
};

function lpSet(report: RugReport, poolAddress?: string) {
  const skip = new Set<string>();
  if (poolAddress) skip.add(poolAddress);
  for (const m of report.markets || []) {
    if (m.lp?.address) skip.add(m.lp.address);
    if (m.pubkey) skip.add(m.pubkey);
    if (m.address) skip.add(m.address);
  }
  return skip;
}

function holderFrac(h: RugTop) {
  if (typeof h.pct === "number") return asFrac(h.pct);
  return 0;
}

function concentration(report: RugReport, poolAddress?: string): MeltLiveFeatures {
  const skip = lpSet(report, poolAddress);
  const all = report.topHolders || [];
  const lpBags = all.filter((h) => skip.has(h.address || "") || skip.has(h.owner || ""));
  const raw = all.filter((h) => !skip.has(h.address || "") && !skip.has(h.owner || ""));
  const firstRaw = raw[0] ? holderFrac(raw[0]) : 0;
  const curveHold = lpBags.length ? holderFrac(lpBags[0]) : firstRaw >= 0.35 ? firstRaw : 0;
  const holders = firstRaw >= 0.35 && skip.size === 0 ? raw.slice(1) : raw;
  const pcts = holders.map(holderFrac).filter((p) => p > 0);
  const top = (n: number) => pcts.slice(0, n).reduce((a, b) => a + b, 0);
  const insiderPct = holders.filter((h) => h.insider).reduce((a, h) => a + holderFrac(h), 0);
  const supply = Number(report.token?.supply || 0);
  const creatorBal = Number(report.creatorBalance || 0);
  const devHold = supply > 0 ? creatorBal / supply : undefined;
  return {
    group2_top1_pct: pcts[0] ?? null,
    group2_top5_pct: pcts.length ? top(5) : null,
    group2_top10_pct: pcts.length ? top(10) : null,
    group2_top20_pct: pcts.length ? top(20) : null,
    group2_holder_gini: pcts.length ? gini(pcts) : null,
    group2_dev_hold_pct: devHold !== undefined && Number.isFinite(devHold) ? devHold : null,
    top10HoldPct: pcts.length ? top(10) : null,
    devHoldPct: devHold !== undefined && Number.isFinite(devHold) ? devHold : null,
    curveHoldPct: curveHold || null,
    lpExcluded: skip.size > 0 || (raw.length > 0 && holderFrac(raw[0]) >= 0.35),
    group4_cluster_total_pct: insiderPct || null,
    bundleHoldPct: insiderPct || null,
  };
}

async function rugReport(mint: string): Promise<RugReport | null> {
  const r = await fetch(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`, {
    headers: { accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(8_000),
  });
  if (!r.ok) return null;
  return (await r.json()) as RugReport;
}

async function tokenLargest(mint: string): Promise<number[] | null> {
  const j = (await heliusRpc(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "getTokenLargestAccounts",
      params: [mint],
    },
    1,
  )) as { result?: { value?: Array<{ uiAmount?: number; amount?: string }> } } | null;
  if (!j) return null;
  const rows = j.result?.value || [];
  const amounts = rows.map((x) => Number(x.uiAmount || 0)).filter((n) => n > 0);
  return amounts.length ? amounts : null;
}

const holderCache = new Map<string, { n: number; at: number }>();
const HOLDER_CACHE_MS = 5 * 60_000;

async function cachedHolderAccounts(mint: string): Promise<number | undefined> {
  const hit = holderCache.get(mint);
  if (hit && Date.now() - hit.at < HOLDER_CACHE_MS) return hit.n;
  const n = await heliusHolderAccounts(mint);
  if (typeof n === "number") holderCache.set(mint, { n, at: Date.now() });
  return n;
}

async function heliusHolderAccounts(mint: string): Promise<number | undefined> {
  const j = (await heliusRpc(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "getTokenAccounts",
      params: { mint, page: 1, limit: 1, options: { showZeroBalance: false } },
    },
    10,
  )) as { result?: { total?: number } } | null;
  if (!j) return undefined;
  const n = j.result?.total;
  return typeof n === "number" && n >= 0 ? n : undefined;
}

const SNIPER_KEYS = [
  "group2_sniper_0s_hold_pct",
  "group2_sniper_1s_hold_pct",
  "group2_sniper_5s_hold_pct",
  "group2_sniper_10s_hold_pct",
  "group2_sniper_0s_ratio",
  "group2_sniper_1s_ratio",
  "group2_sniper_5s_ratio",
  "group2_sniper_10s_ratio",
  "group2_sniper_0s_num",
  "group2_sniper_1s_num",
  "group2_sniper_5s_num",
  "group2_sniper_10s_num",
] as const;

export function pickSniperFeatures(
  m?: MeltLiveFeatures | Record<string, number | string | boolean | null | undefined> | null,
): MeltLiveFeatures | undefined {
  if (!m) return undefined;
  const out: MeltLiveFeatures = {};
  let n = 0;
  for (const k of SNIPER_KEYS) {
    const v = (m as Record<string, unknown>)[k];
    if (typeof v === "number" && Number.isFinite(v)) {
      (out as Record<string, number>)[k] = v;
      n += 1;
    }
  }
  return n > 0 ? out : undefined;
}

export function hasSniperFeatures(
  m?: MeltLiveFeatures | Record<string, number | string | boolean | null | undefined> | null,
) {
  return Boolean(pickSniperFeatures(m));
}

const PUMP_SUPPLY = 1_000_000_000;
const SNIPER_WINDOWS = [0, 1, 5, 10] as const;

export function meltFromTrades(
  trades: TapeTrade[],
  launchedAt?: string,
  creator?: string,
): MeltLiveFeatures {
  if (trades.length === 0) return {};
  const launched = launchedAt ? Date.parse(launchedAt) : NaN;
  const buyTs = trades.filter((t) => t.side === "buy" && t.t > 0).map((t) => t.t);
  const firstBuy = buyTs.length ? Math.min(...buyTs) : Math.min(...trades.map((t) => t.t));
  const inLaunch = Number.isFinite(launched) && trades.some((t) => Math.abs(t.t - launched) <= 15_000);
  const t0 = inLaunch ? launched : firstBuy;
  const wallets = new Set<string>();
  const buyers = new Set<string>();
  const sellers = new Set<string>();
  const sides = new Map<string, Set<string>>();
  let buyN = 0;
  let sellN = 0;
  let buySol = 0;
  let sellSol = 0;
  const sniperWallets = {
    0: new Set<string>(),
    1: new Set<string>(),
    5: new Set<string>(),
    10: new Set<string>(),
  };
  const sniperTokens = { 0: 0, 1: 0, 5: 0, 10: 0 };
  const sniperSol = { 0: 0, 1: 0, 5: 0, 10: 0 };
  let sawTokens = false;

  for (const t of trades) {
    if (t.wallet) wallets.add(t.wallet);
    const set = sides.get(t.wallet) || new Set();
    set.add(t.side);
    sides.set(t.wallet, set);
    if (t.side === "buy") {
      buyN += 1;
      buySol += t.sol;
      buyers.add(t.wallet);
      if (typeof t.tokens === "number" && t.tokens > 0) sawTokens = true;
      if (t0 > 0) {
        const dt = (t.t - t0) / 1000;
        for (const w of SNIPER_WINDOWS) {
          if (dt <= w) {
            if (t.wallet) sniperWallets[w].add(t.wallet);
            sniperTokens[w] += t.tokens || 0;
            sniperSol[w] += t.sol || 0;
          }
        }
      }
    } else {
      sellN += 1;
      sellSol += t.sol;
      sellers.add(t.wallet);
    }
  }

  let wash = 0;
  for (const set of sides.values()) if (set.has("buy") && set.has("sell")) wash += 1;
  const span = (Math.max(...trades.map((t) => t.t)) - Math.min(...trades.map((t) => t.t))) / 1000;
  const holders = wallets.size || 1;

  const out: MeltLiveFeatures = {
    group3_trader_num: wallets.size,
    group3_buy_num: buyN,
    group3_sell_num: sellN,
    group3_buy_user_num: buyers.size,
    group3_sell_user_num: sellers.size,
    group3_sell_pressure: buySol > 0 ? sellSol / buySol : sellSol > 0 ? 2 : 0,
    group3_wash_ratio: trades.length ? wash / trades.length : 0,
    group3_tx_num: trades.length,
    group3_time_span: Math.max(0, span),
    group3_tx_per_sec: span > 0 ? trades.length / span : trades.length,
    creatorSold: Boolean(creator && trades.some((t) => t.side === "sell" && t.wallet === creator)),
  };

  if (t0 > 0) {
    for (const w of SNIPER_WINDOWS) {
      const hold = sawTokens
        ? sniperTokens[w] / PUMP_SUPPLY
        : buySol > 0
          ? sniperSol[w] / buySol
          : 0;
      (out as Record<string, number>)[`group2_sniper_${w}s_num`] = sniperWallets[w].size;
      (out as Record<string, number>)[`group2_sniper_${w}s_ratio`] = sniperWallets[w].size / holders;
      (out as Record<string, number>)[`group2_sniper_${w}s_hold_pct`] = Math.min(1, Math.max(0, hold));
    }
  }

  return out;
}

export async function fetchMeltLive(
  mint: string,
  opts: { poolAddress?: string; creator?: string; complete?: boolean } = {},
): Promise<{
  holders?: number;
  mintAuthority?: boolean;
  freezeAuthority?: boolean;
  melt: MeltLiveFeatures;
}> {
  const report = await rugReport(mint).catch(() => null);
  const rawReport = report as (RugReport & Record<string, unknown>) | null;
  const reportedHolders = (
    [report?.totalHolders, report?.total_holders, report?.holderCount, rawReport?.holders].find(
      (v) => typeof v === "number" && v > 2,
    ) as number | undefined
  );
  const accounts =
    reportedHolders == null ? await cachedHolderAccounts(mint).catch(() => undefined) : undefined;
  const needLargest = !report?.topHolders?.length;
  const largest = needLargest ? await tokenLargest(mint).catch(() => null) : null;

  let melt: MeltLiveFeatures = {};
  let mintAuthority: boolean | undefined;
  let freezeAuthority: boolean | undefined;
  // Token-2022 Helius getTokenAccounts often returns 0/1. That is not a book.
  let holders = typeof accounts === "number" && accounts > 2 ? accounts : undefined;

  if (report) {
    melt = concentration(report, opts.poolAddress);
    mintAuthority = Boolean(report.token?.mintAuthority);
    freezeAuthority = Boolean(report.token?.freezeAuthority);
    if (reportedHolders) holders = holders ? Math.max(holders, reportedHolders) : reportedHolders;
    if (typeof holders === "number") melt.group3_holder_num = holders;
    if (!melt.group2_dev_hold_pct && opts.creator && report.topHolders) {
      const row = report.topHolders.find(
        (h) => h.owner === opts.creator || h.address === opts.creator,
      );
      if (row) {
        melt.group2_dev_hold_pct = holderFrac(row);
        melt.devHoldPct = holderFrac(row);
      }
    }
    if (typeof report.graphInsidersDetected === "number" && report.graphInsidersDetected > 0) {
      melt.insiderGraph = report.graphInsidersDetected;
    }
  }

  if ((!melt.group2_top10_pct || melt.group2_top10_pct === 0) && largest) {
    const supply = Number(report?.token?.supply || 0);
    const total = supply > 0 ? supply : largest.reduce((a, b) => a + b, 0) || 1;
    const rest = largest[0] / total >= 0.28 ? largest.slice(1) : largest;
    const pcts = rest.map((a) => a / total);
    const top = (n: number) => pcts.slice(0, n).reduce((a, b) => a + b, 0);
    melt.group2_top1_pct = pcts[0] ?? null;
    melt.group2_top5_pct = top(5);
    melt.group2_top10_pct = top(10);
    melt.group2_top20_pct = top(20);
    melt.group2_holder_gini = gini(rest);
    melt.top10HoldPct = top(10);
    melt.curveHoldPct = largest[0] / total >= 0.28 ? largest[0] / total : melt.curveHoldPct;
    melt.lpExcluded = largest[0] / total >= 0.28;
  }

  return { holders, mintAuthority, freezeAuthority, melt };
}

export async function enrichMeltLive(snaps: LaunchSnapshot[], concurrency = 5) {
  let i = 0;
  async function worker() {
    while (i < snaps.length) {
      const idx = i++;
      const snap = snaps[idx];
      const live = await fetchMeltLive(snap.mint, {
        poolAddress: snap.poolAddress,
        creator: snap.creator,
        complete: snap.complete,
      }).catch(() => null);
      if (!live) continue;
      if (live.holders !== undefined) snap.holders = live.holders;
      snap.mintAuthority = live.mintAuthority;
      snap.freezeAuthority = live.freezeAuthority;
      snap.melt = { ...snap.melt, ...live.melt };
      if (live.melt.top10HoldPct != null) snap.top10HoldPct = live.melt.top10HoldPct;
      if (live.melt.devHoldPct != null) snap.devHoldPct = live.melt.devHoldPct;
      if (live.melt.curveHoldPct != null) snap.curveHoldPct = live.melt.curveHoldPct;
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, snaps.length) }, () => worker()));
}
