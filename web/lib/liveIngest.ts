import { refreshDeskStats } from "./deskStats";
import { refreshHotBooks } from "./hotBooks";
import { coins, jobs } from "./mongo";
import { enrichMeltLive } from "./meltLive";
import { getTraderSettings, paperEnterSweep } from "./trader";
import { scoreAndUpsert } from "./upsert";
import type { IngestJobDoc, LaunchSnapshot } from "./types";

const PUMPFUN_LIST =
  "https://frontend-api-v3.pump.fun/coins?sort=created_timestamp&order=DESC&includeNsfw=false&offset=0&limit=50";
const PUMP_PROGRAM = process.env.PUMP_PROGRAM_ID || "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

const g = globalThis as typeof globalThis & {
  __livePoll?: ReturnType<typeof setInterval>;
  __liveWs?: WebSocket;
};

function liveMs() {
  return Math.max(5_000, Number(process.env.LIVE_INGEST_MS || 5_000));
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
    usdMarketCap: Number(row.usd_market_cap || 0),
    realSolReserves: Number(row.real_sol_reserves || row.real_quote_reserves || 0),
    launchedAt: created ? new Date(created).toISOString() : undefined,
    poolAddress: row.bonding_curve ? String(row.bonding_curve) : row.pool_address ? String(row.pool_address) : undefined,
    tokenProgram: row.token_program ? String(row.token_program) : undefined,
    boostMode: row.boost_mode ? String(row.boost_mode) : undefined,
    livestream: Boolean(row.is_currently_live),
    replyCount: Number(row.reply_count || 0),
    twitter: row.twitter ? String(row.twitter) : undefined,
    website: row.website ? String(row.website) : undefined,
    athMarketCap: Number(row.ath_market_cap || 0) || undefined,
  };
}

let liveRunning = false;

export async function runLivePumpCycle(): Promise<IngestJobDoc> {
  const result: IngestJobDoc = {
    _id: "live",
    running: true,
    lastRunAt: new Date().toISOString(),
    inserted: 0,
    updated: 0,
    skipped: 0,
    scored: 0,
    errors: [],
    sources: { pumpfun: 0 },
  };
  if (liveRunning) {
    result.running = false;
    result.errors.push("already running");
    return result;
  }
  liveRunning = true;
  try {
    const rows = (await fetch(PUMPFUN_LIST, {
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(12_000),
    }).then((r) => r.json())) as Record<string, unknown>[];
    const snaps = (Array.isArray(rows) ? rows : []).map(pumpSnap).filter((x): x is LaunchSnapshot => Boolean(x));
    result.sources = { pumpfun: snaps.length };
    const col = await coins();
    const fresh: LaunchSnapshot[] = [];
    const staleWatch: LaunchSnapshot[] = [];
    for (const snap of snaps) {
      const existing = await col.findOne({ mint: snap.mint }, { projection: { mint: 1, source: 1, status: 1, launchedAt: 1 } });
      if (existing?.source === "melt") {
        result.skipped = (result.skipped || 0) + 1;
        continue;
      }
      if (!existing) fresh.push(snap);
      else if (existing.status === "watching") {
        const age = existing.launchedAt
          ? (Date.now() - new Date(existing.launchedAt).getTime()) / 60_000
          : 99;
        if (age >= 6) staleWatch.push(snap);
      }
    }
    const enrich = [...fresh, ...staleWatch.slice(0, 12)];
    if (enrich.length) await enrichMeltLive(enrich, 4);
    const toScore = [...fresh, ...staleWatch];
    const seen = new Set<string>();
    const uniq = toScore.filter((s) => (seen.has(s.mint) ? false : (seen.add(s.mint), true)));
    for (const snap of uniq) {
      const wr = await scoreAndUpsert(snap, "live");
      if (!wr) {
        result.skipped = (result.skipped || 0) + 1;
        continue;
      }
      result.scored = (result.scored || 0) + 1;
      if (wr.inserted) result.inserted = (result.inserted || 0) + 1;
      else result.updated = (result.updated || 0) + 1;
    }

    const hot = await refreshHotBooks(seen);
    result.sources = { ...(result.sources || {}), hot: hot.refreshed };
    result.scored = (result.scored || 0) + hot.refreshed;
  } catch (e) {
    result.errors.push(e instanceof Error ? e.message : String(e));
  }
  result.running = false;
  result.nextRunAt = new Date(Date.now() + liveMs()).toISOString();
  await (await jobs()).updateOne({ _id: "live" }, { $set: result }, { upsert: true });
  void refreshDeskStats().catch(() => null);
  liveRunning = false;
  return result;
}

function wsUrl() {
  if (process.env.SOLANA_WS_URL) return process.env.SOLANA_WS_URL;
  if (process.env.HELIUS_API_KEY) return `wss://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
  return "";
}

function startPumpLogSubscribe() {
  const url = wsUrl();
  if (!url || g.__liveWs) return;
  if (typeof WebSocket === "undefined") {
    console.warn("[live] WebSocket not available — poll only");
    return;
  }
  let debounce: ReturnType<typeof setTimeout> | undefined;
  try {
    const ws = new WebSocket(url);
    g.__liveWs = ws;
    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "logsSubscribe",
          params: [{ mentions: [PUMP_PROGRAM] }, { commitment: "confirmed" }],
        }),
      );
      console.log("[live] Helius logsSubscribe on Pump.fun program");
    };
    ws.onmessage = () => {
      if (debounce) return;
      debounce = setTimeout(() => {
        debounce = undefined;
        void runLivePumpCycle().catch((err) => console.error("[live] ws trigger failed", err));
      }, 1500);
    };
    ws.onerror = () => {
      console.warn("[live] ws error — staying on poll");
    };
    ws.onclose = () => {
      g.__liveWs = undefined;
      setTimeout(startPumpLogSubscribe, 15_000);
    };
  } catch (e) {
    console.warn("[live] ws not started", e);
  }
}

export function startLiveIngest() {
  if (g.__livePoll) return;
  void refreshDeskStats().catch(() => null);
  void getTraderSettings()
    .then((s) => (s.enabled ? paperEnterSweep() : undefined))
    .catch((err) => console.error("[trader] boot sweep failed", err));
  const ms = liveMs();
  g.__livePoll = setTimeout(() => {
    void runLivePumpCycle().catch((err) => console.error("[live] cycle failed", err));
    g.__livePoll = setInterval(() => {
      void runLivePumpCycle().catch((err) => console.error("[live] cycle failed", err));
    }, ms);
  }, ms);
  startPumpLogSubscribe();
}

export async function getLiveStatus() {
  return (await jobs()).findOne({ _id: "live" });
}

export { liveMs };
