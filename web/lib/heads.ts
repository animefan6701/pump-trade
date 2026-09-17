import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import type { MigrateBar } from "./types";
import type { XgbTree } from "./xgb";

export const DIR5M_FEATURES = [
  "n_bars",
  "span_min",
  "ret_1",
  "ret_3",
  "ret_lock",
  "min_lock",
  "max_lock",
  "imb",
  "buy_sum",
  "sell_sum",
  "vol_sum",
  "tx_sum",
] as const;

export const MULT_FEATURES = [
  "n_bars",
  "span_min",
  "ret_lock",
  "min_lock",
  "max_lock",
  "imb",
  "buy_sum",
  "sell_sum",
  "vol_sum",
  "log_migrate_mc",
  "top10",
  "holders",
  "wash",
] as const;

export const LOCK_FEATURES = [
  "logMc",
  "liq",
  "vol5",
  "vol1h",
  "ch5",
  "ch1",
  "athRatio",
  "ageMin",
  "holders",
  "top10",
  "buyers5m",
  "sellers5m",
  "devHold",
  "replies",
  "gini",
  "creatorSold",
  "modelUsed",
  "modelMissing",
  "sniperSeen",
  "group4",
  "group4n",
  "jito",
  "trades",
  "unique",
  "wash",
  "sellPressure",
  "heldEntry",
  "bonding",
  "bundle",
] as const;

type HeadName = "dir5m" | "hit2x" | "dumpFirst" | "survive70" | "hit15x";

type HeadModel = {
  kind: "xgb";
  features: string[];
  medians?: number[];
  base_score?: number;
  threshold?: number;
  trees: XgbTree[];
};

const cache: Partial<Record<HeadName, HeadModel | null>> = {};

function modelPaths(file: string) {
  const cwd = process.cwd();
  return [resolve(cwd, `models/${file}`), resolve(cwd, `../models/${file}`)];
}

function loadHead(name: HeadName, file: string): HeadModel | null {
  if (cache[name] !== undefined) return cache[name] || null;
  for (const path of modelPaths(file)) {
    try {
      if (!existsSync(path)) continue;
      const raw = JSON.parse(readFileSync(path, "utf8")) as HeadModel;
      if (raw?.kind === "xgb" && raw.trees?.length) {
        cache[name] = raw;
        return raw;
      }
    } catch {
      /* try next */
    }
  }
  cache[name] = null;
  return null;
}

function walk(node: XgbTree, x: number[]): number {
  if (typeof node.leaf === "number") return node.leaf;
  const i = node.f ?? 0;
  const v = x[i];
  const goLeft = Number.isNaN(v) ? node.miss !== "right" : v < (node.thr ?? 0);
  const child = goLeft ? node.left : node.right;
  return child ? walk(child, x) : 0;
}

function sigmoid(z: number) {
  if (z >= 0) {
    const e = Math.exp(-z);
    return 1 / (1 + e);
  }
  const e = Math.exp(z);
  return e / (1 + e);
}

function predictHead(model: HeadModel, feats: Record<string, number | null | undefined>) {
  const x = model.features.map((name, i) => {
    const raw = feats[name];
    return typeof raw === "number" && Number.isFinite(raw) ? raw : model.medians?.[i] ?? 0;
  });
  let margin = model.base_score || 0;
  for (const tree of model.trees) margin += walk(tree, x);
  return Math.min(0.999, Math.max(0.001, sigmoid(margin)));
}

export function seriesWindowFeats(bars: MigrateBar[], migrateMc: number) {
  const live = bars.filter((b) => b.mc > 0);
  if (live.length < 2 || !(migrateMc > 0)) return null;
  const last = live[live.length - 1];
  const first = live[0];
  const mcs = live.map((b) => b.mc);
  const minMc = Math.min(...mcs);
  const maxMc = Math.max(...mcs);
  const prev1 = live[live.length - 2]?.mc || last.mc;
  const prev3 = live[Math.max(0, live.length - 4)]?.mc || first.mc;
  const buy = live.reduce((s, b) => s + (b.buy || 0), 0);
  const sell = live.reduce((s, b) => s + (b.sell || 0), 0);
  const vol = live.reduce((s, b) => s + (b.vol || 0), 0);
  const tx = live.reduce((s, b) => s + (b.tx || 0), 0);
  const span = Math.max(1, (last.t - first.t) / 60_000);
  return {
    n_bars: live.length,
    span_min: span,
    ret_1: last.mc / prev1 - 1,
    ret_3: last.mc / prev3 - 1,
    ret_lock: last.mc / migrateMc - 1,
    min_lock: minMc / migrateMc,
    max_lock: maxMc / migrateMc,
    imb: buy + sell > 0 ? (buy - sell) / (buy + sell) : 0,
    buy_sum: buy,
    sell_sum: sell,
    vol_sum: vol,
    tx_sum: tx,
    log_migrate_mc: Math.log1p(migrateMc),
  };
}

export function dir5mFlag(p?: number) {
  return typeof p === "number" && p >= 0.6;
}

export function hit2xFlag(p?: number) {
  return typeof p === "number" && p >= 0.55;
}

export function dumpFirstFlag(p?: number) {
  return typeof p === "number" && p >= 0.55;
}

export function survive70Flag(p?: number) {
  const model = loadHead("survive70", "survive70.json");
  return typeof p === "number" && p >= (model?.threshold ?? 0.55);
}

export function hit15xFlag(p?: number) {
  const model = loadHead("hit15x", "hit15x.json");
  return typeof p === "number" && p >= (model?.threshold ?? 0.5);
}

export function lockSnapshotFeats(
  features?: Record<string, number | string | boolean>,
  migrateMc?: number,
  migrateEntryProb?: number,
) {
  const mc =
    typeof migrateMc === "number" && migrateMc > 0
      ? migrateMc
      : typeof features?.mc === "number"
        ? features.mc
        : 0;
  const out: Record<string, number | null> = {
    logMc: mc > 0 ? Math.log1p(mc) : null,
    heldEntry: typeof migrateEntryProb === "number" && Number.isFinite(migrateEntryProb) ? migrateEntryProb : null,
  };
  for (const name of LOCK_FEATURES) {
    if (name === "logMc" || name === "heldEntry") continue;
    const raw = features?.[name];
    out[name] = typeof raw === "number" && Number.isFinite(raw) ? raw : null;
  }
  return out;
}

export function scoreContinuationFlags(opts: {
  migrateFeatures?: Record<string, number | string | boolean>;
  migrateMc?: number;
  migrateEntryProb?: number;
}) {
  if (!opts.migrateFeatures || !(opts.migrateMc && opts.migrateMc > 0)) return {};
  const feats = lockSnapshotFeats(opts.migrateFeatures, opts.migrateMc, opts.migrateEntryProb);
  const filled = LOCK_FEATURES.filter((name) => typeof feats[name] === "number").length;
  if (filled < 8) return {};
  const surviveModel = loadHead("survive70", "survive70.json");
  const hitModel = loadHead("hit15x", "hit15x.json");
  return {
    survive70Prob: surviveModel ? predictHead(surviveModel, feats) : undefined,
    hit15xProb: hitModel ? predictHead(hitModel, feats) : undefined,
  };
}

export function scoreHeadFlags(opts: {
  bars?: MigrateBar[];
  migrateMc: number;
  top10?: number;
  holders?: number;
  wash?: number;
}) {
  const win = seriesWindowFeats(opts.bars || [], opts.migrateMc);
  if (!win) return {};
  const dirModel = loadHead("dir5m", "dir5m.json");
  const hitModel = loadHead("hit2x", "hit2x.json");
  const dumpModel = loadHead("dumpFirst", "dump_first.json");
  const mult = {
    ...win,
    top10: opts.top10 ?? null,
    holders: opts.holders ?? null,
    wash: opts.wash ?? null,
  };
  return {
    dir5mProb: dirModel ? predictHead(dirModel, win) : undefined,
    hit2xProb: hitModel ? predictHead(hitModel, mult) : undefined,
    dumpFirstProb: dumpModel ? predictHead(dumpModel, mult) : undefined,
  };
}
