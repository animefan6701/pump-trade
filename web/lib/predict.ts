import { scoreCorpusRug, scoreEntryModel } from "./entryModel";
import { flagsFor } from "./flags";
import { scoreRugModel } from "./xgb";
import type { CoinDoc, LaunchSnapshot, RiskLabel } from "./types";

const DEPLOY_KIT = /deployed using|j7tracker|uxento|bagwork|autosnipe|pump.?fun.?bot/i;
const BRAND_IMPERSONATION =
  /bmwgroup\.com|(?:x|twitter)\.com\/bmw(?:$|[/?#])|tesla\.com|apple\.com|nike\.com|adidas\.com|microsoft\.com|samsung\.com|cocacola|mcdonalds\.com|meta\.com|openai\.com|pokemon\.com|nintendo\.com|(?:x|twitter)\.com\/pokemon(?:$|[/?#])/i;
const GRADUATE_SOL_LAMPORTS = 85_000_000_000;

function clamp(n: number, lo = 0, hi = 0.97) {
  return Math.min(hi, Math.max(lo, n));
}

function envNum(name: string, fallback: number) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : fallback;
}

function meltVector(snap: LaunchSnapshot): Record<string, number | null | undefined> {
  const m = snap.melt || {};
  const tape = snap.tape;
  return {
    group2_top1_pct: m.group2_top1_pct ?? null,
    group2_top5_pct: m.group2_top5_pct ?? null,
    group2_top10_pct: m.group2_top10_pct ?? null,
    group2_top20_pct: m.group2_top20_pct ?? null,
    group2_holder_gini: m.group2_holder_gini ?? null,
    group2_dev_hold_pct: m.group2_dev_hold_pct ?? null,
    group2_dev_initial_hold_pct: m.group2_dev_initial_hold_pct ?? null,
    group2_sniper_0s_hold_pct: m.group2_sniper_0s_hold_pct ?? null,
    group2_sniper_1s_hold_pct: m.group2_sniper_1s_hold_pct ?? null,
    group2_sniper_5s_hold_pct: m.group2_sniper_5s_hold_pct ?? null,
    group2_sniper_10s_hold_pct: m.group2_sniper_10s_hold_pct ?? null,
    group2_sniper_0s_ratio: m.group2_sniper_0s_ratio ?? null,
    group2_sniper_1s_ratio: m.group2_sniper_1s_ratio ?? null,
    group2_sniper_5s_ratio: m.group2_sniper_5s_ratio ?? null,
    group2_sniper_10s_ratio: m.group2_sniper_10s_ratio ?? null,
    group2_sniper_0s_num: m.group2_sniper_0s_num ?? null,
    group2_sniper_5s_num: m.group2_sniper_5s_num ?? null,
    group2_sniper_10s_num: m.group2_sniper_10s_num ?? null,
    curveHoldPct: m.curveHoldPct ?? null,
    group3_holder_num: m.group3_holder_num ?? snap.holders ?? null,
    group3_trader_num: m.group3_trader_num ?? tape?.uniqueTraders ?? null,
    group3_buy_num: m.group3_buy_num ?? snap.buys5m ?? tape?.buyCount ?? null,
    group3_sell_num: m.group3_sell_num ?? snap.sells5m ?? tape?.sellCount ?? null,
    group3_buy_user_num: m.group3_buy_user_num ?? snap.buyers5m ?? null,
    group3_sell_user_num: m.group3_sell_user_num ?? snap.sellers5m ?? null,
    group3_sell_pressure:
      m.group3_sell_pressure ??
      (tape && (tape.buySol || 0) > 0 ? (tape.sellSol || 0) / (tape.buySol || 1) : null),
    group3_wash_ratio: m.group3_wash_ratio ?? tape?.washRatio ?? null,
    group3_tx_num: m.group3_tx_num ?? tape?.tradeCount ?? null,
    group3_time_span: m.group3_time_span ?? null,
    group3_tx_per_sec: m.group3_tx_per_sec ?? null,
    group4_cluster_num: m.group4_cluster_num ?? null,
    group4_cluster_total_pct: m.group4_cluster_total_pct ?? null,
    group4_cluster_max_pct: m.group4_cluster_max_pct ?? null,
  };
}

function hasSniperObservation(melt: Record<string, number | null | undefined>) {
  return Object.entries(melt).some(([k, v]) => k.includes("sniper") && typeof v === "number" && Number.isFinite(v));
}

/**
 * RugFilter = hard rules then P(insider dump).
 * EntryTimer = graduation hazard / bid forming — not trained on MELT.
 * ExitTimer = 5m tape + mechanical stop. A 5m dump raises exit, not rug.
 */
export function scoreLaunch(snap: LaunchSnapshot): Omit<CoinDoc, "createdAt" | "updatedAt"> {
  const reasons: string[] = [];
  const watch: string[] = [];
  const features: Record<string, number | string | boolean> = {};
  const melt = meltVector(snap);

  const mc = snap.usdMarketCap ?? 0;
  const ath = snap.athMarketCap || mc;
  const minRatio = ath > 0 ? clamp(mc / ath, 0, 1) : 1;
  const returnRatio =
    typeof snap.change5m === "number" ? snap.change5m / 100 : ath > 0 ? (mc - ath) / ath : 0;
  const bonding =
    typeof snap.realSolReserves === "number"
      ? clamp(snap.realSolReserves / GRADUATE_SOL_LAMPORTS, 0, 1)
      : undefined;
  const ageMin = snap.launchedAt
    ? Math.max(0, (Date.now() - new Date(snap.launchedAt).getTime()) / 60_000)
    : undefined;
  const tape = snap.tape;
  const top10Raw = snap.top10HoldPct ?? melt.group2_top10_pct ?? melt.top10HoldPct;
  let top10 = typeof top10Raw === "number" ? Math.min(1, top10Raw) : undefined;
  if (typeof top10 === "number" && top10 >= 0.98 && (snap.holders ?? 0) >= 80) {
    watch.push("ignore top-10 100% — impossible vs holder count");
    top10 = undefined;
  }
  const devHold = snap.devHoldPct ?? melt.group2_dev_hold_pct ?? melt.devHoldPct;
  const insider =
    typeof snap.bundleHoldPct === "number" && snap.bundleHoldPct > 0
      ? Math.min(1, snap.bundleHoldPct)
      : typeof melt.bundleHoldPct === "number" && melt.bundleHoldPct > 0
        ? Math.min(1, melt.bundleHoldPct)
        : undefined;
  const tapeCluster =
    typeof melt.group4_cluster_total_pct === "number" ? Math.min(1, melt.group4_cluster_total_pct) : undefined;
  const bundle = insider;
  const curveHold = snap.curveHoldPct ?? (typeof melt.curveHoldPct === "number" ? melt.curveHoldPct : undefined);
  const replies = snap.replyCount ?? 0;
  const vol5 = snap.volume5m ?? 0;

  features.mc = Math.round(mc);
  if (bonding !== undefined) features.bonding = Number(bonding.toFixed(3));
  if (ageMin !== undefined) features.ageMin = Number(ageMin.toFixed(1));
  if (snap.creatorLaunches) features.creatorLaunches = snap.creatorLaunches;
  if (typeof snap.holders === "number") features.holders = snap.holders;
  if (typeof top10 === "number") features.top10 = Number(top10.toFixed(3));
  if (typeof devHold === "number") features.devHold = Number(devHold.toFixed(3));
  if (typeof insider === "number") features.bundle = Number(insider.toFixed(3));
  if (typeof tapeCluster === "number") features.tapeCluster = Number(tapeCluster.toFixed(3));
  if (typeof curveHold === "number") features.curveHold = Number(curveHold.toFixed(3));
  features.replies = replies;
  if (typeof snap.bondingVelocity === "number") {
    features.bondVel = Number(snap.bondingVelocity.toFixed(3));
  }
  if (typeof melt.group2_holder_gini === "number") {
    features.gini = Number(melt.group2_holder_gini.toFixed(3));
  }

  const maxDev = envNum("MAX_DEV_HOLD_PCT", 0.2);
  const maxTop10 = envNum("MAX_TOP10_HOLD_PCT", 0.45);
  const maxBundle = envNum("MAX_BUNDLE_HOLD_PCT", 0.35);
  const minHolders = envNum("MIN_UNIQUE_HOLDERS", 80);
  const minBondSec = envNum("MIN_BONDING_SECONDS", 60);
  const liq = snap.reserveUsd ?? 0;
  const curveSol = typeof snap.realSolReserves === "number" ? snap.realSolReserves / 1e9 : 0;
  // Fake Dex FDV is not a book. Live = real LP or real SOL still in the curve.
  const liveBook = liq >= 80 || (!snap.complete && curveSol >= 2);
  const scoreMc = liveBook ? mc : Math.min(mc, 8_000);
  const ghostHolders = typeof snap.holders === "number" && snap.holders <= 2 && liveBook;

  let hardReject = false;
  if (snap.banned) {
    hardReject = true;
    reasons.push("banned on Pump.fun");
  }
  if (snap.mintAuthority) {
    hardReject = true;
    reasons.push("mint authority still live");
  }
  if (snap.freezeAuthority) {
    hardReject = true;
    reasons.push("freeze authority still live");
  }
  if (typeof devHold === "number" && devHold >= maxDev) {
    hardReject = true;
    reasons.push(`creator still holds ${(devHold * 100).toFixed(0)}%`);
  }
  if (!ghostHolders && typeof top10 === "number" && top10 >= maxTop10) {
    hardReject = true;
    reasons.push(`top-10 wallets hold ${(top10 * 100).toFixed(0)}%`);
  }
  if (typeof insider === "number" && insider >= maxBundle) {
    hardReject = true;
    reasons.push(`RugCheck insiders hold ${(insider * 100).toFixed(0)}%`);
  }
  if (typeof tapeCluster === "number" && tapeCluster >= maxBundle) {
    watch.push(`tape cluster ${(tapeCluster * 100).toFixed(0)}% of buy SOL (not supply)`);
  } else if (typeof top10 === "number" && top10 >= maxBundle && top10 < maxTop10) {
    reasons.push(`clustered top-10 ${(top10 * 100).toFixed(0)}%`);
  }
  if (
    !ghostHolders &&
    typeof snap.holders === "number" &&
    snap.holders < minHolders &&
    ((ageMin !== undefined && ageMin > 30) || snap.complete)
  ) {
    hardReject = true;
    reasons.push(`only ${snap.holders} holders after ${ageMin !== undefined ? `${Math.round(ageMin)}m` : "migrate"}`);
  }
  if (!ghostHolders && typeof snap.holders === "number" && snap.holders < 12 && ageMin !== undefined && ageMin >= 8) {
    hardReject = true;
    reasons.push(`thin book — ${snap.holders} holders after ${Math.round(ageMin)}m`);
  }
  if (typeof curveHold === "number" && curveHold >= 0.85 && (top10 ?? 0) < 0.05 && (ageMin ?? 0) >= 6) {
    hardReject = true;
    reasons.push(`curve/LP holds ${(curveHold * 100).toFixed(0)}% — no free float`);
  }
  if (typeof snap.reserveUsd === "number" && snap.reserveUsd < 80 && (mc >= 10_000 || snap.complete)) {
    hardReject = true;
    reasons.push(
      `dust LP $${snap.reserveUsd.toFixed(0)} vs $${Math.round(mc).toLocaleString()} MC — drained or fake book`,
    );
  }
  if (snap.complete && liq < 80 && curveSol < 1) {
    hardReject = true;
    reasons.push("migrated book with no tradeable LP");
  }
  if (
    liq < 80 &&
    ((snap.volume1h ?? 0) >= 1_000 ||
      ((tape?.washRatio ?? 0) >= 0.7 && (tape?.tradeCount ?? 0) >= 15))
  ) {
    hardReject = true;
    reasons.push("wash / phantom volume on dust LP");
  }
  const solInCurve = typeof snap.realSolReserves === "number" ? curveSol : undefined;
  // Missing/zero bonding after PumpSwap is a drained curve, not a dead launch.
  if (
    !liveBook &&
    ((typeof solInCurve === "number" && solInCurve < 0.4 && (ageMin ?? 0) >= 6) ||
      (typeof bonding === "number" && bonding < 0.03 && (ageMin ?? 0) >= 8))
  ) {
    hardReject = true;
    reasons.push("empty curve — no SOL in after several minutes");
  }
  if ((ageMin ?? 0) >= 8 && replies === 0 && mc < 8000 && vol5 < 200) {
    hardReject = true;
    reasons.push("dead launch — no replies, no 5m volume, small MC");
  }
  if ((ageMin ?? 0) >= 12 && vol5 < 50 && !ghostHolders && (snap.holders ?? 0) < 25) {
    hardReject = true;
    reasons.push("idle tape — 5m volume dead");
  }
  if (snap.melt?.creatorSold || tape?.creatorSold) {
    if (liveBook && (snap.holders ?? 0) >= 200 && (snap.reserveUsd ?? 0) >= 80) {
      watch.push("creator sold earlier — book still live");
    } else {
      hardReject = true;
      reasons.push("creator already sold into the tape");
    }
  }
  const insiderGraph = snap.melt?.insiderGraph;
  if (typeof insiderGraph === "number" && insiderGraph >= 80) {
    hardReject = true;
    reasons.push(`RugCheck insider graph ${insiderGraph} wallets`);
  }
  const brandHit = [snap.website, snap.twitter, snap.description].filter(Boolean).join(" ");
  if (brandHit && BRAND_IMPERSONATION.test(brandHit)) {
    hardReject = true;
    reasons.push("impersonates an official brand");
  }
  if (snap.complete && (ageMin ?? 99) < 4 && replies === 0) {
    hardReject = true;
    reasons.push(`instant migrate in ${ageMin !== undefined ? `${ageMin.toFixed(1)}m` : "<4m"} with no replies`);
  }

  const model = hardReject ? null : scoreRugModel(melt);
  let rug = hardReject ? 0.97 : 0.5;
  if (model) {
    features.modelUsed = model.used;
    features.modelMissing = model.missing;
    // XGB was fit on migrated books. Imputing sniper/time medians pins almost every live print ~97%.
    if (model.used < 12 || !hasSniperObservation(melt)) {
      features.model = "xgb-sparse";
      const active = vol5 >= 800 && (snap.buyers5m ?? 0) >= 12 && (bonding ?? 0) > 0.1;
      rug = 0.58;
      if (typeof top10 === "number") rug = clamp(0.52 + top10 * 0.4);
      if (typeof devHold === "number") rug = clamp(rug + Math.max(0, devHold) * 0.25);
      const corpus = scoreCorpusRug({
        bonding: 0,
        ageMin: 0,
        logMc: Math.log1p(scoreMc),
        buyers5m: snap.buyers5m ?? null,
        devPct: typeof devHold === "number" ? devHold : null,
        minRatio,
        tx10m: tape?.tradeCount ?? (snap.buys5m ?? 0) + (snap.sells5m ?? 0),
        sigFill: 0,
      });
      if (corpus && corpus.used >= 2 && !snap.complete) {
        features.corpusRug = Number(corpus.p.toFixed(3));
        rug = clamp(0.35 * rug + 0.65 * corpus.p);
        reasons.push(`corpus dump P(dead)=${(corpus.p * 100).toFixed(0)}%`);
      } else if (snap.complete && liveBook && ((snap.holders ?? 0) >= 200 || vol5 >= 400)) {
        rug = clamp(0.38 + (top10 ?? 0.12) * 0.35);
        if (typeof devHold === "number") rug = clamp(rug + Math.max(0, devHold) * 0.2);
        reasons.push("migrated live book — concentration only, not curve-death corpus");
      } else if (snap.complete) {
        rug = Math.max(rug, 0.62);
        reasons.push("sparse migrated book — curve-death corpus does not apply");
      } else if (!active) {
        rug = Math.max(rug, 0.64);
        reasons.push(`sparse live book (${model.used} feats) — no tape, treat as dump-prior`);
      } else {
        reasons.push(`sparse live book (${model.used} feats) — concentration + 5m tape`);
      }
    } else {
      features.model = "xgb-live";
      rug = model.rugProb;
      reasons.push(
        `MELT live XGB P(dump)=${(model.rugProb * 100).toFixed(0)}% (${model.used} feats)`,
      );
    }
  } else if (!hardReject) {
    features.model = "untrained";
    reasons.push("no rug model on disk — hard rules only");
    if (typeof top10 === "number") rug = clamp(0.42 + top10 * 0.4);
    if (typeof devHold === "number") rug = clamp(rug + devHold * 0.25);
  } else {
    features.model = "hard";
  }

  // Watch flags only — do not move rug.
  if (snap.livestream) watch.push("livestream");
  if (snap.boostMode && snap.boostMode !== "NONE") watch.push(`boost ${snap.boostMode}`);
  if (snap.nsfw) watch.push("NSFW");
  if (snap.tokenProgram?.includes("Tokenz")) watch.push("Token-2022");
  if (snap.description && DEPLOY_KIT.test(snap.description)) watch.push("deploy-kit metadata");
  if ((snap.creatorLaunches ?? 0) >= 5) {
    watch.push(`serial creator ×${snap.creatorLaunches}`);
    rug = clamp(rug + 0.04);
  }
  if (ageMin !== undefined && ageMin * 60 < minBondSec) watch.push("younger than min bonding window");
  for (const w of watch) reasons.push(`watch: ${w}`);

  // Entry = graduation hazard. Trained on failed-curve + graduate labels, never MELT.
  const entryModel = scoreEntryModel({
    bonding: bonding ?? null,
    ageMin: ageMin ?? null,
    logMc: Math.log1p(scoreMc),
    holders: snap.holders ?? null,
    buyers5m: snap.buyers5m ?? null,
    wash: melt.group3_wash_ratio ?? tape?.washRatio ?? null,
    top10: typeof top10 === "number" ? top10 : null,
    sellPressure: melt.group3_sell_pressure ?? null,
  });
  let entry = 0.12;
  if (entryModel && entryModel.used >= 3) {
    entry = entryModel.p;
    features.entryModel = "lr-curve";
    reasons.push(`EntryTimer P(graduate)=${(entry * 100).toFixed(0)}%`);
  } else {
    features.entryModel = "rules";
    if (bonding !== undefined && bonding > 0.08 && bonding < 0.72 && !snap.complete) {
      entry += 0.18 + bonding * 0.2;
      reasons.push(`curve ${(bonding * 100).toFixed(0)}% — graduation hazard`);
    }
    if ((snap.bondingVelocity ?? 0) > 0.05 && !snap.complete) {
      entry += 0.12;
      reasons.push("curve filling (SOL-in velocity)");
    }
  }
  if ((snap.change5m ?? 0) >= 25 && (snap.buyers5m ?? 0) >= 20 && (snap.sellers5m ?? 0) < (snap.buyers5m ?? 0)) {
    entry += 0.08;
    reasons.push("hot 5m bid, buyers > sellers");
  }
  if (bonding !== undefined && bonding < 0.02 && mc < 4000) {
    entry = Math.min(entry, 0.08);
    reasons.push("empty curve — almost no SOL in");
  }
  // Exit = dump / migrate / mechanical. 5m −40% is exit, not rug.
  let exit = 0.2;
  if (snap.complete) {
    exit += 0.42;
    reasons.push("already graduated — 73% of MELT migrants dump >60% in 20m");
  }
  if (minRatio < 0.45 && ath > mc) {
    exit += 0.22;
    reasons.push(`off ATH — ${(minRatio * 100).toFixed(0)}% of peak`);
  }
  if ((snap.change5m ?? 0) <= -35) {
    exit += 0.2;
    reasons.push(`5m dump ${snap.change5m!.toFixed(0)}%`);
  }
  if ((snap.change1h ?? 0) <= -50) {
    exit += 0.14;
    reasons.push(`1h dump ${snap.change1h!.toFixed(0)}%`);
  }
  const buyers = snap.buyers5m ?? 0;
  const sellers = snap.sellers5m ?? 0;
  if (buyers + sellers > 0) {
    features.buyers5m = buyers;
    features.sellers5m = sellers;
  }
  if (sellers > buyers * 1.3 && (snap.sells5m ?? 0) >= 5) {
    exit += 0.12;
    reasons.push("5m sellers dominate unique buyers");
  }
  if ((tape?.dumpRatio ?? 0) >= 0.45) {
    exit += 0.14;
    reasons.push(`chart dump ${(tape!.dumpRatio! * 100).toFixed(0)}% off local high`);
  }
  if ((tape?.sellSol ?? 0) > (tape?.buySol ?? 0) * 1.25 && (tape?.sellCount ?? 0) >= 4) {
    exit += 0.1;
    reasons.push("tape SOL out > SOL in");
  }
  if (tape) {
    features.trades = tape.tradeCount ?? 0;
    features.unique = tape.uniqueTraders ?? 0;
  }

  const rugCut = model?.threshold ?? envNum("RUG_THRESHOLD", 0.55);
  rug = clamp(rug);
  entry = clamp(entry, 0.04, 0.88);
  exit = clamp(exit, 0.06, 0.94);
  if (rug >= rugCut) entry = Math.min(entry, 0.08);
  const dumped = (minRatio < 0.45 && ath > mc) || (snap.change5m ?? 0) <= -35 || (snap.change1h ?? 0) <= -50;
  if (dumped || exit >= 0.75) entry = Math.min(entry, 0.12);

  let riskLabel: RiskLabel = "medium";
  if (rug >= 0.6) riskLabel = "high";
  else if (rug < 0.4) riskLabel = "low";

  let status: CoinDoc["status"] = "watching";
  if (hardReject || rug >= rugCut) status = "rejected";
  else if (exit >= 0.75 || dumped) status = "exit";
  else if (entry >= 0.35 && rug < rugCut - 0.08) status = "enter";
  const flags = flagsFor(status, snap.complete);

  return {
    mint: snap.mint,
    venue: snap.venue,
    dex: snap.dex,
    name: snap.name,
    symbol: snap.symbol,
    creator: snap.creator,
    status,
    flags,
    riskLabel,
    rugProb: rug,
    entryProb: entry,
    exitProb: exit,
    minRatio,
    returnRatio,
    manipulated: (melt.group3_wash_ratio ?? tape?.washRatio ?? 0) >= 0.65 ? "yes" : "unknown",
    reasons,
    source: "live",
    complete: snap.complete,
    marketCapUsd: mc || undefined,
    athMarketCap: Math.max(snap.athMarketCap || 0, mc) || undefined,
    priceUsd: snap.priceUsd || (mc > 0 ? mc / 1_000_000_000 : undefined),
    liquidityUsd: snap.reserveUsd,
    volume5m: snap.volume5m,
    volume1h: snap.volume1h,
    change5m: snap.change5m,
    holders: snap.holders,
    bondingProgress: bonding,
    launchedAt: snap.launchedAt,
    twitter: snap.twitter,
    website: snap.website,
    poolAddress: snap.poolAddress,
    features,
  };
}
