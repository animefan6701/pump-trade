from collections import Counter
from pathlib import Path

from openpyxl import load_workbook

root = Path(r"c:\Users\Administrator\Videos\pump-trade\cfjr-weeks")
rows = []
for f in sorted(root.glob("2026-*.xlsx")):
    wb = load_workbook(f, read_only=True, data_only=True)
    for name in ["Full sell", "Partial sell", "Fully holding"]:
        ws = wb[name]
        hdr = None
        for i, r in enumerate(ws.iter_rows(values_only=True)):
            if i == 0:
                hdr = list(r)
                continue
            if not r or not r[1]:
                continue
            d = dict(zip(hdr, r))
            d["status"] = name
            rows.append(d)
    wb.close()


def num(v):
    return float(v) if isinstance(v, (int, float)) else None


PAIR_SYMS = {
    "SOL", "WSOL", "USDC", "USDT", "USD1", "PYUSD", "USDG", "EURC", "JUPUSD",
    "USDS", "UXD", "DAI", "CASH", "JLP", "JITO SOL", "JITOSOL", "MSOL", "HSOL",
    "BSOL", "INF", "CBBTC", "WBTC", "WETH", "JUP",
}
# quote assets, stables, LSTs, and pool receipts — not the coin he was hunting
PAIR_MINTS = {
    "27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4",
    "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn",
    "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo",
    "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH",
    "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",
    "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij",
    "5oVNBeEEQvYi1cX3ir8Dx5n1P7pdxydbGF2X4TxVusJm",
    "he1iusmfkpAdwvxLNGV8Y1iSbj4rUy6yMhEA3fotn9A",
    "HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr",
    "JuprjznTrTSp2UFa3ZBUFgwdAmtZCq4MQCwysN55USD",
    "CASHx9KJUStyftLFWGvEVf59SGeG9sh5FfcnZMVPCASH",
    "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
    "So11111111111111111111111111111111111111112",
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
}


def is_pair(r):
    sym = (r.get("Token") or "").upper().replace(" ", "")
    mint = r.get("Mint") or ""
    return sym in PAIR_SYMS or mint in PAIR_MINTS


pairs = [r for r in rows if is_pair(r)]
real = [r for r in rows if not is_pair(r)]
print("removed", len(pairs), "kept", len(real))
print("REMOVED")
for r in sorted(pairs, key=lambda r: num(r.get("Buy cost USD")) or 0, reverse=True):
    print(
        (r.get("Token") or "")[:16],
        "cost",
        round(num(r.get("Buy cost USD")) or 0),
        "mcM",
        round((num(r.get("First buy MC")) or 0) / 1e6, 1),
        r["status"],
    )


def band(p):
    if p >= 5:
        return "500%+"
    if p >= 2:
        return "200-500%"
    if p >= 1:
        return "100-200%"
    if p >= 0.5:
        return "50-100%"
    if p > 0.005:
        return "0-50%"
    if p >= -0.005:
        return "flat"
    if p >= -0.5:
        return "-50-0%"
    if p >= -0.9:
        return "-90--50%"
    return "under -90%"


order = ["500%+", "200-500%", "100-200%", "50-100%", "0-50%", "flat", "-50-0%", "-90--50%", "under -90%"]
sold = [r for r in real if r["status"] != "Fully holding"]
pcts = []
for r in sold:
    cost = num(r.get("Buy cost USD")) or 0
    real_pnl = num(r.get("Realized PnL")) or 0
    if cost <= 0:
        continue
    pcts.append((real_pnl / cost, real_pnl, num(r.get("First buy MC")) or 0, num(r.get("Total profit")) or 0))
print("SOLD", len(pcts), "realized", round(sum(t for _, t, _, _ in pcts)))
c = Counter(band(p) for p, _, _, _ in pcts)
for b in order:
    xs = [t for p, t, _, _ in pcts if band(p) == b]
    print(f"{b:12} {c[b]:4} {c[b] / len(pcts) * 100:5.1f}% realized {sum(xs):,.0f}")
mcs = sorted(m for _, _, m, _ in pcts if m > 0)
med = mcs[len(mcs) // 2]
under = sum(1 for m in mcs if m < 70_000)
print("sold median entry MC", round(med), "under 70k", under, "of", len(mcs))
print("ge100", sum(1 for p, _, _, _ in pcts if p >= 1), "ge500", sum(1 for p, _, _, _ in pcts if p >= 5))
print("wins", sum(1 for p, _, _, _ in pcts if p > 0.005), "losses", sum(1 for p, _, _, _ in pcts if p < -0.005))
