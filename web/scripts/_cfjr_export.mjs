import { spawn } from "child_process";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

const WALLET = "CFJr1M2z3SZpQpBMoY3nagpafvS7Uzanq4L7KVXVKi22";
const CLI = join(process.env.APPDATA || "", "npm", "node_modules", "gmgn-cli", "dist", "index.js");
const OUT = join("c:", "Users", "Administrator", "Videos", "pump-trade", "cfjr-weeks");
const SKIP = new Set([
  "So11111111111111111111111111111111111111112",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
]);

function gmgn(args, timeoutMs = 70_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args, "--raw"], { windowsHide: true });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("timeout " + args.slice(0, 4).join(" ")));
    }, timeoutMs);
    child.stdout.on("data", (c) => {
      out += String(c);
    });
    child.stderr.on("data", (c) => {
      err += String(c);
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const text = (out || err || "").trim();
      if (code !== 0) {
        const e = new Error(text.slice(0, 500) || `exit ${code}`);
        e.raw = text;
        reject(e);
        return;
      }
      try {
        resolve(JSON.parse(out));
      } catch {
        reject(new Error("non-json " + text.slice(0, 300)));
      }
    });
  });
}

function num(v) {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function resetWait(raw) {
  const m = String(raw || "").match(/reset_at["']?\s*[:=]\s*(\d{10})/);
  if (!m) return 20_000;
  const ms = Number(m[1]) * 1000 - Date.now() + 1500;
  return Math.min(Math.max(ms, 3000), 6 * 60_000);
}

async function call(args) {
  for (let i = 0; i < 6; i++) {
    try {
      const data = await gmgn(args);
      return data;
    } catch (e) {
      const raw = e.raw || e.message || "";
      if (/429|RATE_LIMIT|timeout/i.test(raw)) {
        const wait = resetWait(raw);
        console.log("retry", wait, raw.slice(0, 160));
        await sleep(wait);
        continue;
      }
      throw e;
    }
  }
  throw new Error("gave up " + args.join(" "));
}

function unwrap(resp) {
  if (resp && typeof resp === "object" && resp.data && typeof resp.data === "object") return resp.data;
  return resp;
}

async function pageAll(label, args, pick) {
  const rows = [];
  let cursor = "";
  for (let page = 1; page < 4000; page++) {
    const extra = cursor ? ["--cursor", cursor] : [];
    const resp = unwrap(await call([...args, ...extra]));
    const batch = pick(resp) || [];
    rows.push(...batch);
    const next = resp && typeof resp.next === "string" ? resp.next : "";
    console.log(label, "page", page, "batch", batch.length, "total", rows.length, "next", next ? "yes" : "no");
    if (!batch.length || !next || next === cursor) break;
    cursor = next;
    await sleep(700);
  }
  return rows;
}

const holdings = await pageAll(
  "hold",
  [
    "portfolio",
    "holdings",
    "--chain",
    "sol",
    "--wallet",
    WALLET,
    "--limit",
    "50",
    "--hide-closed",
    "false",
    "--hide-airdrop",
    "true",
    "--hide-abnormal",
    "false",
    "--order-by",
    "last_active_timestamp",
    "--direction",
    "desc",
  ],
  (d) => d.list || [],
);

const activities = await pageAll(
  "act",
  ["portfolio", "activity", "--chain", "sol", "--wallet", WALLET, "--limit", "50", "--type", "buy", "--type", "sell"],
  (d) => d.activities || [],
);

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "_holdings.json"), JSON.stringify(holdings));
writeFileSync(join(OUT, "_activity.json"), JSON.stringify(activities));
console.log("saved", holdings.length, activities.length);
