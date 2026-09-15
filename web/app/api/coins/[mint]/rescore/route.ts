import { NextResponse } from "next/server";
import { loadTokenTape } from "@/lib/tape";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

type Ctx = { params: Promise<{ mint: string }> };

export async function POST(_: Request, ctx: Ctx) {
  const { mint } = await ctx.params;
  if (!mint) return NextResponse.json({ error: "mint required" }, { status: 400 });
  try {
    const tape = await loadTokenTape(mint);
    if (!tape.coin) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({ coin: tape.coin });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "rescore failed" },
      { status: 502 },
    );
  }
}
