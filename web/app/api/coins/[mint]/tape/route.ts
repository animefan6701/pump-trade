import { NextResponse } from "next/server";
import { loadTokenTape } from "@/lib/tape";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

type Ctx = { params: Promise<{ mint: string }> };

export async function GET(_: Request, ctx: Ctx) {
  const { mint } = await ctx.params;
  if (!mint) return NextResponse.json({ error: "mint required" }, { status: 400 });
  try {
    const tape = await loadTokenTape(mint);
    return NextResponse.json(tape);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "tape failed" },
      { status: 502 },
    );
  }
}
