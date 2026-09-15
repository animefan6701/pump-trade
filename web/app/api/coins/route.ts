import { NextResponse } from "next/server";
import { getDeskStats, peekDeskStats } from "@/lib/deskStats";
import { coins } from "@/lib/mongo";
import { mongoSort, parseCoinSort } from "@/lib/sort";
import type { CoinSource, CoinStatus } from "@/lib/types";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status") as CoinStatus | "all" | null;
  const source = (searchParams.get("source") as CoinSource | "all" | null) || "live";
  const q = (searchParams.get("q") || "").trim();
  const lite = searchParams.get("lite") === "1";
  const limit = Math.min(Math.max(Number(searchParams.get("limit") || 25), 5), 100);
  const page = Math.max(Number(searchParams.get("page") || 1), 1);
  const skip = (page - 1) * limit;
  const { field, direction } = parseCoinSort(searchParams.get("sort"), searchParams.get("dir"));

  const filter: Record<string, unknown> = {};
  if (source !== "all") filter.source = source === "melt" ? "melt" : "live";

  const clauses: Record<string, unknown>[] = [];
  if (status && status !== "all") {
    clauses.push({
      $or: [
        { flags: status },
        { flags: { $exists: false }, status },
        { flags: { $size: 0 }, status },
      ],
    });
  }
  if (q) {
    clauses.push({
      $or: [
        { mint: { $regex: q, $options: "i" } },
        { symbol: { $regex: q, $options: "i" } },
        { name: { $regex: q, $options: "i" } },
      ],
    });
  }
  if (clauses.length === 1) Object.assign(filter, clauses[0]);
  else if (clauses.length > 1) filter.$and = clauses;

  const col = await coins();
  const rowsP = col.find(filter).sort(mongoSort(field, direction)).skip(skip).limit(limit).toArray();
  const totalP = lite ? Promise.resolve(-1) : col.countDocuments(filter);
  const statsP = lite ? Promise.resolve(peekDeskStats()) : getDeskStats();
  const [total, rows, stats] = await Promise.all([totalP, rowsP, statsP]);
  const pages = total < 0 ? 1 : Math.max(1, Math.ceil(total / limit));

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
