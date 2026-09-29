import { NextResponse } from "next/server";
import { buildAnalyzeBoard } from "@/lib/analyze";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  try {
    const board = await buildAnalyzeBoard();
    return NextResponse.json(board, {
      headers: { "Cache-Control": "no-store, max-age=0" },
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "analyze failed" }, { status: 500 });
  }
}
