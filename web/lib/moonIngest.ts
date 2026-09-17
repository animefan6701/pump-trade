import { blacklistMints } from "./blacklist";
import { coins, jobs } from "./mongo";
import { enrichMeltLive } from "./meltLive";
import { captureMissingLaunchTapes, fetchDexQuotes, pumpCurveReserve } from "./tape";
import { scoreAndUpsert } from "./upsert";
import type { IngestJobDoc, LaunchSnapshot } from "./types";

const DBC_LIST = "https://dbc.datapi.meteora.ag/pools?sort_by=pool_created_at:desc";
const DEX_DBC = "https://api.dexscreener.com/latest/dex/search?q=meteoradbc";
const DEX_PROFILES = "https://api.dexscreener.com/token-profiles/latest/v1";
const PUMP_COIN = "https://frontend-api-v3.pump.fun/coins";
const QUOTE_MINTS = new Set([
  "So11111111111111111111111111111111111111112",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
]);

type DbcPool = {
  address?: string;
  created_at?: number;
  creator?: string;
  token_x?: { address?: string; name?: string; symbol?: string };
  token_y?: { address?: string };
};

function moonMs() {
  return Math.max(1_500, Number(process.env.MOON_POLL_MS || 2_000));
}

function isMoonMint(mint: string) {
  return /moon$/i.test(mint);
}

function venueFor(mint: string, platform?: string) {
  const p = (platform || "").toLowerCase();
  if (p.includes("moon") || isMoonMint(mint)) return "moonshot";
  if (p.includes("meteora") || p.includes("dbc")) return "meteora";
  return isMoonMint(mint) ? "moonshot" : "meteora";
}

async function getJson(url: string, ms = 10_000) {
  const r = await fetch(url, {
    headers: { accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(ms),
  });
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.json();
}

function dbcSnap(row: DbcPool): LaunchSnapshot | null {
  const mint = String(row.token_x?.address || "");
  if (mint.length < 32 || QUOTE_MINTS.has(mint)) return null;
  const created = Number(row.created_at || 0);
  return {
    mint,
    venue: venueFor(mint),
    dex: "meteora-dbc",
    name: row.token_x?.name || undefined,
    symbol: row.token_x?.symbol || undefined,
    creator: row.creator || undefined,
    complete: false,
    launchedAt: created ? new Date(created).toISOString() : undefined,
    poolAddress: row.address || undefined,
    quoteMint: row.token_y?.address || undefined,
  };
}

export async function fetchRecentDbc(maxAgeMin = 90, maxPages = 6): Promise<LaunchSnapshot[]> {
  const cutoff = Date.now() - maxAgeMin * 60_000;
  const out: LaunchSnapshot[] = [];
  const seen = new Set<string>();
  for (let page = 1; page <= maxPages; page += 1) {
    const body = (await getJson(`${DBC_LIST}&page=${page}&page_size=25`)) as { data?: DbcPool[] };
    const rows = Array.isArray(body.data) ? body.data : [];
    if (!rows.length) break;
    let older = false;
    for (const row of rows) {
      if (Number(row.created_at || 0) && Number(row.created_at) < cutoff) {
        older = true;
        continue;
      }
      const snap = dbcSnap(row);
      if (!snap || seen.has(snap.mint)) continue;
      seen.add(snap.mint);
      out.push(snap);
    }
    if (older || rows.length < 25) break;
  }
  return out;
}

async function fetchDexProfiles(): Promise<LaunchSnapshot[]> {
  try {
    const rows = (await getJson(DEX_PROFILES, 8_000)) as { chainId?: string; tokenAddress?: string }[];
    const out: LaunchSnapshot[] = [];
    const seen = new Set<string>();
    for (const row of Array.isArray(rows) ? rows : []) {
      if (row.chainId !== "solana") continue;
      const mint = String(row.tokenAddress || "");
      if (mint.length < 32 || QUOTE_MINTS.has(mint) || seen.has(mint)) continue;
      if (!isMoonMint(mint)) continue;
      seen.add(mint);
      out.push({
        mint,
        venue: "moonshot",
        dex: "meteora-dbc",
      });
    }
    return out;
  } catch {
    return [];
  }
}

async function fetchDexDbc(): Promise<LaunchSnapshot[]> {
  try {
    const body = (await getJson(DEX_DBC, 8_000)) as {
      pairs?: {
        chainId?: string;
        dexId?: string;
        pairAddress?: string;
        pairCreatedAt?: number;
        baseToken?: { address?: string; name?: string; symbol?: string };
        quoteToken?: { address?: string };
        marketCap?: number;
        fdv?: number;
        liquidity?: { usd?: number };
        priceUsd?: string;
        volume?: { m5?: number; h1?: number };
        priceChange?: { m5?: number; h1?: number };
        txns?: { m5?: { buys?: number; sells?: number } };
      }[];
    };
    const cutoff = Date.now() - 180 * 60_000;
    const out: LaunchSnapshot[] = [];
    const seen = new Set<string>();
    for (const p of body.pairs || []) {
      if (p.chainId !== "solana") continue;
      if (p.dexId !== "meteoradbc" && p.dexId !== "meteora") continue;
      const mint = String(p.baseToken?.address || "");
      if (mint.length < 32 || QUOTE_MINTS.has(mint) || seen.has(mint)) continue;
      if (p.pairCreatedAt && p.pairCreatedAt < cutoff) continue;
      seen.add(mint);
      const mc = Number(p.marketCap || p.fdv || 0) || undefined;
      const m5 = p.txns?.m5;
      out.push({
        mint,
        venue: venueFor(mint, p.dexId),
        dex: p.dexId === "meteoradbc" ? "meteora-dbc" : p.dexId || "meteora",
        name: p.baseToken?.name,
        symbol: p.baseToken?.symbol,
        complete: false,
        launchedAt: p.pairCreatedAt ? new Date(p.pairCreatedAt).toISOString() : undefined,
        poolAddress: p.pairAddress,
        quoteMint: p.quoteToken?.address,
        usdMarketCap: mc,
        priceUsd: p.priceUsd ? Number(p.priceUsd) : undefined,
        reserveUsd: p.liquidity?.usd,
        volume5m: p.volume?.m5,
        volume1h: p.volume?.h1,
        change5m: p.priceChange?.m5,
        change1h: p.priceChange?.h1,
        buyers5m: m5?.buys,
        sellers5m: m5?.sells,
        buys5m: m5?.buys,
        sells5m: m5?.sells,
      });
    }
    return out;
  } catch {
    return [];
  }
}

async function enrichPumpRow(snap: LaunchSnapshot) {
  try {
    const row = (await getJson(`${PUMP_COIN}/${snap.mint}`, 8_000)) as Record<string, unknown>;
    if (!row?.mint) return snap;
    const created = Number(row.created_timestamp || 0);
    snap.name = row.name ? String(row.name) : snap.name;
    snap.symbol = row.symbol ? String(row.symbol) : snap.symbol;
    snap.creator = row.creator ? String(row.creator) : snap.creator;
    snap.description = row.description ? String(row.description) : snap.description;
    snap.twitter = row.twitter ? String(row.twitter) : snap.twitter;
    snap.website = row.website ? String(row.website) : snap.website;
    snap.complete = Boolean(row.complete || snap.complete);
    snap.nsfw = Boolean(row.nsfw);
    snap.usdMarketCap = Number(row.usd_market_cap || row.market_cap_usd || 0) || snap.usdMarketCap;
    snap.athMarketCap = Number(row.ath_market_cap || 0) || snap.athMarketCap;
    snap.reserveUsd = pumpCurveReserve(row) || snap.reserveUsd;
    snap.poolAddress =
      (row.pool_address ? String(row.pool_address) : undefined) ||
      (row.bonding_curve ? String(row.bonding_curve) : undefined) ||
      snap.poolAddress;
    snap.quoteMint = row.quote_mint ? String(row.quote_mint) : snap.quoteMint;
    snap.venue = venueFor(snap.mint, String(row.platform || row.program || snap.venue));
    snap.dex = String(row.program || "").includes("meteora") ? "meteora-dbc" : snap.dex;
    if (created && !snap.launchedAt) snap.launchedAt = new Date(created).toISOString();
  } catch {
    /* list row is enough to insert */
  }
  return snap;
}

export async function fetchMoonLaunches(opts?: { backfillMin?: number }): Promise<{
  snaps: LaunchSnapshot[];
  sources: Record<string, number>;
}> {
  const backfill = opts?.backfillMin ?? 90;
  const [dbc, dex, profiles] = await Promise.all([
    fetchRecentDbc(backfill, backfill > 30 ? 8 : 2),
    fetchDexDbc(),
    fetchDexProfiles(),
  ]);
  const blocked = await blacklistMints();
  const seen = new Set<string>();
  const snaps: LaunchSnapshot[] = [];
  for (const snap of [...profiles, ...dbc, ...dex]) {
    if (blocked.has(snap.mint) || seen.has(snap.mint)) continue;
    seen.add(snap.mint);
    snaps.push(snap);
  }
  snaps.sort((a, b) => Number(isMoonMint(b.mint)) - Number(isMoonMint(a.mint)));
  return { snaps, sources: { meteoraDbc: dbc.length, dexDbc: dex.length, dexMoon: profiles.length } };
}

let moonRunning = false;
let moonBoot = true;

export async function runNewestMoonCycle(): Promise<IngestJobDoc> {
  const result: IngestJobDoc = {
    _id: "moon",
    running: true,
    lastRunAt: new Date().toISOString(),
    inserted: 0,
    updated: 0,
    skipped: 0,
    scored: 0,
    errors: [],
    sources: { meteoraDbc: 0 },
  };
  if (moonRunning) {
    result.running = false;
    result.errors.push("already running");
    return result;
  }
  moonRunning = true;
  try {
    const backfill = moonBoot ? 90 : 25;
    moonBoot = false;
    const { snaps, sources } = await fetchMoonLaunches({ backfillMin: backfill });
    result.sources = sources;
    const blocked = await blacklistMints();
    const col = await coins();
    const fresh: LaunchSnapshot[] = [];
    for (const snap of snaps) {
      if (blocked.has(snap.mint)) {
        result.skipped = (result.skipped || 0) + 1;
        continue;
      }
      const existing = await col.findOne({ mint: snap.mint }, { projection: { mint: 1, source: 1 } });
      if (existing?.source === "melt") {
        result.skipped = (result.skipped || 0) + 1;
        continue;
      }
      if (existing) {
        result.skipped = (result.skipped || 0) + 1;
        continue;
      }
      fresh.push(snap);
    }
    const todo = fresh.slice(0, 16);
    await Promise.all(todo.map((s) => enrichPumpRow(s)));
    const quotes = await fetchDexQuotes(todo.map((s) => s.mint)).catch(() => new Map());
    for (const snap of todo) {
      const q = quotes.get(snap.mint);
      if (!q) continue;
      if (q.marketCapUsd && !snap.usdMarketCap) snap.usdMarketCap = q.marketCapUsd;
      if (q.liquidityUsd && !snap.reserveUsd) snap.reserveUsd = q.liquidityUsd;
      if (q.priceUsd) snap.priceUsd = q.priceUsd;
      if (q.volume5m != null) snap.volume5m = q.volume5m;
      if (q.volume1h != null) snap.volume1h = q.volume1h;
      if (q.change5m != null) snap.change5m = q.change5m;
      if (q.change1h != null) snap.change1h = q.change1h;
      if (q.pairAddress) snap.poolAddress = snap.poolAddress || q.pairAddress;
    }
    if (todo.length) {
      await enrichMeltLive(todo, 2);
      const taped = await captureMissingLaunchTapes(todo.slice(0, 4), 4, 2);
      result.sources = {
        ...(result.sources || {}),
        tape: taped.tried,
        tapeTrades: taped.trades,
        tapeSnipers: taped.snipers,
        tapePump: taped.pump,
        tapeHelius: taped.helius,
      };
      for (const snap of todo) {
        const wr = await scoreAndUpsert(snap, "live");
        if (!wr) {
          result.skipped = (result.skipped || 0) + 1;
          continue;
        }
        result.scored = (result.scored || 0) + 1;
        if (wr.inserted) result.inserted = (result.inserted || 0) + 1;
        else result.updated = (result.updated || 0) + 1;
      }
    }
  } catch (e) {
    result.errors.push(e instanceof Error ? e.message : String(e));
  }
  result.running = false;
  result.nextRunAt = new Date(Date.now() + moonMs()).toISOString();
  await (await jobs()).updateOne({ _id: "moon" }, { $set: result }, { upsert: true });
  moonRunning = false;
  return result;
}

export async function getMoonStatus() {
  return (await jobs()).findOne({ _id: "moon" });
}

export { moonMs };
