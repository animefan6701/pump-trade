"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { PublicApiKey } from "@/lib/types";

function pct(n?: number) {
  return typeof n === "number" && Number.isFinite(n) ? `${Math.round(n)}%` : "—";
}

function spent(row: PublicApiKey) {
  if (typeof row.creditsRemaining !== "number") return false;
  return (row.creditsRemaining || 0) + (row.prepaidRemaining || 0) <= 0;
}

function parked(row: PublicApiKey) {
  return Boolean(row.exhaustedUntil && Date.parse(row.exhaustedUntil) > Date.now());
}

function tone(row: PublicApiKey) {
  if (spent(row) || parked(row)) return "var(--rust)";
  if ((row.usagePct ?? 0) >= 85) return "var(--amber)";
  return "var(--mint)";
}

export function KeysDesk() {
  const [keys, setKeys] = useState<PublicApiKey[]>([]);
  const [endpoints, setEndpoints] = useState<{ rpc?: string | null; ws?: string | null }>({});
  const [key, setKey] = useState("");
  const [projectId, setProjectId] = useState("");
  const [label, setLabel] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    const r = await fetch("/api/keys", { cache: "no-store" });
    const body = await r.json();
    setKeys(body.keys || []);
    setEndpoints({ rpc: body.rpc, ws: body.ws });
  }

  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), 8_000);
    return () => window.clearInterval(t);
  }, []);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key, projectId, label }),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || "add failed");
      setKey("");
      setProjectId("");
      setLabel("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "add failed");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    await fetch(`/api/keys/${id}`, { method: "DELETE" });
    await load();
  }

  return (
    <main style={{ minHeight: "100vh", padding: "28px 32px 64px" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
        <div>
          <p style={{ margin: 0, letterSpacing: "0.28em", fontSize: 11, color: "var(--acid)" }}>HELIUS POOL</p>
          <h1
            style={{
              fontFamily: "var(--font-display), serif",
              fontSize: "clamp(48px, 7vw, 92px)",
              lineHeight: 0.86,
              margin: "10px 0 0",
              fontWeight: 460,
            }}
          >
            KEYS
          </h1>
        </div>
        <Link href="/" style={{ color: "var(--acid)", letterSpacing: "0.14em", fontSize: 12 }}>
          ← TAPE
        </Link>
      </header>
      <form onSubmit={(e) => void add(e)} style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 24 }}>
        <input value={key} onChange={(e) => setKey(e.target.value)} placeholder="api key" style={{ minWidth: 240 }} />
        <input value={projectId} onChange={(e) => setProjectId(e.target.value)} placeholder="project id" />
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="label" />
        <button
          type="submit"
          disabled={busy}
          style={{ border: "1px solid var(--acid)", background: "transparent", color: "var(--acid)", padding: "8px 14px" }}
        >
          {busy ? "ADDING…" : "ADD KEY"}
        </button>
      </form>
      {error ? <p style={{ color: "var(--rust)" }}>{error}</p> : null}
      {endpoints.rpc || endpoints.ws ? (
        <p style={{ color: "var(--mute)", fontSize: 12, letterSpacing: "0.08em" }}>
          RPC {endpoints.rpc || "—"} · WS {endpoints.ws || "—"} · key injected from LIVE
        </p>
      ) : null}
      <div style={{ marginTop: 24 }}>
        {keys.map((k) => {
          const out = spent(k);
          const cool = !out && parked(k);
          return (
            <div
              key={k.id}
              style={{
                borderTop: "1px solid var(--line)",
                padding: "12px 0",
                display: "flex",
                justifyContent: "space-between",
                gap: 12,
              }}
            >
              <div>
                <div>
                  {k.label} · …{k.last4}
                  {k.active ? <span style={{ color: "var(--acid)" }}> · LIVE</span> : null}
                  {out ? <span style={{ color: "var(--rust)" }}> · OUT</span> : null}
                  {cool ? <span style={{ color: "var(--amber)" }}> · COOLDOWN</span> : null}
                </div>
                <div style={{ color: tone(k), fontSize: 12 }}>
                  project {k.projectId || "—"} · used {pct(k.usagePct)}
                  {typeof k.creditsRemaining === "number" ? ` · ${k.creditsRemaining.toLocaleString()} left` : ""}
                  {k.lastStatus ? ` · last ${k.lastStatus}` : ""}
                </div>
              </div>
              <button
                type="button"
                onClick={() => void remove(k.id)}
                style={{
                  border: "1px solid var(--rust)",
                  background: "transparent",
                  color: "var(--rust)",
                  padding: "4px 8px",
                }}
              >
                REMOVE
              </button>
            </div>
          );
        })}
      </div>
    </main>
  );
}
