import { MongoClient, type Db } from "mongodb";
import { config as loadEnv } from "dotenv";
import { resolve } from "path";
import type {
  BlacklistDoc,
  WatchPinDoc,
  CoinDoc,
  CurveOutcomeDoc,
  ApiKeyDoc,
  IngestJobDoc,
  MigrateSeriesDoc,
  PositionDoc,
  OhlcvCacheDoc,
  ScoreDoc,
  TradeDoc,
  TraderSettings,
  WalletAlertEventDoc,
  WalletAlertStateDoc,
  WalletRankDoc,
  PortfolioMilestoneEventDoc,
  PortfolioMilestoneStateDoc,
  PortfolioMilestoneTokenDoc,
} from "./types";

loadEnv({ path: resolve(process.cwd(), "../.env") });
loadEnv({ path: resolve(process.cwd(), ".env") });

const uri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017";
const dbName = process.env.MONGODB_DB || "pump_trade";

let client: MongoClient | null = null;

export async function getDb(): Promise<Db> {
  if (!client) {
    client = new MongoClient(uri);
    await client.connect();
  }
  return client.db(dbName);
}

export async function coins() {
  return (await getDb()).collection<CoinDoc>("coins");
}

export async function trades() {
  return (await getDb()).collection<TradeDoc>("trades");
}

export async function jobs() {
  return (await getDb()).collection<IngestJobDoc>("jobs");
}

export async function scores() {
  return (await getDb()).collection<ScoreDoc>("scores");
}

export async function outcomes() {
  return (await getDb()).collection<CurveOutcomeDoc>("curve_outcomes");
}

export async function positions() {
  return (await getDb()).collection<PositionDoc>("positions");
}

export async function traderSettings() {
  return (await getDb()).collection<TraderSettings & { _id: string }>("trader");
}

export async function migrateSeries() {
  return (await getDb()).collection<MigrateSeriesDoc>("migrate_series");
}

export async function apiKeys() {
  return (await getDb()).collection<ApiKeyDoc>("api_keys");
}

export async function blacklist() {
  return (await getDb()).collection<BlacklistDoc>("blacklist");
}

export async function watchPins() {
  return (await getDb()).collection<WatchPinDoc>("watch_pins");
}

export async function ohlcvCache() {
  return (await getDb()).collection<OhlcvCacheDoc>("ohlcv_cache");
}

export async function walletRanks() {
  return (await getDb()).collection<WalletRankDoc>("wallet_ranks");
}

export async function walletAlertState() {
  return (await getDb()).collection<WalletAlertStateDoc>("wallet_alert_state");
}

export async function walletAlertEvents() {
  return (await getDb()).collection<WalletAlertEventDoc>("wallet_alert_events");
}

export async function portfolioMilestoneState() {
  return (await getDb()).collection<PortfolioMilestoneStateDoc>("portfolio_milestone_state");
}

export async function portfolioMilestoneEvents() {
  return (await getDb()).collection<PortfolioMilestoneEventDoc>("portfolio_milestone_events");
}

let milestoneTokenIndex = false;

export async function portfolioMilestoneTokens() {
  const col = (await getDb()).collection<PortfolioMilestoneTokenDoc>("portfolio_milestone_tokens");
  if (!milestoneTokenIndex) {
    await col.createIndex({ address: 1, mint: 1 }, { unique: true });
    milestoneTokenIndex = true;
  }
  return col;
}
