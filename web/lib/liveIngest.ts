import { blacklistMints } from "./blacklist";
import { refreshDeskStats } from "./deskStats";
import { failActiveKey, liveSolanaUrls, onHeliusRotate } from "./heliusKeys";
import {
  deskRefreshMs,
  listLiveDeskAccounts,
  liveDeskRefreshMs,
  refreshDeskBooks,
  refreshEnterBooks,
  refreshHotBooks,
  refreshLiveDeskBooks,
  refreshMints,
} from "./hotBooks";
import { coins, jobs } from "./mongo";
import { catchOffbookMigrates } from "./migrateSeries";
import { enrichMeltLive } from "./meltLive";
import { captureMissingLaunchTapes, fetchDexQuotes, needsLaunchTape, pumpCurveReserve } from "./tape";
import { moonMs, runNewestMoonCycle } from "./moonIngest";
import { getTraderSettings, paperEnterSweep } from "./trader";
import { scoreAndUpsert } from "./upsert";
import type { IngestJobDoc, LaunchSnapshot } from "./types";

const PUMPFUN_LIST =
  "https://frontend-api-v3.pump.fun/coins?sort=created_timestamp&order=DESC&includeNsfw=false&offset=0&limit=50";
const PUMPFUN_NEWEST =
  "https://frontend-api-v3.pump.fun/coins?sort=created_timestamp&order=DESC&includeNsfw=false&offset=0&limit=10";
const PUMP_PROGRAM = process.env.PUMP_PROGRAM_ID || "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

type LiveWsState = {
  attached: boolean;
  keyId?: string;
  last4?: string;
  lastError?: string;
  lastOpenAt?: string;
};

const g = globalThis as typeof globalThis & {
  __livePoll?: ReturnType<typeof setInterval>;
  __newestPoll?: ReturnType<typeof setInterval>;
  __moonPoll?: ReturnType<typeof setInterval>;
  __enterPoll?: ReturnType<typeof setInterval>;
  __watchPoll?: ReturnType<typeof setInterval>;
  __migratePoll?: ReturnType<typeof setInterval>;
  __liveDeskPoll?: ReturnType<typeof setInterval>;
  __acctSync?: ReturnType<typeof setInterval>;
  __bookDebounce?: ReturnType<typeof setTimeout>;
  __mintDebounce?: ReturnType<typeof setTimeout>;
  __pendingMints?: Set<string>;
  __acctByKey?: Map<string, number>;
  __subToMint?: Map<number, string>;
  __subReq?: Map<number, { account: string; mint: string }>;
  __nextWsId?: number;
  __trackedMints?: Set<string>;
  __liveWs?: WebSocket;
  __liveWsKey?: string;
  __liveWsBoot?: boolean;
  __liveWsHook?: boolean;
  __liveWsTimer?: ReturnType<typeof setTimeout>;
  __liveWsState?: LiveWsState;
};

function liveMs() {
  return Math.max(5_000, Number(process.env.LIVE_INGEST_MS || 5_000));
}

function newestMs() {
  return Math.max(1_000, Number(process.env.NEWEST_POLL_MS || 1_500));
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
    reserveUsd: pumpCurveReserve(row),
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
    const blocked = await blacklistMints();
    const snaps = (Array.isArray(rows) ? rows : [])
      .map(pumpSnap)
      .filter((x): x is LaunchSnapshot => Boolean(x && !blocked.has(x.mint)));
    result.sources = { pumpfun: snaps.length };
    const col = await coins();
    const fresh: LaunchSnapshot[] = [];
    const needTape: LaunchSnapshot[] = [];
    const staleWatch: LaunchSnapshot[] = [];
    const seenList = new Set<string>();
    for (const snap of snaps) {
      seenList.add(snap.mint);
      const existing = await col.findOne(
        { mint: snap.mint },
        {
          projection: {
            mint: 1,
            source: 1,
            status: 1,
            launchedAt: 1,
            complete: 1,
            migrateAt: 1,
            launchSnipers: 1,
            launchTapeAt: 1,
            tapeTries: 1,
            nextTapeAt: 1,
          },
        },
      );
      if (existing?.source === "melt") {
        result.skipped = (result.skipped || 0) + 1;
        continue;
      }
      if (!existing) {
        fresh.push(snap);
        continue;
      }
      if (needsLaunchTape(existing)) {
        snap.tapeTries = existing.tapeTries;
        snap.launchTapeAt = existing.launchTapeAt;
        snap.nextTapeAt = existing.nextTapeAt;
        needTape.push(snap);
      }
      if (existing.status === "watching") {
        const age = existing.launchedAt
          ? (Date.now() - new Date(existing.launchedAt).getTime()) / 60_000
          : 99;
        if (age >= 6) staleWatch.push(snap);
      }
    }
    const youngCut = new Date(Date.now() - 20 * 60_000).toISOString();
    const pending = await col
      .find({
        source: "live",
        launchedAt: { $gte: youngCut },
        launchSnipers: { $exists: false },
        $and: [
          { $or: [{ tapeTries: { $exists: false } }, { tapeTries: { $lt: 3 } }] },
          { $or: [{ nextTapeAt: { $exists: false } }, { nextTapeAt: { $lte: new Date().toISOString() } }] },
          {
            $or: [
              { launchTapeAt: { $exists: false } },
              { launchTapeAt: { $gte: new Date(Date.now() - 3 * 60_000).toISOString() } },
            ],
          },
        ],
        $or: [{ complete: { $ne: true } }, { migrateAt: { $exists: false } }],
        ...(blocked.size ? { mint: { $nin: [...blocked] } } : {}),
      })
      .sort({ launchedAt: 1 })
      .limit(8)
      .project({
        mint: 1,
        venue: 1,
        symbol: 1,
        name: 1,
        creator: 1,
        launchedAt: 1,
        complete: 1,
        tapeTries: 1,
        launchTapeAt: 1,
        nextTapeAt: 1,
      })
      .toArray();
    const extra: LaunchSnapshot[] = [];
    for (const c of pending) {
      if (seenList.has(c.mint)) continue;
      extra.push({
        mint: c.mint,
        venue: c.venue || "pump.fun",
        symbol: c.symbol,
        name: c.name,
        creator: c.creator,
        launchedAt: c.launchedAt,
        complete: c.complete,
        tapeTries: c.tapeTries,
        launchTapeAt: c.launchTapeAt,
        nextTapeAt: c.nextTapeAt,
      });
    }
    if (fresh.length) await enrichMeltLive(fresh, 4);
    const taped = await captureMissingLaunchTapes([...needTape, ...extra, ...fresh], 8, 3);
    result.sources = {
      ...(result.sources || {}),
      tape: taped.tried,
      tapeTrades: taped.trades,
      tapeSnipers: taped.snipers,
      tapePump: taped.pump,
      tapeHelius: taped.helius,
    };
    const toScore = [...fresh, ...needTape, ...extra, ...staleWatch];
    const seen = new Set<string>();
    const uniq = toScore.filter((s) => (seen.has(s.mint) ? false : (seen.add(s.mint), true)));
    const needQuote = uniq.filter((s) => s.complete);
    if (needQuote.length) {
      const quotes = await fetchDexQuotes(needQuote.map((s) => s.mint)).catch(() => new Map());
      for (const snap of needQuote) {
        const q = quotes.get(snap.mint);
        if (!q) continue;
        if (typeof q.liquidityUsd === "number" && q.liquidityUsd > 0) snap.reserveUsd = q.liquidityUsd;
        if (q.volume5m != null) snap.volume5m = q.volume5m;
        if (q.volume1h != null) snap.volume1h = q.volume1h;
        if (q.change5m != null) snap.change5m = q.change5m;
        if (q.change1h != null) snap.change1h = q.change1h;
        if (q.buys5m != null) snap.buyers5m = q.buys5m;
        if (q.sells5m != null) snap.sellers5m = q.sells5m;
        if (q.marketCapUsd != null && (snap.reserveUsd ?? 0) >= 80 && !(snap.usdMarketCap && snap.usdMarketCap > 0)) {
          snap.usdMarketCap = q.marketCapUsd;
        }
        if (q.dex) snap.dex = q.dex;
      }
    }
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

    const hot = await refreshHotBooks(seen, { kind: "rejected" });
    const offbook = await catchOffbookMigrates(16);
    result.sources = {
      ...(result.sources || {}),
      hot: hot.refreshed,
      hotTape: hot.tape ?? 0,
      hotStale: hot.staleExit ?? 0,
      migrateLock: offbook.locked,
      migrateBars: offbook.bars,
    };
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

let newestRunning = false;

export async function runNewestPumpCycle(): Promise<IngestJobDoc> {
  const result: IngestJobDoc = {
    _id: "newest",
    running: true,
    lastRunAt: new Date().toISOString(),
    inserted: 0,
    updated: 0,
    skipped: 0,
    scored: 0,
    errors: [],
    sources: { pumpfun: 0 },
  };
  if (newestRunning) {
    result.running = false;
    result.errors.push("already running");
    return result;
  }
  newestRunning = true;
  try {
    const rows = (await fetch(PUMPFUN_NEWEST, {
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    }).then((r) => r.json())) as Record<string, unknown>[];
    const blocked = await blacklistMints();
    const snaps = (Array.isArray(rows) ? rows : [])
      .map(pumpSnap)
      .filter((x): x is LaunchSnapshot => Boolean(x && !blocked.has(x.mint)));
    result.sources = { pumpfun: snaps.length };
    const col = await coins();
    const fresh: LaunchSnapshot[] = [];
    for (const snap of snaps) {
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
    if (fresh.length) {
      await enrichMeltLive(fresh, 3);
      const taped = await captureMissingLaunchTapes(fresh, 8, 3);
      result.sources = {
        ...(result.sources || {}),
        tape: taped.tried,
        tapeTrades: taped.trades,
        tapeSnipers: taped.snipers,
        tapePump: taped.pump,
        tapeHelius: taped.helius,
      };
      for (const snap of fresh) {
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
  result.nextRunAt = new Date(Date.now() + newestMs()).toISOString();
  await (await jobs()).updateOne({ _id: "newest" }, { $set: result }, { upsert: true });
  newestRunning = false;
  return result;
}

function wsState(patch: Partial<LiveWsState>) {
  g.__liveWsState = { attached: false, ...g.__liveWsState, ...patch };
}

function dropLiveWs() {
  const ws = g.__liveWs;
  g.__liveWs = undefined;
  g.__liveWsKey = undefined;
  g.__liveWsBoot = false;
  g.__acctByKey = new Map();
  g.__subToMint = new Map();
  g.__subReq = new Map();
  wsState({ attached: false });
  try {
    ws?.close();
  } catch {
    /* already closed */
  }
}

function nextWsId() {
  g.__nextWsId = (g.__nextWsId || 10) + 1;
  return g.__nextWsId;
}

function scheduleBookRefresh(ms: number) {
  if (g.__bookDebounce) return;
  g.__bookDebounce = setTimeout(() => {
    g.__bookDebounce = undefined;
    void refreshLiveDeskBooks().catch((err) => console.error("[live] book refresh failed", err));
  }, ms);
}

function queueMintRefresh(mint: string) {
  if (!mint) return;
  g.__pendingMints = g.__pendingMints || new Set();
  g.__pendingMints.add(mint);
  if (g.__mintDebounce) return;
  g.__mintDebounce = setTimeout(() => {
    g.__mintDebounce = undefined;
    const mints = [...(g.__pendingMints || [])];
    g.__pendingMints = new Set();
    if (!mints.length) return;
    void refreshMints(mints).catch((err) => console.error("[live] mint refresh failed", err));
  }, 200);
}

async function syncAccountSubs(ws: WebSocket) {
  if (ws.readyState !== WebSocket.OPEN) return;
  const accounts = await listLiveDeskAccounts();
  g.__trackedMints = new Set(accounts.map((a) => a.mint));
  const want = new Map<string, string>();
  for (const row of accounts) {
    if (row.poolAddress) want.set(row.poolAddress, row.mint);
  }
  g.__acctByKey = g.__acctByKey || new Map();
  g.__subToMint = g.__subToMint || new Map();
  g.__subReq = g.__subReq || new Map();
  for (const [account, id] of [...g.__acctByKey]) {
    if (want.has(account)) continue;
    g.__acctByKey.delete(account);
    g.__subToMint.delete(id);
    try {
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: nextWsId(), method: "accountUnsubscribe", params: [id] }));
    } catch {
      /* closed */
    }
  }
  for (const [account, mint] of want) {
    if (g.__acctByKey.has(account)) continue;
    const id = nextWsId();
    g.__subReq.set(id, { account, mint });
    try {
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "accountSubscribe",
          params: [account, { encoding: "base64", commitment: "confirmed" }],
        }),
      );
    } catch {
      g.__subReq.delete(id);
    }
  }
}

function handleWsMessage(raw: string) {
  let msg: {
    id?: number;
    method?: string;
    result?: number;
    params?: { subscription?: number; result?: { value?: { logs?: string[] } } };
  };
  try {
    msg = JSON.parse(raw);
  } catch {
    scheduleBookRefresh(400);
    return;
  }
  if (msg.id != null && msg.result != null && g.__subReq?.has(msg.id)) {
    const req = g.__subReq.get(msg.id);
    g.__subReq.delete(msg.id);
    if (req && typeof msg.result === "number") {
      g.__acctByKey = g.__acctByKey || new Map();
      g.__subToMint = g.__subToMint || new Map();
      g.__acctByKey.set(req.account, msg.result);
      g.__subToMint.set(msg.result, req.mint);
    }
    return;
  }
  if (msg.method === "accountNotification") {
    const mint = g.__subToMint?.get(msg.params?.subscription ?? -1);
    if (mint) queueMintRefresh(mint);
    else scheduleBookRefresh(400);
    return;
  }
  if (msg.method === "logsNotification") {
    const logs = msg.params?.result?.value?.logs || [];
    const text = logs.join("\n");
    for (const mint of g.__trackedMints || []) {
      if (text.includes(mint)) queueMintRefresh(mint);
    }
  }
}

function schedulePumpLogSubscribe(ms: number) {
  if (g.__liveWsTimer) clearTimeout(g.__liveWsTimer);
  g.__liveWsTimer = setTimeout(() => {
    g.__liveWsTimer = undefined;
    void startPumpLogSubscribe();
  }, ms);
}

async function startPumpLogSubscribe() {
  if (g.__liveWs || g.__liveWsBoot) return;
  if (typeof WebSocket === "undefined") {
    wsState({ attached: false, lastError: "WebSocket unavailable" });
    console.warn("[live] WebSocket not available — poll only");
    return;
  }
  g.__liveWsBoot = true;
  const urls = await liveSolanaUrls();
  if (!urls) {
    g.__liveWsBoot = false;
    wsState({ attached: false, lastError: "no usable key" });
    schedulePumpLogSubscribe(15_000);
    return;
  }
  if (g.__liveWsKey === urls.id && g.__liveWs) {
    g.__liveWsBoot = false;
    return;
  }
  try {
    const ws = new WebSocket(urls.ws);
    g.__liveWs = ws;
    g.__liveWsKey = urls.id;
    let opened = false;
    let debounce: ReturnType<typeof setTimeout> | undefined;
    ws.onopen = () => {
      opened = true;
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "logsSubscribe",
          params: [{ mentions: [PUMP_PROGRAM] }, { commitment: "confirmed" }],
        }),
      );
      wsState({ attached: true, keyId: urls.id, last4: urls.last4, lastError: undefined, lastOpenAt: new Date().toISOString() });
      console.log(`[live] logsSubscribe + accountSubscribe on SOLANA_WS_URL · …${urls.last4}`);
      void syncAccountSubs(ws).catch((err) => console.error("[live] account subscribe failed", err));
      if (g.__acctSync) clearInterval(g.__acctSync);
      g.__acctSync = setInterval(() => {
        if (g.__liveWs !== ws) return;
        void syncAccountSubs(ws).catch((err) => console.error("[live] account resync failed", err));
      }, 15_000);
    };
    ws.onmessage = (ev) => {
      handleWsMessage(typeof ev.data === "string" ? ev.data : "");
      if (debounce) return;
      debounce = setTimeout(() => {
        debounce = undefined;
        void runLivePumpCycle().catch((err) => console.error("[live] ws trigger failed", err));
      }, 1500);
    };
    ws.onerror = () => {
      wsState({ attached: Boolean(opened), lastError: "ws error" });
      console.warn("[live] ws error — rotating if the socket drops");
    };
    ws.onclose = (ev) => {
      const mine = g.__liveWs === ws;
      if (mine) {
        if (g.__acctSync) {
          clearInterval(g.__acctSync);
          g.__acctSync = undefined;
        }
        g.__liveWs = undefined;
        g.__liveWsKey = undefined;
        g.__liveWsBoot = false;
        g.__acctByKey = new Map();
        g.__subToMint = new Map();
        g.__subReq = new Map();
        wsState({ attached: false, lastError: ev.reason || `ws ${ev.code}` });
      }
      const spent = ev.code === 1008 || ev.code === 1011 || /429|402|credit|quota|payment/i.test(ev.reason || "");
      if (mine && (spent || (!opened && ev.code !== 1000))) {
        void failActiveKey(429, ev.reason || `ws ${ev.code}`);
        schedulePumpLogSubscribe(1_000);
        return;
      }
      if (mine) schedulePumpLogSubscribe(15_000);
    };
  } catch (e) {
    g.__liveWsBoot = false;
    wsState({ attached: false, lastError: e instanceof Error ? e.message : String(e) });
    console.warn("[live] ws not started", e);
    schedulePumpLogSubscribe(15_000);
  }
}

export function startLiveIngest() {
  if (!g.__liveWsHook) {
    g.__liveWsHook = true;
    onHeliusRotate((id) => {
      if (g.__liveWsKey && id && g.__liveWsKey !== id) {
        dropLiveWs();
        schedulePumpLogSubscribe(250);
      }
    });
  }
  void startPumpLogSubscribe();
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
  if (!g.__newestPoll) {
    g.__newestPoll = setTimeout(() => {
      void runNewestPumpCycle().catch((err) => console.error("[newest] cycle failed", err));
      g.__newestPoll = setInterval(() => {
        void runNewestPumpCycle().catch((err) => console.error("[newest] cycle failed", err));
      }, newestMs());
    }, 800);
  }
  if (!g.__moonPoll) {
    g.__moonPoll = setTimeout(() => {
      void runNewestMoonCycle().catch((err) => console.error("[moon] cycle failed", err));
      g.__moonPoll = setInterval(() => {
        void runNewestMoonCycle().catch((err) => console.error("[moon] cycle failed", err));
      }, moonMs());
    }, 1_100);
  }
  const deskMs = deskRefreshMs();
  if (!g.__enterPoll) {
    g.__enterPoll = setTimeout(() => {
      void refreshEnterBooks().catch((err) => console.error("[enter] refresh failed", err));
      g.__enterPoll = setInterval(() => {
        void refreshEnterBooks().catch((err) => console.error("[enter] refresh failed", err));
      }, deskMs);
    }, 1_200);
  }
  if (!g.__watchPoll) {
    g.__watchPoll = setTimeout(() => {
      void refreshDeskBooks("watch").catch((err) => console.error("[watch] refresh failed", err));
      g.__watchPoll = setInterval(() => {
        void refreshDeskBooks("watch").catch((err) => console.error("[watch] refresh failed", err));
      }, deskMs);
    }, 1_600);
  }
  if (!g.__migratePoll) {
    g.__migratePoll = setTimeout(() => {
      void refreshDeskBooks("migrated").catch((err) => console.error("[migrate] refresh failed", err));
      g.__migratePoll = setInterval(() => {
        void refreshDeskBooks("migrated").catch((err) => console.error("[migrate] refresh failed", err));
      }, deskMs);
    }, 2_000);
  }
  const liveDeskMs = liveDeskRefreshMs();
  if (!g.__liveDeskPoll) {
    g.__liveDeskPoll = setTimeout(() => {
      void refreshLiveDeskBooks().catch((err) => console.error("[desk] live refresh failed", err));
      g.__liveDeskPoll = setInterval(() => {
        void refreshLiveDeskBooks().catch((err) => console.error("[desk] live refresh failed", err));
      }, liveDeskMs);
    }, 900);
  }
  console.log(
    `[live] poll + rotating SOLANA_RPC/WS · newest ${newestMs()}ms · moon ${moonMs()}ms · desk quote ${deskMs}ms · live desk ${liveDeskMs}ms`,
  );
}

export async function getLiveStatus() {
  const job = await (await jobs()).findOne({ _id: "live" });
  return { ...(job || { _id: "live", running: false, errors: [] }), ws: g.__liveWsState || { attached: false } };
}

export async function getNewestStatus() {
  return (await jobs()).findOne({ _id: "newest" });
}

export { liveMs, newestMs };
