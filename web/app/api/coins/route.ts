import { NextResponse } from "next/server";
import { blacklistMints } from "@/lib/blacklist";
import { getDeskStats, peekDeskStats } from "@/lib/deskStats";
import { coins } from "@/lib/mongo";
import { parseSearchQuery } from "@/lib/searchQuery";
import { mongoSort, parseCoinSort } from "@/lib/sort";
import type { CoinSource, CoinStatus } from "@/lib/types";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status") as CoinStatus | "all" | null;
  const source = (searchParams.get("source") as CoinSource | "all" | null) || "live";
  const parsed = parseSearchQuery(searchParams.get("q") || "");
  const q = parsed.q;
  const mintList = (searchParams.get("mints") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 100);
  const lite = searchParams.get("lite") === "1";
  const limit = Math.min(Math.max(Number(searchParams.get("limit") || 25), 5), 100);
  const page = Math.max(Number(searchParams.get("page") || 1), 1);
  const skip = (page - 1) * limit;
  const { field, direction } = parseCoinSort(searchParams.get("sort"), searchParams.get("dir"));

  const filter: Record<string, unknown> = {};
  if (source !== "all") filter.source = source === "melt" ? "melt" : "live";
  const blocked = await blacklistMints();

  const clauses: Record<string, unknown>[] = [];
  if (mintList.length) {
    filter.mint = { $in: mintList.filter((m) => !blocked.has(m)) };
  } else if (parsed.mint) {
    if (blocked.has(parsed.mint)) {
      return NextResponse.json(
        { coins: [], page, limit, total: 0, pages: 1, sort: field, dir: direction, stats: lite ? peekDeskStats() : await getDeskStats() },
        { headers: { "Cache-Control": "no-store, max-age=0" } },
      );
    }
    filter.mint = parsed.mint;
  } else {
    if (status && status !== "all") {
      // flags is an array: { flags: "enter" } matches ["enter","migrated"].
      // Do not require coin.status === tab — migrated entries keep status "enter"
      // or status "watching" with both flags.
      clauses.push({
        $or: [
          { flags: status },
          { flags: { $exists: false }, status },
          { flags: { $size: 0 }, status },
        ],
      });
    }
    if (q) {
      const safe = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      clauses.push({
        $or: [
          { mint: { $regex: safe, $options: "i" } },
          { symbol: { $regex: safe, $options: "i" } },
          { name: { $regex: safe, $options: "i" } },
        ],
      });
    }
  }
  if (clauses.length === 1) Object.assign(filter, clauses[0]);
  else if (clauses.length > 1) filter.$and = clauses;
  if (blocked.size && !filter.mint) filter.mint = { $nin: [...blocked] };

  const col = await coins();
  const rowsP = col.find(filter).sort(mongoSort(field, direction)).skip(skip).limit(limit).toArray();
  const listed = Array.isArray((filter.mint as { $in?: string[] } | undefined)?.$in)
    ? (filter.mint as { $in: string[] }).$in.length
    : -1;
  const totalP = mintList.length ? Promise.resolve(Math.max(0, listed)) : col.countDocuments(filter);
  const statsP = lite ? Promise.resolve(peekDeskStats()) : getDeskStats();
  const [total, rows, stats] = await Promise.all([totalP, rowsP, statsP]);
  const pages = Math.max(1, Math.ceil(Math.max(0, total) / limit));

  return NextResponse.json(
    {
      coins: rows.map(({ _id: _omit, ...rest }) => rest),
      page,
      limit,
      total: total < 0 ? rows.length : total,
      pages,
      sort: field,
      dir: direction,
      stats,
    },
    { headers: { "Cache-Control": "no-store, max-age=0" } },
  );
}
