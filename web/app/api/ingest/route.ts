import { NextResponse } from "next/server";
import { getCalibrateStatus, runCalibration } from "@/lib/calibrate";
import { getIngestStatus, intervalMs, runIngestCycle } from "@/lib/ingest";
import { getLiveStatus, getNewestStatus, liveMs, newestMs, runLivePumpCycle } from "@/lib/liveIngest";
import { getMoonStatus, moonMs } from "@/lib/moonIngest";
import { fullRescoreIntervalMs, getFullRescoreStatus, getRescoreStatus, rescoreIntervalMs } from "@/lib/rescoreRejected";
import { startIngestScheduler } from "@/lib/scheduler";

export const dynamic = "force-dynamic";
export const maxDuration = 180;

export async function GET() {
  startIngestScheduler();
  const [job, live, newest, moon, cal, rescore, rescoreFull] = await Promise.all([
    getIngestStatus(),
    getLiveStatus(),
    getNewestStatus(),
    getMoonStatus(),
    getCalibrateStatus(),
    getRescoreStatus(),
    getFullRescoreStatus(),
  ]);
  return NextResponse.json({
    job,
    live,
    newest,
    moon,
    cal,
    rescore,
    rescoreFull,
    intervalMs: intervalMs(),
    liveMs: liveMs(),
    newestMs: newestMs(),
    moonMs: moonMs(),
    rescoreMs: rescoreIntervalMs(),
    fullRescoreMs: fullRescoreIntervalMs(),
  });
}

export async function POST() {
  void runIngestCycle().catch((err) => console.error("[ingest] pull failed", err));
  void runLivePumpCycle().catch(() => null);
  void runCalibration().catch(() => null);
  const job = await getIngestStatus();
  return NextResponse.json({ ok: true, job: job ? { ...job, running: true } : { running: true } });
}
