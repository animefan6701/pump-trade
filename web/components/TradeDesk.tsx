"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { VenueLinks } from "@/components/VenueLinks";
import { clock, launchedAgo, price } from "@/lib/format";
import type { EquityPoint, PositionDoc, TraderHistory } from "@/lib/types";

const PAGE_SIZE = 20;

const FILTERS = [
  { id: "all", label: "ALL" },
  { id: "open", label: "OPEN" },
  { id: "close", label: "CLOSE" },
  { id: "win", label: "WIN" },
  { id: "loss", label: "LOSS" },
] as const;

type FilterId = (typeof FILTERS)[number]["id"];

function tone(n?: number) {
  if (n === undefined || Number.isNaN(n)) return "var(--mute)";
  return n >= 0 ? "var(--mint)" : "var(--rust)";
}

function sol(n?: number) {
  if (n === undefined || Number.isNaN(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(3)} SOL`;
}

function pct(n?: number) {
  if (n === undefined || Number.isNaN(n)) return "—";
  return `${n >= 0 ? "+" : ""}${(100 * n).toFixed(1)}%`;
}

function stamp(p: PositionDoc) {
  return p.closedAt || p.openedAt || "";
}

function resultOf(p: PositionDoc) {
  if (p.status === "open") return { label: "OPEN", color: "var(--acid)" };
  const n = p.pnlSol || 0;
  if (n > 0) return { label: "WIN", color: "var(--mint)" };
  if (n < 0) return { label: "LOSS", color: "var(--rust)" };
  return { label: "FLAT", color: "var(--mute)" };
}

function FillLeg({
  side,
  px,
  at,
  reason,
  now,
}: {
  side: string;
  px?: number;
  at?: string;
  reason?: string;
  now: number;
}) {
  return (
    <div className="fill-leg">
      <span
        style={{
          color: side === "BUY" ? "var(--acid)" : side === "SELL" ? "var(--rust)" : "var(--amber)",
          letterSpacing: "0.12em",
        }}
      >
        {side}
      </span>
      <div>
        <div className="fill-meta">PRICE</div>
        <div>{price(px)}</div>
      </div>
      <div>
        <div className="fill-meta">{side === "MARK" ? "AS OF" : "TIME"}</div>
        <div>{clock(at)}</div>
        {at && side !== "MARK" ? (
          <div className="fill-meta" style={{ marginTop: 4 }}>
            {launchedAgo(at, now)}
          </div>
        ) : null}
      </div>
      <div>
        <div className="fill-meta">REASON</div>
        <div style={{ color: "var(--paper)" }}>{reason || "—"}</div>
      </div>
    </div>
  );
}

function FillRow({
  p,
  now,
  open,
  onToggle,
}: {
  p: PositionDoc;
  now: number;
  open: boolean;
  onToggle: (open: boolean) => void;
}) {
  const result = resultOf(p);
  return (
    <details
      className="fill-acc"
      open={open}
      onToggle={(e) => onToggle((e.target as HTMLDetailsElement).open)}
    >
      <summary>
        <span style={{ color: "var(--mute)" }}>{open ? "▾" : "▸"}</span>
        <span style={{ color: result.color, letterSpacing: "0.12em" }}>{result.label}</span>
        <span>{p.symbol || p.mint.slice(0, 6)}</span>
        <span>{p.sol} SOL</span>
        <span className="hide-sm" style={{ color: "var(--mute)" }}>
          {p.status === "open" ? launchedAgo(p.openedAt, now) : launchedAgo(p.closedAt, now)}
        </span>
        <span style={{ color: tone(p.pnlSol) }}>{sol(p.pnlSol)}</span>
        <span style={{ color: tone(p.pnlPct) }}>{pct(p.pnlPct)}</span>
      </summary>
      <div className="fill-body">
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            gap: 12,
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          <div>
            <div className="fill-meta">RESULT</div>
            <div
              style={{
                fontFamily: "var(--font-display), serif",
                fontSize: 28,
                color: result.color,
                lineHeight: 1,
              }}
            >
              {result.label}
              <span style={{ marginLeft: 12, fontSize: 22, color: tone(p.pnlSol) }}>{sol(p.pnlSol)}</span>
              <span style={{ marginLeft: 10, fontSize: 16, color: tone(p.pnlPct) }}>{pct(p.pnlPct)}</span>
            </div>
          </div>
          <VenueLinks mint={p.mint} />
        </div>
        <FillLeg side="BUY" px={p.entryPriceUsd} at={p.openedAt} reason={p.reasonOpen} now={now} />
        {p.status === "open" ? (
          <FillLeg
            side="MARK"
            px={p.markPriceUsd || p.entryPriceUsd}
            at={new Date(now).toISOString()}
            reason="open paper book — mark to tape"
            now={now}
          />
        ) : (
          <FillLeg side="SELL" px={p.exitPriceUsd} at={p.closedAt} reason={p.reasonClose} now={now} />
        )}
      </div>
    </details>
  );
}

function PnlChart({ curve }: { curve: EquityPoint[] }) {
  if (curve.length === 0) {
    return (
      <div
        style={{
          height: 260,
          border: "1px solid var(--line)",
          background: "var(--panel)",
          display: "grid",
          placeItems: "center",
          color: "var(--mute)",
        }}
      >
        no closed fills yet — equity waits for the first flatten
      </div>
    );
  }
  const w = 860;
  const h = 214;
  const ys = curve.map((p) => p.equity);
  const min = Math.min(0, ...ys);
  const span = Math.max(0, ...ys) - min || 0.01;
  const xAt = (i: number) => 44 + (i / Math.max(curve.length - 1, 1)) * w;
  const yAt = (v: number) => 18 + (1 - (v - min) / span) * h;
  const last = curve[curve.length - 1];
  const up = last.equity >= 0;
  const line = curve.map((p, i) => `${i === 0 ? "M" : "L"} ${xAt(i)} ${yAt(p.equity)}`).join(" ");
  const area = `${line} L ${xAt(curve.length - 1)} ${yAt(0)} L ${xAt(0)} ${yAt(0)} Z`;
  const zero = yAt(0);
  const ticks = Array.from({ length: 5 }, (_, i) => min + (span * i) / 4);
  return (
    <svg
      viewBox="0 0 920 260"
      style={{ width: "100%", height: 260, display: "block", background: "var(--panel)", border: "1px solid var(--line)" }}
    >
      <path d={area} fill={up ? "rgba(125,255,163,0.08)" : "rgba(255,77,46,0.08)"} />
      <line x1={44} x2={904} y1={zero} y2={zero} stroke="var(--line)" strokeDasharray="3 4" />
      <path d={line} fill="none" stroke={up ? "var(--mint)" : "var(--rust)"} strokeWidth="1.8" />
      {curve.map((p, i) => (
        <circle
          key={`${p.t}-${i}`}
          cx={xAt(i)}
          cy={yAt(p.equity)}
          r={curve.length < 40 ? 2.4 : 1.4}
          fill={p.pnlSol >= 0 ? "var(--acid)" : "var(--rust)"}
        />
      ))}
      {ticks.map((v) => (
        <text key={v} x={8} y={yAt(v) + 3} fill="#9a8f78" fontSize="9">
          {v >= 0 ? "+" : ""}
          {v.toFixed(2)}
        </text>
      ))}
      <text x={44} y={14} fill="#9a8f78" fontSize="10">
        CUMULATIVE P&L · {last.equity >= 0 ? "+" : ""}
        {last.equity.toFixed(3)} SOL
      </text>
    </svg>
  );
}

export function TradeDesk() {
  const [book, setBook] = useState<TraderHistory | null>(null);
  const [error, setError] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [openIds, setOpenIds] = useState(() => new Set<string>());
  const [filter, setFilter] = useState<FilterId>("all");
  const [page, setPage] = useState(1);

  useEffect(() => {
    let dead = false;
    async function load() {
      try {
        const r = await fetch("/api/trader/history", { cache: "no-store" });
        const body = await r.json();
        if (!dead) {
          setBook(body);
          setError("");
        }
      } catch (e) {
        if (!dead) setError(e instanceof Error ? e.message : "history failed");
      }
    }
    void load();
    const poll = setInterval(() => void load(), 12_000);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      dead = true;
      clearInterval(poll);
      clearInterval(tick);
    };
  }, []);

  const rows = useMemo(() => {
    const next = [...(book?.open || []), ...(book?.closed || [])];
    next.sort((a, b) => stamp(b).localeCompare(stamp(a)));
    return next;
  }, [book]);

  const counts = useMemo(() => {
    let open = 0;
    let close = 0;
    let win = 0;
    let loss = 0;
    for (const p of rows) {
      if (p.status === "open") open += 1;
      else {
        close += 1;
        if ((p.pnlSol || 0) > 0) win += 1;
        else if ((p.pnlSol || 0) < 0) loss += 1;
      }
    }
    return { all: rows.length, open, close, win, loss };
  }, [rows]);

  const filtered = useMemo(
    () =>
      rows.filter((p) => {
        if (filter === "all") return true;
        if (filter === "open") return p.status === "open";
        if (filter === "close") return p.status === "closed";
        if (filter === "win") return p.status === "closed" && (p.pnlSol || 0) > 0;
        return p.status === "closed" && (p.pnlSol || 0) < 0;
      }),
    [rows, filter],
  );

  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageSafe = Math.min(page, pages);
  const slice = filtered.slice((pageSafe - 1) * PAGE_SIZE, pageSafe * PAGE_SIZE);
  const stats = book?.stats;
  const settings = book?.settings;

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
            PAPER BLOTTER · {settings?.sizeSol ?? 0.1} SOL / FILL
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
            FILLS
          </h1>
        </div>
        <div style={{ textAlign: "right" }}>
          <p style={{ margin: 0, color: "var(--mute)", fontSize: 13 }}>
            Paper buys ENTER books at 0.1 SOL and flattens on EXIT / dump / reject.
          </p>
          <p style={{ margin: "10px 0 0", color: "var(--mute)", fontSize: 11 }}>
            {settings?.enabled ? "AUTO ARMED" : "AUTO OFF"} · max {settings?.maxOpen ?? 20} books
          </p>
          <div style={{ display: "flex", gap: 16, justifyContent: "flex-end", marginTop: 12 }}>
            <Link href="/" style={{ color: "var(--acid)", letterSpacing: "0.14em", fontSize: 12 }}>
              ← TAPE
            </Link>
            <Link href="/analyze" style={{ color: "var(--acid)", letterSpacing: "0.14em", fontSize: 12 }}>
              ANALYZE →
            </Link>
            <Link href="/wallets" style={{ color: "var(--acid)", letterSpacing: "0.14em", fontSize: 12 }}>
              WALLETS →
            </Link>
          </div>
        </div>
      </header>
      {error && <p style={{ color: "var(--rust)" }}>{error}</p>}
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
            ["open", stats?.open ?? 0, "var(--paper)"],
            ["closed", stats?.closed ?? 0, "var(--paper)"],
            ["win rate", stats ? `${Math.round(100 * stats.winRate)}%` : "—", "var(--acid)"],
            ["wins / loss", stats ? `${stats.wins} / ${stats.losses}` : "—", "var(--paper)"],
            ["realized", stats ? sol(stats.realizedPnlSol) : "—", tone(stats?.realizedPnlSol)],
            ["equity", stats ? sol(stats.equitySol) : "—", tone(stats?.equitySol)],
          ] as const
        ).map(([label, value, color]) => (
          <div
            key={label}
            style={{ border: "1px solid var(--line)", padding: "12px 14px", background: "var(--panel)" }}
          >
            <div style={{ color: "var(--mute)", fontSize: 11, letterSpacing: "0.12em" }}>
              {String(label).toUpperCase()}
            </div>
            <div
              style={{
                fontFamily: "var(--font-display), serif",
                fontSize: 28,
                marginTop: 4,
                color: String(color),
              }}
            >
              {value}
            </div>
          </div>
        ))}
      </section>
      <section style={{ marginTop: 22 }}>
        <p style={{ margin: "0 0 8px", color: "var(--mute)", fontSize: 11, letterSpacing: "0.14em" }}>
          P&L THROUGH TIME
        </p>
        <PnlChart curve={book?.curve || []} />
      </section>
      <div style={{ display: "flex", gap: 10, marginTop: 28, flexWrap: "wrap", alignItems: "center" }}>
        {FILTERS.map((f) => {
          const count = counts[f.id];
          const on = filter === f.id;
          return (
            <button
              key={f.id}
              onClick={() => {
                setFilter(f.id);
                setPage(1);
              }}
              style={{
                border: "1px solid",
                borderColor: on ? "var(--acid)" : "var(--line)",
                background: on ? "var(--acid)" : "transparent",
                color: on ? "#111" : "var(--paper)",
                padding: "8px 12px",
                cursor: "pointer",
              }}
            >
              {f.label} {count}
            </button>
          );
        })}
      </div>
      <section style={{ marginTop: 14, border: "1px solid var(--line)" }}>
        <div className="fill-head">
          <span />
          <span>RESULT</span>
          <span>TICKER</span>
          <span>SIZE</span>
          <span className="hide-sm">TIME</span>
          <span>P&L</span>
          <span>%</span>
        </div>
        {slice.length === 0 ? (
          <p style={{ margin: 0, padding: 16, color: "var(--mute)" }}>no paper trades on this filter</p>
        ) : (
          slice.map((p) => (
            <FillRow
              key={p.id}
              p={p}
              now={now}
              open={openIds.has(p.id)}
              onToggle={(open) => {
                setOpenIds((prev) => {
                  const next = new Set(prev);
                  if (open) next.add(p.id);
                  else next.delete(p.id);
                  return next;
                });
              }}
            />
          ))
        )}
      </section>
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
          PAGE {pageSafe} / {pages} · {filtered.length} MATCHES · {PAGE_SIZE} / PAGE
        </p>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            disabled={pageSafe <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            style={{
              border: "1px solid var(--line)",
              background: "transparent",
              padding: "8px 14px",
              cursor: pageSafe <= 1 ? "default" : "pointer",
              opacity: pageSafe <= 1 ? 0.4 : 1,
            }}
          >
            PREV
          </button>
          <button
            disabled={pageSafe >= pages}
            onClick={() => setPage((p) => Math.min(pages, p + 1))}
            style={{
              border: "1px solid var(--acid)",
              background: "transparent",
              color: "var(--acid)",
              padding: "8px 14px",
              cursor: pageSafe >= pages ? "default" : "pointer",
              opacity: pageSafe >= pages ? 0.4 : 1,
            }}
          >
            NEXT
          </button>
        </div>
      </nav>
    </main>
  );
}
