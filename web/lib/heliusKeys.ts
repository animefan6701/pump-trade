import { randomUUID } from "crypto";
import { apiKeys } from "./mongo";
import type { ApiKeyDoc, PublicApiKey } from "./types";

const DEFAULT_RPC = "https://mainnet.helius-rpc.com/?api-key=";
const DEFAULT_WS = "wss://mainnet.helius-rpc.com/?api-key=";
const USAGE_URL = "https://admin-api.helius.xyz/v0/admin/projects";
const RATE_PARK_MS = 60_000;
const QUOTA_PARK_MS = 6 * 60 * 60_000;
const USAGE_TTL_MS = 60_000;

let activeId: string | null = null;
const rotateHooks = new Set<(id: string | null) => void>();

function setActive(id: string | null) {
  if (activeId === id) return;
  activeId = id;
  for (const fn of rotateHooks) fn(id);
}

export function onHeliusRotate(fn: (id: string | null) => void) {
  rotateHooks.add(fn);
  return () => rotateHooks.delete(fn);
}

function publicKey(row: ApiKeyDoc, active = false): PublicApiKey {
  const { key, ...rest } = row;
  return { ...rest, last4: key.slice(-4), active };
}

function remaining(row: Pick<ApiKeyDoc, "creditsRemaining" | "prepaidRemaining">) {
  return Math.max(0, row.creditsRemaining ?? 0) + Math.max(0, row.prepaidRemaining ?? 0);
}

function outOfCredits(row: ApiKeyDoc) {
  if (typeof row.creditsRemaining !== "number") return false;
  return remaining(row) <= 0;
}

function parked(row: ApiKeyDoc) {
  return Boolean(row.exhaustedUntil && Date.parse(row.exhaustedUntil) > Date.now());
}

function usable(row: ApiKeyDoc) {
  return row.enabled !== false && !outOfCredits(row) && !parked(row);
}

function envUrl(name: "SOLANA_RPC_URL" | "SOLANA_WS_URL", fallback: string) {
  return (process.env[name] || fallback).trim();
}

export function withApiKey(url: string, key: string) {
  try {
    const u = new URL(url);
    u.searchParams.set("api-key", key);
    return u.toString();
  } catch {
    if (/([?&]api-key=)[^&]*/i.test(url)) return url.replace(/([?&]api-key=)[^&]*/i, `$1${key}`);
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${sep}api-key=${key}`;
  }
}

export function solanaRpcUrl(key: string) {
  return withApiKey(envUrl("SOLANA_RPC_URL", DEFAULT_RPC), key);
}

export function solanaWsUrl(key: string) {
  const raw = process.env.SOLANA_WS_URL?.trim();
  if (raw) return withApiKey(raw, key);
  return withApiKey(envUrl("SOLANA_RPC_URL", DEFAULT_RPC).replace(/^http/i, "ws"), key);
}

async function enabledKeys() {
  const col = await apiKeys();
  return col.find({ kind: "helius", enabled: true }).sort({ priority: 1, createdAt: 1 }).toArray();
}

async function persistUsage(id: string, patch: Partial<ApiKeyDoc>) {
  const col = await apiKeys();
  await col.updateOne({ id }, { $set: { ...patch, updatedAt: new Date().toISOString() } });
}

export async function refreshKeyUsage(row: ApiKeyDoc): Promise<ApiKeyDoc> {
  if (!row.projectId) return row;
  if (row.usageAt && Date.now() - Date.parse(row.usageAt) < USAGE_TTL_MS) return row;
  try {
    const r = await fetch(`${USAGE_URL}/${row.projectId}/usage`, {
      headers: { "X-Api-Key": row.key, accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
    if (!r.ok) return row;
    const u = (await r.json()) as {
      creditsRemaining?: number;
      creditsUsed?: number;
      prepaidCreditsRemaining?: number;
      creditCycle?: { end?: string };
      subscriptionDetails?: { creditsLimit?: number; plan?: string; billingCycle?: { end?: string } };
    };
    const creditsRemaining = Number(u.creditsRemaining ?? 0);
    const prepaidRemaining = Number(u.prepaidCreditsRemaining ?? 0);
    const creditsUsed = Number(u.creditsUsed ?? 0);
    const creditsLimit = Number(u.subscriptionDetails?.creditsLimit ?? 0);
    const usagePct =
      creditsLimit > 0 ? Math.min(100, (creditsUsed / creditsLimit) * 100) : creditsRemaining <= 0 ? 100 : 0;
    const patch: Partial<ApiKeyDoc> = {
      creditsRemaining,
      prepaidRemaining,
      creditsUsed,
      creditsLimit,
      usagePct,
      plan: u.subscriptionDetails?.plan,
      cycleEnd: u.creditCycle?.end || u.subscriptionDetails?.billingCycle?.end,
      usageAt: new Date().toISOString(),
    };
    if (creditsRemaining <= 0 && prepaidRemaining <= 0) {
      patch.exhaustedUntil = new Date(Date.now() + QUOTA_PARK_MS).toISOString();
    }
    await persistUsage(row.id, patch);
    return { ...row, ...patch };
  } catch {
    return row;
  }
}

function pickFrom(keys: ApiKeyDoc[]) {
  if (!keys.length) {
    setActive(null);
    return null;
  }
  const current = activeId ? keys.find((k) => k.id === activeId && usable(k)) : undefined;
  const live = current || keys.find(usable) || null;
  setActive(live?.id || null);
  return live;
}

export async function pickUsableKey(): Promise<ApiKeyDoc | null> {
  return pickFrom(await enabledKeys());
}

export async function liveSolanaUrls() {
  const row = await pickUsableKey();
  if (!row) return null;
  return { id: row.id, last4: row.key.slice(-4), rpc: solanaRpcUrl(row.key), ws: solanaWsUrl(row.key) };
}

export async function listKeys(): Promise<{ keys: PublicApiKey[]; activeId: string | null }> {
  const raw = await (await apiKeys()).find({ kind: "helius" }).sort({ priority: 1, createdAt: 1 }).toArray();
  const rows = await Promise.all(raw.map((row) => refreshKeyUsage(row)));
  const live = pickFrom(rows.filter((r) => r.enabled !== false));
  return {
    keys: rows.map((r) => publicKey(r, Boolean(live && r.id === live.id && usable(r)))),
    activeId,
  };
}

export async function addUserKey(key: string, projectId: string, label?: string) {
  const trimmed = key.trim();
  const project = projectId.trim();
  if (!trimmed || !project) throw new Error("key and project id required");
  const col = await apiKeys();
  const existing = await col.findOne({ kind: "helius", key: trimmed });
  if (existing) throw new Error("key already registered");
  const now = new Date().toISOString();
  const count = await col.countDocuments({ kind: "helius" });
  const row: ApiKeyDoc = {
    id: randomUUID(),
    kind: "helius",
    source: "user",
    label: label?.trim() || `Key ${count + 1}`,
    key: trimmed,
    projectId: project,
    enabled: true,
    priority: count,
    createdAt: now,
    updatedAt: now,
  };
  await col.insertOne(row);
  const fresh = await refreshKeyUsage(row);
  return publicKey(fresh);
}

export async function updateKey(
  id: string,
  patch: Partial<Pick<ApiKeyDoc, "label" | "projectId" | "enabled" | "priority">>,
) {
  const col = await apiKeys();
  const now = new Date().toISOString();
  await col.updateOne({ id, kind: "helius" }, { $set: { ...patch, updatedAt: now } });
  if (patch.enabled === false && activeId === id) setActive(null);
  const row = await col.findOne({ id });
  return row ? publicKey(row) : null;
}

export async function removeKey(id: string) {
  const col = await apiKeys();
  const wr = await col.deleteOne({ id, kind: "helius" });
  if (activeId === id) setActive(null);
  return wr.deletedCount > 0;
}

async function markUsed(row: ApiKeyDoc, status: number, credits = 0, err?: string, exhaust: "quota" | "rate" | null = null) {
  const col = await apiKeys();
  const now = new Date().toISOString();
  const park = exhaust === "quota" ? QUOTA_PARK_MS : exhaust === "rate" ? RATE_PARK_MS : 0;
  await col.updateOne(
    { id: row.id },
    {
      $set: {
        lastStatus: status,
        lastError: err,
        lastUsedAt: now,
        updatedAt: now,
        ...(exhaust
          ? {
              exhaustedUntil: new Date(Date.now() + park).toISOString(),
              ...(exhaust === "quota" ? { creditsRemaining: 0, usagePct: 100 } : {}),
            }
          : {}),
      },
      $inc: { calls: 1, localCredits: credits },
    },
  );
}

export async function failActiveKey(status: number, err?: string) {
  const keys = await enabledKeys();
  const row = activeId ? keys.find((k) => k.id === activeId) : undefined;
  if (!row) return;
  const checked = await refreshKeyUsage({ ...row, usageAt: undefined });
  const quota = outOfCredits(checked) || /max usage|credits|quota|payment|402/i.test(err || "");
  await markUsed(row, status, 0, err, quota ? "quota" : "rate");
  if (activeId === row.id) setActive(null);
}

export async function heliusRpc(body: unknown, credits = 1): Promise<unknown | null> {
  const keys = (await enabledKeys()).filter(usable);
  if (!keys.length) return null;
  const start = Math.max(0, activeId ? keys.findIndex((k) => k.id === activeId) : 0);
  for (let i = 0; i < keys.length; i++) {
    const row = keys[(start + i) % keys.length];
    try {
      const r = await fetch(solanaRpcUrl(row.key), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        cache: "no-store",
        signal: AbortSignal.timeout(12_000),
      });
      if (r.status === 429 || r.status === 402) {
        const checked = await refreshKeyUsage({ ...row, usageAt: undefined });
        const quota =
          outOfCredits(checked) || /max usage|credits|quota|payment/i.test(await r.clone().text().catch(() => ""));
        await markUsed(row, r.status, credits, `http ${r.status}`, quota ? "quota" : "rate");
        if (activeId === row.id) setActive(null);
        continue;
      }
      if (!r.ok) {
        await markUsed(row, r.status, credits, `http ${r.status}`);
        continue;
      }
      await markUsed(row, r.status, credits);
      setActive(row.id);
      return r.json();
    } catch (e) {
      await markUsed(row, 0, credits, e instanceof Error ? e.message : String(e));
    }
  }
  return null;
}
