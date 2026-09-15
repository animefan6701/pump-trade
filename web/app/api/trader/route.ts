import { NextResponse } from "next/server";
import { getTraderSettings, setTraderEnabled } from "@/lib/trader";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ settings: await getTraderSettings() });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  if (typeof body.enabled !== "boolean") {
    return NextResponse.json({ error: "enabled must be boolean" }, { status: 400 });
  }
  const settings = await setTraderEnabled(body.enabled);
  return NextResponse.json({ settings });
}
