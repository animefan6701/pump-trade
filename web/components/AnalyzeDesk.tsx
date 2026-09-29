"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { AnalyzeBoard, AnalyzeTokenRow, HourBucket } from "@/lib/analyzeTypes";
import { clockGmt5, duration, money } from "@/lib/format";

function hitTone(hit: boolean) {
  return hit ? "var(--acid)" : "var(--line)";
}

function changeTone(n: number) {
  if (!n) return "var(--mute)";
  return n > 0 ? "var(--mint)" : "var(--rust)";
}

function HourLabels() {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(24, minmax(0, 1fr))", gap: 3, color: "var(--mute)", fontSize: 9, marginTop: 4 }}>
      {Array.from({ length: 24 }, (_, hour) => (
        <div key={hour} style={{ textAlign: "center" }}>
          {String(hour).padStart(2, "0")}
        </div>
      ))}
    </div>
  );
}

function CountStrip({
  hours,
  pick,
  color,
  title,
}: {
  hours: HourBucket[];
  pick: (h: HourBucket) => number;
  color: string;
  title: string;
}) {
  const max = Math.max(1, ...hours.map(pick));
  const total = hours.reduce((n, h) => n + pick(h), 0);
  return (
    <section style={{ border: "1px solid var(--line)", background: "var(--panel)", padding: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <p style={{ margin: 0, letterSpacing: "0.18em", fontSize: 11, color: "var(--mute)" }}>{title}</p>
        <p style={{ margin: 0, color: color, fontSize: 12 }}>{total} tokens</p>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(24, minmax(0, 1fr))", gap: 3, marginTop: 12 }}>
        {hours.map((h) => {
          const n = pick(h);
          return (
            <div
              key={`${title}-${h.hour}`}
              title={`GMT-5 ${String(h.hour).padStart(2, "0")}:00 · ${n} tokens`}
              style={{
                minHeight: 46,
                border: "1px solid var(--line)",
                background: n ? color : "#14120d",
                color: n ? "#100e0a" : "var(--mute)",
                opacity: n ? 0.35 + 0.65 * (n / max) : 0.35,
                display: "grid",
                placeItems: "center",
                fontSize: 11,
                fontWeight: 600,
              }}
            >
              {n || "·"}
            </div>
          );
        })}
      </div>
      <HourLabels />
    </section>
  );
}

function PctStrip({ hours }: { hours: HourBucket[] }) {
  const total = hours.reduce((n, h) => n + h.changeTokens, 0);
  return (
    <section style={{ border: "1px solid var(--line)", background: "var(--panel)", padding: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <p style={{ margin: 0, letterSpacing: "0.18em", fontSize: 11, color: "var(--mute)" }}>HOURLY % CHANGE · TOKEN COUNT</p>
        <p style={{ margin: 0, color: "var(--mint)", fontSize: 12 }}>{total} tokens</p>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(24, minmax(0, 1fr))", gap: 3, marginTop: 12 }}>
        {hours.map((h) => (
          <div
            key={`pct-${h.hour}`}
            title={`GMT-5 ${String(h.hour).padStart(2, "0")}:00 · ${h.avgChangePct >= 0 ? "+" : ""}${h.avgChangePct.toFixed(1)}% · ${h.changeTokens} tokens`}
            style={{
              minHeight: 52,
              border: "1px solid var(--line)",
              background: h.changeTokens ? (h.avgChangePct >= 0 ? "rgba(125,255,163,0.12)" : "rgba(255,77,46,0.12)") : "#14120d",
              display: "grid",
              placeItems: "center",
              padding: "6px 2px",
              textAlign: "center",
            }}
          >
            <div style={{ fontSize: 11, color: changeTone(h.avgChangePct) }}>{h.changeTokens ? `${h.avgChangePct >= 0 ? "+" : ""}${Math.round(h.avgChangePct)}%` : "·"}</div>
            <div style={{ fontSize: 10, color: "var(--mute)", marginTop: 2 }}>{h.changeTokens || ""}</div>
          </div>
        ))}
      </div>
      <HourLabels />
    </section>
  );
}

function TargetRow({ token }: { token: AnalyzeTokenRow }) {
  return (
    <div style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
      {token.hits.map((h) => (
        <span
          key={h.key}
          title={h.hit ? `${h.key} in ${duration(h.durationMs)}` : `${h.key} not hit`}
          style={{
            width: 8,
            height: 8,
            background: hitTone(h.hit),
            boxShadow: h.hit ? "0 0 0 1px rgba(214,255,63,0.25)" : "none",
          }}
        />
      ))}
    </div>
  );
}

export function AnalyzeDesk() {
  const [board, setBoard] = useState<AnalyzeBoard | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const r = await fetch("/api/analyze", { cache: "no-store" });
        const body = await r.json();
        if (!r.ok) throw new Error(body.error || "analyze failed");
        if (live) setBoard(body);
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : "analyze failed");
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  const tokens = useMemo(() => board?.tokens || [], [board]);

  return (
    <main style={{ minHeight: "100vh", padding: "28px 32px 64px" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 24, flexWrap: "wrap" }}>
        <div>
          <p style={{ margin: 0, letterSpacing: "0.28em", fontSize: 11, color: "var(--acid)" }}>
            SURVIVAL LEDGER · ATH ≥ $500k · LIVE LP ≥ $80
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
            500k+
          </h1>
        </div>
        <div style={{ textAlign: "right" }}>
          <p style={{ margin: 0, color: "var(--mute)", fontSize: 13, maxWidth: 420, marginLeft: "auto" }}>
            Alive $500k+ books only — current LP at least $80. Target counts, first-hit times, and GMT-5 daily min / max / % hours.
          </p>
          <p style={{ margin: "10px 0 0", color: "var(--mute)", fontSize: 11 }}>
            {board ? `${board.tokenCount} books · ${new Date(board.asOf).toLocaleTimeString()}` : "loading ledger…"}
          </p>
          <div style={{ display: "flex", gap: 16, justifyContent: "flex-end", marginTop: 12 }}>
            <Link href="/" style={{ color: "var(--acid)", letterSpacing: "0.14em", fontSize: 12 }}>
              ← TAPE
            </Link>
            <Link href="/wallets" style={{ color: "var(--acid)", letterSpacing: "0.14em", fontSize: 12 }}>
              WALLETS →
            </Link>
            <Link href="/watch" style={{ color: "var(--acid)", letterSpacing: "0.14em", fontSize: 12 }}>
              WATCH LIST →
            </Link>
          </div>
        </div>
      </header>

      {error ? <p style={{ color: "var(--rust)" }}>{error}</p> : null}
      {loading && !board ? <p style={{ color: "var(--mute)" }}>pulling survivor book…</p> : null}

      {board ? (
        <>
          <section
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(108px, 1fr))",
              gap: 8,
              marginTop: 28,
            }}
          >
            {board.targets.map((t) => (
              <div key={t.key} style={{ border: "1px solid var(--line)", background: "var(--panel)", padding: "12px 12px 10px" }}>
                <div style={{ color: "var(--mute)", fontSize: 11, letterSpacing: "0.14em" }}>{t.key.toUpperCase()}</div>
                <div style={{ fontFamily: "var(--font-display), serif", fontSize: 28, lineHeight: 1, marginTop: 6 }}>{t.count}</div>
                <div style={{ color: "var(--mute)", fontSize: 11, marginTop: 6 }}>{t.timed ? `avg ${duration(t.avgDurationMs)}` : "no clock"}</div>
              </div>
            ))}
          </section>

          <section style={{ marginTop: 22, overflowX: "auto", border: "1px solid var(--line)" }}>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "80px 90px 1fr 140px",
                gap: 12,
                padding: "10px 14px",
                color: "var(--mute)",
                letterSpacing: "0.12em",
                fontSize: 11,
                background: "#14120d",
              }}
            >
              <span>TARGET</span>
              <span>TOKENS</span>
              <span>AVG TIME TO FIRST HIT</span>
              <span>TIMED</span>
            </div>
            {board.targets.map((t) => (
              <div
                key={`row-${t.key}`}
                style={{
                  display: "grid",
                  gridTemplateColumns: "80px 90px 1fr 140px",
                  gap: 12,
                  padding: "11px 14px",
                  borderTop: "1px solid var(--line)",
                  background: "var(--panel)",
                  fontSize: 13,
                }}
              >
                <span style={{ color: "var(--acid)" }}>{t.key}</span>
                <span>{t.count}</span>
                <span>{duration(t.avgDurationMs)}</span>
                <span style={{ color: "var(--mute)" }}>{t.timed}/{t.count}</span>
              </div>
            ))}
          </section>

          <div style={{ marginTop: 22, display: "grid", gap: 12 }}>
            <CountStrip hours={board.hours} pick={(h) => h.minHits} color="var(--amber)" title="DAILY MIN HIT HOUR · TOKEN COUNT · GMT-5" />
            <CountStrip hours={board.hours} pick={(h) => h.maxHits} color="var(--acid)" title="DAILY MAX HIT HOUR · TOKEN COUNT · GMT-5" />
            <PctStrip hours={board.hours} />
          </div>

          <section style={{ marginTop: 28 }}>
            <p style={{ margin: 0, letterSpacing: "0.18em", fontSize: 11, color: "var(--mute)" }}>
              TOKEN LIST · {tokens.length} SHOWN · {board.tokenCount} ALIVE OVER $500k
            </p>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(90px, 1fr) 110px 90px 110px 90px 110px 130px 160px",
                gap: 12,
                padding: "12px 0 8px",
                color: "var(--mute)",
                letterSpacing: "0.12em",
                fontSize: 11,
              }}
            >
              <span>BOOK</span>
              <span>NOW</span>
              <span>LP</span>
              <span>ATH</span>
              <span>MAX</span>
              <span>TO 500k</span>
              <span>ATH CLOCK</span>
              <span>TARGETS</span>
            </div>
            {tokens.map((t) => (
              <Link
                key={t.mint}
                href={`/analyze/${t.mint}`}
                style={{
                  display: "grid",
                  gridTemplateColumns: "minmax(90px, 1fr) 110px 90px 110px 90px 110px 130px 160px",
                  gap: 12,
                  padding: "12px 0",
                  borderTop: "1px solid var(--line)",
                  alignItems: "center",
                }}
              >
                <span>
                  <div style={{ fontSize: 16 }}>{t.symbol || t.mint.slice(0, 6)}</div>
                  <div style={{ color: "var(--mute)", fontSize: 11 }}>
                    {t.mint.slice(0, 4)}…{t.mint.slice(-4)}
                  </div>
                </span>
                <span>{money(t.marketCapUsd)}</span>
                <span>{money(t.liquidityUsd)}</span>
                <span style={{ color: "var(--acid)" }}>{money(t.athMarketCap)}</span>
                <span>{t.maxTarget || "—"}</span>
                <span>{duration(t.timeTo500kMs)}</span>
                <span style={{ color: "var(--mute)", fontSize: 12 }}>{clockGmt5(t.athAt)}</span>
                <TargetRow token={t} />
              </Link>
            ))}
          </section>
        </>
      ) : null}
    </main>
  );
}
