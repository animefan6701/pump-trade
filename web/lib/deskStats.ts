import { coins, trades } from "./mongo";
import { bumpDeskStats, emptyDeskStats, type DeskStats } from "./deskStatsShared";
import type { CoinStatus } from "./types";

export type { DeskStats };
export { bumpDeskStats };

const g = globalThis as typeof globalThis & {
  __deskStats?: DeskStats;
  __deskStatsFullAt?: number;
  __deskStatsInflight?: Promise<DeskStats>;
  __deskStatsIdx?: boolean;
};

function isStatus(id: string): id is CoinStatus {
  return id === "rejected" || id === "watching" || id === "enter" || id === "exit" || id === "migrated";
}

export function peekDeskStats(): DeskStats | null {
  return g.__deskStats || null;
}

export function applyStatusChange(from: CoinStatus | undefined, to: CoinStatus, inserted = false) {
  const next = bumpDeskStats(g.__deskStats || null, from, to, inserted);
  if (next) g.__deskStats = next;
  return next;
}

export async function refreshDeskStats(): Promise<DeskStats> {
  if (g.__deskStatsInflight) return g.__deskStatsInflight;
  g.__deskStatsInflight = (async () => {
    const col = await coins();
    if (!g.__deskStatsIdx) {
      g.__deskStatsIdx = true;
      void col.createIndex({ source: 1, status: 1 }).catch(() => null);
      void col.createIndex({ source: 1, flags: 1 }).catch(() => null);
    }
    const [agg, paper] = await Promise.all([
      col
        .aggregate<{ total: { n: number }[]; flags: { _id: string; n: number }[] }>([
          { $match: { source: "live" } },
          {
            $facet: {
              total: [{ $count: "n" }],
              flags: [
                {
                  $project: {
                    flags: {
                      $cond: [
                        { $gt: [{ $size: { $ifNull: ["$flags", []] } }, 0] },
                        "$flags",
                        ["$status"],
                      ],
                    },
                  },
                },
                { $unwind: "$flags" },
                { $group: { _id: "$flags", n: { $sum: 1 } } },
              ],
            },
          },
        ])
        .toArray(),
      trades()
        .then((t) => t.estimatedDocumentCount())
        .catch(() => g.__deskStats?.paper ?? 0),
    ]);
    const next = emptyDeskStats();
    next.paper = paper;
    next.total = agg[0]?.total[0]?.n ?? 0;
    for (const row of agg[0]?.flags || []) {
      if (isStatus(row._id)) next[row._id] = row.n;
    }
    next.live = next.total;
    next.asOf = new Date().toISOString();
    g.__deskStats = next;
    g.__deskStatsFullAt = Date.now();
    return next;
  })().finally(() => {
    g.__deskStatsInflight = undefined;
  });
  return g.__deskStatsInflight;
}

export async function getDeskStats(): Promise<DeskStats> {
  if (!g.__deskStats) {
    g.__deskStats = emptyDeskStats();
    void refreshDeskStats();
    return g.__deskStats;
  }
  if (Date.now() - (g.__deskStatsFullAt || 0) > 8_000) void refreshDeskStats();
  return g.__deskStats;
}
