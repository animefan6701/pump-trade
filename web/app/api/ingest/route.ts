import { NextResponse } from "next/server";
import { getCalibrateStatus, runCalibration } from "@/lib/calibrate";
import { getIngestStatus, intervalMs, runIngestCycle } from "@/lib/ingest";
import { getLiveStatus, liveMs, runLivePumpCycle } from "@/lib/liveIngest";

export const dynamic = "force-dynamic";
export const maxDuration = 180;

export async function GET() {
  const [job, live, cal] = await Promise.all([
    getIngestStatus(),
    getLiveStatus(),
    getCalibrateStatus(),
  ]);
  return NextResponse.json({
    job,
    live,
    cal,
    intervalMs: intervalMs(),
    liveMs: liveMs(),
  });
}

export async function POST() {
  const job = await runIngestCycle();
  void runLivePumpCycle().catch(() => null);
  void runCalibration().catch(() => null);
  return NextResponse.json({ ok: true, job });
}
