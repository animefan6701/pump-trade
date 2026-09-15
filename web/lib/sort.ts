export const COIN_SORT_FIELDS = [
  "status",
  "symbol",
  "mint",
  "rugProb",
  "entryProb",
  "exitProb",
  "returnRatio",
  "updatedAt",
  "launchedAt",
  "marketCapUsd",
  "priceUsd",
  "liquidityUsd",
  "volume5m",
  "change5m",
  "holders",
] as const;

export type CoinSortField = (typeof COIN_SORT_FIELDS)[number];
export type SortDir = "asc" | "desc";

const TEXT_FIELDS = new Set<CoinSortField>(["status", "symbol", "mint"]);

export function parseCoinSort(sort: string | null, dir: string | null) {
  const field = COIN_SORT_FIELDS.includes(sort as CoinSortField)
    ? (sort as CoinSortField)
    : "updatedAt";
  const direction: SortDir = dir === "asc" ? "asc" : "desc";
  return { field, direction };
}

export function defaultDirFor(field: CoinSortField): SortDir {
  return TEXT_FIELDS.has(field) ? "asc" : "desc";
}

export function mongoSort(field: CoinSortField, direction: SortDir) {
  const order = direction === "asc" ? 1 : -1;
  return { [field]: order, mint: 1 } as Record<string, 1 | -1>;
}
