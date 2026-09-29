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
  change1h?: number;
  change6h?: number;
  holders?: number;
  bondingProgress?: number;
  launchedAt?: string;
  twitter?: string;
  website?: string;
  dex?: string;
  poolAddress?: string;
  features?: Record<string, number | string | boolean>;
  launchSnipers?: MeltLiveFeatures;
  launchSigs?: string[];
  launchTapeAt?: string;
  tapeTries?: number;
  nextTapeAt?: string;
  quoteMisses?: number;
  migrateAt?: string;
  migrateMc?: number;
  migrateEntryProb?: number;
  migrateFeatures?: Record<string, number | string | boolean>;
  migrateMinMc?: number;
  migrateOutcomeAt?: string;
  migrateMinRatio?: number;
  migrateHigh?: boolean;
  migrateSurvive70?: boolean;
  migrateHit15x?: boolean;
  migrateMaxMc?: number;
  migrateHit2x?: boolean;
  migrateHit5x?: boolean;
  dir5mProb?: number;
  hit2xProb?: number;
  dumpFirstProb?: number;
  survive70Prob?: number;
  hit15xProb?: number;
  manipScore?: number;
  bondingAt?: string;
  prevBonding?: number;
  bondingVelocity?: number;
  analyzeHits?: Partial<Record<string, { at: string; durationMs?: number }>>;
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

export type BlacklistDoc = {
  mint: string;
  symbol?: string;
  addedAt: string;
};

export type WatchPinDoc = {
  mint: string;
  symbol?: string;
  addedAt: string;
};

export type JobId = "ingest" | "live" | "newest" | "moon" | "calibrate" | "outcomes" | "rescore" | "rescoreFull";

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
  tokens?: number;
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
  group2_sniper_1s_num?: number | null;
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
  group4_jito_hit?: number | null;
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
  complete?: boolean;
  riskLabel: RiskLabel;
  minRatio: number;
  returnRatio: number;
  features?: Record<string, number | string | boolean>;
  reasons: string[];
  marketCapUsd?: number;
  athMarketCap?: number;
  liquidityUsd?: number;
  volume5m?: number;
  volume1h?: number;
  holders?: number;
  change5m?: number;
  change1h?: number;
  launchedAt?: string;
  outcomeAt?: string;
  outcomeMc?: number;
  outcomeMinRatio?: number;
  outcomeReturn?: number;
  outcomeHigh?: boolean;
  outcomeSurvive70?: boolean;
  outcomeHit15x?: boolean;
  outcomeKind?: string;
  calAttempts?: number;
  migrateMc?: number;
  migrateMinMc?: number;
  migrateMinRatio?: number;
  migrateHigh?: boolean;
  migrateKind?: string;
};

export type MigrateBar = {
  t: number;
  mc: number;
  vol?: number;
  buy?: number;
  sell?: number;
  tx?: number;
};

export type MigrateSeriesDoc = {
  mint: string;
  migrateAt: string;
  migrateMc: number;
  bars: MigrateBar[];
  minMc?: number;
  maxMc?: number;
  updatedAt: string;
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
  change6h?: number;
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
  launchSnipers?: MeltLiveFeatures;
  launchSigs?: string[];
  launchTapeAt?: string;
  tapeTries?: number;
  nextTapeAt?: string;
  quoteMisses?: number;
  manipScore?: number;
  lockedEntryProb?: number;
};

export type ApiKeyKind = "helius";
export type ApiKeySource = "user" | "env";

export type ApiKeyDoc = {
  id: string;
  kind: ApiKeyKind;
  source: ApiKeySource;
  label: string;
  key: string;
  projectId?: string;
  enabled: boolean;
  priority: number;
  creditsUsed?: number;
  creditsRemaining?: number;
  creditsLimit?: number;
  prepaidRemaining?: number;
  usagePct?: number;
  plan?: string;
  cycleEnd?: string;
  localCredits?: number;
  calls?: number;
  lastStatus?: number;
  lastError?: string;
  lastUsedAt?: string;
  usageAt?: string;
  exhaustedUntil?: string;
  createdAt: string;
  updatedAt: string;
};

export type PublicApiKey = Omit<ApiKeyDoc, "key"> & { last4: string; active?: boolean };

export type PumpBook = {
  mint: string;
  name?: string;
  symbol?: string;
  creator?: string;
  complete: boolean;
  bondingCurve?: string;
  swapPool?: string;
  poolAddress?: string;
  quoteMint?: string;
  quoteDecimals: number;
  usdMarketCap?: number;
  athMarketCap?: number;
  solUsd?: number;
  twitter?: string;
  website?: string;
  realQuoteReserves?: number;
  realSolReserves?: number;
};

export type DexBook = {
  pairAddress?: string;
  dex?: string;
  name?: string;
  symbol?: string;
  twitter?: string;
  priceUsd?: number;
  marketCapUsd?: number;
  liquidityUsd?: number;
  solUsd?: number;
  volume5m?: number;
  volume1h?: number;
  change5m?: number;
  change1h?: number;
  change6h?: number;
  buys5m?: number;
  sells5m?: number;
};

export type LiveBook = {
  mint: string;
  complete: boolean;
  onCurve: boolean;
  usdMarketCap: number;
  priceUsd?: number;
  athMarketCap?: number;
  reserveUsd: number;
  realQuoteReserves?: number;
  realSolReserves?: number;
  quoteMint?: string;
  quoteDecimals?: number;
  bondingCurve?: string;
  poolAddress?: string;
  name?: string;
  symbol?: string;
  creator?: string;
  twitter?: string;
  website?: string;
  dex?: string;
  volume5m?: number;
  volume1h?: number;
  change5m?: number;
  change1h?: number;
  change6h?: number;
  buys5m?: number;
  sells5m?: number;
  lpSource: "helius" | "pump" | "dex" | "none";
  mcSource: "pump" | "dex" | "none";
};

export type OhlcvBar = {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v?: number;
};

export type OhlcvCacheDoc = {
  mint: string;
  pool?: string;
  tf: "hour" | "day";
  bars: OhlcvBar[];
  supply?: number;
  fetchedAt: string;
};

export type WalletWindow = {
  buy: number;
  sell: number;
  trades: number;
  winrate: number;
  pnl: number;
  realizedUsd: number;
  costUsd: number;
  hit500: number;
  hit2x: number;
  tokens: number;
};

export type WalletAlertKind = "FIRST BUY" | "BUY MORE" | "SELL ALL" | "SELL PARTIAL";

export type WalletAlertStateDoc = {
  address: string;
  primed: boolean;
  seen: string[];
  bags: Record<string, boolean>;
  updatedAt: string;
};

export type WalletAlertEventDoc = {
  address: string;
  kind: WalletAlertKind;
  mint: string;
  symbol?: string;
  tx: string;
  usd?: number;
  mc?: number;
  at: string;
};

export type PortfolioMilestoneToken = {
  symbol: string;
  entry: number;
  hit: number[];
};

export type PortfolioMilestoneStateDoc = {
  address: string;
  primed: boolean;
  tokens: Record<string, PortfolioMilestoneToken>;
  updatedAt: string;
};

export type PortfolioMilestoneRangeStatus = {
  sent: boolean;
  level: number;
  multiple: number;
  at: string;
};

export type PortfolioMilestoneTokenDoc = {
  address: string;
  mint: string;
  symbol: string;
  entry: number;
  entryMc: number;
  cost: number;
  amount: number;
  usd: number;
  price: number;
  mc: number;
  multiple: number;
  range: string;
  notified: Record<string, PortfolioMilestoneRangeStatus>;
  lastNotified?: string;
  lastNotifiedAt?: string;
  updatedAt: string;
};

export type PortfolioMilestoneEventDoc = {
  address: string;
  mint: string;
  symbol?: string;
  label: string;
  level: number;
  entry: number;
  entryMc?: number;
  price: number;
  mc?: number;
  multiple: number;
  amount: number;
  usd: number;
  at: string;
};

export type WalletRankDoc = {
  address: string;
  chain: string;
  name?: string;
  tags: string[];
  twitter?: string;
  d7: WalletWindow;
  d30: WalletWindow;
  all: WalletWindow;
  qualify: boolean;
  reasons: string[];
  fetchedAt: string;
  createdAt: string;
  updatedAt: string;
};
