import { blacklist } from "./mongo";
import type { BlacklistDoc } from "./types";

const g = globalThis as typeof globalThis & {
  __blacklist?: Set<string>;
  __blacklistAt?: number;
};

const TTL_MS = 5_000;

export async function blacklistMints(): Promise<Set<string>> {
  const now = Date.now();
  if (g.__blacklist && now - (g.__blacklistAt || 0) < TTL_MS) return g.__blacklist;
  const rows = await (await blacklist()).find({}).project({ mint: 1 }).toArray();
  g.__blacklist = new Set(rows.map((r) => r.mint));
  g.__blacklistAt = now;
  return g.__blacklist;
}

export async function isBlacklisted(mint: string) {
  if (!mint) return false;
  return (await blacklistMints()).has(mint);
}

export async function notBlacklistedMongo(): Promise<Record<string, unknown>> {
  const blocked = [...(await blacklistMints())];
  if (!blocked.length) return {};
  return { mint: { $nin: blocked } };
}

export async function addBlacklist(mint: string, symbol?: string): Promise<BlacklistDoc> {
  const clean = mint.trim();
  if (!clean) throw new Error("mint required");
  const row: BlacklistDoc = {
    mint: clean,
    symbol: symbol?.trim() || undefined,
    addedAt: new Date().toISOString(),
  };
  await (await blacklist()).updateOne({ mint: clean }, { $set: row }, { upsert: true });
  g.__blacklist = new Set([...(g.__blacklist || []), clean]);
  g.__blacklistAt = Date.now();
  return row;
}

export async function removeBlacklist(mint: string) {
  await (await blacklist()).deleteOne({ mint });
  g.__blacklist?.delete(mint);
  g.__blacklistAt = Date.now();
}

export async function listBlacklist() {
  return (await blacklist()).find({}).sort({ addedAt: -1 }).toArray();
}
