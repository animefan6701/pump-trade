import { config as loadEnv } from "dotenv";
import { resolve } from "path";
import { clustersFromTape, jitoBundleWallets } from "./clusters";
import { heliusRpc } from "./heliusKeys";
import { fetchMeltLive, meltFromTrades, pickSniperFeatures } from "./meltLive";
import { coins } from "./mongo";
import { isBlacklisted } from "./blacklist";
import { scoreAndUpsert } from "./upsert";
import type { CoinDoc, LaunchSnapshot, TapeCandle, TapeFeatures, TapeTrade } from "./types";

loadEnv({ path: resolve(process.cwd(), "../.env") });
loadEnv({ path: resolve(process.cwd(), ".env") });

async function getJson(url: string, timeout = 12_000) {
  const r = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "Mozilla/5.0 (compatible; pump-trade-desk/1.0)",
    },
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
const WSOL = "So11111111111111111111111111111111111111112";
const NATIVE_SOL = "11111111111111111111111111111111";
const SOLISH_QUOTE = new Set([
  WSOL,
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
]);

export function quoteIsSol(mint?: string) {
  const q = (mint || "").trim();
  return !q || q === WSOL || q === NATIVE_SOL;
}

export type DexPair = {
  chainId?: string;
  dexId?: string;
  pairAddress?: string;
  priceUsd?: string;
  priceNative?: string;
  marketCap?: number;
  fdv?: number;
  liquidity?: { usd?: number; base?: number; quote?: number };
  volume?: { m5?: number; h1?: number; h6?: number; h24?: number };
  priceChange?: { m5?: number; h1?: number; h6?: number };
  txns?: {
    m5?: { buys?: number; sells?: number };
    h1?: { buys?: number; sells?: number };
    h6?: { buys?: number; sells?: number };
    h24?: { buys?: number; sells?: number };
  };
  baseToken?: { address?: string };
  quoteToken?: { address?: string; symbol?: string };
};

export function pairVolUsd(p: DexPair) {
  const v = p.volume;
  return Number(v?.h24 || 0) + Number(v?.h6 || 0) + Number(v?.h1 || 0) + Number(v?.m5 || 0);
}

export function pairTxnCount(p: DexPair) {
  const add = (x?: { buys?: number; sells?: number }) => (x?.buys || 0) + (x?.sells || 0);
  const t = p.txns;
  return add(t?.m5) + add(t?.h1) + add(t?.h6) + add(t?.h24);
}

export function isSolishQuote(p: DexPair) {
  const q = p.quoteToken?.address || "";
  return !q || SOLISH_QUOTE.has(q);
}

/** Dex often omits liquidity.usd on meme/non-stable quotes even when the AMM is live. */
export function hasHiddenLp(p: DexPair) {
  const liq = Number(p.liquidity?.usd || 0);
  if (liq > 0) return false;
  if (isSolishQuote(p)) return false;
  return pairTxnCount(p) >= 6 || pairVolUsd(p) > 50;
}

export function solUsdFromPrices(priceUsd?: number, priceNative?: number) {
  const usd = Number(priceUsd || 0);
  const native = Number(priceNative || 0);
  return usd > 0 && native > 0 ? usd / native : undefined;
}

/** GMGN / Pump book: quote SOL × 2. Dex TVL includes dumped token inventory. */
export function solQuoteTvlUsd(p: DexPair) {
  const quoteAmt = Number(p.liquidity?.quote || 0);
  if (quoteAmt <= 0 || !isSolishQuote(p)) return undefined;
  const px = solUsdFromPrices(Number(p.priceUsd), Number(p.priceNative));
  if (!px || px < 10 || px > 5_000) return undefined;
  return quoteAmt * 2 * px;
}

export function solUsdFromPumpMc(usdMarketCap?: number, marketCapSol?: number) {
  const usd = Number(usdMarketCap || 0);
  const sol = Number(marketCapSol || 0);
  return usd > 0 && sol > 0 ? usd / sol : undefined;
}

/** Bonding-curve TVL from Pump reserves. Dex often omits liquidity.usd on these pairs. */
export function curveReserveUsd(opts: {
  realSolLamports?: number;
  virtualSolLamports?: number;
  solUsd?: number;
}) {
  const px = opts.solUsd;
  if (!px || px < 10 || px > 5_000) return undefined;
  const real = (opts.realSolLamports || 0) / 1e9;
  const virt = (opts.virtualSolLamports || 0) / 1e9;
  // TVL is real SOL on both sides of the curve. Virtual SOL is the k-side, not cash LP.
  const sol = real > 0 ? real * 2 : virt;
  return sol > 0 ? sol * px : undefined;
}

export function altQuoteReserveUsd(opts: {
  quoteMint?: string;
  quoteDecimals?: number;
  realQuote?: number;
  virtualQuote?: number;
  quoteUsd?: number;
}) {
  if (quoteIsSol(opts.quoteMint)) return undefined;
  const px = opts.quoteUsd;
  if (!px || px <= 0 || px >= 50) return undefined;
  const dec = Math.min(12, Math.max(0, opts.quoteDecimals ?? 6));
  const scale = 10 ** dec;
  const real = (opts.realQuote || 0) / scale;
  const virt = (opts.virtualQuote || 0) / scale;
  const units = Math.max(real * 2, virt);
  return units > 0 ? units * px : undefined;
}

export function pumpCurveReserve(row: Record<string, unknown>, quoteTokenUsd?: number) {
  if (row.complete) return undefined;
  const quoteMint = String(row.quote_mint || "");
  if (!quoteIsSol(quoteMint)) {
    return altQuoteReserveUsd({
      quoteMint,
      quoteDecimals: Number(row.quote_decimals || 6),
      realQuote: Number(row.real_quote_reserves || row.real_sol_reserves || 0),
      virtualQuote: Number(row.virtual_quote_reserves || row.virtual_sol_reserves || 0),
      quoteUsd: quoteTokenUsd,
    });
  }
  return curveReserveUsd({
    realSolLamports: Number(row.real_sol_reserves || row.real_quote_reserves || 0),
    virtualSolLamports: Number(row.virtual_sol_reserves || row.virtual_quote_reserves || 0),
    solUsd: solUsdFromPumpMc(
      Number(row.usd_market_cap || row.market_cap_usd || 0),
      Number(row.market_cap || 0),
    ),
  });
}

/** Virtual DBC / FDV print — not a tradeable AMM book. Pump curve / PumpSwap is the book. */
export function isVirtualBook(p: DexPair) {
  const dex = String(p.dexId || "").toLowerCase();
  if (dex.includes("pump")) return false;
  const liq = Number(p.liquidity?.usd || 0);
  const vol = pairVolUsd(p);
  const fdv = Number(p.marketCap || p.fdv || 0);
  if (hasHiddenLp(p)) return false;
  if (liq <= 0 && fdv > 1_000) return true;
  if (dex.includes("dbc") && (liq < 80 || vol < Math.max(200, liq * 0.05))) return true;
  return false;
}

export function pairScore(p: DexPair) {
  const liq = Number(p.liquidity?.usd || 0);
  const vol = pairVolUsd(p);
  const dex = String(p.dexId || "");
  const hidden = hasHiddenLp(p);
  let s = vol * 8 + Math.min(liq, 20_000);
  if (PREFERRED_DEX.has(dex)) s += 50_000;
  if (isVirtualBook(p)) s -= 1_500_000;
  else if (dex.includes("dbc")) s -= 20_000;
  if (liq <= 0 && !hidden) s -= 2_000_000;
  if (hidden) s += Math.min(pairTxnCount(p), 500) * 80;
  if (liq > 0 && liq < 80) s += vol * 4;
  return s;
}

export function pickRealPair(pairs: DexPair[]) {
  const sol = pairs.filter((p) => !p.chainId || p.chainId === "solana");
  if (!sol.length) return null;
  const ranked = [...sol].sort((a, b) => pairScore(b) - pairScore(a));
  return ranked[0] || null;
}

export function dexQuote(pairs: DexPair[]) {
  const p = pickRealPair(pairs);
  if (!p) return null;
  const virtual = isVirtualBook(p);
  const tvl = Number(p.liquidity?.usd || 0);
  const pumpDex = String(p.dexId || "").toLowerCase() === "pumpswap";
  const solTvl = pumpDex ? solQuoteTvlUsd(p) : undefined;
  const liq = solTvl && solTvl > 0 ? solTvl : tvl;
  const rawMc = Number(p.marketCap || p.fdv || 0) || undefined;
  return {
    priceUsd: Number(p.priceUsd || 0) || undefined,
    pairAddress: String(p.pairAddress || ""),
    liquidityUsd: virtual ? (liq > 0 && liq < 80 ? liq : 0) : liq > 0 ? liq : undefined,
    solUsd: solUsdFromPrices(Number(p.priceUsd), Number(p.priceNative)),
    volume5m: p.volume?.m5,
    volume1h: p.volume?.h1,
    change5m: p.priceChange?.m5,
    change1h: p.priceChange?.h1,
    change6h: p.priceChange?.h6,
    buys5m: p.txns?.m5?.buys,
    sells5m: p.txns?.m5?.sells,
    marketCapUsd: virtual ? undefined : rawMc,
    dex: p.dexId,
  };
}

type DexQuote = NonNullable<ReturnType<typeof dexQuote>>;
type CacheEntry<T> = { at: number; value: T };

function quoteTtlMs() {
  return Math.max(5_000, Number(process.env.QUOTE_TTL_MS || 20_000));
}

const dexCache = new Map<string, CacheEntry<DexQuote>>();
const pumpCache = new Map<string, CacheEntry<Awaited<ReturnType<typeof fetchPumpCoin>>>>();

function cacheGet<T>(map: Map<string, CacheEntry<T>>, key: string, maxAgeMs?: number): T | undefined {
  const hit = map.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > (maxAgeMs ?? quoteTtlMs())) {
    map.delete(key);
    return undefined;
  }
  return hit.value;
}

function cacheSet<T>(map: Map<string, CacheEntry<T>>, key: string, value: T) {
  map.set(key, { at: Date.now(), value });
  if (map.size <= 4_000) return;
  const now = Date.now();
  const ttl = quoteTtlMs();
  for (const [k, v] of map) if (now - v.at > ttl) map.delete(k);
}

export async function fetchDexQuotes(mints: string[], opts?: { maxAgeMs?: number }) {
  const out = new Map<string, DexQuote>();
  const need: string[] = [];
  for (const mint of mints) {
    if (!mint) continue;
    const hit = cacheGet(dexCache, mint, opts?.maxAgeMs);
    if (hit) out.set(mint, hit);
    else need.push(mint);
  }
  const chunk = 30;
  for (let i = 0; i < need.length; i += chunk) {
    const part = need.slice(i, i + chunk);
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
  const thin = [...out.entries()].filter(([, q]) => (q.liquidityUsd ?? 0) < 80);
  const chunkFill = 6;
  for (let i = 0; i < thin.length; i += chunkFill) {
    await Promise.all(
      thin.slice(i, i + chunkFill).map(async ([mint, q]) => {
        const filled = await fillHiddenLpQuote(mint, q);
        out.set(mint, filled);
        cacheSet(dexCache, mint, filled);
      }),
    );
  }
  for (const [mint, q] of out) {
    if ((q.liquidityUsd ?? 0) >= 80) cacheSet(dexCache, mint, q);
  }
  return out;
}

async function fillHiddenLpQuote(mint: string, q: DexQuote): Promise<DexQuote> {
  if ((q.liquidityUsd ?? 0) >= 80) return q;
  if (String(q.dex || "").toLowerCase().includes("pump")) return q;
  const rows = await fetchGeckoPools(mint);
  const g = geckoQuoteFromRow(pickGeckoRow(rows, q.pairAddress));
  if (!g || (g.reserveUsd ?? 0) < 80) return q;
  return {
    ...q,
    pairAddress: g.pool || q.pairAddress,
    liquidityUsd: g.reserveUsd,
    marketCapUsd: q.marketCapUsd || g.fdvUsd,
    dex: q.dex || g.dex,
    volume5m: q.volume5m ?? g.volume5m,
    volume1h: q.volume1h ?? g.volume1h,
    change5m: q.change5m ?? g.change5m,
    change1h: q.change1h ?? g.change1h,
    change6h: q.change6h ?? g.change6h,
    buys5m: q.buys5m ?? g.buys5m,
    sells5m: q.sells5m ?? g.sells5m,
  };
}

async function fetchPumpCoin(mint: string) {
  try {
    const row = (await getJson(`https://frontend-api-v3.pump.fun/coins/${mint}`, 8_000)) as Record<string, unknown>;
    if (!row || !row.mint) return null;
    const pool = row.raydium_pool
      ? String(row.raydium_pool)
      : row.pump_swap_pool
        ? String(row.pump_swap_pool)
        : undefined;
    const migrated = Boolean(row.complete) || Boolean(pool);
    const quoteMint = row.quote_mint ? String(row.quote_mint) : undefined;
    const solish = quoteIsSol(quoteMint);
    const reserves = Number(row.real_sol_reserves || row.real_quote_reserves || 0);
    const virtualSol = Number(row.virtual_sol_reserves || row.virtual_quote_reserves || 0);
    return {
      usdMarketCap: Number(row.usd_market_cap || row.market_cap_usd || 0) || undefined,
      complete: migrated,
      poolAddress: pool,
      quoteMint,
      quoteDecimals: Number(row.quote_decimals || (solish ? 9 : 6)),
      realQuoteReserves: Number(row.real_quote_reserves || row.real_sol_reserves || 0) || undefined,
      virtualQuoteReserves: Number(row.virtual_quote_reserves || row.virtual_sol_reserves || 0) || undefined,
      // 0 after migrate is the drained curve, not a live reserve print.
      realSolReserves: !solish || migrated || reserves <= 0 ? undefined : reserves,
      virtualSolReserves: !solish || migrated || virtualSol <= 0 ? undefined : virtualSol,
      curveReserveUsd: pumpCurveReserve(row),
      twitter: row.twitter ? String(row.twitter) : undefined,
      website: row.website ? String(row.website) : undefined,
      description: row.description ? String(row.description) : undefined,
      athMarketCap: Number(row.ath_market_cap || 0) || undefined,
    };
  } catch {
    return null;
  }
}

export async function pumpCoin(mint: string, opts?: { maxAgeMs?: number }) {
  const hit = cacheGet(pumpCache, mint, opts?.maxAgeMs);
  if (hit !== undefined) return hit;
  const row = await fetchPumpCoin(mint);
  cacheSet(pumpCache, mint, row);
  return row;
}

export type GeckoPoolRow = {
  id?: string;
  attributes?: {
    reserve_in_usd?: string;
    fdv_usd?: string;
    volume_usd?: { m5?: string; h24?: string; h6?: string; h1?: string };
    price_change_percentage?: { m5?: string; h1?: string; h6?: string };
    transactions?: { m5?: { buys?: number; sells?: number } };
  };
  relationships?: { dex?: { data?: { id?: string } } };
};

function geckoPoolAddr(id?: string) {
  return (id || "").replace(/^solana_/, "");
}

function geckoVol(row: GeckoPoolRow) {
  const v = row.attributes?.volume_usd;
  return Number(v?.h24 || 0) + Number(v?.h6 || 0) + Number(v?.h1 || 0) + Number(v?.m5 || 0);
}

function geckoQuoteFromRow(row?: GeckoPoolRow) {
  if (!row?.id) return undefined;
  const liq = Number(row.attributes?.reserve_in_usd || 0);
  const fdv = Number(row.attributes?.fdv_usd || 0);
  const ch = row.attributes?.price_change_percentage;
  const vol = row.attributes?.volume_usd;
  const tx = row.attributes?.transactions?.m5;
  return {
    pool: geckoPoolAddr(row.id),
    reserveUsd: liq > 0 ? liq : undefined,
    fdvUsd: fdv > 0 ? fdv : undefined,
    dex: row.relationships?.dex?.data?.id,
    volume5m: Number(vol?.m5 || 0) || undefined,
    volume1h: Number(vol?.h1 || 0) || undefined,
    change5m: ch?.m5 !== undefined ? Number(ch.m5) : undefined,
    change1h: ch?.h1 !== undefined ? Number(ch.h1) : undefined,
    change6h: ch?.h6 !== undefined ? Number(ch.h6) : undefined,
    buys5m: tx?.buys,
    sells5m: tx?.sells,
  };
}

export async function fetchGeckoPools(mint: string): Promise<GeckoPoolRow[]> {
  try {
    const body = (await getJson(
      `https://api.geckoterminal.com/api/v2/networks/solana/tokens/${mint}/pools`,
    )) as { data?: GeckoPoolRow[] };
    return [...(body.data || [])];
  } catch {
    return [];
  }
}

export function attachGeckoToPairs(pairs: DexPair[], rows: GeckoPoolRow[]) {
  const byAddr = new Map(rows.map((r) => [geckoPoolAddr(r.id), r]));
  for (const p of pairs) {
    const g = byAddr.get(String(p.pairAddress || ""));
    if (!g) continue;
    const gliq = Number(g.attributes?.reserve_in_usd || 0);
    if (gliq > Number(p.liquidity?.usd || 0)) p.liquidity = { ...(p.liquidity || {}), usd: gliq };
    const fdv = Number(g.attributes?.fdv_usd || 0);
    if (fdv && !p.marketCap && !p.fdv) p.fdv = fdv;
    if (pairVolUsd(p) <= 0) {
      const gv = g.attributes?.volume_usd;
      if (gv) {
        p.volume = {
          m5: Number(gv.m5 || 0) || p.volume?.m5,
          h1: Number(gv.h1 || 0) || p.volume?.h1,
          h6: Number(gv.h6 || 0) || p.volume?.h6,
          h24: Number(gv.h24 || 0) || p.volume?.h24,
        };
      }
    }
  }
}

function pickGeckoRow(rows: GeckoPoolRow[], poolAddress?: string) {
  const hinted = poolAddress ? rows.find((r) => geckoPoolAddr(r.id) === poolAddress) : undefined;
  const ranked = [...rows].sort((a, b) => {
    const dv = geckoVol(b) - geckoVol(a);
    if (Math.abs(dv) > 50) return dv;
    return Number(b.attributes?.reserve_in_usd || 0) - Number(a.attributes?.reserve_in_usd || 0);
  });
  const top = ranked[0];
  const hintLiq = Number(hinted?.attributes?.reserve_in_usd || 0);
  const topLiq = Number(top?.attributes?.reserve_in_usd || 0);
  const hintDust =
    !hinted ||
    hintLiq < 80 ||
    (topLiq >= 80 && hintLiq < topLiq * 0.25 && geckoVol(hinted) < geckoVol(top) * 0.25);
  return hintDust ? top : hinted;
}

async function geckoCandles(
  mint: string,
  poolAddress?: string,
  preloaded?: GeckoPoolRow[],
): Promise<{
  candles: TapeCandle[];
  pool?: string;
  reserveUsd?: number;
  fdvUsd?: number;
  dex?: string;
  volume5m?: number;
  volume1h?: number;
  change5m?: number;
  change1h?: number;
  change6h?: number;
  buys5m?: number;
  sells5m?: number;
}> {
  const rows = preloaded?.length ? preloaded : await fetchGeckoPools(mint);
  let picked = geckoQuoteFromRow(pickGeckoRow(rows, poolAddress));
  const pool = picked?.pool || poolAddress;
  if (pool && !(picked?.reserveUsd)) {
    try {
      const one = (await getJson(
        `https://api.geckoterminal.com/api/v2/networks/solana/pools/${pool}`,
      )) as { data?: GeckoPoolRow };
      picked = geckoQuoteFromRow(one.data) || picked;
    } catch {
      /* keep list pick */
    }
  }
  if (!pool) return { candles: [] };
  const ohlcv = (await getJson(
    `https://api.geckoterminal.com/api/v2/networks/solana/pools/${pool}/ohlcv/minute?aggregate=1&limit=80`,
  )) as { data?: { attributes?: { ohlcv_list?: number[][] } } };
  const ohlcvRows = ohlcv.data?.attributes?.ohlcv_list || [];
  const byT = new Map<number, TapeCandle>();
  for (const [t, o, h, l, c, v] of ohlcvRows) {
    const ts = t * 1000;
    if (c > 0) byT.set(ts, { t: ts, o, h, l, c, v });
  }
  const candles = [...byT.values()].sort((a, b) => a.t - b.t);
  return { candles, ...picked, pool };
}

const TAPE_MAX_TRIES = 3;
const TAPE_RETRY_WINDOW_MS = 3 * 60_000;
const TAPE_BACKOFF_MS = [20_000, 45_000, 90_000];
const HELIUS_TAPE_PER_MIN = 6;
const heliusTapeAt: number[] = [];

function takeHeliusTapeSlot() {
  const now = Date.now();
  while (heliusTapeAt.length && now - heliusTapeAt[0] > 60_000) heliusTapeAt.shift();
  if (heliusTapeAt.length >= HELIUS_TAPE_PER_MIN) return false;
  heliusTapeAt.push(now);
  return true;
}

function coversLaunch(trades: TapeTrade[], launchedAt?: string) {
  if (!trades.length) return false;
  if (!launchedAt) return true;
  const t0 = Date.parse(launchedAt);
  if (!Number.isFinite(t0)) return true;
  if (Date.now() - t0 < 45_000) return true;
  return trades.some((t) => t.t > 0 && t.t <= t0 + 15_000);
}

function accountKey(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object" && "pubkey" in raw) return String((raw as { pubkey: string }).pubkey || "");
  return "";
}

function uiAmt(row?: { uiTokenAmount?: { uiAmount?: number | null; amount?: string; decimals?: number } }) {
  const ui = row?.uiTokenAmount?.uiAmount;
  if (typeof ui === "number" && Number.isFinite(ui)) return ui;
  const raw = Number(row?.uiTokenAmount?.amount || 0);
  const dec = Number(row?.uiTokenAmount?.decimals || 0);
  return raw > 0 ? raw / 10 ** dec : 0;
}

type PumpSwapTrade = {
  tx?: string;
  timestamp?: string;
  userAddress?: string;
  type?: string;
  amountSol?: string | number;
  quoteAmount?: string | number;
  baseAmount?: string | number;
};

async function pumpSwapTrades(mint: string, creator?: string): Promise<TapeTrade[]> {
  const urls = [
    `https://frontend-api-v3.pump.fun/trades/all/${mint}?limit=50&offset=0&minimumSize=0`,
    `https://swap-api.pump.fun/v2/coins/${mint}/trades?limit=50`,
  ];
  for (const url of urls) {
    try {
      const body = (await getJson(url, 10_000)) as PumpSwapTrade[] | { trades?: PumpSwapTrade[] };
      const rows = Array.isArray(body) ? body : body.trades || [];
      if (!rows.length) continue;
      const out: TapeTrade[] = [];
      for (const row of rows) {
        const side = row.type === "buy" || row.type === "sell" ? row.type : null;
        const wallet = String(row.userAddress || "");
        if (!side || !wallet) continue;
        const sol = Number(row.amountSol ?? row.quoteAmount ?? 0);
        const tokens = Number(row.baseAmount ?? 0);
        const t = row.timestamp ? Date.parse(row.timestamp) : 0;
        out.push({
          t: Number.isFinite(t) ? t : 0,
          side,
          sol: Number.isFinite(sol) ? sol : 0,
          tokens: Number.isFinite(tokens) && tokens > 0 ? tokens : undefined,
          wallet,
          sig: row.tx,
          creator: Boolean(creator && wallet === creator),
        });
      }
      if (out.length) return out.sort((a, b) => b.t - a.t);
    } catch {
      /* try next host */
    }
  }
  return [];
}

type AddressTx = {
  slot?: number;
  blockTime?: number;
  transaction?: {
    signatures?: string[];
    message?: { accountKeys?: unknown[] };
  };
  meta?: {
    err?: unknown;
    fee?: number;
    preBalances?: number[];
    postBalances?: number[];
    preTokenBalances?: Array<{
      accountIndex: number;
      mint: string;
      owner?: string;
      uiTokenAmount?: { uiAmount?: number | null; amount?: string; decimals?: number };
    }>;
    postTokenBalances?: Array<{
      accountIndex: number;
      mint: string;
      owner?: string;
      uiTokenAmount?: { uiAmount?: number | null; amount?: string; decimals?: number };
    }>;
  };
};

function parseAddressTx(tx: AddressTx, mint: string, creator?: string): TapeTrade | null {
  if (tx.meta?.err) return null;
  const keys = (tx.transaction?.message?.accountKeys || []).map(accountKey);
  const feePayer = keys[0] || "";
  const pre = (tx.meta?.preTokenBalances || []).filter((b) => b.mint === mint);
  const post = (tx.meta?.postTokenBalances || []).filter((b) => b.mint === mint);
  const preBy = new Map(pre.map((b) => [b.owner || keys[b.accountIndex] || "", uiAmt(b)]));
  const postBy = new Map(post.map((b) => [b.owner || keys[b.accountIndex] || "", uiAmt(b)]));
  const owners = new Set([...preBy.keys(), ...postBy.keys()].filter(Boolean));
  let wallet = "";
  let delta = 0;
  const fpDelta = (postBy.get(feePayer) || 0) - (preBy.get(feePayer) || 0);
  if (Math.abs(fpDelta) > 0) {
    wallet = feePayer;
    delta = fpDelta;
  } else {
    for (const o of owners) {
      const d = (postBy.get(o) || 0) - (preBy.get(o) || 0);
      if (Math.abs(d) > Math.abs(delta)) {
        wallet = o;
        delta = d;
      }
    }
  }
  if (!wallet || Math.abs(delta) < 1e-9) return null;
  const fee = tx.meta?.fee || 0;
  const sol = Math.abs((tx.meta?.preBalances?.[0] || 0) - (tx.meta?.postBalances?.[0] || 0) - fee) / 1e9;
  return {
    t: (tx.blockTime || 0) * 1000,
    side: delta > 0 ? "buy" : "sell",
    sol,
    tokens: Math.abs(delta) || undefined,
    wallet,
    sig: tx.transaction?.signatures?.[0],
    creator: Boolean(creator && wallet === creator),
    slot: tx.slot,
  };
}

async function heliusAddressTrades(mint: string, creator?: string, limit = 40): Promise<TapeTrade[]> {
  if (!takeHeliusTapeSlot()) return [];
  const n = Math.min(40, Math.max(20, limit));
  const j = (await heliusRpc(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "getTransactionsForAddress",
      params: [
        mint,
        {
          transactionDetails: "full",
          encoding: "jsonParsed",
          maxSupportedTransactionVersion: 0,
          sortOrder: "asc",
          limit: n,
          filters: { status: "succeeded", tokenAccounts: "none" },
        },
      ],
    },
    10,
  )) as { result?: { data?: AddressTx[] } } | null;
  if (!j) return [];
  const rows = j.result?.data || [];
  const out: TapeTrade[] = [];
  for (const tx of rows) {
    const trade = parseAddressTx(tx, mint, creator);
    if (trade) out.push(trade);
  }
  return out.sort((a, b) => b.t - a.t);
}

/** Pump.fun swap tape first; cheap Helius RPC only if launch window is still missing. */
export async function fetchLaunchTrades(
  mint: string,
  creator?: string,
  launchedAt?: string,
  limit = 40,
): Promise<{ trades: TapeTrade[]; source: "pump" | "helius" | "none" }> {
  const pump = await pumpSwapTrades(mint, creator).catch(() => [] as TapeTrade[]);
  if (coversLaunch(pump, launchedAt)) return { trades: pump, source: "pump" };
  const helius = await heliusAddressTrades(mint, creator, limit).catch(() => [] as TapeTrade[]);
  if (coversLaunch(helius, launchedAt) || (helius.length && !pump.length)) {
    return { trades: helius, source: "helius" };
  }
  if (pump.length) return { trades: pump, source: "pump" };
  return { trades: [], source: "none" };
}

/** @deprecated launch path no longer uses Enhanced /v0 — kept for any leftover callers. */
export async function heliusTrades(mint: string, creator?: string, limit = 40): Promise<TapeTrade[]> {
  const got = await fetchLaunchTrades(mint, creator, undefined, limit);
  return got.trades;
}

export function needsLaunchTape(existing?: {
  source?: string;
  launchSnipers?: LaunchSnapshot["launchSnipers"] | null;
  complete?: boolean;
  migrateAt?: string;
  launchedAt?: string;
  launchTapeAt?: string;
  tapeTries?: number;
  nextTapeAt?: string;
} | null) {
  if (!existing) return true;
  if (existing.source === "melt") return false;
  if (pickSniperFeatures(existing.launchSnipers)) return false;
  if (existing.complete && existing.migrateAt) return false;
  if ((existing.tapeTries || 0) >= TAPE_MAX_TRIES) return false;
  if (existing.nextTapeAt && Date.now() < Date.parse(existing.nextTapeAt)) return false;
  if (existing.launchTapeAt) {
    const first = Date.parse(existing.launchTapeAt);
    if (Number.isFinite(first) && Date.now() - first > TAPE_RETRY_WINDOW_MS) return false;
  }
  if (!existing.launchedAt) return true;
  const t = Date.parse(existing.launchedAt);
  if (!Number.isFinite(t)) return true;
  return Date.now() - t < 20 * 60_000;
}

function markTapeAttempt(snap: LaunchSnapshot) {
  const tries = (snap.tapeTries || 0) + 1;
  const now = new Date().toISOString();
  snap.tapeTries = tries;
  snap.launchTapeAt = snap.launchTapeAt || now;
  snap.nextTapeAt = new Date(Date.now() + (TAPE_BACKOFF_MS[tries - 1] || 90_000)).toISOString();
}

export async function captureLaunchTape(mint: string, launchedAt?: string, creator?: string, limit = 40) {
  const got = await fetchLaunchTrades(mint, creator, launchedAt, limit);
  const trades = got.trades;
  const melt = meltFromTrades(trades, launchedAt, creator);
  const launchSnipers = coversLaunch(trades, launchedAt) ? pickSniperFeatures(melt) : undefined;
  const launchSigs = trades.map((t) => t.sig).filter((s): s is string => Boolean(s)).slice(0, limit);
  return { launchSnipers, launchSigs, melt, trades, source: got.source };
}

export async function applyLaunchTape(snap: LaunchSnapshot) {
  const cap = await captureLaunchTape(snap.mint, snap.launchedAt, snap.creator, 40);
  markTapeAttempt(snap);
  if (cap.launchSnipers) snap.launchSnipers = { ...snap.launchSnipers, ...cap.launchSnipers };
  if (cap.launchSigs.length) snap.launchSigs = cap.launchSigs;
  snap.melt = { ...snap.melt, ...cap.melt, ...cap.launchSnipers };
  return cap;
}

async function persistTapeAttempt(snap: LaunchSnapshot) {
  const col = await coins();
  await col.updateOne(
    { mint: snap.mint, source: { $ne: "melt" } },
    {
      $set: {
        launchTapeAt: snap.launchTapeAt,
        tapeTries: snap.tapeTries,
        nextTapeAt: snap.nextTapeAt,
        ...(snap.launchSnipers ? { launchSnipers: snap.launchSnipers } : {}),
        ...(snap.launchSigs?.length ? { launchSigs: snap.launchSigs } : {}),
      },
    },
  );
}

export async function captureMissingLaunchTapes(snaps: LaunchSnapshot[], capN: number, concurrency = 4) {
  const seen = new Set<string>();
  const todo = snaps
    .filter((s) => (seen.has(s.mint) ? false : (seen.add(s.mint), true)))
    .sort((a, b) => Date.parse(a.launchedAt || "") - Date.parse(b.launchedAt || ""))
    .slice(0, capN);
  let i = 0;
  let trades = 0;
  let snipers = 0;
  let pump = 0;
  let helius = 0;
  async function worker() {
    while (i < todo.length) {
      const snap = todo[i++];
      try {
        const cap = await applyLaunchTape(snap);
        trades += cap.trades.length;
        if (cap.launchSnipers) snipers += 1;
        if (cap.source === "pump") pump += 1;
        if (cap.source === "helius") helius += 1;
        await persistTapeAttempt(snap).catch(() => null);
      } catch {
        markTapeAttempt(snap);
        await persistTapeAttempt(snap).catch(() => null);
      }
    }
  }
  if (todo.length) {
    await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, () => worker()));
  }
  return { tried: todo.length, trades, snipers, pump, helius };
}

/** Live wash / flow from Pump trades. Never writes launchSnipers. */
export async function attachPumpLiveTape(snaps: LaunchSnapshot[], cap = 16) {
  const todo = snaps.slice(0, cap);
  let attached = 0;
  let i = 0;
  async function worker() {
    while (i < todo.length) {
      const snap = todo[i++];
      try {
        const trades = await pumpSwapTrades(snap.mint, snap.creator);
        if (!trades.length) continue;
        snap.tape = { ...snap.tape, ...tapeFromTrades(trades, [], snap.creator) };
        const live = meltFromTrades(trades, snap.launchedAt, snap.creator);
        snap.melt = {
          ...snap.melt,
          group3_trader_num: live.group3_trader_num,
          group3_buy_num: live.group3_buy_num,
          group3_sell_num: live.group3_sell_num,
          group3_buy_user_num: live.group3_buy_user_num,
          group3_sell_user_num: live.group3_sell_user_num,
          group3_sell_pressure: live.group3_sell_pressure,
          group3_wash_ratio: live.group3_wash_ratio,
          group3_tx_num: live.group3_tx_num,
          group3_time_span: live.group3_time_span,
          group3_tx_per_sec: live.group3_tx_per_sec,
          creatorSold: live.creatorSold ?? snap.melt?.creatorSold,
        };
        attached += 1;
      } catch {
        /* Pump tape is best-effort */
      }
    }
  }
  if (todo.length) {
    await Promise.all(Array.from({ length: Math.min(3, todo.length) }, () => worker()));
  }
  return attached;
}

export async function loadTokenTape(mint: string, opts?: { rescore?: boolean }) {
  if (await isBlacklisted(mint)) {
    return { coin: null, candles: [] as TapeCandle[], trades: [] as TapeTrade[] };
  }
  const col = await coins();
  const existing = await col.findOne({ mint });
  const [dexBody, pump, trades, geckoRows] = await Promise.all([
    getJson(`https://api.dexscreener.com/latest/dex/tokens/${mint}`).catch(() => ({ pairs: [] })),
    pumpCoin(mint, { maxAgeMs: 0 }),
    heliusTrades(mint, existing?.creator, existing?.complete && !existing.migrateAt ? 100 : 40).catch(
      () => [] as TapeTrade[],
    ),
    fetchGeckoPools(mint),
  ]);
  const pairs = ((dexBody as { pairs?: DexPair[] }).pairs || []) as DexPair[];
  attachGeckoToPairs(pairs, geckoRows);
  const quote = dexQuote(pairs);
  const gecko = await geckoCandles(mint, quote?.pairAddress, geckoRows).catch(() => ({
    candles: [] as TapeCandle[],
    pool: undefined,
    reserveUsd: undefined,
    fdvUsd: undefined,
    dex: undefined,
    volume5m: undefined,
    volume1h: undefined,
    change5m: undefined,
    change1h: undefined,
    change6h: undefined,
    buys5m: undefined,
    sells5m: undefined,
  }));
  const quoteLiq = Number(quote?.liquidityUsd || 0);
  const geckoLiq = Number(gecko.reserveUsd || 0);
  const onCurve = !(pump?.complete || existing?.complete);
  const geckoBook = !onCurve && geckoLiq >= 80 && quoteLiq < 80;
  const liveMc = pump?.usdMarketCap || (geckoBook ? gecko.fdvUsd : quote?.marketCapUsd) || gecko.fdvUsd;
  const pool =
    (geckoBook && gecko.pool) ||
    quote?.pairAddress ||
    pump?.poolAddress ||
    gecko.pool ||
    existing?.poolAddress;
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

  if (existing?.source !== "melt" && opts?.rescore !== false) {
    const snap: LaunchSnapshot = {
      mint,
      venue: existing?.venue || "pump.fun",
      dex: (geckoBook && gecko.dex) || quote?.dex || existing?.dex,
      name: existing?.name,
      symbol: existing?.symbol,
      creator: existing?.creator,
      complete: pump?.complete ?? existing?.complete,
      twitter: pump?.twitter || existing?.twitter,
      website: pump?.website || existing?.website,
      description: pump?.description,
      usdMarketCap: liveMc || existing?.marketCapUsd,
      athMarketCap:
        Math.max(
          pump?.athMarketCap || 0,
          existing?.athMarketCap || 0,
          pump?.usdMarketCap || 0,
          geckoBook ? gecko.fdvUsd || 0 : quote?.marketCapUsd || 0,
        ) || undefined,
      priceUsd:
        quote?.priceUsd ||
        (liveMc && liveMc > 0 ? liveMc / 1_000_000_000 : undefined) ||
        existing?.priceUsd,
      launchedAt: existing?.launchedAt,
      poolAddress: pool,
      realSolReserves:
        (geckoBook && (gecko.reserveUsd ?? 0) >= 80) ||
        (quote?.liquidityUsd && quote.liquidityUsd >= 80)
          ? undefined
          : pump?.realSolReserves,
      buyers5m: geckoBook ? gecko.buys5m ?? quote?.buys5m : quote?.buys5m,
      sellers5m: geckoBook ? gecko.sells5m ?? quote?.sells5m : quote?.sells5m,
      buys5m: geckoBook ? gecko.buys5m ?? quote?.buys5m : quote?.buys5m,
      sells5m: geckoBook ? gecko.sells5m ?? quote?.sells5m : quote?.sells5m,
      change5m: geckoBook ? gecko.change5m ?? quote?.change5m : quote?.change5m,
      change1h: geckoBook ? gecko.change1h ?? quote?.change1h : quote?.change1h,
      change6h: geckoBook ? gecko.change6h ?? quote?.change6h : quote?.change6h,
      reserveUsd: geckoBook
        ? gecko.reserveUsd ?? quote?.liquidityUsd
        : (quote?.liquidityUsd && quote.liquidityUsd > 0 ? quote.liquidityUsd : undefined) ??
          gecko.reserveUsd ??
          altQuoteReserveUsd({
            quoteMint: pump?.quoteMint,
            quoteDecimals: pump?.quoteDecimals,
            realQuote: pump?.realQuoteReserves,
            virtualQuote: pump?.virtualQuoteReserves,
            quoteUsd: quote?.solUsd,
          }) ??
          pump?.curveReserveUsd,
      volume5m: geckoBook ? gecko.volume5m ?? quote?.volume5m : quote?.volume5m,
      volume1h: geckoBook ? gecko.volume1h ?? quote?.volume1h : quote?.volume1h,
      holders:
        live?.holders && live.holders > 2
          ? live.holders
          : existing?.holders && existing.holders > 2
            ? existing.holders
            : live?.holders,
      tape,
      launchSnipers: existing?.launchSnipers,
      launchSigs: existing?.launchSigs,
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
            group4_jito_hit: extras.length || null,
          };
        })()),
        ...pickSniperFeatures(existing?.launchSnipers),
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
  } else if (coin) {
    const liq =
      (quote?.liquidityUsd && quote.liquidityUsd > 0 ? quote.liquidityUsd : undefined) ??
      pump?.curveReserveUsd ??
      coin.liquidityUsd;
    const patch = {
      marketCapUsd: liveMc || coin.marketCapUsd,
      priceUsd:
        (liveMc && liveMc > 0 ? liveMc / 1_000_000_000 : undefined) ||
        quote?.priceUsd ||
        coin.priceUsd,
      liquidityUsd: liq,
      volume5m: quote?.volume5m ?? coin.volume5m,
      volume1h: quote?.volume1h ?? coin.volume1h,
      change5m: quote?.change5m ?? coin.change5m,
      change1h: quote?.change1h ?? coin.change1h,
      updatedAt: new Date().toISOString(),
    };
    coin = { ...coin, ...patch };
    if (existing) {
      await col.updateOne({ mint }, { $set: patch }).catch(() => null);
    }
  }

  return {
    coin,
    candles,
    trades,
    quote,
    tape,
  };
}
