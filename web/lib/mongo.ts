import { MongoClient, type Db } from "mongodb";
import { config as loadEnv } from "dotenv";
import { resolve } from "path";
import type { CoinDoc, CurveOutcomeDoc, IngestJobDoc, PositionDoc, ScoreDoc, TradeDoc, TraderSettings } from "./types";

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
