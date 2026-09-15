import { coins, jobs, scores } from "./mongo";
import { enrichMeltLive } from "./meltLive";
import { scoreAndUpsert } from "./upsert";
import type { IngestJobDoc, LaunchSnapshot } from "./types";

const PUMPFUN_LIST =
  "https://frontend-api-v3.pump.fun/coins?sort=created_timestamp&order=DESC&includeNsfw=false";
const GECKO_NEW = "https://api.geckoterminal.com/api/v2/networks/solana/new_pools?page=1";

const QUOTE_MINTS = new Set([
  "So11111111111111111111111111111111111111112",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
]);

const DEX_VENUE: Record<string, string> = {
  "pump-fun": "pump.fun",
  pumpswap: "pumpswap",
  "raydium-launchlab": "raydium",
  raydium: "raydium",
  "meteora-damm-v2": "meteora",
  "meteora-dbc": "meteora",
  meteora: "meteora",
  orca: "orca",
  fluxbeam: "fluxbeam",
  "lets-bonk": "letsbonk",
  moonshot: "moonit",
};

let running = false;

function intervalMs() {
  return Math.max(60_000, Number(process.env.INGEST_INTERVAL_MS || 3_600_000));
}

async function getJson(url: string, headers: Record<string, string> = {}) {
  const r = await fetch(url, {
    headers: { accept: "application/json", ...headers },
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.json();
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
    description: row.description ? String(row.description) : undefined,
    creator: row.creator ? String(row.creator) : undefined,
    complete: Boolean(row.complete),
    nsfw: Boolean(row.nsfw),
    banned: Boolean(row.is_banned),
    twitter: row.twitter ? String(row.twitter) : undefined,
    telegram: row.telegram ? String(row.telegram) : undefined,
    website: row.website ? String(row.website) : undefined,
    replyCount: Number(row.reply_count || 0),
    usdMarketCap: Number(row.usd_market_cap || row.market_cap_usd || 0),
    priceUsd: (() => {
      const mc = Number(row.usd_market_cap || row.market_cap_usd || 0);
      const decimals = Number(row.base_decimals || 6);
      const supply = Number(row.total_supply || 0) / 10 ** decimals;
      return mc > 0 && supply > 0 ? mc / supply : undefined;
    })(),
    athMarketCap: Number(row.ath_market_cap || 0) || undefined,
    realSolReserves: Number(row.real_sol_reserves || row.real_quote_reserves || 0),
    launchedAt: created ? new Date(created).toISOString() : undefined,
    poolAddress: row.pool_address ? String(row.pool_address) : row.bonding_curve ? String(row.bonding_curve) : undefined,
    tokenProgram: row.token_program ? String(row.token_program) : undefined,
    quoteMint: row.quote_mint ? String(row.quote_mint) : undefined,
    boostMode: row.boost_mode ? String(row.boost_mode) : undefined,
    livestream: Boolean(row.is_currently_live),
    username: row.username ? String(row.username) : undefined,
  };
}

type GeckoPool = {
  attributes?: {
    name?: string;
    pool_created_at?: string;
    fdv_usd?: string;
    base_token_price_usd?: string;
    reserve_in_usd?: string;
    volume_usd?: { m5?: string };
    price_change_percentage?: { m5?: string };
    transactions?: {
      m5?: { buys?: number; sells?: number; buyers?: number; sellers?: number };
    };
  };
  relationships?: {
    base_token?: { data?: { id?: string } };
    dex?: { data?: { id?: string } };
  };
};

function geckoSnap(row: GeckoPool): LaunchSnapshot | null {
  const id = row.relationships?.base_token?.data?.id || "";
  const mint = id.replace(/^solana_/, "");
  if (!mint || QUOTE_MINTS.has(mint)) return null;
  const dex = row.relationships?.dex?.data?.id || "unknown";
  const a = row.attributes || {};
  const tx = a.transactions?.m5;
  const pair = (a.name || "").split(" / ")[0];
  return {
    mint,
    venue: DEX_VENUE[dex] || dex,
    dex,
    name: pair || undefined,
    symbol: pair || undefined,
    usdMarketCap: Number(a.fdv_usd || 0) || undefined,
    priceUsd: a.base_token_price_usd ? Number(a.base_token_price_usd) : undefined,
    launchedAt: a.pool_created_at,
    buyers5m: tx?.buyers,
    sellers5m: tx?.sellers,
    buys5m: tx?.buys,
    sells5m: tx?.sells,
    change5m: a.price_change_percentage?.m5 ? Number(a.price_change_percentage.m5) : undefined,
    reserveUsd: a.reserve_in_usd ? Number(a.reserve_in_usd) : undefined,
    volume5m: a.volume_usd?.m5 ? Number(a.volume_usd.m5) : undefined,
  };
}

export async function fetchNewLaunches(): Promise<{
  snaps: LaunchSnapshot[];
  sources: Record<string, number>;
}> {
  const limit = Math.min(Number(process.env.INGEST_PUMPFUN_LIMIT || 100), 150);
  const pages = Math.ceil(limit / 50);
  const pumpRows: LaunchSnapshot[] = [];

  for (let i = 0; i < pages; i++) {
    const offset = i * 50;
    const take = Math.min(50, limit - offset);
    const url = `${PUMPFUN_LIST}&offset=${offset}&limit=${take}`;
    const rows = (await getJson(url)) as Record<string, unknown>[];
    if (!Array.isArray(rows)) break;
    for (const row of rows) {
      const snap = pumpSnap(row);
      if (snap) pumpRows.push(snap);
    }
  }

  let geckoRows: LaunchSnapshot[] = [];
  try {
    const body = (await getJson(GECKO_NEW)) as { data?: GeckoPool[] };
    geckoRows = (body.data || []).map(geckoSnap).filter((x): x is LaunchSnapshot => Boolean(x));
  } catch {
    geckoRows = [];
  }

  const seen = new Set<string>();
  const snaps: LaunchSnapshot[] = [];
  for (const snap of [...pumpRows, ...geckoRows]) {
    if (seen.has(snap.mint)) continue;
    seen.add(snap.mint);
    snaps.push(snap);
  }

  await enrichDexscreener(snaps);
  await enrichCreatorCounts(snaps);
  await enrichMeltLive(snaps);

  return {
    snaps,
    sources: { pumpfun: pumpRows.length, geckoterminal: geckoRows.length },
  };
}

async function enrichDexscreener(snaps: LaunchSnapshot[]) {
  const mints = snaps.map((s) => s.mint);
  for (let i = 0; i < mints.length; i += 25) {
    const chunk = mints.slice(i, i + 25);
    try {
      type DexPair = {
        chainId?: string;
        pairAddress?: string;
        priceUsd?: string;
        fdv?: number;
        marketCap?: number;
        liquidity?: { usd?: number };
        volume?: { m5?: number; h1?: number };
        priceChange?: { m5?: number; h1?: number };
        txns?: { m5?: { buys?: number; sells?: number }; h1?: { buys?: number; sells?: number } };
        baseToken?: { address?: string };
      };
      const body = (await getJson(`https://api.dexscreener.com/latest/dex/tokens/${chunk.join(",")}`)) as {
        pairs?: DexPair[];
      };
      const best = new Map<string, DexPair>();
      for (const p of body.pairs || []) {
        if (p.chainId !== "solana") continue;
        const mint = p.baseToken?.address;
        if (!mint) continue;
        const prev = best.get(mint);
        if (!prev || (p.liquidity?.usd || 0) > (prev.liquidity?.usd || 0)) best.set(mint, p);
      }
      for (const snap of snaps) {
        const p = best.get(snap.mint);
        if (!p) continue;
        snap.poolAddress = snap.poolAddress || p.pairAddress;
        if (p.priceUsd) snap.priceUsd = Number(p.priceUsd);
        if (!snap.usdMarketCap) snap.usdMarketCap = p.marketCap || p.fdv;
        snap.reserveUsd = snap.reserveUsd ?? p.liquidity?.usd;
        snap.volume5m = snap.volume5m ?? p.volume?.m5;
        snap.volume1h = p.volume?.h1;
        snap.change5m = snap.change5m ?? p.priceChange?.m5;
        snap.change1h = p.priceChange?.h1;
        const m5 = p.txns?.m5;
        if (m5) {
          snap.buys5m = snap.buys5m ?? m5.buys;
          snap.sells5m = snap.sells5m ?? m5.sells;
          snap.buyers5m = snap.buyers5m ?? m5.buys;
          snap.sellers5m = snap.sellers5m ?? m5.sells;
        }
      }
    } catch {
      /* keep list-only features */
    }
  }
}

async function enrichCreatorCounts(snaps: LaunchSnapshot[]) {
  const batch = new Map<string, number>();
  for (const s of snaps) {
    if (!s.creator) continue;
    batch.set(s.creator, (batch.get(s.creator) || 0) + 1);
  }
  const creators = [...batch.keys()];
  if (creators.length === 0) return;
  try {
    const col = await coins();
    const rows = await col
      .aggregate<{ _id: string; n: number }>([
        { $match: { creator: { $in: creators } } },
        { $group: { _id: "$creator", n: { $sum: 1 } } },
      ])
      .toArray();
    const db = new Map(rows.map((r) => [r._id, r.n]));
    for (const s of snaps) {
      if (!s.creator) continue;
      s.creatorLaunches = (db.get(s.creator) || 0) + (batch.get(s.creator) || 0);
    }
  } catch {
    for (const s of snaps) {
      if (s.creator) s.creatorLaunches = batch.get(s.creator);
    }
  }
}

export async function runIngestCycle(): Promise<IngestJobDoc> {
  if (running) {
    const existing = await (await jobs()).findOne({ _id: "ingest" });
    return (
      existing || {
        _id: "ingest",
        running: true,
        inserted: 0,
        updated: 0,
        skipped: 0,
        scored: 0,
        errors: ["already running"],
      }
    );
  }

  running = true;
  const now = new Date();
  const next = new Date(now.getTime() + intervalMs()).toISOString();
  const col = await coins();
  const jobCol = await jobs();
  await col.createIndex({ mint: 1 }, { unique: true });
  await col.createIndex({ status: 1, updatedAt: -1 });
  await col.createIndex({ source: 1, updatedAt: -1 });
  try {
    await (await scores()).createIndex({ mint: 1, scoredAt: -1 });
  } catch {
    /* optional */
  }

  const result: IngestJobDoc = {
    _id: "ingest",
    running: true,
    lastRunAt: now.toISOString(),
    nextRunAt: next,
    inserted: 0,
    updated: 0,
    skipped: 0,
    scored: 0,
    errors: [],
    sources: {},
  };
  await jobCol.updateOne({ _id: "ingest" }, { $set: result }, { upsert: true });

  try {
    const { snaps, sources } = await fetchNewLaunches();
    result.sources = sources;

    for (const snap of snaps) {
      const existing = await col.findOne({ mint: snap.mint });
      if (existing?.source === "melt") {
        result.skipped = (result.skipped || 0) + 1;
        continue;
      }
      const wr = await scoreAndUpsert(snap, "ingest");
      if (!wr) {
        result.skipped = (result.skipped || 0) + 1;
        continue;
      }
      result.scored = (result.scored || 0) + 1;
      if (wr.inserted) result.inserted = (result.inserted || 0) + 1;
      else result.updated = (result.updated || 0) + 1;
    }
  } catch (e) {
    result.errors.push(e instanceof Error ? e.message : String(e));
  }

  result.running = false;
  result.nextRunAt = new Date(Date.now() + intervalMs()).toISOString();
  await jobCol.updateOne({ _id: "ingest" }, { $set: result }, { upsert: true });
  running = false;
  return result;
}

export async function getIngestStatus(): Promise<IngestJobDoc | null> {
  return (await jobs()).findOne({ _id: "ingest" });
}

export { intervalMs };
