import { config as loadEnv } from "dotenv";
import { resolve } from "path";
import { clustersFromTape, jitoBundleWallets } from "./clusters";
import { fetchMeltLive, meltFromTrades } from "./meltLive";
import { coins } from "./mongo";
import { scoreAndUpsert } from "./upsert";
import type { CoinDoc, LaunchSnapshot, TapeCandle, TapeFeatures, TapeTrade } from "./types";

loadEnv({ path: resolve(process.cwd(), "../.env") });
loadEnv({ path: resolve(process.cwd(), ".env") });

async function getJson(url: string, timeout = 12_000) {
  const r = await fetch(url, {
    headers: { accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(timeout),
  });
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}

function tapeFromTrades(trades: TapeTrade[], candles: TapeCandle[], creator?: string): TapeFeatures {
  const wallets = new Set(trades.map((t) => t.wallet));
  const sides = new Map<string, Set<string>>();
  let buySol = 0;
  let sellSol = 0;
  let buyCount = 0;
  let sellCount = 0;
  let creatorSold = false;
  for (const t of trades) {
    if (t.side === "buy") {
      buySol += t.sol;
      buyCount += 1;
    } else {
      sellSol += t.sol;
      sellCount += 1;
      if (creator && t.wallet === creator) creatorSold = true;
    }
    const set = sides.get(t.wallet) || new Set();
    set.add(t.side);
    sides.set(t.wallet, set);
  }
  let sameWalletRoundtrip = 0;
  for (const set of sides.values()) if (set.has("buy") && set.has("sell")) sameWalletRoundtrip += 1;
  const highs = candles.map((c) => c.h);
  const last = candles[candles.length - 1]?.c;
  const peak = highs.length ? Math.max(...highs) : 0;
  return {
    uniqueTraders: wallets.size,
    tradeCount: trades.length,
    buyCount,
    sellCount,
    creatorSold,
    washRatio: trades.length ? 1 - wallets.size / trades.length : 0,
    dumpRatio: peak > 0 && last ? clamp01(1 - last / peak) : 0,
    sameWalletRoundtrip,
    buySol,
    sellSol,
  };
}

function clamp01(n: number) {
  return Math.min(1, Math.max(0, n));
}

const PREFERRED_DEX = new Set(["pumpswap", "pumpfun", "raydium", "raydium-clmm", "raydium-launchlab"]);

export type DexPair = {
  chainId?: string;
  dexId?: string;
  pairAddress?: string;
  priceUsd?: string;
  marketCap?: number;
  fdv?: number;
  liquidity?: { usd?: number };
  volume?: { m5?: number; h1?: number };
  priceChange?: { m5?: number; h1?: number };
  txns?: { m5?: { buys?: number; sells?: number } };
  baseToken?: { address?: string };
};

export function pairScore(p: DexPair) {
  const liq = Number(p.liquidity?.usd || 0);
  const vol = Number(p.volume?.h1 || 0) + Number(p.volume?.m5 || 0);
  const mc = Number(p.marketCap || p.fdv || 0);
  let s = liq + vol * 3 + Math.log1p(mc) * 100;
  if (PREFERRED_DEX.has(String(p.dexId || ""))) s += 50_000;
  if (liq <= 0) s -= 2_000_000;
  if (liq > 0 && liq < 80) s -= 500_000;
  return s;
}

export function dexQuote(pairs: DexPair[]) {
  const sol = pairs.filter((p) => p.chainId === "solana");
  sol.sort((a, b) => pairScore(b) - pairScore(a));
  const p = sol[0];
  if (!p) return null;
  return {
    priceUsd: Number(p.priceUsd || 0) || undefined,
    pairAddress: String(p.pairAddress || ""),
    liquidityUsd: p.liquidity?.usd,
    volume5m: p.volume?.m5,
    volume1h: p.volume?.h1,
    change5m: p.priceChange?.m5,
    change1h: p.priceChange?.h1,
    buys5m: p.txns?.m5?.buys,
    sells5m: p.txns?.m5?.sells,
    marketCapUsd: Number(p.marketCap || p.fdv || 0) || undefined,
    dex: p.dexId,
  };
}

export async function fetchDexQuotes(mints: string[]) {
  const out = new Map<string, NonNullable<ReturnType<typeof dexQuote>>>();
  const chunk = 30;
  for (let i = 0; i < mints.length; i += chunk) {
    const part = mints.slice(i, i + chunk).filter(Boolean);
    if (!part.length) continue;
    try {
      const body = (await getJson(
        `https://api.dexscreener.com/latest/dex/tokens/${part.join(",")}`,
        10_000,
      )) as { pairs?: DexPair[] };
      const byMint = new Map<string, DexPair[]>();
      for (const p of body.pairs || []) {
        const mint = p.baseToken?.address;
        if (!mint) continue;
        const rows = byMint.get(mint) || [];
        rows.push(p);
        byMint.set(mint, rows);
      }
      for (const [mint, pairs] of byMint) {
        const q = dexQuote(pairs);
        if (q) out.set(mint, q);
      }
    } catch {
      /* keep going */
    }
  }
  return out;
}

export async function pumpCoin(mint: string) {
  try {
    const row = (await getJson(`https://frontend-api-v3.pump.fun/coins/${mint}`, 8_000)) as Record<string, unknown>;
    if (!row || !row.mint) return null;
    const pool = row.raydium_pool
      ? String(row.raydium_pool)
      : row.pump_swap_pool
        ? String(row.pump_swap_pool)
        : undefined;
    const migrated = Boolean(row.complete) || Boolean(pool);
    const reserves = Number(row.real_sol_reserves || 0);
    return {
      usdMarketCap: Number(row.usd_market_cap || 0) || undefined,
      complete: migrated,
      poolAddress: pool,
      // 0 after migrate is the drained curve, not a live reserve print.
      realSolReserves: migrated || reserves <= 0 ? undefined : reserves,
      twitter: row.twitter ? String(row.twitter) : undefined,
      website: row.website ? String(row.website) : undefined,
      description: row.description ? String(row.description) : undefined,
      athMarketCap: Number(row.ath_market_cap || 0) || undefined,
    };
  } catch {
    return null;
  }
}

async function geckoCandles(
  mint: string,
  poolAddress?: string,
): Promise<{ candles: TapeCandle[]; pool?: string; reserveUsd?: number; fdvUsd?: number }> {
  let pool = poolAddress;
  let reserveUsd: number | undefined;
  let fdvUsd: number | undefined;
  try {
    const body = (await getJson(
      `https://api.geckoterminal.com/api/v2/networks/solana/tokens/${mint}/pools`,
    )) as {
      data?: Array<{
        id?: string;
        attributes?: { reserve_in_usd?: string; fdv_usd?: string };
      }>;
    };
    const ranked = [...(body.data || [])].sort(
      (a, b) => Number(b.attributes?.reserve_in_usd || 0) - Number(a.attributes?.reserve_in_usd || 0),
    );
    const best = ranked[0];
    if (best?.id) pool = best.id.replace(/^solana_/, "");
    const liq = Number(best?.attributes?.reserve_in_usd || 0);
    const fdv = Number(best?.attributes?.fdv_usd || 0);
    if (liq > 0) reserveUsd = liq;
    if (fdv > 0) fdvUsd = fdv;
  } catch {
    /* keep hinted pool */
  }
  if (!pool) return { candles: [] };
  const ohlcv = (await getJson(
    `https://api.geckoterminal.com/api/v2/networks/solana/pools/${pool}/ohlcv/minute?aggregate=1&limit=80`,
  )) as { data?: { attributes?: { ohlcv_list?: number[][] } } };
  const rows = ohlcv.data?.attributes?.ohlcv_list || [];
  const byT = new Map<number, TapeCandle>();
  for (const [t, o, h, l, c, v] of rows) {
    const ts = t * 1000;
    if (c > 0) byT.set(ts, { t: ts, o, h, l, c, v });
  }
  const candles = [...byT.values()].sort((a, b) => a.t - b.t);
  return { candles, pool, reserveUsd, fdvUsd };
}

async function heliusTrades(mint: string, creator?: string): Promise<TapeTrade[]> {
  const key = process.env.HELIUS_API_KEY;
  if (!key) return [];
  const url = `https://api.helius.xyz/v0/addresses/${mint}/transactions?api-key=${key}&limit=40`;
  const txs = (await getJson(url, 15_000)) as Array<{
    timestamp?: number;
    signature?: string;
    slot?: number;
    feePayer?: string;
    tokenTransfers?: Array<{
      mint?: string;
      fromUserAccount?: string;
      toUserAccount?: string;
      tokenAmount?: number;
    }>;
    nativeTransfers?: Array<{ fromUserAccount?: string; toUserAccount?: string; amount?: number }>;
  }>;
  if (!Array.isArray(txs)) return [];
  const out: TapeTrade[] = [];
  for (const tx of txs) {
    const tfs = (tx.tokenTransfers || []).filter((t) => t.mint === mint);
    if (tfs.length === 0) continue;
    const native = tx.nativeTransfers || [];
    const solIn = native.reduce((s, n) => s + (n.toUserAccount === tx.feePayer ? n.amount || 0 : 0), 0);
    const solOut = native.reduce((s, n) => s + (n.fromUserAccount === tx.feePayer ? n.amount || 0 : 0), 0);
    const received = tfs.some((t) => t.toUserAccount === tx.feePayer);
    const sent = tfs.some((t) => t.fromUserAccount === tx.feePayer);
    let side: "buy" | "sell" | null = null;
    if (received && !sent) side = "buy";
    else if (sent && !received) side = "sell";
    else if (solOut > solIn) side = "buy";
    else if (solIn > solOut) side = "sell";
    if (!side) continue;
    const sol = Math.max(solIn, solOut) / 1e9;
    const funder = native.find((n) => n.toUserAccount === tx.feePayer && n.fromUserAccount !== tx.feePayer)
      ?.fromUserAccount;
    out.push({
      t: (tx.timestamp || 0) * 1000,
      side,
      sol,
      wallet: tx.feePayer || "",
      sig: tx.signature,
      creator: Boolean(creator && tx.feePayer === creator),
      funder,
      slot: tx.slot,
    });
  }
  return out.sort((a, b) => b.t - a.t);
}

export async function loadTokenTape(mint: string) {
  const col = await coins();
  const existing = await col.findOne({ mint });
  const [dexBody, pump, gecko, trades] = await Promise.all([
    getJson(`https://api.dexscreener.com/latest/dex/tokens/${mint}`).catch(() => ({ pairs: [] })),
    pumpCoin(mint),
    geckoCandles(mint).catch(() => ({ candles: [] as TapeCandle[], pool: undefined, reserveUsd: undefined, fdvUsd: undefined })),
    heliusTrades(mint, existing?.creator).catch(() => [] as TapeTrade[]),
  ]);
  const quote = dexQuote(((dexBody as { pairs?: DexPair[] }).pairs || []) as DexPair[]);
  const pool = gecko.pool || quote?.pairAddress || pump?.poolAddress || existing?.poolAddress;
  const live = await fetchMeltLive(mint, {
    poolAddress: pool,
    creator: existing?.creator,
    complete: pump?.complete ?? existing?.complete,
  }).catch(() => null);
  const candles = gecko.candles;
  const tape = tapeFromTrades(trades, candles, existing?.creator);

  let coin: CoinDoc | null = existing
    ? (({ _id: _omit, ...rest }) => rest as CoinDoc)(existing)
    : null;

  if (existing?.source !== "melt") {
    const snap: LaunchSnapshot = {
      mint,
      venue: existing?.venue || "pump.fun",
      dex: existing?.dex,
      name: existing?.name,
      symbol: existing?.symbol,
      creator: existing?.creator,
      complete: pump?.complete ?? existing?.complete,
      twitter: pump?.twitter || existing?.twitter,
      website: pump?.website || existing?.website,
      description: pump?.description,
      usdMarketCap: pump?.usdMarketCap || quote?.marketCapUsd || gecko.fdvUsd || existing?.marketCapUsd,
      athMarketCap: Math.max(
        pump?.athMarketCap || 0,
        existing?.athMarketCap || 0,
        pump?.usdMarketCap || 0,
        quote?.marketCapUsd || 0,
      ) || undefined,
      priceUsd: quote?.priceUsd || existing?.priceUsd,
      launchedAt: existing?.launchedAt,
      poolAddress: pool,
      realSolReserves:
        (quote?.liquidityUsd && quote.liquidityUsd >= 80) || (gecko.reserveUsd && gecko.reserveUsd >= 80)
          ? undefined
          : pump?.realSolReserves,
      buyers5m: quote?.buys5m,
      sellers5m: quote?.sells5m,
      buys5m: quote?.buys5m,
      sells5m: quote?.sells5m,
      change5m: quote?.change5m,
      change1h: quote?.change1h,
      reserveUsd:
        quote?.liquidityUsd && quote.liquidityUsd >= 80 ? quote.liquidityUsd : gecko.reserveUsd || quote?.liquidityUsd,
      volume5m: quote?.volume5m,
      volume1h: quote?.volume1h,
      holders:
        live?.holders && live.holders > 2
          ? live.holders
          : existing?.holders && existing.holders > 2
            ? existing.holders
            : live?.holders,
      tape,
      melt: {
        ...live?.melt,
        ...meltFromTrades(trades, existing?.launchedAt, existing?.creator),
        ...(await (async () => {
          const extras = await jitoBundleWallets(trades.map((t) => t.sig || "").filter(Boolean));
          const c = clustersFromTape(trades, extras);
          const insider = live?.melt.bundleHoldPct ?? null;
          const tapePct = c.group4_cluster_total_pct ?? c.bundleHoldPct ?? null;
          return {
            ...c,
            bundleHoldPct: insider,
            group4_cluster_total_pct: tapePct,
          };
        })()),
      },
      mintAuthority: live?.mintAuthority,
      freezeAuthority: live?.freezeAuthority,
      top10HoldPct: live?.melt.top10HoldPct ?? undefined,
      devHoldPct: live?.melt.devHoldPct ?? undefined,
      bundleHoldPct: live?.melt.bundleHoldPct ?? undefined,
    };
    const wr = await scoreAndUpsert(snap, "tape");
    const ts = new Date().toISOString();
    if (wr) coin = { ...wr.scored, createdAt: existing?.createdAt || ts, updatedAt: ts };
  }

  return {
    coin,
    candles,
    trades,
    quote,
    tape,
  };
}
