import { isBlacklisted } from "./blacklist";
import { applyStatusChange } from "./deskStats";
import { isDumpedCoin, isFatLiveBook, isOffAth, saneAth } from "./dumpCheck";
import { flagsFor, hasFlag, isContinuationEnter, lockMultiple } from "./flags";
import {
  dir5mFlag,
  dumpFirstFlag,
  hit15xFlag,
  hit2xFlag,
  scoreContinuationFlags,
  scoreHeadFlags,
  survive70Flag,
} from "./heads";
import { appendMigrateBar, migrateLockFields, resolveMigrateEntryProb, scoreManipProxy } from "./migrateSeries";
import { pickSniperFeatures } from "./meltLive";
import { coins, migrateSeries } from "./mongo";
import { ANALYZE_TARGETS } from "./analyzeTypes";
import { scoreLaunch } from "./predict";
import { logScore } from "./scores";
import { maybeAutoTrade } from "./trader";
import type { CoinDoc, LaunchSnapshot, ScoreDoc } from "./types";

const GRADUATE_SOL = 85_000_000_000;

export async function scoreAndUpsert(
  snap: LaunchSnapshot,
  source: ScoreDoc["source"],
): Promise<{ inserted: boolean; scored: Omit<CoinDoc, "createdAt" | "updatedAt"> } | null> {
  if (await isBlacklisted(snap.mint)) return null;
  const col = await coins();
  const existing = await col.findOne({ mint: snap.mint });
  if (existing?.source === "melt") return null;

  if (typeof existing?.bondingProgress === "number" && typeof snap.realSolReserves === "number") {
    const hours = existing.bondingAt
      ? Math.max(1 / 60, (Date.now() - new Date(existing.bondingAt).getTime()) / 3_600_000)
      : 1;
    const nextBond = Math.min(1, snap.realSolReserves / GRADUATE_SOL);
    snap.bondingVelocity = (nextBond - existing.bondingProgress) / hours;
  }

  const dustLp = typeof snap.reserveUsd === "number" && snap.reserveUsd < 80;
  const liveMc = dustLp ? snap.usdMarketCap || 0 : snap.usdMarketCap || existing?.marketCapUsd || 0;
  snap.athMarketCap = saneAth(
    Math.max(existing?.athMarketCap || 0, snap.athMarketCap || 0, liveMc, existing?.marketCapUsd || 0),
    liveMc,
    existing?.migrateMc,
  );

  if (existing?.launchSnipers) {
    snap.launchSnipers = existing.launchSnipers;
    snap.launchSigs = existing.launchSigs ?? snap.launchSigs;
  }
  const lockedSnipers = pickSniperFeatures(snap.launchSnipers);
  if (lockedSnipers) snap.melt = { ...snap.melt, ...lockedSnipers };
  if (snap.complete == null && existing?.complete) snap.complete = existing.complete;
  if (snap.holders == null && existing?.holders) snap.holders = existing.holders;
  if (snap.reserveUsd == null && existing?.liquidityUsd) {
    const mc = snap.usdMarketCap || existing.marketCapUsd || 0;
    const inherit = existing.liquidityUsd;
    if (!(mc > 0 && inherit > mc * 8)) snap.reserveUsd = inherit;
  }
  if (snap.volume5m == null && existing?.volume5m) snap.volume5m = existing.volume5m;
  if (snap.volume1h == null && existing?.volume1h) snap.volume1h = existing.volume1h;
  if (snap.buyers5m == null && typeof existing?.features?.buyers5m === "number") {
    snap.buyers5m = existing.features.buyers5m;
  }
  if (snap.sellers5m == null && typeof existing?.features?.sellers5m === "number") {
    snap.sellers5m = existing.features.sellers5m;
  }
  if (snap.top10HoldPct == null && typeof existing?.features?.top10 === "number") {
    snap.top10HoldPct = existing.features.top10;
  }
  if (snap.devHoldPct == null && typeof existing?.features?.devHold === "number") {
    snap.devHoldPct = existing.features.devHold;
  }
  if (snap.complete && existing?.migrateMc && existing.migrateAt) {
    try {
      const series = await (await migrateSeries()).findOne({ mint: snap.mint });
      snap.manipScore = scoreManipProxy(series?.bars || [], existing.migrateMc).score;
    } catch {
      snap.manipScore = existing.manipScore;
    }
  }

  const heldEntry = await resolveMigrateEntryProb(existing, Boolean(snap.complete));
  if (heldEntry != null) snap.lockedEntryProb = heldEntry;

  const scored = scoreLaunch(snap);
  const holdEntry = heldEntry != null;
  const mergedAth = snap.athMarketCap || scored.athMarketCap || existing?.athMarketCap || liveMc;
  const mergedMc = scored.marketCapUsd || liveMc;
  const drained =
    dustLp &&
    (mergedAth || 0) >= 10_000 &&
    ((snap.change6h ?? 0) <= -50 || (snap.change1h ?? 0) <= -50 || (snap.change5m ?? 0) <= -35 || liveMc <= 0);
  if (
    drained ||
    isOffAth({
      minRatio: mergedAth > 0 && mergedMc > 0 ? mergedMc / mergedAth : 1,
      athMarketCap: mergedAth,
      marketCapUsd: mergedMc,
      liquidityUsd: snap.reserveUsd,
      holders: snap.holders ?? scored.holders,
    })
  ) {
    scored.status = "exit";
    scored.flags = flagsFor("exit", scored.complete);
    scored.minRatio = mergedMc / mergedAth;
    if (!holdEntry) scored.entryProb = Math.min(scored.entryProb, 0.12);
    scored.exitProb = Math.max(scored.exitProb, 0.8);
    scored.reasons = [
      `off stored ATH — ${Math.round((mergedMc / mergedAth) * 100)}% of $${Math.round(mergedAth).toLocaleString()}`,
      ...(scored.reasons || []).slice(0, 8),
    ];
  }
  const realTape = Boolean(snap.tape?.tradeCount || snap.tape?.uniqueTraders);
  const feat = existing?.features || {};
  const hardReasons = (existing?.reasons || []).filter((r) =>
    /creator already sold|insider graph|mint authority|freeze authority|impersonates/i.test(r),
  );
  const heldHard =
    feat.creatorSold === 1 ||
    feat.creatorSold === true ||
    (typeof feat.insiderGraph === "number" && feat.insiderGraph >= 80) ||
    hardReasons.length > 0;
  const fatLive = isFatLiveBook({
    liquidityUsd: snap.reserveUsd ?? scored.liquidityUsd,
    holders: snap.holders ?? scored.holders,
    marketCapUsd: scored.marketCapUsd || snap.usdMarketCap,
  });
  if (existing && source !== "tape" && heldHard && scored.status === "enter" && !fatLive) {
    scored.status = "rejected";
    scored.flags = flagsFor("rejected", scored.complete);
    if (!holdEntry) scored.entryProb = Math.min(scored.entryProb, 0.08);
    scored.rugProb = Math.max(scored.rugProb, 0.97);
    scored.reasons = [`held rejected — tape hard rule`, ...hardReasons.slice(0, 3), ...(scored.reasons || []).slice(0, 6)];
  }
  if (source !== "tape" && !realTape && snap.complete && scored.status === "enter" && !fatLive) {
    scored.status = "watching";
    scored.flags = flagsFor("watching", scored.complete);
    if (!holdEntry) scored.entryProb = Math.min(scored.entryProb, 0.28);
    scored.reasons = [`held enter — quote-only, no tape`, ...(scored.reasons || []).slice(0, 8)];
  }
  if ((snap.quoteMisses ?? 0) >= 12 && scored.status === "enter") {
    scored.status = "exit";
    scored.flags = flagsFor("exit", scored.complete);
    if (!holdEntry) scored.entryProb = Math.min(scored.entryProb, 0.1);
    scored.exitProb = Math.max(scored.exitProb, 0.7);
    scored.reasons = [`stale book — no Dex/Pump quote ×${snap.quoteMisses}`, ...(scored.reasons || []).slice(0, 8)];
  }
  if (
    existing &&
    source !== "tape" &&
    !realTape &&
    (existing.status === "rejected" || hasFlag(existing, "rejected")) &&
    scored.status === "enter"
  ) {
    const mc = scored.marketCapUsd || snap.usdMarketCap || 0;
    const liveBook = Boolean(scored.complete || (snap.reserveUsd ?? 0) >= 80 || mc >= 15_000);
    if (!liveBook) {
      scored.status = "rejected";
      scored.flags = flagsFor("rejected", scored.complete);
      if (!holdEntry) scored.entryProb = Math.min(scored.entryProb, 0.08);
      scored.reasons = [`held rejected — thin ${source} snap, no live book`, ...(scored.reasons || []).slice(0, 8)];
    }
  }
  const ts = new Date().toISOString();
  const lock = migrateLockFields(existing, scored, liveMc, ts, heldEntry);
  const athMarketCap = saneAth(
    Math.max(
      existing?.athMarketCap || 0,
      snap.athMarketCap || 0,
      snap.usdMarketCap || 0,
      scored.marketCapUsd || 0,
    ),
    scored.marketCapUsd || liveMc || 0,
    lock.migrateMc || existing?.migrateMc,
  );
  scored.athMarketCap = athMarketCap;
  if (lock.migrateMc) scored.migrateMc = lock.migrateMc;
  if (typeof lock.migrateEntryProb === "number") {
    scored.migrateEntryProb = lock.migrateEntryProb;
    scored.entryProb = lock.migrateEntryProb;
  }
  if (lock.migrateAt && scored.features) scored.features.migrateLock = existing?.migrateAt ? 0 : 1;
  if (lock.migrateMc && snap.complete) {
    let series = await appendMigrateBar(snap.mint, lock.migrateAt!, lock.migrateMc, {
      t: Date.now(),
      mc: liveMc || scored.marketCapUsd || lock.migrateMc,
      vol: snap.volume5m,
      buy: snap.buys5m ?? snap.buyers5m,
      sell: snap.sells5m ?? snap.sellers5m,
      tx: snap.tape?.tradeCount,
    });
    if (!series) {
      try {
        series = await (await migrateSeries()).findOne({ mint: snap.mint });
      } catch {
        series = null;
      }
    }
    const proxy = scoreManipProxy(series?.bars || [], lock.migrateMc);
    scored.manipScore = proxy.score;
    scored.features = { ...scored.features, manipScore: proxy.score };
    if (proxy.score >= 0.7) {
      scored.manipulated = "yes";
      if (proxy.why) {
        scored.reasons = [`manipulator flag — ${proxy.why}`, ...(scored.reasons || []).slice(0, 8)];
      }
    }
    const top10 = typeof scored.features?.top10 === "number" ? scored.features.top10 : undefined;
    const wash = typeof scored.features?.wash === "number" ? scored.features.wash : undefined;
    const heads = scoreHeadFlags({
      bars: series?.bars,
      migrateMc: lock.migrateMc,
      top10,
      holders: scored.holders ?? snap.holders,
      wash,
    });
    if (heads.dir5mProb != null) scored.dir5mProb = heads.dir5mProb;
    if (heads.hit2xProb != null) scored.hit2xProb = heads.hit2xProb;
    if (heads.dumpFirstProb != null) scored.dumpFirstProb = heads.dumpFirstProb;
    scored.features = {
      ...scored.features,
      ...(heads.dir5mProb != null ? { dir5mProb: heads.dir5mProb } : {}),
      ...(heads.hit2xProb != null ? { hit2xProb: heads.hit2xProb } : {}),
      ...(heads.dumpFirstProb != null ? { dumpFirstProb: heads.dumpFirstProb } : {}),
    };
    const headNotes: string[] = [];
    if (dir5mFlag(heads.dir5mProb)) headNotes.push(`flag — UP5M ${Math.round((heads.dir5mProb || 0) * 100)}%`);
    if (hit2xFlag(heads.hit2xProb)) headNotes.push(`flag — X2 ${Math.round((heads.hit2xProb || 0) * 100)}%`);
    if (dumpFirstFlag(heads.dumpFirstProb)) {
      headNotes.push(`flag — DUMP1st ${Math.round((heads.dumpFirstProb || 0) * 100)}%`);
    }
    if (headNotes.length) {
      scored.reasons = [...headNotes, ...(scored.reasons || []).filter((r) => !r.startsWith("flag — ")).slice(0, 8)];
    }
  }
  const lockFeats = lock.migrateFeatures || existing?.migrateFeatures;
  if (lock.migrateMc && lockFeats) {
    const cont = scoreContinuationFlags({
      migrateFeatures: lockFeats,
      migrateMc: lock.migrateMc,
      migrateEntryProb: lock.migrateEntryProb ?? existing?.migrateEntryProb,
    });
    if (cont.survive70Prob != null) scored.survive70Prob = cont.survive70Prob;
    if (cont.hit15xProb != null) scored.hit15xProb = cont.hit15xProb;
    scored.features = {
      ...scored.features,
      ...(cont.survive70Prob != null ? { survive70Prob: cont.survive70Prob } : {}),
      ...(cont.hit15xProb != null ? { hit15xProb: cont.hit15xProb } : {}),
    };
    const flagNotes = (scored.reasons || []).filter((r) => r.startsWith("flag — "));
    if (survive70Flag(cont.survive70Prob)) {
      flagNotes.push(`flag — HOLD70 ${Math.round((cont.survive70Prob || 0) * 100)}%`);
    }
    if (hit15xFlag(cont.hit15xProb)) {
      flagNotes.push(`flag — HIT15x ${Math.round((cont.hit15xProb || 0) * 100)}%`);
    }
    if (flagNotes.length) {
      scored.reasons = [...flagNotes, ...(scored.reasons || []).filter((r) => !r.startsWith("flag — ")).slice(0, 8)];
    }
    const lockMult = lockMultiple(scored.marketCapUsd, lock.migrateMc);
    const dumpedNow =
      scored.status === "exit" ||
      (lockMult != null && lockMult < 0.7) ||
      isDumpedCoin({
        status: scored.status,
        exitProb: scored.exitProb,
        minRatio: scored.minRatio,
        athMarketCap: scored.athMarketCap,
        marketCapUsd: scored.marketCapUsd,
        liquidityUsd: scored.liquidityUsd,
        holders: scored.holders,
        change5m: scored.change5m,
        change1h: scored.change1h,
        change6h: scored.change6h,
      });
    if (dumpedNow && scored.status !== "rejected") {
      scored.status = "exit";
      scored.flags = flagsFor("exit", true);
      if (lockMult != null && lockMult < 0.7) {
        scored.reasons = [
          `dumped vs lock — ${lockMult.toFixed(2)}× migrate MC`,
          ...(scored.reasons || []).filter((r) => !r.startsWith("dumped vs lock")).slice(0, 8),
        ];
      }
    } else if (
      isContinuationEnter({
        complete: scored.complete,
        status: scored.status,
        survive70Prob: scored.survive70Prob,
        marketCapUsd: scored.marketCapUsd,
        migrateMc: lock.migrateMc,
        athMarketCap: scored.athMarketCap,
        liquidityUsd: scored.liquidityUsd,
        holders: scored.holders,
        change5m: scored.change5m,
        change1h: scored.change1h,
        change6h: scored.change6h,
        exitProb: scored.exitProb,
        minRatio: scored.minRatio,
        entryProb: scored.entryProb,
        migrateEntryProb: scored.migrateEntryProb ?? lock.migrateEntryProb,
      })
    ) {
      scored.status = "enter";
      scored.flags = flagsFor("enter", true);
      scored.reasons = [
        `continuation ENTER — HOLD70 ${Math.round((scored.survive70Prob || 0) * 100)}% · ${(lockMult || 0).toFixed(2)}× lock`,
        ...(scored.reasons || []).filter((r) => !r.startsWith("continuation ENTER")).slice(0, 8),
      ];
    }
  }
  const analyzeHits = { ...(existing?.analyzeHits || {}) };
  const liveMcNow = scored.marketCapUsd || 0;
  const prevMc = existing?.marketCapUsd || 0;
  const t0 = snap.launchedAt || existing?.launchedAt;
  for (const tg of ANALYZE_TARGETS) {
    if (analyzeHits[tg.key]?.at) continue;
    if (liveMcNow >= tg.usd && prevMc < tg.usd) {
      analyzeHits[tg.key] = {
        at: ts,
        durationMs: t0 ? Math.max(0, Date.now() - new Date(t0).getTime()) : undefined,
      };
    }
  }
  void logScore(scored, source);
  const launchSnipers =
    existing?.launchSnipers || pickSniperFeatures(snap.launchSnipers) || pickSniperFeatures(snap.melt);
  const launchSigs = existing?.launchSigs?.length ? existing.launchSigs : snap.launchSigs;
  const launchTapeAt = snap.launchTapeAt || existing?.launchTapeAt || (launchSnipers || launchSigs?.length ? ts : undefined);
  const tapeTries = snap.tapeTries ?? existing?.tapeTries;
  const nextTapeAt = snap.nextTapeAt ?? existing?.nextTapeAt;
  const wr = await col.updateOne(
    { mint: snap.mint },
    {
      $set: {
        ...scored,
        athMarketCap,
        updatedAt: ts,
        prevBonding: existing?.bondingProgress,
        bondingAt: ts,
        bondingVelocity: snap.bondingVelocity,
        ...(launchSnipers ? { launchSnipers } : {}),
        ...(launchSigs?.length ? { launchSigs } : {}),
        ...(launchTapeAt ? { launchTapeAt } : {}),
        ...(typeof tapeTries === "number" ? { tapeTries } : {}),
        ...(nextTapeAt ? { nextTapeAt } : {}),
        ...(typeof snap.quoteMisses === "number" ? { quoteMisses: snap.quoteMisses } : {}),
        analyzeHits,
        ...lock,
      },
      $setOnInsert: { createdAt: existing?.createdAt || ts },
    },
    { upsert: true },
  );
  const inserted = Boolean(wr.upsertedCount) || !existing;
  applyStatusChange(existing?.status, scored.status, inserted);
  void maybeAutoTrade(existing, scored);
  return { inserted, scored };
}
