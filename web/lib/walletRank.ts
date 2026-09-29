import { firstGmgnRow, gmgnJson } from "./gmgnCli";
import { walletRanks } from "./mongo";
import type { WalletRankDoc, WalletWindow } from "./types";

export const HIT500_MIN = 3;
export const WINRATE_MIN = 0.4;
export const PNL_MIN = 0.3;

const ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,48}$/;

export function parseWalletAddresses(raw: string) {
  const found = raw.match(/[1-9A-HJ-NP-Za-km-z]{32,48}/g) || [];
  return [...new Set(found.filter((a) => ADDR.test(a)))];
}

function num(v: unknown) {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function windowFromStats(row: Record<string, unknown>): WalletWindow {
  const pnl = (row.pnl_stat && typeof row.pnl_stat === "object" ? row.pnl_stat : {}) as Record<string, unknown>;
  const buy = num(row.buy ?? row.buy_count);
  const sell = num(row.sell ?? row.sell_count);
  const cost = num(row.bought_cost ?? row.total_cost);
  const realized = num(row.realized_profit);
  const ratio = num(row.realized_profit_pnl);
  return {
    buy,
    sell,
    trades: buy + sell,
    winrate: num(pnl.winrate ?? row.winrate),
    pnl: ratio || (cost > 0 ? realized / cost : 0),
    realizedUsd: realized,
    costUsd: cost,
    hit500: num(pnl.pnl_gt_5x_num),
    hit2x: num(pnl.pnl_2x_5x_num),
    tokens: num(pnl.token_num),
  };
}

function windowFromProfits(row: Record<string, unknown>): WalletWindow {
  const buy = num(row.buy);
  const sell = num(row.sell);
  const cost = num(row.total_realized_profit_cost ?? row.total_cost ?? row.realized_profit_cost);
  const realized = num(row.total_realized_profit ?? row.realized_profit);
  return {
    buy,
    sell,
    trades: buy + sell,
    winrate: 0,
    pnl: cost > 0 ? realized / cost : 0,
    realizedUsd: realized,
    costUsd: cost,
    hit500: 0,
    hit2x: 0,
    tokens: 0,
  };
}

function gates(d7: WalletWindow) {
  const reasons: string[] = [];
  if (d7.hit500 >= HIT500_MIN) reasons.push(`${d7.hit500} × 500%+ in 7d`);
  else reasons.push(`need ${HIT500_MIN}+ 500% trades in 7d · have ${d7.hit500}`);
  if (d7.winrate >= WINRATE_MIN) reasons.push(`winrate ${(d7.winrate * 100).toFixed(0)}%`);
  else reasons.push(`winrate ${(d7.winrate * 100).toFixed(0)}% < 40%`);
  if (d7.pnl >= PNL_MIN) reasons.push(`7d PnL +${(d7.pnl * 100).toFixed(0)}%`);
  else reasons.push(`7d PnL +${(d7.pnl * 100).toFixed(0)}% < +${(PNL_MIN * 100).toFixed(0)}%`);
  const qualify = d7.hit500 >= HIT500_MIN && d7.winrate >= WINRATE_MIN && d7.pnl >= PNL_MIN;
  return { qualify, reasons };
}

export async function fetchWalletRank(address: string, chain = "sol"): Promise<WalletRankDoc> {
  const s7 = await gmgnJson(["portfolio", "stats", "--chain", chain, "--wallet", address, "--period", "7d"]);
  const s30 = await gmgnJson(["portfolio", "stats", "--chain", chain, "--wallet", address, "--period", "30d"]);
  const pall = await gmgnJson(["portfolio", "profits", "--chain", chain, "--wallet", address, "--period", "all"]).catch(
    () => ({}),
  );
  const r7 = firstGmgnRow(s7);
  const r30 = firstGmgnRow(s30);
  const rall = firstGmgnRow(pall);
  const d7 = windowFromStats(r7);
  const d30 = windowFromStats(r30);
  const all = windowFromProfits(rall);
  const { qualify, reasons } = gates(d7);
  const common = (r7.common && typeof r7.common === "object" ? r7.common : {}) as Record<string, unknown>;
  const tags = Array.isArray(common.tags) ? common.tags.map(String) : [];
  const now = new Date().toISOString();
  return {
    address,
    chain,
    name: String(common.twitter_name || common.name || common.nick_name || "") || undefined,
    tags,
    twitter: String(common.twitter_username || "") || undefined,
    d7,
    d30,
    all,
    qualify,
    reasons,
    fetchedAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

export async function upsertWalletRank(address: string, chain = "sol") {
  const row = await fetchWalletRank(address, chain);
  const col = await walletRanks();
  const existing = await col.findOne({ address });
  const doc = { ...row, createdAt: existing?.createdAt || row.createdAt };
  await col.updateOne({ address }, { $set: doc }, { upsert: true });
  return doc;
}

export async function listWalletRanks(opts?: { qualify?: boolean }) {
  const col = await walletRanks();
  await col.createIndex({ "d7.hit500": -1, qualify: 1 }).catch(() => null);
  const rows = await col.find({}).sort({ "d7.hit500": -1, "d7.winrate": -1, "d7.pnl": -1 }).limit(400).toArray();
  const scored = rows.map(({ _id: _omit, ...r }) => {
    const g = gates(r.d7);
    return { ...r, qualify: g.qualify, reasons: g.reasons } as WalletRankDoc;
  });
  await Promise.all(
    scored
      .filter((r, i) => r.qualify !== rows[i].qualify)
      .map((r) => col.updateOne({ address: r.address }, { $set: { qualify: r.qualify, reasons: r.reasons } })),
  );
  return opts?.qualify ? scored.filter((r) => r.qualify) : scored;
}
