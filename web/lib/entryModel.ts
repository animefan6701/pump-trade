import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

export type EntryModel = {
  kind: "lr";
  features: string[];
  weights: number[];
  bias: number;
  means: number[];
  stds: number[];
  threshold: number;
  metrics?: Record<string, number>;
};

let cached: EntryModel | null | undefined;
let cachedRug: EntryModel | null | undefined;

function paths() {
  const fromEnv = process.env.GRADUATION_MODEL_PATH;
  const cwd = process.cwd();
  return [
    fromEnv?.endsWith(".json") ? fromEnv : undefined,
    resolve(cwd, "models/entry_live.json"),
    resolve(cwd, "../models/entry_live.json"),
  ].filter((p): p is string => Boolean(p));
}

function rugPaths() {
  const cwd = process.cwd();
  return [resolve(cwd, "models/corpus_rug.json"), resolve(cwd, "../models/corpus_rug.json")];
}

export function loadEntryModel(): EntryModel | null {
  if (cached !== undefined) return cached;
  for (const path of paths()) {
    try {
      if (!existsSync(path)) continue;
      const raw = JSON.parse(readFileSync(path, "utf8")) as EntryModel;
      if (raw?.kind === "lr" && raw.weights?.length) {
        cached = raw;
        console.log(`[entry] loaded ${path}`);
        return cached;
      }
    } catch {
      /* next */
    }
  }
  cached = null;
  return cached;
}

function sigmoid(z: number) {
  if (z >= 0) {
    const e = Math.exp(-z);
    return 1 / (1 + e);
  }
  const e = Math.exp(z);
  return e / (1 + e);
}

function scoreLr(
  model: EntryModel,
  features: Record<string, number | null | undefined>,
): { p: number; used: number; threshold: number } {
  let used = 0;
  let z = model.bias;
  for (let i = 0; i < model.features.length; i++) {
    const raw = features[model.features[i]];
    const mean = model.means[i] ?? 0;
    const std = model.stds[i] || 1;
    const value = typeof raw === "number" && Number.isFinite(raw) ? raw : mean;
    if (typeof raw === "number" && Number.isFinite(raw)) used += 1;
    z += ((value - mean) / std) * (model.weights[i] || 0);
  }
  return {
    p: Math.min(0.97, Math.max(0.03, sigmoid(z))),
    used,
    threshold: Number(process.env.GRADUATION_THRESHOLD || model.threshold || 0.35),
  };
}

export function loadCorpusRug(): EntryModel | null {
  if (cachedRug !== undefined) return cachedRug;
  for (const path of rugPaths()) {
    try {
      if (!existsSync(path)) continue;
      const raw = JSON.parse(readFileSync(path, "utf8")) as EntryModel;
      if (raw?.kind === "lr" && raw.weights?.length) {
        cachedRug = raw;
        console.log(`[corpus-rug] loaded ${path}`);
        return cachedRug;
      }
    } catch {
      /* next */
    }
  }
  cachedRug = null;
  return cachedRug;
}

export function scoreCorpusRug(features: Record<string, number | null | undefined>): {
  p: number;
  used: number;
  threshold: number;
} | null {
  const model = loadCorpusRug();
  if (!model) return null;
  const scored = scoreLr(model, features);
  return { ...scored, threshold: Number(process.env.CORPUS_RUG_THRESHOLD || model.threshold || 0.55) };
}

export function scoreEntryModel(features: Record<string, number | null | undefined>): {
  p: number;
  used: number;
  threshold: number;
} | null {
  const model = loadEntryModel();
  if (!model) return null;
  return scoreLr(model, features);
}
