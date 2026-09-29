"""Build weekly workbooks for CFJr from paged GMGN holdings + activity."""
import json
from datetime import datetime, timezone
from pathlib import Path

from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment
from openpyxl.utils import get_column_letter

OUT = Path(r"c:\Users\Administrator\Videos\pump-trade\cfjr-weeks")
SKIP = {
    "So11111111111111111111111111111111111111112",
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
}
SKIP_SYM = {"SOL", "WSOL", "USDC", "USDT", "USD1"}
NOW = datetime.now(timezone.utc).timestamp()

COLS = [
    "Token",
    "Mint",
    "Status",
    "First entry (UTC)",
    "First buy MC",
    "Avg entry MC",
    "Sell MC",
    "First sell MC",
    "Realized PnL",
    "Unrealized PnL",
    "Total profit",
    "PnL %",
    "Holding duration",
    "Hours held",
    "Time to first sell",
    "Hours to first sell",
    "Win/Loss",
    "Buys",
    "Sells",
    "Buy cost USD",
    "Sell proceeds USD",
    "Remaining USD",
]


def n(v):
    try:
        x = float(v)
    except (TypeError, ValueError):
        return 0.0
    return x if x == x and abs(x) != float("inf") else 0.0


def week_key(ts):
    d = datetime.fromtimestamp(ts, timezone.utc)
    monday = d.timestamp() - ((d.weekday()) * 86400) - d.hour * 3600 - d.minute * 60 - d.second
    return datetime.fromtimestamp(monday, timezone.utc).strftime("%Y-%m-%d")


def fmt_dur(sec):
    if sec is None:
        return ""
    s = max(0, int(round(sec)))
    if s < 1:
        return "same second"
    d, rem = divmod(s, 86400)
    h, rem = divmod(rem, 3600)
    m, _ = divmod(rem, 60)
    if d >= 1:
        return f"{d}d {h}h"
    if h >= 1:
        return f"{h}h {m}m"
    return f"{m}m"


def fmt_ts(ts):
    if not ts:
        return ""
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def load(name):
    return json.loads((OUT / name).read_text(encoding="utf-8"))


holdings = load("_holdings.json")
activity = load("_activity.json")

by_mint = {}


def slot(mint):
    row = by_mint.get(mint)
    if row is None:
        row = {
            "mint": mint,
            "symbol": "",
            "supply": 0.0,
            "first_buy_ts": 0,
            "first_buy_px": 0.0,
            "first_sell_ts": 0,
            "first_sell_px": 0.0,
            "last_sell_ts": 0,
            "buy_usd": 0.0,
            "buy_qty": 0.0,
            "sell_usd": 0.0,
            "sell_qty": 0.0,
            "buy_n": 0,
            "sell_n": 0,
            "hold": None,
        }
        by_mint[mint] = row
    return row


for h in holdings:
    tok = h.get("token") or {}
    mint = tok.get("token_address") or ""
    if not mint or mint in SKIP:
        continue
    sym = (tok.get("symbol") or "").strip()
    if sym.upper() in SKIP_SYM:
        continue
    row = slot(mint)
    row["symbol"] = sym or row["symbol"]
    row["supply"] = n(tok.get("total_supply") or tok.get("max_supply")) or row["supply"]
    row["hold"] = h

for ev in activity:
    tok = ev.get("token") or {}
    mint = tok.get("address") or ""
    if not mint or mint in SKIP:
        continue
    sym = (tok.get("symbol") or "").strip()
    if sym.upper() in SKIP_SYM:
        continue
    side = ev.get("event_type") or ev.get("type") or ""
    if side not in ("buy", "sell"):
        continue
    row = slot(mint)
    row["symbol"] = sym or row["symbol"]
    supply = n(tok.get("total_supply"))
    if supply > 0:
        row["supply"] = supply
    ts = int(n(ev.get("timestamp")))
    px = n(ev.get("price_usd"))
    usd = n(ev.get("cost_usd"))
    qty = n(ev.get("token_amount"))
    if side == "buy":
        row["buy_n"] += 1
        row["buy_usd"] += usd
        row["buy_qty"] += qty
        if ts and (not row["first_buy_ts"] or ts < row["first_buy_ts"]):
            row["first_buy_ts"] = ts
            row["first_buy_px"] = px
    else:
        row["sell_n"] += 1
        row["sell_usd"] += usd
        row["sell_qty"] += qty
        if ts and (not row["first_sell_ts"] or ts < row["first_sell_ts"]):
            row["first_sell_ts"] = ts
            row["first_sell_px"] = px
        if ts > row["last_sell_ts"]:
            row["last_sell_ts"] = ts

weeks = {}


def mc(px, supply):
    if px > 0 and supply > 0:
        return px * supply
    return None


for row in by_mint.values():
    h = row["hold"] or {}
    buys = int(n(h.get("history_total_buys"))) or row["buy_n"]
    sells = int(n(h.get("history_total_sells"))) or row["sell_n"]
    if buys <= 0 and row["buy_n"] <= 0:
        continue
    start = int(n(h.get("start_holding_at"))) or row["first_buy_ts"]
    if row["first_buy_ts"] and (not start or row["first_buy_ts"] < start):
        start = row["first_buy_ts"]
    if not start:
        continue
    end = int(n(h.get("end_holding_at")))
    bal = n(h.get("balance"))
    bought_amt = n(h.get("history_bought_amount")) or row["buy_qty"]
    usd_value = n(h.get("usd_value"))
    remain_ratio = (bal / bought_amt) if bought_amt > 0 else (1.0 if bal > 0 else 0.0)
    if sells <= 0 and bal > 0:
        status = "Fully holding"
    elif sells > 0 and (bal <= 0 or remain_ratio < 0.02 or (usd_value < 1 and remain_ratio < 0.05)):
        status = "Full sell"
    elif sells > 0:
        status = "Partial sell"
    else:
        status = "Fully holding"

    supply = row["supply"]
    buy_qty = row["buy_qty"] or bought_amt
    buy_usd = row["buy_usd"] or n(h.get("history_bought_cost"))
    sell_qty = row["sell_qty"] or n(h.get("history_sold_amount"))
    sell_usd = row["sell_usd"] or n(h.get("history_sold_income"))
    avg_px = (buy_usd / buy_qty) if buy_qty > 0 else 0
    sell_px = (sell_usd / sell_qty) if sell_qty > 0 else 0
    first_mc = mc(row["first_buy_px"], supply)
    avg_mc = mc(avg_px, supply)
    sell_mc = mc(sell_px, supply) if sells > 0 else None
    first_sell_mc = mc(row["first_sell_px"], supply) if row["first_sell_ts"] else None

    realized = n(h.get("realized_profit")) if h else (sell_usd - buy_usd if status == "Full sell" else 0)
    unrealized = n(h.get("unrealized_profit")) if h else 0
    total = n(h.get("total_profit")) if h else realized + unrealized
    cost = n(h.get("history_bought_cost")) or buy_usd
    pnl_pct = (total / cost) if cost else None

    if status == "Full sell":
        hold_end = end or row["last_sell_ts"] or start
        held = max(0, hold_end - start)
    else:
        held = max(0, NOW - start)
    to_sell = (row["first_sell_ts"] - start) if row["first_sell_ts"] and row["first_sell_ts"] >= start else None

    if total > 0.5:
        wl = "Win"
    elif total < -0.5:
        wl = "Loss"
    else:
        wl = "Flat"

    item = {
        "Token": row["symbol"],
        "Mint": row["mint"],
        "Status": status,
        "First entry (UTC)": fmt_ts(start),
        "First buy MC": first_mc,
        "Avg entry MC": avg_mc,
        "Sell MC": sell_mc,
        "First sell MC": first_sell_mc,
        "Realized PnL": realized,
        "Unrealized PnL": unrealized,
        "Total profit": total,
        "PnL %": pnl_pct,
        "Holding duration": fmt_dur(held),
        "Hours held": held / 3600,
        "Time to first sell": fmt_dur(to_sell) if to_sell is not None else "",
        "Hours to first sell": (to_sell / 3600) if to_sell is not None else None,
        "Win/Loss": wl,
        "Buys": buys,
        "Sells": sells,
        "Buy cost USD": cost,
        "Sell proceeds USD": n(h.get("history_sold_income")) or sell_usd,
        "Remaining USD": usd_value,
        "_ts": start,
    }
    weeks.setdefault(week_key(start), []).append(item)

HEADER_FILL = PatternFill("solid", fgColor="1F2937")
HEADER_FONT = Font(color="FFFFFF", bold=True)
FILLS = {
    "Full sell": PatternFill("solid", fgColor="FEE2E2"),
    "Partial sell": PatternFill("solid", fgColor="FEF3C7"),
    "Fully holding": PatternFill("solid", fgColor="DCFCE7"),
}
MONEY = {"First buy MC", "Avg entry MC", "Sell MC", "First sell MC", "Realized PnL", "Unrealized PnL", "Total profit", "Buy cost USD", "Sell proceeds USD", "Remaining USD"}


def write_sheet(ws, rows):
    ws.append(COLS)
    for cell in ws[1]:
        cell.fill = HEADER_FILL
        cell.font = HEADER_FONT
        cell.alignment = Alignment(wrap_text=True)
    rows = sorted(rows, key=lambda r: r["_ts"])
    for rec in rows:
        ws.append([rec[c] for c in COLS])
        fill = FILLS.get(rec["Status"])
        if fill:
            for cell in ws[ws.max_row]:
                cell.fill = fill
    for col in ws.columns:
        letter = get_column_letter(col[0].column)
        name = col[0].value
        if name in MONEY or name == "PnL %":
            fmt = '0.00%' if name == "PnL %" else '#,##0.00'
            for cell in col[1:]:
                if isinstance(cell.value, float):
                    cell.number_format = fmt
        width = 22 if name in ("Mint", "First entry (UTC)") else 16
        ws.column_dimensions[letter].width = width
    ws.auto_filter.ref = ws.dimensions
    ws.freeze_panes = "A2"
    ws.auto_filter.ref = f"A1:{get_column_letter(len(COLS))}{ws.max_row}"


def summarize(rows):
    lines = []
    for status in ("Full sell", "Partial sell", "Fully holding"):
        part = [r for r in rows if r["Status"] == status]
        wins = sum(1 for r in part if r["Win/Loss"] == "Win")
        losses = sum(1 for r in part if r["Win/Loss"] == "Loss")
        decided = wins + losses
        lines.append(
            [
                status,
                len(part),
                wins,
                losses,
                (wins / decided) if decided else None,
                sum(r["Realized PnL"] or 0 for r in part),
                sum(r["Unrealized PnL"] or 0 for r in part),
                sum(r["Total profit"] or 0 for r in part),
            ]
        )
    lines.append(
        [
            "All",
            len(rows),
            sum(1 for r in rows if r["Win/Loss"] == "Win"),
            sum(1 for r in rows if r["Win/Loss"] == "Loss"),
            None,
            sum(r["Realized PnL"] or 0 for r in rows),
            sum(r["Unrealized PnL"] or 0 for r in rows),
            sum(r["Total profit"] or 0 for r in rows),
        ]
    )
    decided = lines[-1][2] + lines[-1][3]
    lines[-1][4] = (lines[-1][2] / decided) if decided else None
    return lines


SUM_COLS = ["Bucket", "Tokens", "Wins", "Losses", "Win rate", "Realized PnL", "Unrealized PnL", "Total profit"]

for key in sorted(weeks):
    rows = weeks[key]
    wb = Workbook()
    ws = wb.active
    ws.title = "Summary"
    ws.append([f"Wallet CFJr1M2z3SZpQpBMoY3nagpafvS7Uzanq4L7KVXVKi22"])
    ws.append([f"Week of first entry (Monday UTC) {key}"])
    ws.append(["Status is the position now: Full sell = sold out, Partial sell = sold some and still holding, Fully holding = no sell yet."])
    ws.append(["Win/Loss uses total profit (realized + unrealized). Flat is between -$0.50 and +$0.50."])
    ws.append(["Market cap = trade price × token total supply. Avg entry MC weights every buy. Sell MC weights every sell."])
    ws.append([])
    ws.append(SUM_COLS)
    for line in summarize(rows):
        ws.append(line)
    for cell in ws[7]:
        cell.fill = HEADER_FILL
        cell.font = HEADER_FONT
    for row in ws.iter_rows(min_row=8, max_row=11, min_col=5, max_col=5):
        for cell in row:
            if isinstance(cell.value, float):
                cell.number_format = "0.0%"
    for row in ws.iter_rows(min_row=8, max_row=11, min_col=6, max_col=8):
        for cell in row:
            cell.number_format = '#,##0.00'
    ws.column_dimensions["A"].width = 18
    for col in "BCDEFGH":
        ws.column_dimensions[col].width = 16

    for status, title in (
        ("Full sell", "Full sell"),
        ("Partial sell", "Partial sell"),
        ("Fully holding", "Fully holding"),
    ):
        sheet = wb.create_sheet(title)
        write_sheet(sheet, [r for r in rows if r["Status"] == status])
    path = OUT / f"{key}.xlsx"
    wb.save(path)
    print(key, "tokens", len(rows), "->", path)

print("weeks", len(weeks), "tokens", sum(len(v) for v in weeks.values()))
