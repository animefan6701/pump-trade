import { NextResponse } from "next/server";
import { addUserKey, listKeys, liveSolanaUrls } from "@/lib/heliusKeys";

export const dynamic = "force-dynamic";

function hostOnly(url: string) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return url.split("?")[0];
  }
}

export async function GET() {
  const [{ keys, activeId }, urls] = await Promise.all([listKeys(), liveSolanaUrls()]);
  return NextResponse.json({
    keys,
    activeId,
    rpc: urls ? hostOnly(urls.rpc) : null,
    ws: urls ? hostOnly(urls.ws) : null,
  });
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { key?: string; projectId?: string; label?: string };
    const row = await addUserKey(String(body.key || ""), String(body.projectId || ""), body.label);
    return NextResponse.json({ key: row });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "add failed" }, { status: 400 });
  }
}
