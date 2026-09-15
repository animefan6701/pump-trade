import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

export type XgbTree = {
  leaf?: number;
  f?: number;
  thr?: number;
  left?: XgbTree;
  right?: XgbTree;
  miss?: "left" | "right";
};

export type RugModel = {
  kind: "xgb";
  features: string[];
  medians: number[];
  threshold: number;
  base_score: number;
  trees: XgbTree[];
  metrics?: Record<string, number>;
  check?: { x: number[]; p: number };
};

let cached: RugModel | null | undefined;

function modelPaths() {
  const fromEnv = process.env.RUG_MODEL_PATH || process.env.RUG_LIVE_MODEL_PATH;
  const cwd = process.cwd();
  return [
    fromEnv,
    resolve(cwd, "models/rug_live.json"),
    resolve(cwd, "../models/rug_live.json"),
    resolve(cwd, "models/rug_xgb.json"),
    resolve(cwd, "../models/rug_xgb.json"),
  ].filter((p): p is string => Boolean(p));
}

export function loadRugModel(): RugModel | null {
  if (cached !== undefined) return cached;
  for (const path of modelPaths()) {
    try {
      if (!existsSync(path)) continue;
      const raw = JSON.parse(readFileSync(path, "utf8")) as RugModel;
      if (raw?.kind === "xgb" && raw.trees?.length && raw.features?.length) {
        cached = raw;
        console.log(`[rug] loaded ${path} (${raw.trees.length} trees)`);
        return cached;
      }
    } catch {
      /* try next path */
    }
  }
  cached = null;
  return cached;
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

export function scoreRugModel(features: Record<string, number | null | undefined>): {
  rugProb: number;
  used: number;
  missing: number;
  threshold: number;
} | null {
  const model = loadRugModel();
  if (!model) return null;
  let used = 0;
  let missing = 0;
  const sawSniper = model.features.some(
    (name) => name.includes("sniper") && typeof features[name] === "number" && Number.isFinite(features[name]),
  );
  const x = model.features.map((name, i) => {
    const raw = features[name];
    if (typeof raw === "number" && Number.isFinite(raw)) {
      used += 1;
      return raw;
    }
    missing += 1;
    if (name.includes("sniper") && sawSniper) return 0;
    return model.medians[i] ?? 0;
  });
  let margin = model.base_score || 0;
  for (const tree of model.trees) margin += walk(tree, x);
  return {
    rugProb: Math.min(0.999, Math.max(0.001, sigmoid(margin))),
    used,
    missing,
    threshold: calThreshold() ?? Math.max(0.45, Number(process.env.RUG_THRESHOLD || 0.55)),
  };
}

function calThreshold(): number | null {
  const cwd = process.cwd();
  for (const path of [resolve(cwd, "models/rug_cal.json"), resolve(cwd, "../models/rug_cal.json")]) {
    try {
      if (!existsSync(path)) continue;
      const raw = JSON.parse(readFileSync(path, "utf8")) as { threshold?: number; n?: number };
      if (typeof raw.threshold === "number" && (raw.n || 0) >= 40) {
        return Math.max(0.45, Math.min(0.75, raw.threshold));
      }
    } catch {
      /* keep env cutoff */
    }
  }
  return null;
}
