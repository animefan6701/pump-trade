import { NextResponse } from "next/server";
import { getDeskStats } from "@/lib/deskStats";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await getDeskStats(), {
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}
