import { randomUUID } from "crypto";
import { notBlacklistedMongo } from "./blacklist";
import { peekDeskStats } from "./deskStats";
import { hasFlag } from "./flags";
import { coins, positions, traderSettings, trades } from "./mongo";
import type { CoinDoc, EquityPoint, PositionDoc, TradeDoc, TraderHistory, TraderSettings } from "./types";

function sizeSol() {
  const n = Number(process.env.AUTO_SIZE_SOL || 0.1);
  return Number.isFinite(n) && n > 0 ? n : 0.1;
}

function maxOpen() {
  const n = Number(process.env.AUTO_MAX_OPEN || 20);
  return Number.isFinite(n) ? Math.max(1, Math.min(50, n)) : 20;
}

export function defaultTraderSettings(): TraderSettings {
  return {
    enabled: false,
    sizeSol: sizeSol(),
    maxOpen: maxOpen(),
    updatedAt: new Date().toISOString(),
  };
}

export async function getTraderSettings(): Promise<TraderSettings> {
  const col = await traderSettings();
  void (await positions()).createIndex({ mint: 1, status: 1 }).catch(() => null);
  const row = await col.findOne({ _id: "auto" });
  if (!row) return defaultTraderSettings();
  const { _id: _omit, ...rest } = row;
  return { ...defaultTraderSettings(), ...rest };
}

export async function setTraderEnabled(enabled: boolean): Promise<TraderSettings> {
  const next = { ...defaultTraderSettings(), ...(await getTraderSettings()), enabled, updatedAt: new Date().toISOString() };
  await (await traderSettings()).updateOne({ _id: "auto" }, { $set: next }, { upsert: true });
  if (enabled) void paperEnterSweep().catch((e) => console.error("[trader] sweep failed", e));
  return next;
}

/** Paper-buy current ENTER books when the switch is flipped on. */
export async function paperEnterSweep() {
  const settings = await getTraderSettings();
  if (!settings.enabled) return;
  const rows = await (await coins())
    .find({ source: "live", $or: [{ status: "enter" }, { flags: "enter" }], ...(await notBlacklistedMongo()) })
    .sort({ updatedAt: -1 })
    .limit(settings.maxOpen * 2)
    .toArray();
  for (const row of rows) {
    await maybeAutoTrade(null, row);
  }
}

function px(c: Pick<CoinDoc, "priceUsd" | "marketCapUsd">) {
  if (typeof c.priceUsd === "number" && c.priceUsd > 0) return c.priceUsd;
  if (typeof c.marketCapUsd === "number" && c.marketCapUsd > 0) return c.marketCapUsd / 1_000_000_000;
  return 0;
}

function shouldFlatten(c: Pick<CoinDoc, "status" | "flags" | "complete" | "minRatio" | "athMarketCap" | "marketCapUsd" | "change5m" | "exitProb">) {
  if (c.status === "exit" || c.status === "rejected") return true;
  if (hasFlag(c, "exit")) return true;
  if ((c.exitProb ?? 0) >= 0.75) return true;
  if ((c.change5m ?? 0) <= -35) return true;
  const ath = c.athMarketCap || 0;
  const mc = c.marketCapUsd || 0;
  if (ath > 0 && mc > 0 && mc / ath < 0.45) return true;
  return false;
}

async function writeFill(fill: TradeDoc) {
  await (await trades()).insertOne(fill);
  const snap = peekDeskStats();
  if (snap) snap.paper += 1;
}

async function openBuy(scored: Omit<CoinDoc, "createdAt" | "updatedAt">, settings: TraderSettings) {
  const priceUsd = px(scored);
  if (priceUsd <= 0) return;
  const openN = await (await positions()).countDocuments({ status: "open" });
  if (openN >= settings.maxOpen) return;
  const existing = await (await positions()).findOne({ mint: scored.mint, status: "open" });
  if (existing) return;

  const id = randomUUID();
  const ts = new Date().toISOString();
  const pos: PositionDoc = {
    id,
    mint: scored.mint,
    symbol: scored.symbol,
    name: scored.name,
    status: "open",
    sol: settings.sizeSol,
    entryPriceUsd: priceUsd,
    entryMc: scored.marketCapUsd,
    openedAt: ts,
    reasonOpen: `ENTER rug ${(scored.rugProb * 100).toFixed(0)}% entry ${(scored.entryProb * 100).toFixed(0)}%`,
  };
  await (await positions()).insertOne(pos);
  console.log(`[trader] paper BUY ${scored.symbol || scored.mint.slice(0, 8)} ${settings.sizeSol} SOL @ ${priceUsd}`);
  await writeFill({
    mint: scored.mint,
    symbol: scored.symbol,
    name: scored.name,
    side: "buy",
    mode: "paper",
    sol: settings.sizeSol,
    priceUsd,
    marketCapUsd: scored.marketCapUsd,
    note: pos.reasonOpen || "paper auto buy",
    createdAt: ts,
    positionId: id,
  });
}

async function closeSell(
  pos: PositionDoc,
  scored: Omit<CoinDoc, "createdAt" | "updatedAt">,
  reason: string,
) {
  const priceUsd = px(scored);
  if (priceUsd <= 0) return;
  const ts = new Date().toISOString();
  const pnlPct = pos.entryPriceUsd > 0 ? priceUsd / pos.entryPriceUsd - 1 : 0;
  const pnlSol = pos.sol * pnlPct;
  await (await positions()).updateOne(
    { id: pos.id },
    {
      $set: {
        status: "closed",
        exitPriceUsd: priceUsd,
        exitMc: scored.marketCapUsd,
        closedAt: ts,
        reasonClose: reason,
        pnlSol,
        pnlPct,
      },
    },
  );
  await writeFill({
    mint: scored.mint,
    symbol: scored.symbol || pos.symbol,
    name: scored.name || pos.name,
    side: "sell",
    mode: "paper",
    sol: pos.sol,
    priceUsd,
    marketCapUsd: scored.marketCapUsd,
    note: reason,
    createdAt: ts,
    positionId: pos.id,
  });
}

/** Buy on first ENTER print, flatten on EXIT / reject / dump. Never throws into ingest. */
export async function maybeAutoTrade(
  _prev: CoinDoc | null | undefined,
  scored: Omit<CoinDoc, "createdAt" | "updatedAt">,
) {
  try {
    const settings = await getTraderSettings();
    if (!settings.enabled) return;

    const pos = await (await positions()).findOne({ mint: scored.mint, status: "open" });
    if (pos && shouldFlatten(scored)) {
      await closeSell(
        pos,
        scored,
        scored.status === "rejected"
          ? `REJECTED rug ${(scored.rugProb * 100).toFixed(0)}%`
          : `EXIT ${(scored.exitProb * 100).toFixed(0)}% · ${(scored.minRatio * 100).toFixed(0)}% ATH`,
      );
      return;
    }

    const nowEnter = hasFlag(scored, "enter") || scored.status === "enter";
    if (!nowEnter || pos) return;
    if (shouldFlatten(scored)) return;
    if (scored.entryProb < 0.35) return;
    await openBuy(scored, settings);
  } catch (e) {
    console.error("[trader] fill failed", e);
  }
}

export async function traderHistory(): Promise<TraderHistory> {
  const settings = await getTraderSettings();
  const posCol = await positions();
  const tradeCol = await trades();
  const [open, closed, fills] = await Promise.all([
    posCol.find({ status: "open" }).sort({ openedAt: -1 }).toArray(),
    posCol.find({ status: "closed" }).sort({ closedAt: -1 }).limit(200).toArray(),
    tradeCol.find({ mode: "paper" }).sort({ createdAt: -1 }).limit(300).toArray(),
  ]);

  const mintPx = new Map<string, number>();
  if (open.length) {
    const live = await (await coins())
      .find({ mint: { $in: open.map((p) => p.mint) } })
      .project({ mint: 1, priceUsd: 1, marketCapUsd: 1 })
      .toArray();
    for (const c of live) mintPx.set(c.mint, px(c));
  }

  let openMtm = 0;
  for (const p of open) {
    const now = mintPx.get(p.mint) || p.entryPriceUsd;
    openMtm += p.sol * (p.entryPriceUsd > 0 ? now / p.entryPriceUsd - 1 : 0);
  }

  const closedAsc = [...closed].sort((a, b) => (a.closedAt || "").localeCompare(b.closedAt || ""));
  let cum = 0;
  const curve: EquityPoint[] = [];
  for (const p of closedAsc) {
    const pnl = p.pnlSol || 0;
    cum += pnl;
    curve.push({ t: p.closedAt || p.openedAt, pnlSol: pnl, cumPnl: cum, equity: cum });
  }
  if (open.length) {
    curve.push({
      t: new Date().toISOString(),
      pnlSol: openMtm,
      cumPnl: cum + openMtm,
      equity: cum + openMtm,
    });
  }

  const wins = closed.filter((p) => (p.pnlSol || 0) > 0).length;
  const losses = closed.filter((p) => (p.pnlSol || 0) < 0).length;
  const realized = closed.reduce((s, p) => s + (p.pnlSol || 0), 0);

  return {
    settings,
    open: open.map(({ _id: _o, ...r }) => {
      const mark = mintPx.get(r.mint) || r.entryPriceUsd;
      const pnlPct = r.entryPriceUsd > 0 ? mark / r.entryPriceUsd - 1 : 0;
      return { ...r, markPriceUsd: mark, pnlSol: r.sol * pnlPct, pnlPct } as PositionDoc;
    }),
    closed: closed.map(({ _id: _c, ...r }) => r as PositionDoc),
    fills: fills.map(({ _id: _t, ...r }) => r as TradeDoc),
    curve,
    stats: {
      open: open.length,
      closed: closed.length,
      wins,
      losses,
      winRate: closed.length ? wins / closed.length : 0,
      realizedPnlSol: realized,
      openMtmSol: openMtm,
      equitySol: realized + openMtm,
    },
  };
}
