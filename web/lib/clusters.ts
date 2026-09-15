import type { MeltLiveFeatures, TapeTrade } from "./types";

class UnionFind {
  parent = new Map<string, string>();
  find(x: string): string {
    if (!this.parent.has(x)) this.parent.set(x, x);
    let r = x;
    while (this.parent.get(r) !== r) r = this.parent.get(r)!;
    while (x !== r) {
      const p = this.parent.get(x)!;
      this.parent.set(x, r);
      x = p;
    }
    return r;
  }
  union(a: string, b: string) {
    if (!a || !b) return;
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

const bundleIdCache = new Map<string, string | null>();
const bundleWalletsCache = new Map<string, string[]>();

function jitoBase() {
  return (process.env.JITO_BUNDLE_API_URL || "https://bundles.jito.wtf").replace(/\/$/, "");
}

function jitoHeaders() {
  const h: Record<string, string> = { accept: "application/json" };
  const uuid = process.env.JITO_UUID;
  if (uuid) h["x-jito-auth"] = uuid;
  return h;
}

async function jitoGet(path: string, timeout = 6_000): Promise<unknown> {
  const url = `${jitoBase()}${path}`;
  const uuid = process.env.JITO_UUID;
  const withUuid = uuid && !url.includes("uuid=") ? `${url}${url.includes("?") ? "&" : "?"}uuid=${uuid}` : url;
  for (let i = 0; i < 2; i++) {
    const r = await fetch(withUuid, {
      headers: jitoHeaders(),
      cache: "no-store",
      signal: AbortSignal.timeout(timeout),
    });
    if (r.status === 429) {
      await new Promise((res) => setTimeout(res, 700));
      continue;
    }
    if (!r.ok) return null;
    return r.json();
  }
  return null;
}

function asBundleId(raw: unknown): string | null {
  if (!raw) return null;
  const row = Array.isArray(raw) ? raw[0] : raw;
  if (!row || typeof row !== "object") return null;
  const o = row as { bundle_id?: string; bundleId?: string };
  return o.bundle_id || o.bundleId || null;
}

type BundleInfo = {
  bundleId?: string;
  tippers?: string[];
  txSignatures?: string[];
  transactions?: string[];
};

function asBundleInfo(raw: unknown): BundleInfo | null {
  if (!raw) return null;
  const row = Array.isArray(raw) ? raw[0] : raw;
  if (!row || typeof row !== "object") return null;
  return row as BundleInfo;
}

async function feePayers(sigs: string[]): Promise<string[]> {
  const key = process.env.HELIUS_API_KEY;
  if (!key || sigs.length === 0) return [];
  const r = await fetch(`https://api.helius.xyz/v0/transactions?api-key=${key}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({ transactions: sigs.slice(0, 20) }),
  });
  if (!r.ok) return [];
  const txs = (await r.json()) as Array<{ feePayer?: string }>;
  if (!Array.isArray(txs)) return [];
  return txs.map((t) => t.feePayer).filter((w): w is string => Boolean(w));
}

/** Same-funder, same-slot, same-second, plus official Jito bundle wallet sets. */
export function clustersFromTape(trades: TapeTrade[], extras: string[][] = []): MeltLiveFeatures {
  const uf = new UnionFind();
  const buyers = trades.filter((t) => t.side === "buy" && t.wallet);
  const byFunder = new Map<string, string[]>();
  const bySecond = new Map<number, string[]>();
  const bySlot = new Map<number, string[]>();

  for (const t of buyers) {
    if (t.funder) {
      const list = byFunder.get(t.funder) || [];
      list.push(t.wallet);
      byFunder.set(t.funder, list);
    }
    const sec = Math.floor(t.t / 1000);
    const list = bySecond.get(sec) || [];
    list.push(t.wallet);
    bySecond.set(sec, list);
    if (typeof t.slot === "number") {
      const slotList = bySlot.get(t.slot) || [];
      slotList.push(t.wallet);
      bySlot.set(t.slot, slotList);
    }
  }

  for (const group of byFunder.values()) {
    for (let i = 1; i < group.length; i++) uf.union(group[0], group[i]);
  }
  for (const group of bySlot.values()) {
    if (group.length < 2) continue;
    for (let i = 1; i < group.length; i++) uf.union(group[0], group[i]);
  }
  for (const group of bySecond.values()) {
    if (group.length < 3) continue;
    for (let i = 1; i < group.length; i++) uf.union(group[0], group[i]);
  }
  for (const group of extras) {
    for (let i = 1; i < group.length; i++) uf.union(group[0], group[i]);
  }

  const roots = new Map<string, Set<string>>();
  for (const t of buyers) {
    const r = uf.find(t.wallet);
    if (r === t.wallet && !uf.parent.has(t.wallet)) continue;
    const set = roots.get(r) || new Set();
    set.add(t.wallet);
    roots.set(r, set);
  }
  const clusters = [...roots.values()].filter((s) => s.size >= 2);

  const solByWallet = new Map<string, number>();
  let buySol = 0;
  for (const t of buyers) {
    solByWallet.set(t.wallet, (solByWallet.get(t.wallet) || 0) + t.sol);
    buySol += t.sol;
  }
  const den = buySol || 1;
  let clusterSol = 0;
  let maxCluster = 0;
  for (const s of clusters) {
    let sol = 0;
    for (const w of s) sol += solByWallet.get(w) || 0;
    clusterSol += sol;
    maxCluster = Math.max(maxCluster, sol / den);
  }
  const pct = clusterSol / den;
  return {
    group4_cluster_num: clusters.length,
    group4_cluster_total_pct: pct,
    group4_cluster_max_pct: maxCluster,
    bundleHoldPct: pct,
  };
}

/**
 * Official Jito explorer: sig → bundle_id → tippers + all signatures in that bundle.
 * Extra signatures are resolved to fee-payers via Helius.
 */
export async function jitoBundleWallets(sigs: string[]): Promise<string[][]> {
  const unique = [...new Set(sigs.filter(Boolean))].slice(0, 10);
  if (unique.length === 0) return [];
  const byBundle = new Map<string, Set<string>>();

  for (const sig of unique) {
    try {
      let bundleId = bundleIdCache.get(sig);
      if (bundleId === undefined) {
        const raw = await jitoGet(`/api/v1/bundles/transaction/${sig}`);
        bundleId = asBundleId(raw);
        bundleIdCache.set(sig, bundleId);
      }
      if (!bundleId) continue;

      let wallets = bundleWalletsCache.get(bundleId);
      if (!wallets) {
        const info = asBundleInfo(await jitoGet(`/api/v1/bundles/bundle/${bundleId}`));
        const tippers = info?.tippers || [];
        const txSigs = info?.txSignatures || info?.transactions || [];
        const payers = await feePayers(txSigs);
        wallets = [...new Set([...tippers, ...payers])];
        bundleWalletsCache.set(bundleId, wallets);
      }
      if (wallets.length < 2) continue;
      const set = byBundle.get(bundleId) || new Set();
      for (const w of wallets) set.add(w);
      byBundle.set(bundleId, set);
    } catch {
      /* keep same-funder / same-slot */
    }
  }
  return [...byBundle.values()].map((s) => [...s]).filter((g) => g.length >= 2);
}
