"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { WalletRankDoc } from "@/lib/types";

type Board = {
  wallets: WalletRankDoc[];
  gates: { hit500: number; winrate: number; pnl: number };
  asOf?: string;
  errors?: { address: string; error: string }[];
};

function pct(n?: number) {
  if (n === undefined || Number.isNaN(n)) return "—";
  return `${n >= 0 ? "+" : ""}${(100 * n).toFixed(0)}%`;
}

function tone(ok: boolean) {
  return ok ? "var(--mint)" : "var(--rust)";
}

function shortAddr(a: string) {
  return `${a.slice(0, 4)}…${a.slice(-4)}`;
}

export function WalletDesk() {
  const [text, setText] = useState("");
  const [board, setBoard] = useState<Board | null>(null);
  const [qualifyOnly, setQualifyOnly] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function load(qualify = qualifyOnly) {
    const r = await fetch(`/api/wallets${qualify ? "?qualify=1" : ""}`, { cache: "no-store" });
    const body = (await r.json()) as Board & { error?: string };
    if (!r.ok) throw new Error(body.error || "wallet list failed");
    setBoard(body);
  }

  useEffect(() => {
    void load(true).catch((e) => setError(e instanceof Error ? e.message : "wallet list failed"));
  }, []);

  async function submit(refresh = false) {
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/wallets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(refresh ? { refresh: true, text } : { text }),
      });
      const body = (await r.json()) as Board & { error?: string };
      if (!r.ok) throw new Error(body.error || "fetch failed");
      if (body.errors?.length) setError(body.errors.map((e) => `${shortAddr(e.address)}: ${e.error}`).join(" · "));
      await load(qualifyOnly);
      if (!refresh) setText("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "fetch failed");
    } finally {
      setBusy(false);
    }
  }

  const rows = useMemo(() => board?.wallets || [], [board]);
  const gates = board?.gates || { hit500: 3, winrate: 0.4, pnl: 0.3 };

  return (
    <main style={{ minHeight: "100vh", padding: "28px 32px 64px" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 24, flexWrap: "wrap" }}>
        <div>
          <p style={{ margin: 0, letterSpacing: "0.28em", fontSize: 11, color: "var(--acid)" }}>
            WALLET RANK · 7d 500%+ ≥ {gates.hit500} · WR ≥ {(gates.winrate * 100).toFixed(0)}% · PnL ≥ +
            {(gates.pnl * 100).toFixed(0)}%
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
            500%+
          </h1>
        </div>
        <div style={{ textAlign: "right" }}>
          <p style={{ margin: 0, color: "var(--mute)", fontSize: 13, maxWidth: 440, marginLeft: "auto" }}>
            Paste GMGN wallet addresses. Pulls 7d / 30d / all via gmgn-cli. Rank is 7-day count of 500%+ trades.
          </p>
          <div style={{ display: "flex", gap: 16, justifyContent: "flex-end", marginTop: 12 }}>
            <Link href="/" style={{ color: "var(--acid)", letterSpacing: "0.14em", fontSize: 12 }}>
              ← TAPE
            </Link>
            <Link href="/analyze" style={{ color: "var(--acid)", letterSpacing: "0.14em", fontSize: 12 }}>
              ANALYZE →
            </Link>
          </div>
        </div>
      </header>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit(false);
        }}
        style={{ marginTop: 28, display: "grid", gap: 10 }}
      >
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="CFJr1… or gmgn.ai/sol/address/…  — one or many"
          rows={3}
          style={{
            width: "100%",
            background: "var(--panel)",
            border: "1px solid var(--line)",
            padding: 12,
            resize: "vertical",
          }}
        />
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <button
            type="submit"
            disabled={busy}
            style={{ border: "1px solid var(--acid)", background: "transparent", color: "var(--acid)", padding: "8px 14px" }}
          >
            {busy ? "FETCHING…" : "FETCH TAPE"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void submit(true)}
            style={{ border: "1px solid var(--line)", background: "transparent", color: "var(--paper)", padding: "8px 14px" }}
          >
            REFRESH ALL
          </button>
          <button
            type="button"
            onClick={() => {
              const next = !qualifyOnly;
              setQualifyOnly(next);
              void load(next).catch((e) => setError(e instanceof Error ? e.message : "list failed"));
            }}
            style={{
              border: `1px solid ${qualifyOnly ? "var(--acid)" : "var(--line)"}`,
              background: "transparent",
              color: qualifyOnly ? "var(--acid)" : "var(--paper)",
              padding: "8px 14px",
            }}
          >
            {qualifyOnly ? "QUALIFYING" : "ALL CAPTURED"}
          </button>
          <span style={{ color: "var(--mute)", fontSize: 12 }}>
            {rows.length} wallets{board?.asOf ? ` · ${new Date(board.asOf).toLocaleTimeString()}` : ""}
          </span>
        </div>
      </form>

      {error ? <p style={{ color: "var(--rust)" }}>{error}</p> : null}

      <div
        style={{
          marginTop: 22,
          display: "grid",
          gridTemplateColumns: "44px 1.4fr 70px 70px 64px 64px 70px 70px 64px 70px 90px",
          gap: 8,
          color: "var(--mute)",
          fontSize: 11,
          letterSpacing: "0.1em",
        }}
      >
        <div>#</div>
        <div>WALLET</div>
        <div>7D TRD</div>
        <div>B / S</div>
        <div>500%+</div>
        <div>WR</div>
        <div>7D PNL</div>
        <div>30D 5X</div>
        <div>30D WR</div>
        <div>ALL PNL</div>
        <div>GATE</div>
      </div>

      {rows.map((w, i) => (
        <div
          key={w.address}
          style={{
            marginTop: 8,
            display: "grid",
            gridTemplateColumns: "44px 1.4fr 70px 70px 64px 64px 70px 70px 64px 70px 90px",
            gap: 8,
            alignItems: "center",
            border: "1px solid var(--line)",
            background: "var(--panel)",
            padding: "10px 8px",
          }}
        >
          <div style={{ color: "var(--mute)" }}>{i + 1}</div>
          <div>
            <a href={`https://gmgn.ai/sol/address/${w.address}`} target="_blank" rel="noreferrer" style={{ color: "var(--paper)" }}>
              {w.name || shortAddr(w.address)}
            </a>
            <div style={{ color: "var(--mute)", fontSize: 11, wordBreak: "break-all" }}>{w.address}</div>
            {w.tags.length ? <div style={{ color: "var(--amber)", fontSize: 11 }}>{w.tags.join(" · ")}</div> : null}
          </div>
          <div>{w.d7.trades}</div>
          <div>
            {w.d7.buy} / {w.d7.sell}
          </div>
          <div style={{ color: w.d7.hit500 >= gates.hit500 ? "var(--acid)" : "var(--paper)", fontWeight: 600 }}>{w.d7.hit500}</div>
          <div style={{ color: tone(w.d7.winrate >= gates.winrate) }}>{(w.d7.winrate * 100).toFixed(0)}%</div>
          <div style={{ color: tone(w.d7.pnl >= gates.pnl) }}>{pct(w.d7.pnl)}</div>
          <div>{w.d30.hit500}</div>
          <div>{(w.d30.winrate * 100).toFixed(0)}%</div>
          <div style={{ color: tone(w.all.pnl >= 0) }}>{pct(w.all.pnl)}</div>
          <div style={{ color: w.qualify ? "var(--mint)" : "var(--rust)", letterSpacing: "0.1em", fontSize: 11 }}>
            {w.qualify ? "KEEP" : "SKIP"}
          </div>
        </div>
      ))}

      {!rows.length && !busy ? (
        <p style={{ color: "var(--mute)", marginTop: 24 }}>No wallets yet. Paste an address and fetch.</p>
      ) : null}
    </main>
  );
}
