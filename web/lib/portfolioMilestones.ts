import { gmgnJson, unwrapGmgn } from "./gmgnCli";
import { portfolioMilestoneEvents, portfolioMilestoneTokens } from "./mongo";
import type { PortfolioMilestoneRangeStatus } from "./types";
import { sendTelegram } from "./walletTelegram";

const SOL_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SKIP_MINTS = new Set([
  "So11111111111111111111111111111111111111112",
  "11111111111111111111111111111111",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
]);
const SKIP_SYMBOLS = new Set(["SOL", "WSOL", "USDC", "USDT", "USD1"]);
const LEVELS = [
  { multiple: 1.5, label: "150%" },
  { multiple: 2, label: "200%" },
  { multiple: 3, label: "300%" },
  { multiple: 5, label: "500%" },
  { multiple: 7, label: "700%" },
  { multiple: 9, label: "900%" },
  { multiple: 10, label: "1000%" },
  { multiple: 12, label: "1200%" },
  { multiple: 15, label: "1500%" },
  { multiple: 17, label: "1700%" },
  { multiple: 20, label: "2000%" },
  { multiple: 25, label: "2500%" },
];

const PARTIALS = [
  { multiple: 2, key: "partial_2x", slice: 1, label: "2x" },
  { multiple: 4, key: "partial_4x", slice: 2, label: "4x" },
  { multiple: 8, key: "partial_8x", slice: 3, label: "8x" },
] as const;

const MILESTONE_SKIP = new Set(["200%"]);

const g = globalThis as typeof globalThis & {
  __portfolioMs?: ReturnType<typeof setInterval>;
  __portfolioMsBusy?: boolean;
};

function num(v: unknown) {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function esc(s: string) {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] || c));
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

function alertMs() {
  const n = Number(process.env.PORTFOLIO_MILESTONE_MS || 30_000);
  return Number.isFinite(n) && n >= 12_000 ? n : 30_000;
}

function extraWallets() {
  const raw = process.env.PORTFOLIO_MILESTONE_ADDRESS || "";
  return [...new Set(raw.split(/[\s,]+/).map((s) => s.trim()).filter((s) => SOL_RE.test(s)))];
}

function walletFromRow(row: unknown): string {
  if (typeof row === "string" && SOL_RE.test(row) && !SKIP_MINTS.has(row)) return row;
  if (!row || typeof row !== "object") return "";
  const o = row as Record<string, unknown>;
  for (const key of ["wallet_address", "wallet", "address", "account", "public_key"]) {
    const v = o[key];
    if (typeof v === "string" && SOL_RE.test(v) && !SKIP_MINTS.has(v)) return v;
  }
  return "";
}

function walletsFromInfo(node: unknown) {
  const found = new Set<string>();
  const body = node && typeof node === "object" ? (node as Record<string, unknown>) : {};
  const lists = [body.wallets, body.wallet_list, body.accounts, body.sol_wallets];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const row of list) {
      const w = walletFromRow(row);
      if (w) found.add(w);
    }
  }
  const single = walletFromRow(body);
  if (single) found.add(single);
  return found;
}

async function profileWallets() {
  const found = new Set<string>(extraWallets());
  try {
    const raw = await gmgnJson(["portfolio", "info"]);
    for (const w of walletsFromInfo(unwrapGmgn(raw))) found.add(w);
  } catch (e) {
    console.error("[portfolio-ms] info failed", e instanceof Error ? e.message : e);
  }
  return [...found];
}

type Holding = {
  mint: string;
  symbol: string;
  amount: number;
  usd: number;
  cost: number;
  entry: number;
  entryMc: number;
  price: number;
  mc: number;
  multiple: number;
};

function parseHolding(row: Record<string, unknown>): Holding | null {
  const token = (row.token && typeof row.token === "object" ? row.token : {}) as Record<string, unknown>;
  const mint = String(token.token_address || token.address || row.token_address || "");
  const symbol = String(token.symbol || row.symbol || "TOKEN").replace(/[\u0000-\u001f]/g, "").slice(0, 24) || "TOKEN";
  if (!mint || SKIP_MINTS.has(mint) || SKIP_SYMBOLS.has(symbol.toUpperCase())) return null;
  const amount = num(row.balance ?? row.ui_amount ?? row.token_amount);
  const usd = num(row.usd_value ?? row.value);
  const cost = num(row.accu_cost ?? row.cost);
  const price = num(token.price ?? row.price ?? row.price_usd) || (amount > 0 ? usd / amount : 0);
  const entry = amount > 0 && cost > 0 ? cost / amount : 0;
  const supply = num(token.circulating_supply ?? token.total_supply ?? token.max_supply ?? row.total_supply);
  const mcNow = num(token.market_cap ?? token.mc ?? row.market_cap) || (supply > 0 && price > 0 ? price * supply : 0);
  const entryMc = supply > 0 && entry > 0 ? entry * supply : 0;
  if (!mint || amount <= 0 || entry <= 0 || price <= 0 || usd < 0.5) return null;
  const basisMc = entryMc > 0 ? entryMc : entry;
  const nowMc = mcNow > 0 ? mcNow : price;
  return {
    mint,
    symbol,
    amount,
    usd,
    cost,
    entry,
    entryMc: entryMc || basisMc,
    price,
    mc: nowMc,
    multiple: nowMc / basisMc,
  };
}

function reachedLevels(multiple: number) {
  return LEVELS.filter((lvl) => multiple + 1e-9 >= lvl.multiple);
}

function alertHtml(h: Holding, label: string) {
  const tokenUrl = `https://gmgn.ai/sol/token/${h.mint}`;
  return [
    `<b>${label}</b> · ${esc(h.symbol)}`,
    `Activity: <b>${label}</b> from entry MC`,
    `Entry MC: ${mc(h.entryMc)}`,
    `Now MC: ${mc(h.mc)} (${h.multiple.toFixed(2)}x)`,
    `Entry purchase: ${money(h.cost)}`,
    `Balance: ${qty(h.amount)} ${esc(h.symbol)} (${money(h.usd)})`,
    `<a href="${tokenUrl}">${tokenUrl}</a>`,
  ].join("\n");
}

function partialHtml(h: Holding, slice: (typeof PARTIALS)[number]) {
  const sellAmt = h.amount / 3;
  const sellUsd = h.usd / 3;
  const tokenUrl = `https://gmgn.ai/sol/token/${h.mint}`;
  return [
    `<b>SELL 1/3</b> · SLICE ${slice.slice}/3 · ${slice.label}`,
    `${esc(h.symbol)}`,
    `Action: sell one third now`,
    `Sell: ${qty(sellAmt)} ${esc(h.symbol)} (${money(sellUsd)})`,
    `Leave: ${qty(h.amount - sellAmt)} ${esc(h.symbol)} (${money(h.usd - sellUsd)})`,
    `Entry MC: ${mc(h.entryMc)}`,
    `Now MC: ${mc(h.mc)} (${h.multiple.toFixed(2)}x)`,
    `Entry purchase: ${money(h.cost)}`,
    `<a href="${tokenUrl}">${tokenUrl}</a>`,
  ].join("\n");
}

async function fetchHoldings(address: string) {
  const rows: Holding[] = [];
  let cursor = "";
  for (let page = 0; page < 8; page++) {
    const args = [
      "portfolio",
      "holdings",
      "--chain",
      "sol",
      "--wallet",
      address,
      "--limit",
      "50",
      "--hide-airdrop",
      "true",
      "--hide-closed",
      "true",
    ];
    if (cursor) args.push("--cursor", cursor);
    const raw = await gmgnJson(args);
    const body = unwrapGmgn(raw) as { list?: Record<string, unknown>[]; next?: unknown };
    for (const row of body.list || []) {
      const h = parseHolding(row);
      if (h) rows.push(h);
    }
    cursor = body.next != null && body.next !== "" ? String(body.next) : "";
    if (!cursor) break;
  }
  return rows;
}

async function fire(address: string, h: Holding, label: string, level: number) {
  const ev = {
    address,
    mint: h.mint,
    symbol: h.symbol,
    label,
    level,
    entry: h.entry,
    entryMc: h.entryMc,
    price: h.price,
    mc: h.mc,
    multiple: h.multiple,
    amount: h.amount,
    usd: h.usd,
    at: new Date().toISOString(),
  };
  await (await portfolioMilestoneEvents()).insertOne(ev);
  const sent = await sendTelegram(alertHtml(h, label));
  console.log(`[portfolio-ms] ${label} ${h.symbol} ${h.multiple.toFixed(2)}x ${sent ? "telegram" : "no telegram keys"}`);
}

async function upsertLatest(address: string, h: Holding, range: string) {
  const now = new Date().toISOString();
  await (await portfolioMilestoneTokens()).updateOne(
    { address, mint: h.mint },
    {
      $set: {
        address,
        mint: h.mint,
        symbol: h.symbol,
        entry: h.entry,
        entryMc: h.entryMc,
        cost: h.cost,
        amount: h.amount,
        usd: h.usd,
        price: h.price,
        mc: h.mc,
        multiple: h.multiple,
        range,
        updatedAt: now,
      },
      $setOnInsert: { notified: {} },
    },
    { upsert: true },
  );
}

async function claimPartial(address: string, h: Holding, slice: (typeof PARTIALS)[number]) {
  const now = new Date().toISOString();
  return (await portfolioMilestoneTokens()).findOneAndUpdate(
    { address, mint: h.mint, [`notified.${slice.key}.sent`]: { $ne: true } },
    {
      $set: {
        [`notified.${slice.key}`]: { sent: true, level: slice.multiple, multiple: h.multiple, at: now },
        lastNotified: `SELL 1/3 ${slice.label}`,
        lastNotifiedAt: now,
      },
    },
    { returnDocument: "after" },
  );
}

async function firePartial(address: string, h: Holding, slice: (typeof PARTIALS)[number]) {
  const ev = {
    address,
    mint: h.mint,
    symbol: h.symbol,
    label: `SELL 1/3 ${slice.label}`,
    level: slice.multiple,
    entry: h.entry,
    entryMc: h.entryMc,
    price: h.price,
    mc: h.mc,
    multiple: h.multiple,
    amount: h.amount / 3,
    usd: h.usd / 3,
    at: new Date().toISOString(),
  };
  await (await portfolioMilestoneEvents()).insertOne(ev);
  const sent = await sendTelegram(partialHtml(h, slice));
  console.log(`[portfolio-ms] SELL 1/3 ${slice.label} ${h.symbol} ${h.multiple.toFixed(2)}x ${sent ? "telegram" : "no telegram keys"}`);
}

async function syncPartials(address: string, h: Holding) {
  for (const slice of PARTIALS) {
    if (h.multiple + 1e-9 < slice.multiple) continue;
    const claimed = await claimPartial(address, h, slice);
    if (!claimed) continue;
    try {
      await firePartial(address, h, slice);
    } catch (e) {
      console.error("[portfolio-ms] partial telegram failed", e);
    }
  }
}

async function claimRange(address: string, h: Holding, reached: { multiple: number; label: string }[]) {
  const top = reached[reached.length - 1];
  if (!top) return null;
  const now = new Date().toISOString();
  const notified: Record<string, PortfolioMilestoneRangeStatus> = {};
  for (const lvl of reached) {
    notified[lvl.label] = { sent: true, level: lvl.multiple, multiple: h.multiple, at: now };
  }
  const set: Record<string, unknown> = {
    lastNotified: top.label,
    lastNotifiedAt: now,
  };
  for (const [label, status] of Object.entries(notified)) {
    set[`notified.${label}`] = status;
  }
  return (await portfolioMilestoneTokens()).findOneAndUpdate(
    { address, mint: h.mint, [`notified.${top.label}.sent`]: { $ne: true } },
    { $set: set },
    { returnDocument: "after" },
  );
}

async function syncHolding(address: string, h: Holding) {
  const prev = await (await portfolioMilestoneTokens()).findOne({ address, mint: h.mint });
  const entryReset = Boolean(prev && prev.entry > 0 && Math.abs(h.entry - prev.entry) / prev.entry > 0.2);
  if (entryReset) {
    await (await portfolioMilestoneTokens()).updateOne({ address, mint: h.mint }, { $set: { notified: {} } });
  } else if (prev && prev.entryMc > 0) {
    h.entryMc = prev.entryMc;
    h.multiple = h.mc > 0 && h.entryMc > 0 ? h.mc / h.entryMc : h.multiple;
  }
  const reached = reachedLevels(h.multiple);
  const range = reached.length ? reached[reached.length - 1].label : "below";
  await upsertLatest(address, h, range);
  await syncPartials(address, h);
  const milestone = reached.filter((lvl) => !MILESTONE_SKIP.has(lvl.label));
  if (!milestone.length) return;
  const claimed = await claimRange(address, h, milestone);
  if (!claimed) return;
  try {
    await fire(address, h, milestone[milestone.length - 1].label, milestone[milestone.length - 1].multiple);
  } catch (e) {
    console.error("[portfolio-ms] telegram failed", e);
  }
}

async function pollWallet(address: string) {
  const holdings = await fetchHoldings(address);
  console.log(`[portfolio-ms] sync ${address.slice(0, 6)}… ${holdings.length} bags`);
  for (const h of holdings) {
    await syncHolding(address, h);
  }
}

async function tick() {
  if (g.__portfolioMsBusy) return;
  g.__portfolioMsBusy = true;
  try {
    const wallets = await profileWallets();
    if (!(tick as { logged?: boolean }).logged) {
      console.log(`[portfolio-ms] wallets ${wallets.map((w) => `${w.slice(0, 4)}…${w.slice(-4)}`).join(", ") || "(none)"}`);
      if (!wallets.length) {
        console.warn("[portfolio-ms] API key profile has no bound wallets; set PORTFOLIO_MILESTONE_ADDRESS");
      }
      (tick as { logged?: boolean }).logged = true;
    }
    for (const address of wallets) {
      try {
        await pollWallet(address);
      } catch (e) {
        console.error(`[portfolio-ms] ${address.slice(0, 6)} failed`, e instanceof Error ? e.message : e);
      }
    }
  } finally {
    g.__portfolioMsBusy = false;
  }
}

export function startPortfolioMilestones() {
  if (g.__portfolioMs) return;
  const ms = alertMs();
  console.log(`[portfolio-ms] watching profile holdings every ${ms}ms`);
  setTimeout(() => {
    void tick();
    g.__portfolioMs = setInterval(() => {
      void tick();
    }, ms);
  }, 18_000);
}
