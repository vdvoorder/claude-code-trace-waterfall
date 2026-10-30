import os from "os";
import { exec, home, readTextFile, window as herdrWindow } from "herdr";

export const FORMAT = "trace-waterfall/1";

let found = null;

function isWindows() {
  try {
    const platform = herdrWindow()?.platform;
    if (platform) return platform === "windows";
  } catch {}
  return String(os.platform()).startsWith("win");
}

async function findFolder() {
  const windows = isWindows();
  const sep = windows ? "\\" : "/";
  let base = null;
  try {
    const result = windows
      ? await exec("cmd.exe", ["/d", "/c", "echo", "%LOCALAPPDATA%"])
      : await exec("sh", ["-c", 'case "$XDG_STATE_HOME" in /*) printf "%s" "$XDG_STATE_HOME" ;; *) printf "%s" "$HOME/.local/state" ;; esac']);
    const out = result.stdout.trim();
    if (result.code === 0 && out !== "" && !out.includes("%")) base = out.replace(/[\\/]+$/, "");
  } catch {}
  base ??= windows ? `${home()}\\AppData\\Local` : `${home()}/.local/state`;
  return { dir: [base, "trace-waterfall", "live"].join(sep), sep, windows };
}

export function liveFolder() {
  found ??= findFolder();
  return found;
}

export function fileName(terminal) {
  return `${terminal}.json`;
}

export function sameName(path, name, windows) {
  const base = String(path).split(/[\\/]/).pop() ?? "";
  return windows ? base.toLowerCase() === name.toLowerCase() : base === name;
}

const number = (value, fallback = 0) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);
const text = (value) => (typeof value === "string" ? value : "");
const KINDS = new Set(["turn", "agent", "model", "tool"]);

function usageOf(value) {
  if (value === null || typeof value !== "object") return null;
  return { input: number(value.input), output: number(value.output), cacheRead: number(value.cacheRead), cacheWrite: number(value.cacheWrite) };
}

function spanOf(value) {
  if (value === null || typeof value !== "object" || typeof value.id !== "string") return null;
  const start = number(value.start);
  return {
    id: value.id,
    parent: typeof value.parent === "string" ? value.parent : null,
    kind: KINDS.has(value.kind) ? value.kind : "tool",
    name: text(value.name) || "Span",
    details: Array.isArray(value.details) ? value.details.filter((one) => typeof one === "string" && one !== "") : [],
    loop: typeof value.loop === "string" ? value.loop : null,
    start,
    end: number(value.end, start),
    pending: number(value.pending),
    isError: value.isError === true,
    model: typeof value.model === "string" ? value.model : null,
    usage: usageOf(value.usage),
    cost: typeof value.cost === "number" && Number.isFinite(value.cost) ? value.cost : null,
    prompt: typeof value.prompt === "string" ? value.prompt : null,
    agentId: typeof value.agentId === "string" ? value.agentId : null,
  };
}

function traceOf(value) {
  if (value === null || typeof value !== "object" || typeof value.id !== "string" || !Array.isArray(value.spans)) return null;
  const spans = value.spans.map(spanOf).filter((span) => span !== null);
  if (spans.length === 0) return null;
  return { id: value.id, prompt: text(value.prompt), start: number(value.start, spans[0].start), spans };
}

export async function readTrace(folder, terminal) {
  let content;
  try {
    content = await readTextFile(folder.dir + folder.sep + fileName(terminal));
  } catch {
    return { state: "unreadable" };
  }
  if (content === null) return { state: "missing" };
  let doc;
  try {
    doc = JSON.parse(content);
  } catch {
    return { state: "unreadable" };
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return { state: "unreadable" };
  if (doc.format !== FORMAT) return { state: "format", format: String(doc.format ?? "none") };
  if (!Array.isArray(doc.traces)) return { state: "unreadable" };
  const traces = doc.traces.map(traceOf).filter((trace) => trace !== null);
  const main = typeof doc.main === "string" ? doc.main : null;
  return { state: "ok", content, doc: { session: text(doc.session), written: number(doc.written), main, traces } };
}
