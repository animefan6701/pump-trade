import { NextResponse } from "next/server";
import { traderHistory } from "@/lib/trader";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await traderHistory());
}
