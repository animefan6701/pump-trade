import { config as loadEnv } from "dotenv";
import { resolve } from "path";
import type { LaunchSnapshot, MeltLiveFeatures, TapeTrade } from "./types";

loadEnv({ path: resolve(process.cwd(), "../.env") });
loadEnv({ path: resolve(process.cwd(), ".env") });

function rpcUrl() {
  return (
    process.env.SOLANA_RPC_URL ||
    (process.env.HELIUS_API_KEY
      ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
      : "")
  );
}

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
  const url = rpcUrl();
  if (!url) return null;
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(8_000),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getTokenLargestAccounts",
      params: [mint],
    }),
  });
  const j = (await r.json()) as {
    result?: { value?: Array<{ uiAmount?: number; amount?: string }> };
  };
  const rows = j.result?.value || [];
  const amounts = rows.map((x) => Number(x.uiAmount || 0)).filter((n) => n > 0);
  return amounts.length ? amounts : null;
}

async function heliusHolderAccounts(mint: string): Promise<number | undefined> {
  const url = rpcUrl();
  if (!url) return undefined;
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(8_000),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getTokenAccounts",
      params: { mint, page: 1, limit: 1, options: { showZeroBalance: false } },
    }),
  });
  const j = (await r.json()) as { result?: { total?: number } };
  const n = j.result?.total;
  return typeof n === "number" && n >= 0 ? n : undefined;
}

export function meltFromTrades(
  trades: TapeTrade[],
  launchedAt?: string,
  creator?: string,
): MeltLiveFeatures {
  if (trades.length === 0) return {};
  const mintTs = launchedAt ? Date.parse(launchedAt) : Math.min(...trades.map((t) => t.t));
  const hasLaunchWindow = trades.some((t) => Math.abs(t.t - mintTs) <= 15_000);
  const wallets = new Set<string>();
  const buyers = new Set<string>();
  const sellers = new Set<string>();
  const sides = new Map<string, Set<string>>();
  let buyN = 0;
  let sellN = 0;
  let buySol = 0;
  let sellSol = 0;
  const sniper0 = new Set<string>();
  const sniper1 = new Set<string>();
  const sniper5 = new Set<string>();
  const sniper10 = new Set<string>();

  for (const t of trades) {
    if (t.wallet) wallets.add(t.wallet);
    const set = sides.get(t.wallet) || new Set();
    set.add(t.side);
    sides.set(t.wallet, set);
    if (t.side === "buy") {
      buyN += 1;
      buySol += t.sol;
      buyers.add(t.wallet);
      if (hasLaunchWindow) {
        const dt = (t.t - mintTs) / 1000;
        if (dt <= 0) sniper0.add(t.wallet);
        if (dt <= 1) sniper1.add(t.wallet);
        if (dt <= 5) sniper5.add(t.wallet);
        if (dt <= 10) sniper10.add(t.wallet);
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

  if (hasLaunchWindow) {
    out.group2_sniper_0s_num = sniper0.size;
    out.group2_sniper_5s_num = sniper5.size;
    out.group2_sniper_10s_num = sniper10.size;
    out.group2_sniper_0s_ratio = sniper0.size / holders;
    out.group2_sniper_1s_ratio = sniper1.size / holders;
    out.group2_sniper_5s_ratio = sniper5.size / holders;
    out.group2_sniper_10s_ratio = sniper10.size / holders;
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
  const [report, accounts] = await Promise.all([
    rugReport(mint).catch(() => null),
    heliusHolderAccounts(mint).catch(() => undefined),
  ]);
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
    const raw = report as RugReport & Record<string, unknown>;
    const reported = [report.totalHolders, report.total_holders, report.holderCount, raw.holders].find(
      (v) => typeof v === "number" && v > 0,
    ) as number | undefined;
    if (reported) holders = holders ? Math.max(holders, reported) : reported;
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
    if (typeof report.creatorBalance === "number" && report.creatorBalance === 0 && opts.complete) {
      melt.creatorSold = true;
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
