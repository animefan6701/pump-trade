import { NextResponse } from "next/server";
import { isBlacklisted } from "@/lib/blacklist";
import { applyStatusChange } from "@/lib/deskStats";
import { coins, trades } from "@/lib/mongo";
import type { CoinStatus, TradeDoc } from "@/lib/types";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ mint: string }> };

export async function GET(_: Request, ctx: Ctx) {
  const { mint } = await ctx.params;
  if (await isBlacklisted(mint)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const coin = await (await coins()).findOne({ mint });
  if (!coin) return NextResponse.json({ error: "not found" }, { status: 404 });
  const fills = await (await trades())
    .find({ mint })
    .sort({ createdAt: -1 })
    .limit(40)
    .toArray();
  const { _id: _omit, ...rest } = coin;
  return NextResponse.json({
    coin: rest,
    trades: fills.map(({ _id: _t, ...t }) => t),
  });
}

export async function POST(req: Request, ctx: Ctx) {
  const { mint } = await ctx.params;
  if (await isBlacklisted(mint)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  const side: TradeDoc["side"] | null =
    body.side === "sell" ? "sell" : body.side === "buy" ? "buy" : null;
  if (!side) return NextResponse.json({ error: "side required" }, { status: 400 });

  const col = await coins();
  const coin = await col.findOne({ mint });
  if (!coin) return NextResponse.json({ error: "not found" }, { status: 404 });

  const now = new Date().toISOString();
  const nextStatus: CoinStatus = side === "buy" ? "enter" : "exit";
  const trade: TradeDoc = {
    mint,
    symbol: coin.symbol,
    name: coin.name,
    side,
    mode: "paper" as const,
    sol: 0.1,
    priceUsd: coin.priceUsd,
    marketCapUsd: coin.marketCapUsd,
    note: "desk paper fill",
    createdAt: now,
  };
  await (await trades()).insertOne(trade);
  applyStatusChange(coin.status, nextStatus);
  await col.updateOne({ mint }, { $set: { status: nextStatus, updatedAt: now } });
  return NextResponse.json({ ok: true, trade });
}
