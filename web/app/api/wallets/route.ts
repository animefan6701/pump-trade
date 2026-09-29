import { NextResponse } from "next/server";
import { HIT500_MIN, PNL_MIN, WINRATE_MIN, listWalletRanks, parseWalletAddresses, upsertWalletRank } from "@/lib/walletRank";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: Request) {
  const qualify = new URL(req.url).searchParams.get("qualify") === "1";
  const wallets = await listWalletRanks({ qualify });
  return NextResponse.json({
    wallets,
    gates: { hit500: HIT500_MIN, winrate: WINRATE_MIN, pnl: PNL_MIN },
    asOf: new Date().toISOString(),
  });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { text?: string; wallets?: string[]; refresh?: boolean };
  let addrs = parseWalletAddresses([body.text, ...(body.wallets || [])].filter(Boolean).join(" "));
  if (body.refresh) {
    const stored = await listWalletRanks();
    addrs = [...new Set([...addrs, ...stored.map((w) => w.address)])];
  }
  if (!addrs.length) {
    return NextResponse.json({ error: "paste at least one wallet address" }, { status: 400 });
  }
  const keep = addrs.slice(0, 20);
  const wallets = [];
  const errors: { address: string; error: string }[] = [];
  for (const address of keep) {
    try {
      wallets.push(await upsertWalletRank(address));
    } catch (e) {
      errors.push({ address, error: e instanceof Error ? e.message : "fetch failed" });
    }
  }
  wallets.sort((a, b) => b.d7.hit500 - a.d7.hit500 || b.d7.winrate - a.d7.winrate || b.d7.pnl - a.d7.pnl);
  return NextResponse.json({
    wallets,
    errors,
    truncated: addrs.length > keep.length,
    gates: { hit500: HIT500_MIN, winrate: WINRATE_MIN, pnl: PNL_MIN },
  });
}
