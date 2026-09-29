"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { BanButton } from "@/components/BanButton";
import { PinButton } from "@/components/PinButton";
import { VenueLinks } from "@/components/VenueLinks";
import { isDumpedCoin } from "@/lib/dumpCheck";
import { flagsOf, isDir5mFlag, isDumpFirstFlag, isHit15xFlag, isHit2xFlag, isManipFlag, isSurvive70Flag } from "@/lib/flags";
import { changeTone, holders, launchedAgo, money, signedPct } from "@/lib/format";
import { loadWatchlist, syncWatchPins, type WatchItem } from "@/lib/watchlist";
import type { CoinDoc } from "@/lib/types";

function pct(n: number) {
  return `${Math.round(100 * n)}%`;
}

function flagTone(flag: string) {
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

export function WatchDesk() {
  const [pins, setPins] = useState<WatchItem[]>([]);
  const [coins, setCoins] = useState<CoinDoc[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [scoring, setScoring] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  async function load() {
    const list = loadWatchlist();
    setPins(list);
    if (!list.length) {
      setCoins([]);
      setError("");
      setLoading(false);
      return;
    }
    try {
      const qs = new URLSearchParams({
        source: "all",
        status: "all",
        mints: list.map((p) => p.mint).join(","),
        limit: "100",
        lite: "1",
      });
      const r = await fetch(`/api/coins?${qs}`, { cache: "no-store" });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || "load failed");
      const byMint = new Map<string, CoinDoc>((body.coins || []).map((c: CoinDoc) => [c.mint, c]));
      setCoins(list.map((p) => byMint.get(p.mint)).filter((c): c is CoinDoc => Boolean(c)));
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "load failed");
    } finally {
      setLoading(false);
    }
  }

  async function rescore(mint: string) {
    setScoring(mint);
    try {
      const r = await fetch(`/api/coins/${mint}/rescore`, { method: "POST", cache: "no-store" });
      const body = await r.json();
      if (body.coin) {
        setCoins((cur) => cur.map((c) => (c.mint === mint ? { ...c, ...body.coin } : c)));
      }
    } finally {
      setScoring(null);
    }
  }

  useEffect(() => {
    syncWatchPins(loadWatchlist());
    void load();
    const poll = window.setInterval(() => void load(), 1_000);
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      window.clearInterval(poll);
      window.clearInterval(tick);
    };
  }, []);

  const rows = useMemo(() => {
    const byMint = new Map(coins.map((c) => [c.mint, c]));
    return pins.map((p) => ({ pin: p, coin: byMint.get(p.mint) }));
  }, [pins, coins]);

  const dumped = coins.filter((c) => isDumpedCoin(c) || c.status === "exit").length;
  const migrated = coins.filter((c) => c.complete || flagsOf(c).includes("migrated")).length;

  return (
    <main style={{ minHeight: "100vh", padding: "28px 32px 64px" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 24, flexWrap: "wrap" }}>
        <div>
          <p style={{ margin: 0, letterSpacing: "0.28em", fontSize: 11, color: "var(--acid)" }}>
            PINNED REVIEW · {pins.length} BOOK{pins.length === 1 ? "" : "S"}
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
            LIST
          </h1>
        </div>
        <div style={{ textAlign: "right" }}>
          <p style={{ margin: 0, color: "var(--mute)", fontSize: 13 }}>
            Your pins only. Rescore, dump-check, and unpin without leaving this book.
          </p>
          <p style={{ margin: "10px 0 0", color: "var(--mute)", fontSize: 11 }}>
            {migrated} migrated · {dumped} dumped/exit
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
            <Link href="/trades" style={{ color: "var(--acid)", letterSpacing: "0.14em", fontSize: 12 }}>
              FILLS →
            </Link>
            <Link href="/keys" style={{ color: "var(--acid)", letterSpacing: "0.14em", fontSize: 12 }}>
              KEYS →
            </Link>
          </div>
        </div>
      </header>
      {error ? <p style={{ color: "var(--rust)" }}>{error}</p> : null}
      {loading && !rows.length ? <p style={{ color: "var(--mute)" }}>loading pins…</p> : null}
      {!loading && !pins.length ? <p style={{ color: "var(--mute)" }}>Watch list is empty. Hit PIN on any coin record.</p> : null}
      {rows.map(({ pin, coin }) => {
        const flags: string[] = coin ? [...flagsOf(coin)] : [];
        if (coin && isManipFlag(coin)) flags.push("manip");
        if (coin && isDir5mFlag(coin)) flags.push("up5m");
        if (coin && isHit2xFlag(coin)) flags.push("x2");
        if (coin && isDumpFirstFlag(coin)) flags.push("dump1st");
        if (coin && isSurvive70Flag(coin)) flags.push("hold70");
        if (coin && isHit15xFlag(coin)) flags.push("hit15x");
        return (
          <div key={pin.mint} style={{ borderTop: "1px solid var(--line)", padding: "14px 0" }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
              <div>
                <div style={{ fontSize: 11 }}>
                  {flags.map((f, i) => (
                    <span key={f}>
                      {i > 0 ? <span style={{ color: "var(--mute)" }}> · </span> : null}
                      <span style={{ color: flagTone(f) }}>{f === "dump1st" ? "DUMP1st" : f === "hit15x" ? "HIT15x" : f === "hold70" ? "HOLD70" : f.toUpperCase()}</span>
                    </span>
                  ))}
                </div>
                <div style={{ fontSize: 20, marginTop: 4 }}>{coin?.symbol || pin.symbol || pin.mint.slice(0, 6)}</div>
                <div style={{ color: "var(--mute)", fontSize: 11 }}>
                  {pin.mint.slice(0, 4)}…{pin.mint.slice(-4)}
                  {coin?.launchedAt ? ` · ${launchedAgo(coin.launchedAt, now)}` : ""}
                </div>
              </div>
              <div style={{ display: "flex", gap: 16, fontSize: 13 }}>
                <span>{money(coin?.marketCapUsd)}</span>
                <span>{money(coin?.liquidityUsd)}</span>
                <span>{holders(coin?.holders)}</span>
                <span style={{ color: changeTone(coin?.change5m) }}>{signedPct(coin?.change5m)}</span>
                <span>R {coin ? pct(coin.rugProb) : "—"}</span>
                <span style={{ color: "var(--acid)" }}>E {coin ? pct(coin.entryProb) : "—"}</span>
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <PinButton
                  mint={pin.mint}
                  symbol={coin?.symbol || pin.symbol}
                  onChange={(items) => {
                    setPins(items);
                    setCoins((cur) => cur.filter((c) => items.some((w) => w.mint === c.mint)));
                  }}
                />
                <BanButton
                  mint={pin.mint}
                  symbol={coin?.symbol || pin.symbol}
                  onBanned={(mint) => {
                    setPins((cur) => cur.filter((p) => p.mint !== mint));
                    setCoins((cur) => cur.filter((c) => c.mint !== mint));
                  }}
                />
                <button
                  type="button"
                  disabled={scoring === pin.mint}
                  onClick={() => void rescore(pin.mint)}
                  style={{
                    border: "1px solid var(--amber)",
                    background: "transparent",
                    color: scoring === pin.mint ? "var(--amber)" : "var(--paper)",
                    padding: "4px 8px",
                    fontSize: 11,
                    cursor: scoring === pin.mint ? "wait" : "pointer",
                  }}
                >
                  {scoring === pin.mint ? "SCORING…" : "RESCORE"}
                </button>
                <VenueLinks mint={pin.mint} compact />
                <Link href={`/coins/${pin.mint}`} style={{ color: "var(--acid)", fontSize: 11 }}>
                  FULL →
                </Link>
              </div>
            </div>
          </div>
        );
      })}
    </main>
  );
}
