"use client";

import { useEffect, useRef, useState } from "react";
import { VenueLinks } from "@/components/VenueLinks";
import type { EntryNotice, NoticeKind } from "@/lib/entryNotices";
import { dumpLine, scorePct, unreadCount } from "@/lib/entryNotices";
import { venueLinks } from "@/lib/venues";

function ago(at: string): string {
  const t = Math.max(0, Math.round((Date.now() - new Date(at).getTime()) / 1e3));
  if (t < 60) return `${t}s`;
  if (t < 3600) return `${Math.round(t / 60)}m`;
  return `${Math.round(t / 3600)}h`;
}

function ScoreLine({ n }: { n: EntryNotice }) {
  return (
    <span
      style={{
        display: "flex",
        gap: 10,
        marginTop: 5,
        fontSize: 10,
        letterSpacing: "0.06em",
        flexWrap: "wrap",
      }}
    >
      <span style={{ color: "var(--rust)" }}>RUG {scorePct(n.rugProb)}</span>
      <span style={{ color: "var(--acid)" }}>ENTRY {scorePct(n.entryProb)}</span>
      <span style={{ color: "var(--amber)" }}>EXIT {scorePct(n.exitProb)}</span>
      {n.kind === "dump" && (
        <span style={{ color: "var(--rust)" }}>{dumpLine(n)}</span>
      )}
    </span>
  );
}

export function EntryBell({
  items,
  open,
  onToggle,
  onClose,
  onRead,
  onReadAll,
  onSelect,
}: {
  items: EntryNotice[];
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  onRead: (mint: string) => void;
  onReadAll: () => void;
  onSelect: (mint: string, kind?: NoticeKind) => void;
}) {
  const unread = unreadCount(items);
  const box = useRef<HTMLDivElement>(null);
  const [perm, setPerm] = useState(() =>
    typeof Notification === "undefined" ? "denied" : Notification.permission,
  );

  useEffect(() => {
    function onDoc(ev: MouseEvent) {
      if (!box.current?.contains(ev.target as Node)) onClose();
    }
    if (open) document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open, onClose]);

  return (
    <div ref={box} style={{ position: "relative", display: "inline-block" }}>
      <button
        type="button"
        onClick={onToggle}
        aria-label={unread ? `${unread} unread prints` : "entry and dump notices"}
        style={{
          position: "relative",
          border: "1px solid",
            borderColor: unread ? "var(--amber)" : "var(--line)",
          background: unread ? "rgba(232,168,56,0.1)" : "transparent",
          color: unread ? "var(--amber)" : "var(--paper)",
          width: 42,
          height: 42,
          cursor: "pointer",
          padding: 0,
        }}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
          <path d="M6 9a6 6 0 1 1 12 0c0 7 2 7 2 9H4c0-2 2-2 2-9" />
          <path d="M10 20a2 2 0 0 0 4 0" />
        </svg>
        {unread > 0 && (
          <span
            className="noti-pulse"
            style={{
              position: "absolute",
              top: -7,
              right: -7,
              minWidth: 18,
              height: 18,
              padding: "0 4px",
              background: "var(--acid)",
              color: "#111",
              fontSize: 10,
              lineHeight: "18px",
              letterSpacing: "0.04em",
            }}
          >
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            right: 0,
            top: 50,
            width: 360,
            maxHeight: 420,
            overflow: "auto",
            background: "var(--panel)",
            border: "1px solid var(--line)",
            zIndex: 20,
            boxShadow: "0 18px 40px rgba(0,0,0,0.45)",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              padding: "10px 12px",
              borderBottom: "1px solid var(--line)",
              color: "var(--mute)",
              fontSize: 11,
              letterSpacing: "0.12em",
            }}
          >
            <span>ENTRY / DUMP</span>
            <span style={{ display: "flex", gap: 10 }}>
              {typeof Notification !== "undefined" && perm !== "granted" && (
                <button
                  type="button"
                  onClick={async () => {
                    setPerm(await Notification.requestPermission());
                  }}
                  style={{ all: "unset", cursor: "pointer", color: "var(--acid)" }}
                >
                  DESKTOP
                </button>
              )}
              <button
                type="button"
                onClick={onReadAll}
                disabled={unread === 0}
                style={{
                  all: "unset",
                  cursor: unread ? "pointer" : "default",
                  color: unread ? "var(--acid)" : "var(--mute)",
                }}
              >
                MARK READ
              </button>
            </span>
          </div>
          {items.length === 0 && (
            <p style={{ padding: 16, color: "var(--mute)", fontSize: 12, margin: 0 }}>
              No ENTRY or DUMP flags since this desk opened.
            </p>
          )}
          {items.map((n) => (
            <div
              key={`${n.mint}-${n.at}`}
              style={{
                width: "100%",
                textAlign: "left",
                borderTop: "1px solid var(--line)",
                background: n.read
                  ? "transparent"
                  : n.kind === "dump"
                    ? "rgba(196,74,58,0.1)"
                    : "rgba(214,255,63,0.06)",
                padding: "11px 12px",
              }}
            >
              <button
                type="button"
                onClick={() => {
                  onRead(n.mint);
                  onSelect(n.mint, n.kind);
                }}
                style={{ all: "unset", display: "block", width: "100%", cursor: "pointer" }}
              >
                <span style={{ color: n.read ? "var(--paper)" : n.kind === "dump" ? "var(--rust)" : "var(--acid)", fontSize: 13 }}>
                  {n.read ? "" : "● "}
                  {n.kind === "dump" ? "DUMP " : "ENTRY "}
                  {n.symbol}
                </span>
                <ScoreLine n={n} />
                <span style={{ display: "block", color: "var(--mute)", fontSize: 10, marginTop: 3 }}>
                  {n.mint.slice(0, 4)}…{n.mint.slice(-4)} · {ago(n.at)}
                </span>
              </button>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                <VenueLinks mint={n.mint} compact />
                <button
                  type="button"
                  onClick={() => {
                    const hrefs = venueLinks(n.mint);
                    onRead(n.mint);
                    window.open(hrefs.pumpfun, "_blank", "noopener,noreferrer");
                    window.open(hrefs.gmgn, "_blank", "noopener,noreferrer");
                    window.open(hrefs.axiom, "_blank", "noopener,noreferrer");
                    onSelect(n.mint, n.kind);
                  }}
                  style={{
                    all: "unset",
                    cursor: "pointer",
                    color: "var(--acid)",
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
    </div>
  );
}
