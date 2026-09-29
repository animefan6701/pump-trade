import { heliusRpc } from "./heliusKeys";

const WSOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const TOKEN_PROGRAMS = [
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
];

function quoteIsSol(mint?: string) {
  const q = (mint || "").trim();
  return !q || q === WSOL || q === "11111111111111111111111111111111";
}

function stableQuoteUsd(mint?: string) {
  const q = (mint || "").trim();
  if (q === USDC || q === USDT) return 1;
  return undefined;
}

export type HeliusCurve = {
  bondingCurve: string;
  virtualQuote: number;
  realQuote: number;
  virtualToken: number;
  realToken: number;
  complete: boolean;
  lamports: number;
  quoteUi?: number;
  quoteMint?: string;
  quoteDecimals?: number;
  reserveUsd?: number;
};

type RpcAccount = {
  lamports?: number;
  owner?: string;
  data?: [string, string] | { parsed?: { info?: Record<string, unknown> } };
} | null;

function u64(buf: Buffer, off: number) {
  return Number(buf.readBigUInt64LE(off));
}

/** Raydium Launchpad pool: realB is quote (usually WSOL) raw units. */
export function decodeLaunchpadPool(data: Buffer) {
  if (data.length < 72) return null;
  const read = (off: number) => Number(data.readBigUInt64LE(off));
  const cands = [
    { virtualB: read(45), realB: read(61), status: data[17] },
    { virtualB: read(48), realB: read(64), status: data[17] },
  ].filter((p) => p.realB >= 1_000_000 && p.realB < 1e16);
  if (!cands.length) return null;
  return cands.sort((a, b) => b.realB - a.realB)[0];
}

/** Pump BondingCurve: 8-byte disc + virtual/real token/quote u64s + complete. */
export function decodeBondingCurve(data: Buffer) {
  if (data.length < 49) return null;
  return {
    virtualToken: u64(data, 8),
    virtualQuote: u64(data, 16),
    realToken: u64(data, 24),
    realQuote: u64(data, 32),
    supply: u64(data, 40),
    complete: data[48] === 1,
  };
}

export function heliusReserveUsd(opts: {
  realQuote: number;
  quoteMint?: string;
  quoteDecimals?: number;
  solUsd?: number;
}) {
  if (quoteIsSol(opts.quoteMint)) {
    const px = opts.solUsd;
    if (!px || px < 10 || px > 5_000) return undefined;
    const sol = opts.realQuote / 1e9;
    return sol > 0 ? sol * 2 * px : 0;
  }
  const px = stableQuoteUsd(opts.quoteMint);
  if (!px) return undefined;
  const dec = Math.min(12, Math.max(0, opts.quoteDecimals ?? 6));
  const units = opts.realQuote / 10 ** dec;
  return units > 0 ? units * 2 * px : 0;
}

async function getMultiple(keys: string[], encoding: "base64" | "jsonParsed"): Promise<RpcAccount[]> {
  if (!keys.length) return [];
  const out: RpcAccount[] = [];
  for (let i = 0; i < keys.length; i += 100) {
    const chunk = keys.slice(i, i + 100);
    const j = (await heliusRpc(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "getMultipleAccounts",
        params: [chunk, { encoding, commitment: "confirmed" }],
      },
      1,
    )) as { result?: { value?: RpcAccount[] } } | null;
    out.push(...(j?.result?.value || chunk.map(() => null)));
  }
  return out;
}

async function quoteVaults(owner: string): Promise<{ mint: string; amount: number; decimals: number }[]> {
  const found: { mint: string; amount: number; decimals: number }[] = [];
  for (const programId of TOKEN_PROGRAMS) {
    const j = (await heliusRpc(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "getTokenAccountsByOwner",
        params: [owner, { programId }, { encoding: "jsonParsed", commitment: "confirmed" }],
      },
      1,
    )) as {
      result?: {
        value?: Array<{
          account?: {
            data?: {
              parsed?: {
                info?: {
                  mint?: string;
                  tokenAmount?: { amount?: string; decimals?: number; uiAmount?: number };
                };
              };
            };
          };
        }>;
      };
    } | null;
    for (const row of j?.result?.value || []) {
      const info = row.account?.data?.parsed?.info;
      const mint = info?.mint ? String(info.mint) : "";
      const dec = Number(info?.tokenAmount?.decimals ?? 0);
      const raw = Number(info?.tokenAmount?.amount || 0);
      if (mint && raw >= 0) found.push({ mint, amount: raw, decimals: dec });
    }
  }
  return found;
}

function curveFromAccount(bondingCurve: string, acct: RpcAccount): HeliusCurve | null {
  if (!acct?.data || !Array.isArray(acct.data)) return null;
  const buf = Buffer.from(acct.data[0], "base64");
  const decoded = decodeBondingCurve(buf);
  if (!decoded) return null;
  return {
    bondingCurve,
    virtualQuote: decoded.virtualQuote,
    realQuote: decoded.realQuote,
    virtualToken: decoded.virtualToken,
    realToken: decoded.realToken,
    complete: decoded.complete,
    lamports: Number(acct.lamports || 0),
  };
}

/** Quote vault × 2 for a LaunchLab / AMM pool owner. */
export async function heliusOwnerQuoteUsd(
  owner: string,
  opts?: { quoteMint?: string; solUsd?: number },
) {
  if (!owner) return undefined;
  const vaults = await quoteVaults(owner).catch(() => []);
  const quoteMint = opts?.quoteMint;
  const vault = quoteMint
    ? vaults.find((v) => v.mint === quoteMint)
    : vaults.find((v) => quoteIsSol(v.mint)) || vaults.find((v) => Boolean(stableQuoteUsd(v.mint)));
  if (vault) {
    return heliusReserveUsd({
      realQuote: vault.amount,
      quoteMint: vault.mint,
      quoteDecimals: vault.decimals,
      solUsd: opts?.solUsd,
    });
  }
  const acct = (await getMultiple([owner], "base64"))[0];
  if (!acct?.data || !Array.isArray(acct.data)) return undefined;
  const pool = decodeLaunchpadPool(Buffer.from(acct.data[0], "base64"));
  if (!pool) return undefined;
  return heliusReserveUsd({
    realQuote: pool.realB,
    quoteMint: opts?.quoteMint || WSOL,
    quoteDecimals: quoteIsSol(opts?.quoteMint || WSOL) ? 9 : 6,
    solUsd: opts?.solUsd,
  });
}

/** Batch-decode Pump bonding curves via Helius getMultipleAccounts. */
export async function heliusCurves(accounts: string[]): Promise<Map<string, HeliusCurve>> {
  const keys = [...new Set(accounts.filter(Boolean))];
  const out = new Map<string, HeliusCurve>();
  if (!keys.length) return out;
  const accts = await getMultiple(keys, "base64");
  keys.forEach((key, i) => {
    const row = curveFromAccount(key, accts[i] || null);
    if (row) out.set(key, row);
  });
  return out;
}

/** One-mint live book: curve account + quote vault ATAs. Used by RESCORE. */
export async function heliusLiveBook(opts: {
  bondingCurve?: string;
  quoteMint?: string;
  quoteDecimals?: number;
  solUsd?: number;
}): Promise<HeliusCurve | null> {
  const curve = opts.bondingCurve;
  if (!curve) return null;
  const [curves, vaults] = await Promise.all([heliusCurves([curve]), quoteVaults(curve).catch(() => [])]);
  const row = curves.get(curve);
  if (!row) return null;
  const quoteMint = opts.quoteMint;
  const vault = quoteMint
    ? vaults.find((v) => v.mint === quoteMint)
    : vaults.find((v) => Boolean(stableQuoteUsd(v.mint)));
  if (vault) {
    row.quoteMint = vault.mint;
    row.quoteDecimals = vault.decimals;
    row.quoteUi = vault.amount / 10 ** vault.decimals;
    row.realQuote = vault.amount;
  } else {
    row.quoteMint = quoteMint;
    row.quoteDecimals = opts.quoteDecimals;
  }
  row.reserveUsd = heliusReserveUsd({
    realQuote: row.realQuote,
    quoteMint: row.quoteMint || quoteMint,
    quoteDecimals: row.quoteDecimals ?? opts.quoteDecimals,
    solUsd: opts.solUsd,
  });
  return row;
}

export function applyHeliusCurve<T extends {
  realQuoteReserves?: number;
  realSolReserves?: number;
  curveReserveUsd?: number;
  complete?: boolean;
  quoteMint?: string;
  quoteDecimals?: number;
}>(pump: T, curve: HeliusCurve | undefined, solUsd?: number): T {
  if (!curve) return pump;
  const quoteMint = curve.quoteMint || pump.quoteMint;
  const reserveUsd = heliusReserveUsd({
    realQuote: curve.realQuote,
    quoteMint,
    quoteDecimals: curve.quoteDecimals ?? pump.quoteDecimals,
    solUsd,
  });
  return {
    ...pump,
    complete: Boolean(pump.complete || curve.complete),
    quoteMint,
    realQuoteReserves: curve.realQuote,
    realSolReserves: quoteIsSol(quoteMint) ? curve.realQuote : pump.realSolReserves,
    curveReserveUsd: reserveUsd ?? pump.curveReserveUsd,
  };
}
