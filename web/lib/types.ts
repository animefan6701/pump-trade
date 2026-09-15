export type CoinStatus = "rejected" | "watching" | "enter" | "exit" | "migrated";
export type RiskLabel = "high" | "medium" | "low";
export type CoinSource = "melt" | "live";

export type CoinDoc = {
  mint: string;
  venue: string;
  symbol?: string;
  name?: string;
  creator?: string;
  status: CoinStatus;
  flags?: CoinStatus[];
  riskLabel: RiskLabel;
  rugProb: number;
  entryProb: number;
  exitProb: number;
  minRatio: number;
  returnRatio: number;
  manipulated: string;
  reasons: string[];
  source: CoinSource;
  complete?: boolean;
  marketCapUsd?: number;
  athMarketCap?: number;
  priceUsd?: number;
  liquidityUsd?: number;
  volume5m?: number;
  volume1h?: number;
  change5m?: number;
  holders?: number;
  bondingProgress?: number;
  launchedAt?: string;
  twitter?: string;
  website?: string;
  dex?: string;
  poolAddress?: string;
  features?: Record<string, number | string | boolean>;
  bondingAt?: string;
  prevBonding?: number;
  bondingVelocity?: number;
  createdAt: string;
  updatedAt: string;
};

export type TradeDoc = {
  mint: string;
  symbol?: string;
  name?: string;
  side: "buy" | "sell";
  mode: "paper";
  sol: number;
  priceUsd?: number;
  marketCapUsd?: number;
  note: string;
  createdAt: string;
  positionId?: string;
};

export type PositionStatus = "open" | "closed";

export type PositionDoc = {
  id: string;
  mint: string;
  symbol?: string;
  name?: string;
  status: PositionStatus;
  sol: number;
  entryPriceUsd: number;
  entryMc?: number;
  openedAt: string;
  reasonOpen?: string;
  exitPriceUsd?: number;
  exitMc?: number;
  closedAt?: string;
  reasonClose?: string;
  pnlSol?: number;
  pnlPct?: number;
  markPriceUsd?: number;
};

export type TraderSettings = {
  enabled: boolean;
  sizeSol: number;
  maxOpen: number;
  updatedAt: string;
};

export type EquityPoint = { t: string; pnlSol: number; cumPnl: number; equity: number };

export type TraderHistory = {
  settings: TraderSettings;
  open: PositionDoc[];
  closed: PositionDoc[];
  fills: TradeDoc[];
  curve: EquityPoint[];
  stats: {
    open: number;
    closed: number;
    wins: number;
    losses: number;
    winRate: number;
    realizedPnlSol: number;
    openMtmSol: number;
    equitySol: number;
  };
};

export type JobId = "ingest" | "live" | "calibrate" | "outcomes" | "rescore";

export type IngestJobDoc = {
  _id: JobId;
  running: boolean;
  lastRunAt?: string;
  nextRunAt?: string;
  inserted?: number;
  updated?: number;
  skipped?: number;
  scored?: number;
  labeled?: number;
  graduated?: number;
  failed?: number;
  outcomes?: number;
  threshold?: number;
  brier?: number;
  errors: string[];
  sources?: Record<string, number>;
  note?: string;
};

export type TapeCandle = {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
};

export type TapeTrade = {
  t: number;
  side: "buy" | "sell";
  sol: number;
  usd?: number;
  wallet: string;
  sig?: string;
  creator?: boolean;
  funder?: string;
  slot?: number;
};

export type TapeFeatures = {
  uniqueTraders?: number;
  tradeCount?: number;
  buyCount?: number;
  sellCount?: number;
  creatorSold?: boolean;
  washRatio?: number;
  dumpRatio?: number;
  sameWalletRoundtrip?: number;
  buySol?: number;
  sellSol?: number;
};

export type MeltLiveFeatures = {
  group2_top1_pct?: number | null;
  group2_top5_pct?: number | null;
  group2_top10_pct?: number | null;
  group2_top20_pct?: number | null;
  group2_holder_gini?: number | null;
  group2_dev_hold_pct?: number | null;
  group2_dev_initial_hold_pct?: number | null;
  group2_sniper_0s_hold_pct?: number | null;
  group2_sniper_1s_hold_pct?: number | null;
  group2_sniper_5s_hold_pct?: number | null;
  group2_sniper_10s_hold_pct?: number | null;
  group2_sniper_0s_ratio?: number | null;
  group2_sniper_1s_ratio?: number | null;
  group2_sniper_5s_ratio?: number | null;
  group2_sniper_10s_ratio?: number | null;
  group2_sniper_0s_num?: number | null;
  group2_sniper_5s_num?: number | null;
  group2_sniper_10s_num?: number | null;
  group3_holder_num?: number | null;
  group3_trader_num?: number | null;
  group3_buy_num?: number | null;
  group3_sell_num?: number | null;
  group3_buy_user_num?: number | null;
  group3_sell_user_num?: number | null;
  group3_sell_pressure?: number | null;
  group3_wash_ratio?: number | null;
  group3_tx_num?: number | null;
  group3_time_span?: number | null;
  group3_tx_per_sec?: number | null;
  top10HoldPct?: number | null;
  devHoldPct?: number | null;
  curveHoldPct?: number | null;
  lpExcluded?: boolean;
  creatorSold?: boolean;
  insiderGraph?: number | null;
  group4_cluster_num?: number | null;
  group4_cluster_total_pct?: number | null;
  group4_cluster_max_pct?: number | null;
  bundleHoldPct?: number | null;
};

export type ScoreDoc = {
  mint: string;
  source: "ingest" | "tape" | "live";
  scoredAt: string;
  rugProb: number;
  entryProb: number;
  exitProb: number;
  status: CoinStatus;
  flags?: CoinStatus[];
  riskLabel: RiskLabel;
  minRatio: number;
  returnRatio: number;
  features?: Record<string, number | string | boolean>;
  reasons: string[];
  marketCapUsd?: number;
  outcomeAt?: string;
  outcomeMc?: number;
  outcomeMinRatio?: number;
  outcomeReturn?: number;
  outcomeHigh?: boolean;
};

export type CurveOutcomeDoc = {
  mint: string;
  label: "graduated" | "failed";
  labeledAt: string;
  source?: "dump" | "live";
  ageMin?: number;
  bonding?: number;
  marketCapUsd?: number;
  holders?: number;
  buyers5m?: number;
  wash?: number;
  top10?: number;
  sellPressure?: number;
};

export type LaunchSnapshot = {
  mint: string;
  venue: string;
  dex?: string;
  name?: string;
  symbol?: string;
  description?: string;
  creator?: string;
  complete?: boolean;
  nsfw?: boolean;
  banned?: boolean;
  twitter?: string;
  telegram?: string;
  website?: string;
  replyCount?: number;
  usdMarketCap?: number;
  priceUsd?: number;
  athMarketCap?: number;
  realSolReserves?: number;
  launchedAt?: string;
  buyers5m?: number;
  sellers5m?: number;
  buys5m?: number;
  sells5m?: number;
  change5m?: number;
  change1h?: number;
  reserveUsd?: number;
  volume5m?: number;
  volume1h?: number;
  poolAddress?: string;
  tokenProgram?: string;
  quoteMint?: string;
  boostMode?: string;
  livestream?: boolean;
  username?: string;
  creatorLaunches?: number;
  holders?: number;
  tape?: TapeFeatures;
  melt?: MeltLiveFeatures;
  mintAuthority?: boolean;
  freezeAuthority?: boolean;
  top10HoldPct?: number;
  devHoldPct?: number;
  bundleHoldPct?: number;
  curveHoldPct?: number;
  bondingVelocity?: number;
};
