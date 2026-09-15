import type { CSSProperties } from "react";
import { venueLinks } from "@/lib/venues";

const style: CSSProperties = {
  color: "var(--acid)",
  letterSpacing: "0.08em",
  fontSize: 11,
  border: "1px solid var(--line)",
  padding: "4px 8px",
};

export function VenueLinks({
  mint,
  compact = false,
}: {
  mint: string;
  compact?: boolean;
}) {
  const hrefs = venueLinks(mint);
  return (
    <span
      style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}
      onClick={(e) => e.stopPropagation()}
    >
      <a href={hrefs.pumpfun} target="_blank" rel="noreferrer" style={style}>
        {compact ? "PUMP" : "PUMP.FUN"}
      </a>
      <a href={hrefs.gmgn} target="_blank" rel="noreferrer" style={style}>
        GMGN
      </a>
      <a href={hrefs.axiom} target="_blank" rel="noreferrer" style={style}>
        AXIOM
      </a>
    </span>
  );
}
