export const ANALYZE_FLOOR = 500_000;
/** Dust LP on the desk. Alive analyze books need at least this. */
export const ANALYZE_LIVE_LP = 80;

export const ANALYZE_TARGETS = [
  { key: "500k", usd: 500_000 },
  { key: "800k", usd: 800_000 },
  { key: "1m", usd: 1_000_000 },
  { key: "1.5m", usd: 1_500_000 },
  { key: "2m", usd: 2_000_000 },
  { key: "3m", usd: 3_000_000 },
  { key: "5m", usd: 5_000_000 },
  { key: "10m", usd: 10_000_000 },
  { key: "15m", usd: 15_000_000 },
  { key: "20m", usd: 20_000_000 },
  { key: "30m", usd: 30_000_000 },
  { key: "40m", usd: 40_000_000 },
  { key: "50m", usd: 50_000_000 },
  { key: "100m", usd: 100_000_000 },
  { key: "100m+", usd: 100_000_001 },
] as const;

export type AnalyzeTargetKey = (typeof ANALYZE_TARGETS)[number]["key"];

export type TargetHit = {
  key: AnalyzeTargetKey;
  usd: number;
  hit: boolean;
  at?: string;
  durationMs?: number;
};

export const ANALYZE_TZ = "GMT-5";
export const ANALYZE_TZ_OFFSET_H = -5;

export type HourBucket = {
  hour: number;
  minHits: number;
  maxHits: number;
  changeTokens: number;
  changeSum: number;
  changeN: number;
  avgChangePct: number;
};

export type DayPrint = {
  date: string;
  min: number;
  max: number;
  minAt?: string;
  maxAt?: string;
  hours: {
    hour: number;
    open?: number;
    high?: number;
    low?: number;
    close?: number;
    changePct?: number;
  }[];
};

export type AnalyzeTokenRow = {
  mint: string;
  symbol?: string;
  name?: string;
  launchedAt?: string;
  marketCapUsd: number;
  athMarketCap: number;
  liquidityUsd?: number;
  migrateMc?: number;
  complete?: boolean;
  status: "rejected" | "watching" | "enter" | "exit" | "migrated";
  flags?: AnalyzeTokenRow["status"][];
  hits: TargetHit[];
  maxTarget?: AnalyzeTargetKey;
  athAt?: string;
  timeTo500kMs?: number;
};

export type AnalyzeBoard = {
  asOf: string;
  tokenCount: number;
  targets: {
    key: AnalyzeTargetKey;
    usd: number;
    count: number;
    avgDurationMs: number | null;
    timed: number;
  }[];
  hours: HourBucket[];
  tokens: AnalyzeTokenRow[];
};

export type AnalyzeTokenDetail = {
  coin: AnalyzeTokenRow & {
    venue: string;
    poolAddress?: string;
    priceUsd?: number;
    liquidityUsd?: number;
  };
  hits: TargetHit[];
  maxTarget?: AnalyzeTargetKey;
  athAt?: string;
  days: DayPrint[];
  hours: HourBucket[];
  source: { scores: number; bars: number; ohlcv: number };
};
