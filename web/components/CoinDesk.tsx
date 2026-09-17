"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { BanButton } from "@/components/BanButton";
import { PinButton } from "@/components/PinButton";
import { VenueLinks } from "@/components/VenueLinks";
import { isDir5mFlag, isDumpFirstFlag, isHit15xFlag, isHit2xFlag, isManipFlag, isSurvive70Flag } from "@/lib/flags";
import type { CoinDoc, TradeDoc } from "@/lib/types";

function pct(n: number) {
  return `${Math.round(100 * n)}%`;
}

function Bar({ value, color }: { value: number; color: string }) {
  return (
    <div style={{ height: 8, background: "#2a261c", marginTop: 8 }}>
      <div
        style={{
          width: `${Math.max(2, Math.min(100, 100 * value))}%`,
          height: "100%",
          background: color,
        }}
      />
    </div>
  );
}

export function CoinDesk({ mint }: { mint: string }) {
  const router = useRouter();
  const [coin, setCoin] = useState<CoinDoc | null>(null);
  const [fills, setFills] = useState<TradeDoc[]>([]);
  const [busy, setBusy] = useState(false);
  const [scoring, setScoring] = useState(false);
  const [error, setError] = useState("");

  async function load() {
    const r = await fetch(`/api/coins/${mint}`);
    if (!r.ok) {
      setError("mint not in mongo — seed MELT first");
      return;
    }
    const body = await r.json();
    setCoin(body.coin);
    setFills(body.trades || []);
  }

  async function paper(side: "buy" | "sell") {
    setBusy(true);
    try {
      await fetch(`/api/coins/${mint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ side }),
      });
      await load();
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void load();
    const poll = window.setInterval(() => void load(), 1_000);
    return () => window.clearInterval(poll);
  }, [mint]);

  if (error) {
    return (
      <main style={{ padding: 40 }}>
        <Link href="/">← tape</Link>
        <p style={{ color: "var(--rust)" }}>{error}</p>
      </main>
    );
  }

  if (!coin) {
    return (
      <main style={{ minHeight: "100vh", padding: "28px 32px 64px" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            color: "var(--acid)",
            letterSpacing: "0.12em",
            fontSize: 12,
          }}
        >
          <span className="tape-spin" />
          FETCHING PRINT
        </div>
        <div className="skel" style={{ width: 220, height: 48, marginTop: 22 }} />
        <div className="skel" style={{ width: "60%", height: 14, marginTop: 16 }} />
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
            gap: 14,
            marginTop: 28,
          }}
        >
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              style={{ border: "1px solid var(--line)", padding: 18, background: "var(--panel)" }}
            >
              <div className="skel" style={{ width: 80, height: 10 }} />
              <div className="skel" style={{ width: 120, height: 48, marginTop: 14 }} />
              <div className="skel" style={{ width: "100%", height: 8, marginTop: 12 }} />
            </div>
          ))}
        </div>
      </main>
    );
  }

  const flags: string[] = coin.flags && coin.flags.length ? [...coin.flags] : [coin.status];
  if (isManipFlag(coin)) flags.push("manip");
  if (isDir5mFlag(coin)) flags.push("up5m");
  if (isHit2xFlag(coin)) flags.push("x2");
  if (isDumpFirstFlag(coin)) flags.push("dump1st");
  if (isSurvive70Flag(coin)) flags.push("hold70");
  if (isHit15xFlag(coin)) flags.push("hit15x");

  return (
    <main style={{ minHeight: "100vh", padding: "28px 32px 64px" }}>
      <Link href="/" style={{ color: "var(--acid)", letterSpacing: "0.16em", fontSize: 12 }}>
        ← BACK TO TAPE
      </Link>
      <h1
        style={{
          fontFamily: "var(--font-display), serif",
          fontSize: "clamp(36px, 5vw, 64px)",
          lineHeight: 0.9,
          margin: "16px 0 8px",
          fontWeight: 460,
        }}
      >
        {coin.name || coin.symbol || coin.status.toUpperCase()}
      </h1>
      <p style={{ color: "var(--mute)", margin: 0 }}>
        {flags.map((f) => (f === "dump1st" ? "DUMP1st" : f === "hit15x" ? "HIT15x" : f === "hold70" ? "HOLD70" : f.toUpperCase())).join(" · ")} · {coin.symbol || "—"} · {coin.venue}
        {coin.source === "live" ? " · LIVE SCORE" : " · MELT ARCHIVE"}
      </p>
      <p style={{ color: "var(--mute)", wordBreak: "break-all", maxWidth: 720 }}>{coin.mint}</p>
      <div style={{ marginTop: 14, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <PinButton mint={coin.mint} symbol={coin.symbol} />
        <BanButton mint={coin.mint} symbol={coin.symbol} onBanned={() => router.push("/")} />
        <Link href="/watch" style={{ color: "var(--acid)", letterSpacing: "0.1em", fontSize: 11 }}>
          WATCH LIST →
        </Link>
        <Link href="/keys" style={{ color: "var(--acid)", letterSpacing: "0.1em", fontSize: 11 }}>
          KEYS →
        </Link>
        <button
          type="button"
          disabled={scoring}
          onClick={async () => {
            setScoring(true);
            setError("");
            try {
              const r = await fetch(`/api/coins/${mint}/rescore`, { method: "POST", cache: "no-store" });
              const body = await r.json();
              if (!r.ok || !body.coin) throw new Error(body.error || "rescore failed");
              setCoin(body.coin);
            } catch (e) {
              setError(e instanceof Error ? e.message : "rescore failed");
            } finally {
              setScoring(false);
            }
          }}
          style={{
            color: scoring ? "var(--amber)" : "var(--paper)",
            letterSpacing: "0.08em",
            fontSize: 11,
            border: "1px solid var(--amber)",
            background: "transparent",
            padding: "4px 10px",
            cursor: scoring ? "wait" : "pointer",
          }}
        >
          {scoring ? "SCORING…" : "RESCORE"}
        </button>
        <VenueLinks mint={coin.mint} />
      </div>
      <p style={{ color: "var(--mute)", fontSize: 12, maxWidth: 640, lineHeight: 1.5 }}>
        {coin.source === "live"
          ? "Scored from the hourly Pump.fun / GeckoTerminal snapshot. Rule layer only — MELT XGB is not serving yet."
          : "MELT archive print (Dec 2024–Mar 2025). The coin page may still open after graduation; many are already dead."}
      </p>
      <section
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
          gap: 14,
          marginTop: 28,
        }}
      >
        <article style={{ border: "1px solid var(--line)", padding: 18, background: "var(--panel)" }}>
          <div style={{ color: "var(--mute)", fontSize: 11, letterSpacing: "0.14em" }}>RUG GATE</div>
          <div style={{ fontFamily: "var(--font-display), serif", fontSize: 56, color: "var(--rust)" }}>
            {pct(coin.rugProb)}
          </div>
          <Bar value={coin.rugProb} color="var(--rust)" />
          <p style={{ color: "var(--mute)", fontSize: 12 }}>
            {coin.source === "live" ? "Rule" : "MELT"} label {coin.riskLabel}. Skip if ≥ 55%.
          </p>
        </article>
        <article style={{ border: "1px solid var(--line)", padding: 18, background: "var(--panel)" }}>
          <div style={{ color: "var(--mute)", fontSize: 11, letterSpacing: "0.14em" }}>ENTRY CLOCK</div>
          <div style={{ fontFamily: "var(--font-display), serif", fontSize: 56, color: "var(--acid)" }}>
            {pct(coin.entryProb)}
          </div>
          <Bar value={coin.entryProb} color="var(--acid)" />
          <p style={{ color: "var(--mute)", fontSize: 12 }}>
            Rule score until failed-curve history is pulled.
          </p>
        </article>
        <article style={{ border: "1px solid var(--line)", padding: 18, background: "var(--panel)" }}>
          <div style={{ color: "var(--mute)", fontSize: 11, letterSpacing: "0.14em" }}>EXIT CLOCK</div>
          <div style={{ fontFamily: "var(--font-display), serif", fontSize: 56, color: "var(--amber)" }}>
            {pct(coin.exitProb)}
          </div>
          <Bar value={coin.exitProb} color="var(--amber)" />
          <p style={{ color: "var(--mute)", fontSize: 12 }}>
            1h min ratio {coin.minRatio.toFixed(2)} · return {(100 * coin.returnRatio).toFixed(0)}%
          </p>
        </article>
      </section>
      <section style={{ display: "grid", gridTemplateColumns: "1.2fr 0.8fr", gap: 18, marginTop: 22 }}>
        <div style={{ border: "1px solid var(--line)", padding: 18 }}>
          <h2 style={{ fontFamily: "var(--font-display), serif", marginTop: 0 }}>Why this print</h2>
          <ul style={{ paddingLeft: 18, lineHeight: 1.7 }}>
            {coin.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          <p style={{ color: "var(--mute)", fontSize: 12 }}>
            venue {coin.venue} · source {coin.source}
            {isManipFlag(coin)
              ? ` · MANIP ${typeof coin.manipScore === "number" ? Math.round(coin.manipScore * 100) + "%" : "yes"}`
              : ""}
            {typeof coin.dir5mProb === "number" ? ` · UP5M ${Math.round(coin.dir5mProb * 100)}%` : ""}
            {typeof coin.hit2xProb === "number" ? ` · X2 ${Math.round(coin.hit2xProb * 100)}%` : ""}
            {typeof coin.dumpFirstProb === "number" ? ` · DUMP1st ${Math.round(coin.dumpFirstProb * 100)}%` : ""}
            {typeof coin.survive70Prob === "number" ? ` · HOLD70 ${Math.round(coin.survive70Prob * 100)}%` : ""}
            {typeof coin.hit15xProb === "number" ? ` · HIT15x ${Math.round(coin.hit15xProb * 100)}%` : ""}
          </p>
        </div>
        <div style={{ border: "1px solid var(--acid)", padding: 18 }}>
          <h2 style={{ fontFamily: "var(--font-display), serif", marginTop: 0 }}>Paper trade</h2>
          <p style={{ color: "var(--mute)", fontSize: 13 }}>
            Writes a paper fill to Mongo. No wallet. No live SOL.
          </p>
          <div style={{ display: "flex", gap: 10 }}>
            <button
              disabled={busy}
              onClick={() => void paper("buy")}
              style={{
                flex: 1,
                background: "var(--acid)",
                color: "#111",
                border: 0,
                padding: "12px 10px",
                cursor: "pointer",
              }}
            >
              PAPER BUY
            </button>
            <button
              disabled={busy}
              onClick={() => void paper("sell")}
              style={{
                flex: 1,
                background: "transparent",
                border: "1px solid var(--amber)",
                color: "var(--amber)",
                padding: "12px 10px",
                cursor: "pointer",
              }}
            >
              PAPER SELL
            </button>
          </div>
          <div style={{ marginTop: 16, fontSize: 12, color: "var(--mute)" }}>
            {fills.length === 0 && <p>no fills yet</p>}
            {fills.map((t) => (
              <p key={t.createdAt} style={{ margin: "6px 0" }}>
                {t.side.toUpperCase()} · {t.createdAt.slice(11, 19)}
              </p>
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}
