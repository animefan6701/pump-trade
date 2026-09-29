import { NextResponse } from "next/server";
import { buildAnalyzeToken } from "@/lib/analyze";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

type Ctx = { params: Promise<{ mint: string }> };

export async function GET(_: Request, ctx: Ctx) {
  const { mint } = await ctx.params;
  try {
    const detail = await buildAnalyzeToken(mint);
    if (!detail) return NextResponse.json({ error: "not a 500k survivor" }, { status: 404 });
    return NextResponse.json(detail, {
      headers: { "Cache-Control": "no-store, max-age=0" },
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "analyze failed" }, { status: 500 });
  }
}
