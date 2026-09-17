import { NextResponse } from "next/server";
import { addBlacklist, listBlacklist } from "@/lib/blacklist";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  const rows = await listBlacklist();
  return NextResponse.json({
    mints: rows.map(({ _id: _omit, ...rest }) => rest),
  });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { mint?: string; symbol?: string };
  try {
    const row = await addBlacklist(String(body.mint || ""), body.symbol);
    return NextResponse.json({ ok: true, mint: row });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "blacklist failed" }, { status: 400 });
  }
}
