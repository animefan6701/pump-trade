"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { AnalyzeTokenDetail, DayPrint } from "@/lib/analyzeTypes";
import { clockGmt5, duration, money } from "@/lib/format";

function changeTone(n?: number) {
  if (n == null || Number.isNaN(n)) return "var(--mute)";
  return n >= 0 ? "var(--mint)" : "var(--rust)";
}

function DayCard({ day }: { day: DayPrint }) {
  return (
    <article style={{ border: "1px solid var(--line)", background: "var(--panel)", padding: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
        <div>
          <p style={{ margin: 0, letterSpacing: "0.16em", fontSize: 11, color: "var(--mute)" }}>{day.date} GMT-5</p>
          <div style={{ display: "flex", gap: 22, marginTop: 8, fontSize: 13 }}>
            <span>
              MIN <b style={{ color: "var(--amber)" }}>{money(day.min)}</b>
              <span style={{ color: "var(--mute)", marginLeft: 8 }}>{clockGmt5(day.minAt)}</span>
            </span>
            <span>
              MAX <b style={{ color: "var(--acid)" }}>{money(day.max)}</b>
              <span style={{ color: "var(--mute)", marginLeft: 8 }}>{clockGmt5(day.maxAt)}</span>
            </span>
          </div>
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(24, minmax(0, 1fr))", gap: 3, marginTop: 14 }}>
        {day.hours.map((h) => (
          <div
            key={h.hour}
            title={
              h.changePct == null
                ? `GMT-5 ${String(h.hour).padStart(2, "0")}:00 · no print`
                : `GMT-5 ${String(h.hour).padStart(2, "0")}:00 · ${h.changePct >= 0 ? "+" : ""}${h.changePct.toFixed(1)}% · ${money(h.low)}–${money(h.high)}`
            }
            style={{
              minHeight: 42,
              border: "1px solid var(--line)",
              background: h.changePct == null ? "#14120d" : h.changePct >= 0 ? "rgba(125,255,163,0.08)" : "rgba(255,77,46,0.1)",
              display: "grid",
              placeItems: "center",
              fontSize: 9,
              color: changeTone(h.changePct),
            }}
          >
            {h.changePct == null ? "·" : Math.round(h.changePct)}
          </div>
        ))}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(24, minmax(0, 1fr))", gap: 3, marginTop: 4, color: "var(--mute)", fontSize: 9 }}>
        {day.hours.map((h) => (
          <div key={`h-${h.hour}`} style={{ textAlign: "center" }}>
            {String(h.hour).padStart(2, "0")}
          </div>
        ))}
      </div>
    </article>
  );
}

export function AnalyzeCoin({ mint }: { mint: string }) {
  const [detail, setDetail] = useState<AnalyzeTokenDetail | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const r = await fetch(`/api/analyze/${mint}`, { cache: "no-store" });
        const body = await r.json();
        if (!r.ok) throw new Error(body.error || "analyze failed");
        if (live) setDetail(body);
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : "analyze failed");
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [mint]);

  const coin = detail?.coin;

  return (
    <main style={{ minHeight: "100vh", padding: "28px 32px 64px" }}>
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
        <Link href="/analyze" style={{ color: "var(--acid)", letterSpacing: "0.12em", fontSize: 12 }}>
          ← 500k BOOK
        </Link>
        <Link href={`/coins/${mint}`} style={{ color: "var(--acid)", letterSpacing: "0.12em", fontSize: 12 }}>
          TAPE CARD →
        </Link>
      </div>
      {loading ? <p style={{ color: "var(--mute)" }}>opening survivor tape…</p> : null}
      {error ? <p style={{ color: "var(--rust)" }}>{error}</p> : null}
      {coin ? (
        <>
          <header style={{ marginTop: 18, display: "flex", justifyContent: "space-between", gap: 24, flexWrap: "wrap" }}>
            <div>
              <p style={{ margin: 0, letterSpacing: "0.28em", fontSize: 11, color: "var(--acid)" }}>
                SURVIVOR · MAX {coin.maxTarget || "—"}
              </p>
              <h1
                style={{
                  fontFamily: "var(--font-display), serif",
                  fontSize: "clamp(42px, 6vw, 80px)",
                  lineHeight: 0.88,
                  margin: "10px 0 0",
                  fontWeight: 460,
                  letterSpacing: "-0.04em",
                }}
              >
                {coin.symbol || coin.mint.slice(0, 6)}
              </h1>
              <p style={{ color: "var(--mute)", wordBreak: "break-all", maxWidth: 720 }}>{coin.mint}</p>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 13, color: "var(--mute)" }}>NOW / ATH</div>
              <div style={{ fontSize: 22, marginTop: 4 }}>
                {money(coin.marketCapUsd)} <span style={{ color: "var(--acid)" }}>{money(coin.athMarketCap)}</span>
              </div>
              <div style={{ color: "var(--mute)", fontSize: 12, marginTop: 8 }}>ATH clock {clockGmt5(detail?.athAt)}</div>
              <div style={{ color: "var(--mute)", fontSize: 11, marginTop: 6 }}>
                tape {detail?.source.scores || 0} scores · {detail?.source.ohlcv || 0} hours · {detail?.source.bars || 0} migrate bars
              </div>
            </div>
          </header>

          <section style={{ marginTop: 28, overflowX: "auto", border: "1px solid var(--line)" }}>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "90px 110px 160px 1fr",
                gap: 12,
                padding: "10px 14px",
                color: "var(--mute)",
                letterSpacing: "0.12em",
                fontSize: 11,
                background: "#14120d",
              }}
            >
              <span>TARGET</span>
              <span>HIT</span>
              <span>FIRST CLOCK</span>
              <span>TIME FROM LAUNCH</span>
            </div>
            {(detail?.hits || []).map((h) => (
              <div
                key={h.key}
                style={{
                  display: "grid",
                  gridTemplateColumns: "90px 110px 160px 1fr",
                  gap: 12,
                  padding: "11px 14px",
                  borderTop: "1px solid var(--line)",
                  background: h.hit ? "#1d1a13" : "var(--panel)",
                  boxShadow: h.key === coin.maxTarget ? "inset 3px 0 0 var(--acid)" : undefined,
                }}
              >
                <span style={{ color: h.hit ? "var(--acid)" : "var(--mute)" }}>{h.key}</span>
                <span style={{ color: h.hit ? "var(--mint)" : "var(--mute)" }}>{h.hit ? "YES" : "NO"}</span>
                <span>{h.at ? clockGmt5(h.at) : "—"}</span>
                <span>{duration(h.durationMs)}</span>
              </div>
            ))}
          </section>

          <section style={{ marginTop: 28, display: "grid", gap: 12 }}>
            <p style={{ margin: 0, letterSpacing: "0.18em", fontSize: 11, color: "var(--mute)" }}>
              DAILY RANGE · HOURLY % CHANGE · MIN / MAX CLOCK
            </p>
            {(detail?.days || []).length ? (
              detail?.days.map((d) => <DayCard key={d.date} day={d} />)
            ) : (
              <p style={{ color: "var(--mute)" }}>No hourly tape yet for this mint.</p>
            )}
          </section>
        </>
      ) : null}
    </main>
  );
}
