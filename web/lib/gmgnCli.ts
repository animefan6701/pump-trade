import { spawn } from "child_process";
import { join } from "path";

function gmgnBin() {
  if (process.platform === "win32") {
    return join(process.env.APPDATA || "", "npm", "gmgn-cli.cmd");
  }
  return "gmgn-cli";
}

export async function gmgnJson(args: string[], timeoutMs = 45_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(gmgnBin(), [...args, "--raw"], {
      windowsHide: true,
      shell: process.platform === "win32",
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("gmgn-cli timeout"));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      out += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      err += String(chunk);
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error((err || out || `gmgn-cli exit ${code}`).trim().slice(0, 400)));
        return;
      }
      try {
        resolve(JSON.parse(out));
      } catch {
        reject(new Error("gmgn-cli returned non-JSON"));
      }
    });
  });
}

export function unwrapGmgn(resp: unknown): unknown {
  if (resp && typeof resp === "object" && "data" in resp) {
    return (resp as { data: unknown }).data;
  }
  return resp;
}

export function firstGmgnRow(resp: unknown): Record<string, unknown> {
  const d = unwrapGmgn(resp);
  if (d && typeof d === "object" && Array.isArray((d as { list?: unknown }).list)) {
    const list = (d as { list: unknown[] }).list;
    return list[0] && typeof list[0] === "object" ? (list[0] as Record<string, unknown>) : {};
  }
  if (Array.isArray(d)) {
    return d[0] && typeof d[0] === "object" ? (d[0] as Record<string, unknown>) : {};
  }
  return d && typeof d === "object" ? (d as Record<string, unknown>) : {};
}
