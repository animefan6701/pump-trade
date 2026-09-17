const MINT_RE = /[1-9A-HJ-NP-Za-km-z]{32,44}/;
const VENUE_RE = [
  /gmgn\.ai\/(?:sol\/)?token\/([1-9A-HJ-NP-Za-km-z]{32,44})/i,
  /pump\.fun\/(?:coin\/)?([1-9A-HJ-NP-Za-km-z]{32,44})/i,
  /axiom\.trade\/t\/([1-9A-HJ-NP-Za-km-z]{32,44})/i,
  /dexscreener\.com\/solana\/([1-9A-HJ-NP-Za-km-z]{32,44})/i,
  /birdeye\.so\/token\/([1-9A-HJ-NP-Za-km-z]{32,44})/i,
];

export function parseSearchQuery(raw: string): { q: string; mint?: string } {
  const s = raw.trim();
  if (!s) return { q: "" };
  for (const re of VENUE_RE) {
    const m = s.match(re);
    if (m?.[1]) return { q: m[1], mint: m[1] };
  }
  const mint = s.match(MINT_RE)?.[0];
  if (mint && mint.length >= 32 && (!s.includes(" ") || s === mint)) return { q: mint, mint };
  return { q: s };
}
