import { NextResponse } from "next/server";
import { removeKey, updateKey } from "@/lib/heliusKeys";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function DELETE(_: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const ok = await removeKey(id);
  return NextResponse.json({ ok });
}

export async function PATCH(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const body = (await req.json()) as { label?: string; projectId?: string; enabled?: boolean; priority?: number };
  const row = await updateKey(id, body);
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ key: row });
}
