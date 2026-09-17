import { watchPins } from "./mongo";
import type { WatchPinDoc } from "./types";

export async function listWatchPins(): Promise<WatchPinDoc[]> {
  return (await watchPins()).find({}).sort({ addedAt: -1 }).limit(100).toArray();
}

export async function replaceWatchPins(items: { mint?: string; symbol?: string; addedAt?: string }[]) {
  const clean: WatchPinDoc[] = [];
  const seen = new Set<string>();
  for (const item of items || []) {
    const mint = String(item.mint || "").trim();
    if (mint.length < 32 || seen.has(mint)) continue;
    seen.add(mint);
    clean.push({
      mint,
      symbol: item.symbol?.trim() || undefined,
      addedAt: item.addedAt || new Date().toISOString(),
    });
    if (clean.length >= 100) break;
  }
  const col = await watchPins();
  await col.deleteMany({});
  if (clean.length) await col.insertMany(clean);
  return clean;
}
