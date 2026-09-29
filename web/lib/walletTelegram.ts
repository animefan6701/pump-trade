import { firstGmgnRow, gmgnJson, unwrapGmgn } from "./gmgnCli";
import { liveBook } from "./liveBook";
import { coins, walletAlertEvents, walletAlertState } from "./mongo";
import type { WalletAlertKind, WalletAlertStateDoc } from "./types";

const DEFAULT_WALLET = "CFJr1M2z3SZpQpBMoY3nagpafvS7Uzanq4L7KVXVKi22";

const g = globalThis as typeof globalThis & { __walletTg?: ReturnType<typeof setInterval> };

function alertWallets() {
  const raw = process.env.WALLET_ALERT_ADDRESS || DEFAULT_WALLET;
  return [...new Set(raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean))];
}

function alertMs() {
  const n = Number(process.env.WALLET_ALERT_MS || 20_000);
  return Number.isFinite(n) && n >= 8_000 ? n : 20_000;
}

function num(v: unknown) {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function esc(s: string) {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] || c));
}

function sideOf(row: Record<string, unknown>) {
  return String(row.event_type || row.type || "").toLowerCase();
}

function mintOf(row: Record<string, unknown>) {
  const token = (row.token && typeof row.token === "object" ? row.token : {}) as Record<string, unknown>;
  return String(token.address || token.token_address || row.base_address || "");
}

function symbolOf(row: Record<string, unknown>) {
  const token = (row.token && typeof row.token === "object" ? row.token : {}) as Record<string, unknown>;
  const raw = String(token.symbol || row.symbol || "TOKEN").slice(0, 24);
  return raw.replace(/[\u0000-\u001f]/g, "") || "TOKEN";
}

function txOf(row: Record<string, unknown>) {
  return String(row.tx_hash || row.transaction_hash || row.signature || "");
}

function money(n: number) {
  if (!n) return "—";
  if (n >= 1000) return `$${n.toFixed(0)}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(4)}`;
}

function px(n: number) {
  if (!n) return "—";
  if (n >= 1) return `$${n.toFixed(4)}`;
  if (n >= 0.0001) return `$${n.toFixed(6)}`;
  return `$${n.toExponential(2)}`;
}

function qty(n: number) {
  if (!n) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K`;
  return n.toFixed(n >= 1 ? 2 : 4);
}

function mc(n: number) {
  if (!n) return "—";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return money(n);
}

function mcFromRow(row: Record<string, unknown>) {
  const token = (row.token && typeof row.token === "object" ? row.token : {}) as Record<string, unknown>;
  const supply = num(token.circulating_supply ?? token.total_supply ?? token.max_supply ?? row.total_supply ?? row.circulating_supply);
  const price = num(row.price_usd ?? token.price_usd ?? token.price);
  return (
    num(token.market_cap ?? token.mc ?? token.usd_market_cap ?? row.market_cap ?? row.usd_market_cap ?? row.mc) ||
    (supply > 0 && price > 0 ? price * supply : 0)
  );
}

async function resolveMc(mint: string, row: Record<string, unknown>) {
  const fromRow = mcFromRow(row);
  if (fromRow > 0) return fromRow;
  try {
    const book = await liveBook(mint);
    if (book && book.usdMarketCap > 0) return book.usdMarketCap;
  } catch {
    /* live book miss is fine */
  }
  try {
    const coin = await (await coins()).findOne({ mint }, { projection: { marketCapUsd: 1 } });
    if (coin?.marketCapUsd && coin.marketCapUsd > 0) return coin.marketCapUsd;
  } catch {
    /* desk cache miss is fine */
  }
  return 0;
}

function entryPrice(row: Record<string, unknown>, side: string) {
  const tokens = num(row.token_amount);
  const basis = num(row.buy_cost_usd);
  if (side === "sell" && basis > 0 && tokens > 0) return basis / tokens;
  return num(row.price_usd);
}

function alertHtml(opts: {
  kind: WalletAlertKind;
  symbol: string;
  address: string;
  mint: string;
  amount: number;
  usd: number;
  entry: number;
  mc: number;
}) {
  const tokenUrl = `https://gmgn.ai/sol/token/${opts.mint}`;
  return [
    `<b>${opts.kind}</b> · ${esc(opts.symbol)}`,
    `Activity: <b>${opts.kind}</b>`,
    `Amount: ${qty(opts.amount)} ${esc(opts.symbol)} (${money(opts.usd)})`,
    `Entry: ${px(opts.entry)}`,
    `MC: ${mc(opts.mc)}`,
    `<a href="${tokenUrl}">${tokenUrl}</a>`,
  ].join("\n");
}

async function tokenHeld(address: string, mint: string) {
  try {
    const raw = await gmgnJson([
      "portfolio",
      "token-balance",
      "--chain",
      "sol",
      "--wallet",
      address,
      "--token",
      mint,
    ]);
    const row = firstGmgnRow(raw);
    const bal = num(row.balance ?? row.ui_amount ?? row.amount ?? row.token_amount);
    const usd = num(row.usd_value ?? row.value);
    return bal > 1e-6 || usd >= 0.5;
  } catch {
    return undefined;
  }
}

function classify(side: string, heldBefore: boolean, heldAfter?: boolean): WalletAlertKind {
  if (side === "buy") return heldBefore ? "BUY MORE" : "FIRST BUY";
  if (heldAfter === false) return "SELL ALL";
  if (heldAfter === true) return "SELL PARTIAL";
  return heldBefore ? "SELL PARTIAL" : "SELL ALL";
}

export async function sendTelegram(html: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chat = process.env.TELEGRAM_CHAT_ID?.trim();
  if (!token || !chat) return false;
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chat,
      text: html,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });
  if (!r.ok) throw new Error(`telegram ${r.status}`);
  return true;
}

async function loadState(address: string): Promise<WalletAlertStateDoc> {
  const col = await walletAlertState();
  const row = await col.findOne({ address });
  if (row) {
    const { _id: _omit, ...rest } = row;
    return rest as WalletAlertStateDoc;
  }
  return { address, primed: false, seen: [], bags: {}, updatedAt: new Date().toISOString() };
}

async function saveState(state: WalletAlertStateDoc) {
  state.updatedAt = new Date().toISOString();
  state.seen = state.seen.slice(-400);
  await (await walletAlertState()).updateOne({ address: state.address }, { $set: state }, { upsert: true });
}

async function pollWallet(address: string) {
  const raw = await gmgnJson([
    "portfolio",
    "activity",
    "--chain",
    "sol",
    "--wallet",
    address,
    "--type",
    "buy",
    "--type",
    "sell",
    "--limit",
    "30",
  ]);
  const body = unwrapGmgn(raw) as { activities?: Record<string, unknown>[] };
  const rows = [...(body.activities || [])].filter((row) => {
    const side = sideOf(row);
    return (side === "buy" || side === "sell") && txOf(row) && mintOf(row);
  });
  const state = await loadState(address);
  const seen = new Set(state.seen);
  const fresh = rows.filter((row) => !seen.has(txOf(row))).sort((a, b) => num(a.timestamp) - num(b.timestamp));

  if (!state.primed) {
    for (const row of rows) {
      seen.add(txOf(row));
      const mint = mintOf(row);
      if (mint) state.bags[mint] = sideOf(row) === "buy";
    }
    state.seen = [...seen];
    state.primed = true;
    await saveState(state);
    console.log(`[wallet-tg] primed ${address.slice(0, 6)}… ${rows.length} prints, alerts from here`);
    return;
  }

  for (const row of fresh) {
    const side = sideOf(row);
    const mint = mintOf(row);
    const tx = txOf(row);
    const heldBefore = Boolean(state.bags[mint]);
    const heldAfter = side === "sell" ? await tokenHeld(address, mint) : true;
    const kind = classify(side, heldBefore, heldAfter);
    state.bags[mint] = side === "buy" ? true : heldAfter !== false;
    seen.add(tx);
    const usd = num(row.cost_usd ?? row.amount_usd);
    const amount = num(row.token_amount);
    const entry = entryPrice(row, side);
    const marketCap = await resolveMc(mint, row);
    const ts = num(row.timestamp);
    const at = ts > 0 ? new Date(ts * 1000).toISOString() : new Date().toISOString();
    const ev = { address, kind, mint, symbol: symbolOf(row), tx, usd, mc: marketCap, at };
    await (await walletAlertEvents()).insertOne(ev);
    const html = alertHtml({
      kind,
      symbol: ev.symbol || "TOKEN",
      address,
      mint,
      amount,
      usd,
      entry,
      mc: marketCap,
    });
    try {
      const sent = await sendTelegram(html);
      console.log(`[wallet-tg] ${kind} ${ev.symbol} ${sent ? "telegram" : "no telegram keys"}`);
    } catch (e) {
      console.error("[wallet-tg] telegram failed", e);
    }
  }
  state.seen = [...seen];
  await saveState(state);
}

async function tick() {
  if (!process.env.TELEGRAM_BOT_TOKEN?.trim() || !process.env.TELEGRAM_CHAT_ID?.trim()) {
    if (!(tick as { warned?: boolean }).warned) {
      console.warn("[wallet-tg] set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env");
      (tick as { warned?: boolean }).warned = true;
    }
  }
  for (const address of alertWallets()) {
    try {
      await pollWallet(address);
    } catch (e) {
      console.error(`[wallet-tg] ${address.slice(0, 6)} failed`, e instanceof Error ? e.message : e);
    }
  }
}

export function startWalletTelegram() {
  if (g.__walletTg) return;
  const ms = alertMs();
  console.log(`[wallet-tg] watching ${alertWallets().join(", ")} every ${ms}ms`);
  setTimeout(() => {
    void tick();
    g.__walletTg = setInterval(() => {
      void tick();
    }, ms);
  }, 12_000);
}
