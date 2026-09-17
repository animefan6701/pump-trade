import { calibrateIntervalMs, runCalibration } from "./calibrate";
import { intervalMs, runIngestCycle } from "./ingest";
import { startLiveIngest } from "./liveIngest";
import { runOutcomesCycle } from "./outcomes";
import { fullRescoreIntervalMs, rescoreIntervalMs, rescoreRejected } from "./rescoreRejected";

const g = globalThis as typeof globalThis & {
  __tapeIngest?: ReturnType<typeof setInterval>;
  __tapeIngestBoot?: ReturnType<typeof setTimeout>;
  __calibrate?: ReturnType<typeof setInterval>;
  __outcomes?: ReturnType<typeof setInterval>;
  __rescore?: ReturnType<typeof setInterval>;
  __rescoreFull?: ReturnType<typeof setInterval>;
};

function tick() {
  void runIngestCycle().catch((err) => {
    console.error("[ingest] cycle failed", err);
  });
}

export function startIngestScheduler() {
  if (g.__tapeIngest || g.__tapeIngestBoot) return;
  g.__tapeIngestBoot = setTimeout(() => {
    g.__tapeIngestBoot = undefined;
    tick();
    g.__tapeIngest = setInterval(tick, intervalMs());
  }, 20_000);

  startLiveIngest();

  const calMs = calibrateIntervalMs();
  setTimeout(() => {
    void runCalibration().catch((err) => console.error("[calibrate] failed", err));
    g.__calibrate = setInterval(() => {
      void runCalibration().catch((err) => console.error("[calibrate] failed", err));
    }, calMs);
  }, 45_000);

  setTimeout(() => {
    void runOutcomesCycle().catch((err) => console.error("[outcomes] failed", err));
    g.__outcomes = setInterval(() => {
      void runOutcomesCycle().catch((err) => console.error("[outcomes] failed", err));
    }, 30 * 60_000);
  }, 70_000);

  const rescoreMs = rescoreIntervalMs();
  setTimeout(() => {
    void rescoreRejected({ mode: "hot" }).catch((err) => console.error("[rescore] failed", err));
    g.__rescore = setInterval(() => {
      void rescoreRejected({ mode: "hot" }).catch((err) => console.error("[rescore] failed", err));
    }, rescoreMs);
  }, 90_000);

  const fullMs = fullRescoreIntervalMs();
  setTimeout(() => {
    void rescoreRejected({ mode: "full" }).catch((err) => console.error("[rescore-full] failed", err));
    g.__rescoreFull = setInterval(() => {
      void rescoreRejected({ mode: "full" }).catch((err) => console.error("[rescore-full] failed", err));
    }, fullMs);
  }, 20 * 60_000);
}
