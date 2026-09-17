import { NextResponse } from "next/server";
import { listWatchPins, replaceWatchPins } from "@/lib/watchPins";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  const pins = await listWatchPins();
  return NextResponse.json({
    pins: pins.map((p) => ({ mint: p.mint, symbol: p.symbol, addedAt: p.addedAt })),
  });
}

export async function PUT(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { items?: { mint?: string; symbol?: string; addedAt?: string }[] };
  const pins = await replaceWatchPins(body.items || []);
  return NextResponse.json({ ok: true, pins });
}
