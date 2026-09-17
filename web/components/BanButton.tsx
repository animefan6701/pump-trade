"use client";

export function BanButton({
  mint,
  symbol,
  onBanned,
}: {
  mint: string;
  symbol?: string;
  onBanned?: (mint: string) => void;
}) {
  return (
    <button
      type="button"
      title="Hide this mint from every list and stop fetching it"
      onClick={() => {
        void (async () => {
          const r = await fetch("/api/blacklist", {
            method: "POST",
            headers: { "content-type": "application/json" },
            cache: "no-store",
            body: JSON.stringify({ mint, symbol }),
          });
          if (!r.ok) return;
          onBanned?.(mint);
        })();
      }}
      style={{
        color: "var(--rust)",
        letterSpacing: "0.08em",
        fontSize: 11,
        border: "1px solid var(--rust)",
        background: "transparent",
        padding: "4px 8px",
        cursor: "pointer",
      }}
    >
      BAN
    </button>
  );
}
