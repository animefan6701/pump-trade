import { NextResponse } from "next/server";
import { isBlacklisted, removeBlacklist } from "@/lib/blacklist";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ mint: string }> };

export async function GET(_: Request, ctx: Ctx) {
  const { mint } = await ctx.params;
  return NextResponse.json({ mint, blocked: await isBlacklisted(mint) });
}

export async function DELETE(_: Request, ctx: Ctx) {
  const { mint } = await ctx.params;
  if (!mint) return NextResponse.json({ error: "mint required" }, { status: 400 });
  await removeBlacklist(mint);
  return NextResponse.json({ ok: true, mint });
}
