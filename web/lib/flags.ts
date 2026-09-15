import type { CoinDoc, CoinStatus } from "./types";

export function flagsOf(c: Pick<CoinDoc, "status" | "flags" | "complete">): CoinStatus[] {
  if (c.flags && c.flags.length) return c.flags;
  if (c.status === "rejected") return ["rejected"];
  const out: CoinStatus[] = c.status === "migrated" ? [] : [c.status];
  if (c.complete || c.status === "migrated") out.push("migrated");
  if (out.length === 0) out.push("watching");
  return out;
}

export function hasFlag(c: Pick<CoinDoc, "status" | "flags" | "complete">, flag: CoinStatus) {
  return flagsOf(c).includes(flag);
}

export function flagsFor(status: CoinStatus, complete?: boolean): CoinStatus[] {
  if (status === "rejected") return ["rejected"];
  const out: CoinStatus[] = [status];
  if (complete) out.push("migrated");
  return out;
}
