"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { EntryBell } from "@/components/EntryBell";
import { BanButton } from "@/components/BanButton";
import { PinButton } from "@/components/PinButton";
import { VenueLinks } from "@/components/VenueLinks";
import { loadWatchlist, syncWatchPins, type WatchItem } from "@/lib/watchlist";
import { isDumpedCoin } from "@/lib/dumpCheck";
import {
  dumpLine,
  emptyNotices,
  loadNotices,
  pushDumps,
  isLiveEnter,
  pushEntries,
  saveNotices,
  scorePct,
  type EntryNotice,
  type NoticeKind,
  type NoticeStore,
} from "@/lib/entryNotices";
import { changeTone, holders, launchedAgo, money, price, signedPct } from "@/lib/format";
import { flagsOf, hasFlag as coinHasFlag, isDir5mFlag, isDumpFirstFlag, isHit15xFlag, isHit2xFlag, isManipFlag, isSurvive70Flag } from "@/lib/flags";
import { defaultDirFor, type CoinSortField, type SortDir } from "@/lib/sort";
import type { CoinDoc, CoinStatus, IngestJobDoc, TapeCandle, TapeTrade, TraderSettings } from "@/lib/types";
import { venueLinks } from "@/lib/venues";

type Stats = {
  total: number;
  rejected: number;
  watching: number;
  enter: number;
  exit: number;
  migrated: number;
  live: number;
  paper: number;
  asOf: string;
};

type TapePayload = {
  coin?: CoinDoc | null;
  candles: TapeCandle[];
  trades: TapeTrade[];
  quote?: {
    priceUsd?: number;
    liquidityUsd?: number;
    change5m?: number;
  };
};

const PAGE_SIZE = 25;
const POLL_MS = 1_000;
const GRID =
  "110px 100px 78px 88px 68px 64px 56px 64px 58px 52px 52px 52px 292px";

type DeskTab = "all" | "watchlist" | CoinStatus;

const FILTERS: { id: DeskTab; label: string }[] = [
  { id: "all", label: "ALL PRINTS" },
  { id: "watchlist", label: "WATCH LIST" },
  { id: "rejected", label: "RUG / SKIP" },
  { id: "watching", label: "WATCH" },
  { id: "enter", label: "ENTRY" },
  { id: "exit", label: "EXIT" },
  { id: "migrated", label: "MIGRATED" },
];

const COLS: { id: CoinSortField; label: string }[] = [
  { id: "status", label: "STATUS" },
  { id: "symbol", label: "TICKER" },
  { id: "launchedAt", label: "AGE" },
  { id: "priceUsd", label: "PRICE" },
  { id: "marketCapUsd", label: "MCAP" },
  { id: "liquidityUsd", label: "LIQ" },
  { id: "holders", label: "HOLD" },
  { id: "volume5m", label: "VOL 5M" },
  { id: "change5m", label: "5M" },
  { id: "rugProb", label: "RUG" },
  { id: "entryProb", label: "ENTRY" },
  { id: "exitProb", label: "EXIT" },
];

function pct(n: number) {
  return `${Math.round(100 * n)}%`;
}

function keepOpenRow(incoming: CoinDoc[], prev: CoinDoc[], open: string | null): CoinDoc[] {
  if (!open) return incoming;
  if (incoming.some((r) => r.mint === open)) return incoming;
  const held = prev.find((r) => r.mint === open);
  return held ? [held, ...incoming] : incoming;
}

function tone(flag: string) {
  if (flag === "rejected") return "var(--rust)";
  if (flag === "enter") return "var(--acid)";
  if (flag === "exit") return "var(--amber)";
  if (flag === "migrated") return "var(--mint)";
  if (flag === "manip") return "var(--amber)";
  if (flag === "up5m") return "var(--acid)";
  if (flag === "x2") return "var(--mint)";
  if (flag === "dump1st") return "var(--rust)";
  if (flag === "hold70") return "var(--mint)";
  if (flag === "hit15x") return "var(--acid)";
  return "var(--paper)";
}

function rowFlags(row: CoinDoc): string[] {
  const flags: string[] = [...flagsOf(row)];
  if (isManipFlag(row)) flags.push("manip");
  if (isDir5mFlag(row)) flags.push("up5m");
  if (isHit2xFlag(row)) flags.push("x2");
  if (isDumpFirstFlag(row)) flags.push("dump1st");
  if (isSurvive70Flag(row)) flags.push("hold70");
  if (isHit15xFlag(row)) flags.push("hit15x");
  return flags;
}

function hasFlag(row: CoinDoc, flag: string) {
  return coinHasFlag(row, flag as CoinStatus);
}

function bumpDeskStats(cur: Stats | null, from: CoinStatus | undefined, to: CoinStatus, inserted = false) {
  if (!cur) return cur;
  const next = { ...cur, asOf: new Date().toISOString() };
  if (inserted) {
    next.total += 1;
    next.live += 1;
    next[to] += 1;
  } else if (from && from !== to) {
    next[from] = Math.max(0, next[from] - 1);
    next[to] += 1;
  }
  return next;
}

function agoTape(t: number) {
  const s = Math.max(0, Math.round((Date.now() - t) / 1e3));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

function shortWallet(w: string) {
  return w.length > 10 ? `${w.slice(0, 4)}…${w.slice(-4)}` : w;
}

function fmtPx(n: number) {
  if (n >= 1) return n.toFixed(4);
  if (n >= 0.001) return n.toFixed(6);
  return n.toExponential(2);
}

function TapeSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          style={{
            display: "grid",
            gridTemplateColumns: GRID,
            gap: 12,
            padding: "13px 8px",
            borderTop: "1px solid var(--line)",
            alignItems: "center",
          }}
        >
          <div className="skel" style={{ width: 64 }} />
          <div className="skel" style={{ width: 72 }} />
          <div className="skel" style={{ width: 56 }} />
          <div className="skel" style={{ width: 70 }} />
          <div className="skel" style={{ width: 48 }} />
          <div className="skel" style={{ width: 48 }} />
          <div className="skel" style={{ width: 36 }} />
          <div className="skel" style={{ width: 44 }} />
          <div className="skel" style={{ width: 40 }} />
          <div className="skel" style={{ width: 32 }} />
          <div className="skel" style={{ width: 32 }} />
          <div className="skel" style={{ width: 32 }} />
          <div style={{ display: "flex", gap: 6 }}>
            <div className="skel" style={{ width: 64, height: 22 }} />
            <div className="skel" style={{ width: 44, height: 22 }} />
            <div className="skel" style={{ width: 44, height: 22 }} />
            <div className="skel" style={{ width: 44, height: 22 }} />
          </div>
        </div>
      ))}
    </>
  );
}

function StatSkeleton() {
  return (
    <section
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(6, minmax(0, 1fr))",
        gap: 10,
        marginTop: 22,
      }}
    >
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} style={{ border: "1px solid var(--line)", padding: "12px 14px", background: "var(--panel)" }}>
          <div className="skel" style={{ width: 54, height: 8 }} />
          <div className="skel" style={{ width: 40, height: 28, marginTop: 10 }} />
        </div>
      ))}
    </section>
  );
}

function TokenChart({ candles, trades }: { candles: TapeCandle[]; trades: TapeTrade[] }) {
  if (candles.length === 0) {
    return (
      <div
        style={{
          height: 220,
          border: "1px solid var(--line)",
          display: "grid",
          placeItems: "center",
          color: "var(--mute)",
        }}
      >
        no candle tape yet
      </div>
    );
  }
  const w = 624;
  const h = 174;
  const lo = Math.min(...candles.map((c) => c.l));
  const hi = Math.max(...candles.map((c) => c.h));
  const maxV = Math.max(...candles.map((c) => c.v), 1e-12);
  const span = hi - lo || 0.01 * hi || 1;
  const xAt = (i: number) => 8 + (i / Math.max(candles.length - 1, 1)) * w;
  const yAt = (v: number) => 10 + (1 - (v - lo) / span) * h;
  const bw = Math.max(2, w / candles.length - 1.5);
  const last = candles[candles.length - 1];
  const first = candles[0];
  const up = last.c >= first.o;
  const line = candles.map((c, i) => `${i === 0 ? "M" : "L"} ${xAt(i)} ${yAt(c.c)}`).join(" ");

  function nearest(t: number) {
    let idx = 0;
    let best = Math.abs(candles[0].t - t);
    for (let i = 1; i < candles.length; i++) {
      const d = Math.abs(candles[i].t - t);
      if (d < best) {
        best = d;
        idx = i;
      }
    }
    return idx;
  }

  return (
    <svg
      viewBox="0 0 640 220"
      style={{
        width: "100%",
        height: 220,
        display: "block",
        background: "var(--panel)",
        border: "1px solid var(--line)",
      }}
    >
      <path d={line} fill="none" stroke={up ? "var(--mint)" : "var(--rust)"} strokeWidth="1.6" />
      {candles.map((c, i) => {
        const color = c.c >= c.o ? "#7dffa3" : "#ff4d2e";
        const vol = (c.v / maxV) * 24;
        return (
          <g key={`${c.t}-${i}`}>
            <line x1={xAt(i)} x2={xAt(i)} y1={yAt(c.h)} y2={yAt(c.l)} stroke={color} strokeWidth="1" />
            <rect
              x={xAt(i) - bw / 2}
              y={Math.min(yAt(c.o), yAt(c.c))}
              width={bw}
              height={Math.max(1, Math.abs(yAt(c.c) - yAt(c.o)))}
              fill={color}
            />
            <rect x={xAt(i) - bw / 2} y={220 - vol - 4} width={bw} height={vol} fill={color} opacity={0.28} />
          </g>
        );
      })}
      {trades.slice(0, 24).map((tr, i) => {
        const idx = nearest(tr.t);
        if (idx < 0) return null;
        return (
          <circle
            key={`${tr.sig || tr.t}-${tr.side}-${i}`}
            cx={xAt(idx)}
            cy={yAt(candles[idx].c)}
            r={tr.creator ? 4 : 2.4}
            fill={tr.side === "buy" ? "#d6ff3f" : "#ff4d2e"}
            stroke={tr.creator ? "#efe6d2" : "none"}
          />
        );
      })}
      <text x={8} y={14} fill="#9a8f78" fontSize="10">
        {fmtPx(last.c)} · {(((last.c - first.o) / first.o) * 100).toFixed(1)}%
      </text>
    </svg>
  );
}

function TokenAccordion({
  mint,
  onScored,
  onWatchChange,
}: {
  mint: string;
  onScored: (coin: CoinDoc) => void;
  onWatchChange?: (items: WatchItem[]) => void;
}) {
  const [tape, setTape] = useState<TapePayload | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let dead = false;
    setLoading(true);
    setError("");
    (async () => {
      try {
        const r = await fetch(`/api/coins/${mint}/tape?view=1`, { cache: "no-store" });
        const body = await r.json();
        if (dead) return;
        if (!r.ok) throw new Error(body.error || "tape failed");
        setTape(body);
        if (body.coin) onScored(body.coin);
      } catch (e) {
        if (!dead) setError(e instanceof Error ? e.message : "tape failed");
      } finally {
        if (!dead) setLoading(false);
      }
    })();
    return () => {
      dead = true;
    };
  }, [mint]);

  if (loading) {
    return (
      <div style={{ padding: "16px 8px 20px", borderTop: "1px dashed var(--line)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--acid)", fontSize: 11, letterSpacing: "0.12em" }}>
          <span className="tape-spin" />
          LOADING CHART + TAPE
        </div>
        <div className="skel" style={{ height: 220, marginTop: 12 }} />
      </div>
    );
  }
  if (error) {
    return (
      <div style={{ padding: 16, color: "var(--rust)", fontSize: 12 }}>
        tape failed: {error}
      </div>
    );
  }
  if (!tape) return null;
  const coin = tape.coin;
  return (
    <div style={{ padding: "14px 8px 18px", borderTop: "1px dashed var(--line)", background: "#14120d" }}>
      <div style={{ display: "grid", gridTemplateColumns: "1.4fr 0.8fr", gap: 14 }}>
        <div>
          <TokenChart candles={tape.candles || []} trades={tape.trades || []} />
          <div style={{ display: "flex", gap: 14, marginTop: 10, color: "var(--mute)", fontSize: 11, flexWrap: "wrap" }}>
            {tape.quote?.priceUsd ? <span>px {tape.quote.priceUsd.toExponential(2)}</span> : null}
            {tape.quote?.liquidityUsd ? <span>liq ${Math.round(tape.quote.liquidityUsd)}</span> : null}
            {typeof tape.quote?.change5m === "number" ? <span>5m {tape.quote.change5m.toFixed(1)}%</span> : null}
            {typeof coin?.holders === "number" ? <span>{coin.holders} holders</span> : null}
            {typeof coin?.features?.top10 === "number" ? (
              <span>top10 {(100 * Number(coin.features.top10)).toFixed(0)}%</span>
            ) : null}
            {typeof coin?.features?.devHold === "number" ? (
              <span>dev {(100 * Number(coin.features.devHold)).toFixed(0)}%</span>
            ) : null}
            {typeof coin?.features?.bundle === "number" ? (
              <span>cluster {(100 * Number(coin.features.bundle)).toFixed(0)}%</span>
            ) : null}
            {coin?.features?.model ? <span>{String(coin.features.model)}</span> : null}
            {coin?.features?.creatorLaunches ? <span>creator x{String(coin.features.creatorLaunches)}</span> : null}
          </div>
        </div>
        <div style={{ border: "1px solid var(--line)", maxHeight: 268, overflow: "auto" }}>
          <div
            style={{
              padding: "8px 10px",
              color: "var(--mute)",
              fontSize: 11,
              letterSpacing: "0.1em",
              borderBottom: "1px solid var(--line)",
            }}
          >
            BUYS / SELLS
          </div>
          {(tape.trades || []).length === 0 && (
            <p style={{ padding: 12, color: "var(--mute)", fontSize: 12 }}>no parsed fills yet</p>
          )}
          {(tape.trades || []).map((tr, i) => (
            <div
              key={`${tr.sig || tr.t}-${tr.side}-${tr.wallet}-${i}`}
              style={{
                display: "grid",
                gridTemplateColumns: "44px 1fr 64px 40px",
                gap: 8,
                padding: "7px 10px",
                borderTop: "1px solid var(--line)",
                fontSize: 11,
                color: tr.side === "buy" ? "var(--mint)" : "var(--rust)",
              }}
            >
              <span>{tr.side.toUpperCase()}</span>
              <span style={{ color: tr.creator ? "var(--amber)" : "var(--paper)" }}>
                {shortWallet(tr.wallet)}
                {tr.creator ? " · DEV" : ""}
              </span>
              <span>{tr.sol.toFixed(3)} SOL</span>
              <span style={{ color: "var(--mute)" }}>{agoTape(tr.t)}</span>
            </div>
          ))}
        </div>
      </div>
      {coin && (
        <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          {coin.reasons.slice(0, 8).map((r) => (
            <span key={r} style={{ border: "1px solid var(--line)", padding: "4px 8px", fontSize: 11, color: "var(--mute)" }}>
              {r}
            </span>
          ))}
          <PinButton mint={mint} symbol={coin.symbol} onChange={onWatchChange} />
          <VenueLinks mint={mint} compact />
          <Link href={`/coins/${mint}`} style={{ color: "var(--acid)", fontSize: 11, letterSpacing: "0.1em" }}>
            FULL DESK →
          </Link>
        </div>
      )}
    </div>
  );
}

function SortHead({
  id,
  label,
  active,
  dir,
  onSort,
}: {
  id: CoinSortField;
  label: string;
  active: boolean;
  dir: SortDir;
  onSort: (id: CoinSortField) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSort(id)}
      style={{
        all: "unset",
        cursor: "pointer",
        color: active ? "var(--acid)" : "var(--mute)",
        letterSpacing: "0.1em",
        fontSize: 11,
      }}
    >
      {label}
      <span style={{ marginLeft: 4, opacity: active ? 1 : 0.35 }}>{active ? (dir === "asc" ? "▲" : "▼") : "↕"}</span>
    </button>
  );
}

export function Desk() {
  const [status, setStatus] = useState<DeskTab>("all");
  const [watch, setWatch] = useState<WatchItem[]>([]);
  const [query, setQuery] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<CoinSortField>("updatedAt");
  const [dir, setDir] = useState<SortDir>("desc");
  const [pages, setPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [rows, setRows] = useState<CoinDoc[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [job, setJob] = useState<IngestJobDoc | null>(null);
  const [error, setError] = useState("");
  const [pulling, setPulling] = useState(false);
  const [loading, setLoading] = useState(true);
  const [openMint, setOpenMint] = useState<string | null>(null);
  const [scoringMint, setScoringMint] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [notices, setNotices] = useState<NoticeStore>(emptyNotices);
  const [bellOpen, setBellOpen] = useState(false);
  const [toasts, setToasts] = useState<EntryNotice[]>([]);
  const [trader, setTrader] = useState<TraderSettings | null>(null);
  const [traderBusy, setTraderBusy] = useState(false);

  const uiGen = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const silentInFlight = useRef(false);
  const noticesRef = useRef(notices);
  noticesRef.current = notices;
  const noticesReadyRef = useRef(false);
  const watchMints = watch.map((w) => w.mint);
  const filtersRef = useRef({ status, q, page, sort, dir, hasStats: false, watchMints });
  filtersRef.current = { status, q, page, sort, dir, hasStats: Boolean(stats), watchMints };
  const openMintRef = useRef(openMint);
  openMintRef.current = openMint;
  const bookRef = useRef(new Map<string, CoinStatus>());
  const loadRef = useRef<(opts?: { silent?: boolean }) => Promise<void>>(async () => undefined);

  function bookStats(incoming: CoinDoc[]) {
    setStats((cur) => {
      if (!cur) return cur;
      let next = cur;
      let dirty = false;
      for (const row of incoming) {
        const prev = bookRef.current.get(row.mint);
        if (prev === undefined) {
          bookRef.current.set(row.mint, row.status);
          continue;
        }
        if (prev !== row.status) {
          bookRef.current.set(row.mint, row.status);
          next = bumpDeskStats(next, prev, row.status) || next;
          dirty = true;
        }
      }
      return dirty ? { ...next } : cur;
    });
  }

  async function toggleTrader() {
    if (traderBusy) return;
    setTraderBusy(true);
    try {
      const r = await fetch("/api/trader", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: !trader?.enabled }),
      });
      const body = await r.json();
      if (!r.ok || !body.settings) throw new Error(body.error || "trader toggle failed");
      setTrader(body.settings);
    } catch (e) {
      setError(e instanceof Error ? e.message : "trader toggle failed");
    } finally {
      setTraderBusy(false);
    }
  }

  function flashNotices(fresh: EntryNotice[]) {
    if (!fresh.length) return;
    setToasts((cur) => [...fresh, ...cur].slice(0, 8));
    window.setTimeout(() => {
      setToasts((cur) => cur.filter((t) => !fresh.some((f) => f.mint === t.mint && f.at === t.at)));
    }, 8000);
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    for (const note of fresh) {
      try {
        const hrefs = venueLinks(note.mint);
        const dump = note.kind === "dump";
        const n = new Notification(`${dump ? "DUMP" : "ENTRY"} ${note.symbol}`, {
          body: dump
            ? `${dumpLine(note)}\nRUG ${scorePct(note.rugProb)} · ENTRY ${scorePct(note.entryProb)}\n${note.mint.slice(0, 4)}…${note.mint.slice(-4)}`
            : `RUG ${scorePct(note.rugProb)} · ENTRY ${scorePct(note.entryProb)} · EXIT ${scorePct(note.exitProb)}\nPUMP · GMGN · AXIOM\n${note.mint.slice(0, 4)}…${note.mint.slice(-4)}`,
          tag: dump ? `dump-${note.mint}` : note.mint,
        });
        n.onclick = () => {
          window.focus();
          window.open(hrefs.pumpfun, "_blank", "noopener,noreferrer");
          window.open(hrefs.gmgn, "_blank", "noopener,noreferrer");
          window.open(hrefs.axiom, "_blank", "noopener,noreferrer");
          selectMint(note.mint, note.kind);
        };
      } catch {
        /* ignore */
      }
    }
  }

  function announce(rowsIn: CoinDoc[]) {
    if (!noticesReadyRef.current) return;
    const { next, fresh } = pushEntries(
      noticesRef.current,
      rowsIn.map((r) => ({ ...r, status: r.status || "enter" })),
    );
    noticesRef.current = next;
    setNotices(next);
    flashNotices(fresh);
  }

  function announceDump(rowsIn: CoinDoc[]) {
    if (!noticesReadyRef.current) return;
    const { next, fresh } = pushDumps(noticesRef.current, rowsIn);
    noticesRef.current = next;
    setNotices(next);
    flashNotices(fresh);
  }

  function noteDumps(incoming: CoinDoc[]) {
    const fresh: CoinDoc[] = [];
    for (const row of incoming) {
      const prev = bookRef.current.get(row.mint);
      if ((prev === "enter" || prev === "watching") && isDumpedCoin(row)) fresh.push(row);
    }
    if (fresh.length) announceDump(fresh);
  }

  function selectMint(mint: string, kind?: NoticeKind) {
    markRead(mint);
    setBellOpen(false);
    setToasts((cur) => cur.filter((t) => t.mint !== mint));
    setStatus(kind === "dump" ? "exit" : "enter");
    setQuery(mint);
    setQ(mint);
    setPage(1);
    setOpenMint(mint);
  }

  function markRead(mint: string) {
    setNotices((prev) => {
      const next = { ...prev, items: prev.items.map((i) => (i.mint === mint ? { ...i, read: true } : i)) };
      noticesRef.current = next;
      return next;
    });
  }

  function markAllRead() {
    setNotices((prev) => {
      const next = { ...prev, items: prev.items.map((i) => ({ ...i, read: true })) };
      noticesRef.current = next;
      return next;
    });
  }

  function applyScored(next: CoinDoc) {
    const prev = rows.find((r) => r.mint === next.mint);
    if (prev && prev.status !== next.status) {
      setStats((cur) => bumpDeskStats(cur, prev.status, next.status) || cur);
      bookRef.current.set(next.mint, next.status);
    }
    const prevStatus = prev?.status || bookRef.current.get(next.mint);
    if (isLiveEnter(next)) announce([next]);
    if ((prevStatus === "enter" || prevStatus === "watching") && isDumpedCoin(next)) announceDump([next]);
    setRows((rs) => {
      const open = openMintRef.current === next.mint;
      const stays = status === "all" || status === "watchlist" || hasFlag(next, status) || open;
      if (!stays) return rs.filter((r) => r.mint !== next.mint);
      if (rs.some((r) => r.mint === next.mint)) {
        return rs.map((r) => (r.mint === next.mint ? { ...r, ...next } : r));
      }
      return open ? [next, ...rs] : rs;
    });
  }

  async function rescore(mint: string) {
    if (scoringMint) return;
    setScoringMint(mint);
    setError("");
    try {
      const r = await fetch(`/api/coins/${mint}/rescore`, { method: "POST", cache: "no-store" });
      const body = await r.json();
      if (!r.ok || !body.coin) throw new Error(body.error || "rescore failed");
      applyScored(body.coin);
    } catch (e) {
      setError(e instanceof Error ? e.message : "rescore failed");
    } finally {
      setScoringMint(null);
    }
  }

  async function load(opts?: { silent?: boolean }) {
    const silent = !!opts?.silent;
    if (silent && silentInFlight.current) return;
    silentInFlight.current = true;
    const gen = silent ? uiGen.current : ++uiGen.current;
    if (!silent) {
      abortRef.current?.abort();
      abortRef.current = new AbortController();
      setLoading(true);
    }
    const signal = silent ? undefined : abortRef.current?.signal;
    const f = filtersRef.current;
    try {
      const qs = new URLSearchParams({
        status: f.status === "watchlist" ? "all" : f.status,
        source: "live",
        q: f.q,
        page: String(f.page),
        limit: String(PAGE_SIZE),
        sort: f.sort,
        dir: f.dir,
        ...(silent ? { lite: "1" } : {}),
      });
      if (f.status === "watchlist") {
        if (!f.watchMints.length) {
          if (gen !== uiGen.current) return;
          setRows([]);
          setPages(1);
          setTotal(0);
          setError("");
          return;
        }
        qs.set("mints", f.watchMints.join(","));
      }
      const coinP = fetch(`/api/coins?${qs}`, { signal, cache: "no-store" }).then((r) => r.json());
      const enterP =
        silent || f.status === "enter"
          ? coinP
          : fetch("/api/coins?status=enter&source=live&sort=updatedAt&dir=desc&limit=20&page=1&lite=1", {
              signal,
              cache: "no-store",
            }).then((r) => r.json());
      const exitP =
        silent
          ? Promise.resolve({ coins: [] })
          : f.status === "exit"
            ? coinP
            : fetch("/api/coins?status=exit&source=live&sort=updatedAt&dir=desc&limit=20&page=1&lite=1", {
                signal,
                cache: "no-store",
              }).then((r) => r.json());
      const jobP = silent && f.hasStats
        ? Promise.resolve(null)
        : fetch("/api/ingest", { signal, cache: "no-store" }).then((r) => r.json());
      const [c, enters, exits, ingest] = await Promise.all([coinP, enterP, exitP, jobP]);
      if (gen !== uiGen.current) return;
      const nextRows: CoinDoc[] = c.coins || [];
      const enterRows: CoinDoc[] = enters.coins || [];
      const exitRows: CoinDoc[] = exits.coins || [];
      noteDumps(nextRows);
      noteDumps(enterRows);
      noteDumps(exitRows);
      bookStats(nextRows);
      bookStats(enterRows);
      bookStats(exitRows);
      const s = c.stats;
      if (s && typeof s.total === "number") {
        setStats({
          total: s.total,
          rejected: s.rejected ?? 0,
          watching: s.watching ?? 0,
          enter: s.enter ?? 0,
          exit: s.exit ?? 0,
          migrated: s.migrated ?? 0,
          live: s.live ?? s.total,
          paper: s.paper ?? 0,
          asOf: s.asOf || new Date().toISOString(),
        });
      }
      const nextPages = Math.max(1, Number(c.pages) || 1);
      const nextTotal = Math.max(0, Number(c.total) || 0);
      setRows((prev) => keepOpenRow(nextRows, prev, openMintRef.current));
      setPages(nextPages);
      setTotal(nextTotal);
      if (f.page > nextPages) setPage(nextPages);
      if (ingest) setJob(ingest.job || null);
      announce(enters.coins || nextRows.filter((r) => hasFlag(r, "enter")));
      setError("");
    } catch (e) {
      if ((e instanceof DOMException && e.name === "AbortError") || gen !== uiGen.current) return;
      setError(e instanceof Error ? e.message : "load failed");
    } finally {
      silentInFlight.current = false;
      if (!silent && gen === uiGen.current) setLoading(false);
    }
  }
  loadRef.current = load;

  function onSort(id: CoinSortField) {
    if (id === sort) setDir((d) => (d === "desc" ? "asc" : "desc"));
    else {
      setSort(id);
      setDir(defaultDirFor(id));
    }
    setPage(1);
  }

  async function pullNow() {
    setPulling(true);
    setLoading(true);
    try {
      await fetch("/api/ingest", { method: "POST" });
      filtersRef.current = { ...filtersRef.current, page: 1, sort: "updatedAt", dir: "desc" };
      setPage(1);
      setSort("updatedAt");
      setDir("desc");
      await load();
    } finally {
      setPulling(false);
    }
  }

  useEffect(() => {
    const store = loadNotices();
    noticesRef.current = store;
    setNotices(store);
    noticesReadyRef.current = true;
    const pins = loadWatchlist();
    setWatch(pins);
    syncWatchPins(pins);
  }, []);

  useEffect(() => {
    saveNotices(notices);
  }, [notices]);

  useEffect(() => {
    const t = window.setTimeout(() => setQ(query), 280);
    return () => window.clearTimeout(t);
  }, [query]);

  useEffect(() => {
    void load();
  }, [status, q, page, sort, dir]);

  useEffect(() => {
    const poll = window.setInterval(() => void loadRef.current({ silent: true }), POLL_MS);
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      window.clearInterval(poll);
      window.clearInterval(tick);
    };
  }, []);

  useEffect(() => {
    fetch("/api/trader", { cache: "no-store" })
      .then((r) => r.json())
      .then((b) => {
        if (b.settings) setTrader(b.settings);
      })
      .catch(() => null);
  }, []);

  const blurb = useMemo(
    () => (stats ? `${stats.total} live prints · ${stats.rejected} rugs · ${stats.enter} entries` : "warming the desk"),
    [stats],
  );
  const emptyLoading = loading && rows.length === 0;
  const dimRows = loading && rows.length > 0;

  return (
    <main style={{ minHeight: "100vh", padding: "28px 32px 48px" }}>
      <header
        style={{
          display: "grid",
          gridTemplateColumns: "1.2fr 1fr",
          gap: 28,
          alignItems: "end",
          borderBottom: "1px solid var(--line)",
          paddingBottom: 22,
        }}
      >
        <div>
          <p style={{ margin: 0, letterSpacing: "0.28em", fontSize: 11, color: "var(--acid)" }}>
            SOLANA ONLY · SIGNALS + PAPER
          </p>
          <h1
            style={{
              fontFamily: "var(--font-display), serif",
              fontSize: "clamp(48px, 7vw, 92px)",
              lineHeight: 0.86,
              margin: "10px 0 0",
              fontWeight: 460,
              letterSpacing: "-0.04em",
            }}
          >
            TAPE
          </h1>
          <label
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 10,
              marginTop: 16,
              padding: "10px 14px",
              border: "1px solid",
              borderColor: trader?.enabled ? "var(--acid)" : "var(--line)",
              background: trader?.enabled ? "rgba(214,255,63,0.08)" : "var(--panel)",
              cursor: traderBusy ? "wait" : "pointer",
              userSelect: "none",
            }}
          >
            <input
              type="checkbox"
              checked={!!trader?.enabled}
              disabled={traderBusy}
              onChange={() => void toggleTrader()}
              style={{ width: 18, height: 18, accentColor: "#d6ff3f", cursor: "pointer" }}
            />
            <span>
              <span
                style={{
                  letterSpacing: "0.14em",
                  fontSize: 12,
                  color: trader?.enabled ? "var(--acid)" : "var(--paper)",
                }}
              >
                AUTO TRADE
              </span>
              <span
                style={{
                  marginLeft: 10,
                  fontSize: 12,
                  color: trader?.enabled ? "var(--acid)" : "var(--mute)",
                }}
              >
                {traderBusy ? "…" : trader?.enabled ? "ACTIVE · 0.1 SOL" : "DISABLED"}
              </span>
            </span>
          </label>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "flex-start", gap: 16 }}>
            <div>
              <p style={{ margin: 0, color: "var(--mute)", fontSize: 13 }}>{blurb}</p>
              <p
                style={{
                  margin: "8px 0 0",
                  color: "var(--paper)",
                  maxWidth: 420,
                  marginLeft: "auto",
                  fontSize: 13,
                  lineHeight: 1.5,
                }}
              >
                Live Pump poll + Helius logs, hourly Gecko backfill. Failed-curve entry + 20m rug calibration.
              </p>
              <p style={{ margin: "10px 0 0", color: "var(--mute)", fontSize: 11 }}>
                {job?.lastRunAt
                  ? `hourly ${new Date(job.lastRunAt).toLocaleTimeString()} · +${job.inserted ?? 0} · ${job.scored ?? 0} scored`
                  : "ingest has not run yet"}
              </p>
              <div style={{ display: "flex", gap: 16, justifyContent: "flex-end", marginTop: 10 }}>
                <Link href="/watch" style={{ color: "var(--acid)", letterSpacing: "0.14em", fontSize: 12 }}>
                  WATCH LIST →
                </Link>
                <Link href="/trades" style={{ color: "var(--acid)", letterSpacing: "0.14em", fontSize: 12 }}>
                  FILLS →
                </Link>
                <Link href="/keys" style={{ color: "var(--acid)", letterSpacing: "0.14em", fontSize: 12 }}>
                  KEYS →
                </Link>
              </div>
            </div>
            <EntryBell
              items={notices.items}
              open={bellOpen}
              onToggle={() => setBellOpen((v) => !v)}
              onClose={() => setBellOpen(false)}
              onRead={markRead}
              onReadAll={markAllRead}
              onSelect={selectMint}
            />
          </div>
        </div>
      </header>

      {stats ? (
        <section
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(6, minmax(0, 1fr))",
            gap: 10,
            marginTop: 22,
          }}
        >
          {(
            [
              ["prints", stats.total],
              ["rug / skip", stats.rejected],
              ["watch", stats.watching],
              ["entry", stats.enter],
              ["exit", stats.exit],
              ["paper", stats.paper],
            ] as const
          ).map(([label, value]) => (
            <div
              key={label}
              style={{ border: "1px solid var(--line)", padding: "12px 14px", background: "var(--panel)" }}
            >
              <div style={{ color: "var(--mute)", fontSize: 11, letterSpacing: "0.12em" }}>
                {String(label).toUpperCase()}
              </div>
              <div style={{ fontFamily: "var(--font-display), serif", fontSize: 32, marginTop: 4 }}>{value}</div>
            </div>
          ))}
        </section>
      ) : (
        <StatSkeleton />
      )}

      <div style={{ display: "flex", gap: 10, marginTop: 22, flexWrap: "wrap", alignItems: "center" }}>
        {FILTERS.map((f) => {
          const count =
            f.id === "all"
              ? stats?.total
              : f.id === "rejected"
                ? stats?.rejected
                : f.id === "watching"
                  ? stats?.watching
                  : f.id === "enter"
                    ? stats?.enter
                    : f.id === "exit"
                      ? stats?.exit
                      : f.id === "migrated"
                        ? stats?.migrated
                        : f.id === "watchlist"
                          ? watch.length
                          : undefined;
          return (
            <button
              key={f.id}
              onClick={() => {
                setStatus(f.id);
                setPage(1);
              }}
              style={{
                border: "1px solid",
                borderColor: status === f.id ? "var(--acid)" : "var(--line)",
                background: status === f.id ? "var(--acid)" : "transparent",
                color: status === f.id ? "#111" : "var(--paper)",
                padding: "8px 12px",
                cursor: "pointer",
              }}
            >
              {f.label}
              {typeof count === "number" ? ` ${count}` : ""}
            </button>
          );
        })}
        <button
          onClick={() => void pullNow()}
          disabled={pulling || job?.running}
          style={{
            border: "1px solid var(--acid)",
            background: "transparent",
            color: "var(--acid)",
            padding: "8px 12px",
            cursor: "pointer",
          }}
        >
          {pulling || job?.running ? "PULLING…" : "PULL NOW"}
        </button>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="search mint / ticker"
          style={{
            marginLeft: "auto",
            background: "var(--panel)",
            border: "1px solid var(--line)",
            padding: "8px 12px",
            minWidth: 240,
            outline: "none",
          }}
        />
      </div>

      {error && <p style={{ color: "var(--rust)" }}>{error}</p>}

      <div style={{ marginTop: 18, borderTop: "1px solid var(--line)", position: "relative", overflowX: "auto" }}>
        {loading && (
          <div
            style={{
              position: "absolute",
              top: 10,
              right: 8,
              display: "flex",
              alignItems: "center",
              gap: 8,
              color: "var(--acid)",
              fontSize: 11,
              letterSpacing: "0.12em",
              zIndex: 1,
            }}
          >
            <span className="tape-spin" />
            FETCHING
          </div>
        )}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: GRID,
            gap: 12,
            padding: "10px 8px",
            color: "var(--mute)",
            fontSize: 11,
            letterSpacing: "0.1em",
          }}
        >
          {COLS.map((c) => (
            <SortHead key={c.id} id={c.id} label={c.label} active={sort === c.id} dir={dir} onSort={onSort} />
          ))}
          <span>LINKS</span>
        </div>
        {emptyLoading && <TapeSkeleton rows={8} />}
        {!emptyLoading && rows.length === 0 && (
          <p style={{ padding: 24, color: "var(--mute)" }}>
            {status === "watchlist"
              ? "Watch list is empty. Hit PIN on any coin record."
              : "No live prints on this page. Hit PULL NOW to fetch new launches."}
          </p>
        )}
        <div style={{ opacity: dimRows ? 0.35 : 1, transition: "opacity 0.15s linear" }}>
          {!emptyLoading &&
            rows.map((row) => {
              const open = openMint === row.mint;
              return (
                <div key={row.mint} style={{ borderTop: "1px solid var(--line)" }}>
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      const next = open ? null : row.mint;
                      setOpenMint(next);
                      if (next && hasFlag(row, "enter")) markRead(row.mint);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        const next = open ? null : row.mint;
                        setOpenMint(next);
                        if (next && hasFlag(row, "enter")) markRead(row.mint);
                      }
                    }}
                    style={{
                      display: "grid",
                      gridTemplateColumns: GRID,
                      gap: 12,
                      padding: "13px 8px",
                      alignItems: "center",
                      cursor: "pointer",
                      background: open ? "#1a1711" : "transparent",
                    }}
                  >
                    <span style={{ fontSize: 11, lineHeight: 1.25 }}>
                      <span style={{ color: "var(--mute)" }}>{open ? "▾ " : "▸ "}</span>
                      {rowFlags(row).map((f, i) => (
                        <span key={f}>
                          {i > 0 ? <span style={{ color: "var(--mute)" }}> · </span> : null}
                          <span style={{ color: tone(f) }}>{f === "dump1st" ? "DUMP1st" : f === "hit15x" ? "HIT15x" : f === "hold70" ? "HOLD70" : f.toUpperCase()}</span>
                        </span>
                      ))}
                    </span>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {row.symbol || row.name || row.mint.slice(0, 6)}
                      <span style={{ display: "block", color: "var(--mute)", fontSize: 10 }}>
                        {row.venue}
                        {row.mint ? ` · ${row.mint.slice(0, 4)}…${row.mint.slice(-4)}` : ""}
                      </span>
                    </span>
                    <span style={{ color: "var(--mute)", fontSize: 12, whiteSpace: "nowrap" }}>
                      {launchedAgo(row.launchedAt, now)}
                    </span>
                    <span>{price(row.priceUsd, row.marketCapUsd)}</span>
                    <span>{money(row.marketCapUsd)}</span>
                    <span>{money(row.liquidityUsd)}</span>
                    <span>{holders(row.holders)}</span>
                    <span>{money(row.volume5m)}</span>
                    <span style={{ color: changeTone(row.change5m ?? 100 * row.returnRatio) }}>
                      {signedPct(row.change5m ?? 100 * row.returnRatio)}
                    </span>
                    <span style={{ color: row.rugProb >= 0.55 ? "var(--rust)" : "var(--paper)" }}>
                      {pct(row.rugProb)}
                    </span>
                    <span style={{ color: row.entryProb >= 0.35 ? "var(--acid)" : "var(--mute)" }}>
                      {pct(row.entryProb)}
                    </span>
                    <span style={{ color: row.exitProb >= 0.5 ? "var(--amber)" : "var(--mute)" }}>
                      {pct(row.exitProb)}
                    </span>
                    <span
                      onClick={(e) => e.stopPropagation()}
                      style={{ display: "inline-flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}
                    >
                      <PinButton
                        mint={row.mint}
                        symbol={row.symbol}
                        onChange={(items) => {
                          setWatch(items);
                          if (status === "watchlist" && !items.some((w) => w.mint === row.mint)) {
                            setRows((rs) => rs.filter((r) => r.mint !== row.mint));
                            setTotal((n) => Math.max(0, n - 1));
                          }
                        }}
                      />
                      <BanButton
                        mint={row.mint}
                        symbol={row.symbol}
                        onBanned={(mint) => {
                          setRows((rs) => rs.filter((r) => r.mint !== mint));
                          setTotal((n) => Math.max(0, n - 1));
                        }}
                      />
                      <button
                        type="button"
                        disabled={scoringMint === row.mint}
                        onClick={() => void rescore(row.mint)}
                        style={{
                          color: scoringMint === row.mint ? "var(--amber)" : "var(--paper)",
                          letterSpacing: "0.08em",
                          fontSize: 11,
                          border: "1px solid var(--amber)",
                          background: "transparent",
                          padding: "4px 8px",
                          cursor: scoringMint === row.mint ? "wait" : "pointer",
                        }}
                      >
                        {scoringMint === row.mint ? "SCORING…" : "RESCORE"}
                      </button>
                      <VenueLinks mint={row.mint} compact />
                    </span>
                  </div>
                  {open && (
                    <TokenAccordion
                      mint={row.mint}
                      onScored={applyScored}
                      onWatchChange={(items) => {
                        setWatch(items);
                        if (status === "watchlist" && !items.some((w) => w.mint === row.mint)) {
                          setRows((rs) => rs.filter((r) => r.mint !== row.mint));
                          setTotal((n) => Math.max(0, n - 1));
                        }
                      }}
                    />
                  )}
                </div>
              );
            })}
        </div>
      </div>

      <nav
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginTop: 18,
          borderTop: "1px solid var(--line)",
          paddingTop: 16,
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <p style={{ margin: 0, color: "var(--mute)", fontSize: 12, letterSpacing: "0.08em" }}>
          PAGE {page} / {pages} · {total} MATCHES · {PAGE_SIZE} / PAGE
          {sort !== "updatedAt" || dir !== "desc" ? ` · SORT ${sort} ${dir.toUpperCase()}` : ""}
        </p>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            disabled={page <= 1 || loading}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            style={{
              border: "1px solid var(--line)",
              background: "transparent",
              padding: "8px 14px",
              cursor: page <= 1 || loading ? "default" : "pointer",
              opacity: page <= 1 || loading ? 0.4 : 1,
            }}
          >
            PREV
          </button>
          <button
            disabled={page >= pages || loading}
            onClick={() => setPage((p) => Math.min(pages, p + 1))}
            style={{
              border: "1px solid var(--acid)",
              background: "transparent",
              color: "var(--acid)",
              padding: "8px 14px",
              cursor: page >= pages || loading ? "default" : "pointer",
              opacity: page >= pages || loading ? 0.4 : 1,
            }}
          >
            NEXT
          </button>
        </div>
      </nav>

      {toasts.length > 0 && (
        <div
          style={{
            position: "fixed",
            right: 22,
            bottom: 22,
            zIndex: 40,
            display: "flex",
            flexDirection: "column",
            gap: 8,
            width: 320,
          }}
        >
          {toasts.map((n) => (
            <div
              key={`${n.kind || "enter"}-${n.mint}-${n.at}`}
              style={{
                textAlign: "left",
                border: n.kind === "dump" ? "1px solid var(--rust)" : "1px solid var(--acid)",
                background: "#16140f",
                color: n.kind === "dump" ? "var(--rust)" : "var(--acid)",
                padding: "12px 14px",
                boxShadow: "0 12px 28px rgba(0,0,0,0.4)",
              }}
            >
              <button
                type="button"
                onClick={() => selectMint(n.mint, n.kind)}
                style={{ all: "unset", cursor: "pointer", display: "block", width: "100%" }}
              >
                <span style={{ display: "block", fontSize: 11, letterSpacing: "0.12em", color: "var(--mute)" }}>
                  {n.kind === "dump" ? "DUMP" : "ENTRY"}
                </span>
                <span style={{ display: "block", marginTop: 4, fontSize: 15 }}>{n.symbol}</span>
                <span
                  style={{
                    display: "flex",
                    gap: 10,
                    marginTop: 6,
                    fontSize: 10,
                    letterSpacing: "0.06em",
                    flexWrap: "wrap",
                  }}
                >
                  <span style={{ color: "var(--rust)" }}>RUG {scorePct(n.rugProb)}</span>
                  <span style={{ color: "var(--acid)" }}>ENTRY {scorePct(n.entryProb)}</span>
                  <span style={{ color: "var(--amber)" }}>EXIT {scorePct(n.exitProb)}</span>
                  {n.kind === "dump" && <span style={{ color: "var(--rust)" }}>{dumpLine(n)}</span>}
                </span>
                <span style={{ display: "block", marginTop: 3, fontSize: 10, color: "var(--mute)" }}>
                  {n.mint.slice(0, 4)}…{n.mint.slice(-4)}
                </span>
              </button>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
                <VenueLinks mint={n.mint} compact />
                <button
                  type="button"
                  onClick={() => {
                    const hrefs = venueLinks(n.mint);
                    window.open(hrefs.pumpfun, "_blank", "noopener,noreferrer");
                    window.open(hrefs.gmgn, "_blank", "noopener,noreferrer");
                    window.open(hrefs.axiom, "_blank", "noopener,noreferrer");
                    selectMint(n.mint, n.kind);
                  }}
                  style={{
                    all: "unset",
                    cursor: "pointer",
                    color: n.kind === "dump" ? "var(--rust)" : "var(--acid)",
                    fontSize: 11,
                    letterSpacing: "0.08em",
                  }}
                >
                  OPEN ALL
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
