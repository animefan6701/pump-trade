"use client";

import { isWatched, toggleWatch, type WatchItem } from "@/lib/watchlist";
import { useEffect, useState } from "react";

export function PinButton({
  mint,
  symbol,
  onChange,
}: {
  mint: string;
  symbol?: string;
  onChange?: (items: WatchItem[]) => void;
}) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    setOn(isWatched(mint));
  }, [mint]);
  return (
    <button
      type="button"
      title={on ? "Remove from watch list" : "Add to watch list"}
      onClick={() => {
        const items = toggleWatch(mint, symbol);
        setOn(items.some((w) => w.mint === mint));
        onChange?.(items);
      }}
      style={{
        color: on ? "var(--acid)" : "var(--paper)",
        letterSpacing: "0.08em",
        fontSize: 11,
        border: "1px solid",
        borderColor: on ? "var(--acid)" : "var(--line)",
        background: "transparent",
        padding: "4px 8px",
        cursor: "pointer",
      }}
    >
      {on ? "PINNED" : "PIN"}
    </button>
  );
}
