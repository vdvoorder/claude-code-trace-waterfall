export const MAX_TRACES = 20;
export const AGENT_PREFIX = "agent:";

export function displayEnd(span, now) {
  return span.pending > 0 ? Math.max(now, span.end, span.start) : span.end;
}

export function isLive(trace) {
  return trace.spans.some((span) => span.pending > 0);
}

function soleTurnOf(trace) {
  const turns = trace.spans.filter((span) => span.kind === "turn" && span.id !== trace.id);
  return turns.length === 1 ? turns[0] : undefined;
}

export function rowsOf(trace) {
  const sole = soleTurnOf(trace);
  const children = new Map();

  for (const span of trace.spans) {
    if (span.id === sole?.id) continue;
    const parent = span.id === trace.id ? null : span.parent === sole?.id ? trace.id : span.parent;
    const shown =
      span.id === trace.id && sole !== undefined
        ? { ...span, end: Math.max(span.end, sole.end), pending: sole.pending, isError: span.isError || sole.isError }
        : span;
    const list = children.get(parent) ?? [];
    list.push(shown);
    children.set(parent, list);
  }

  const rows = [];
  const seen = new Set();

  const walk = (parent, depth) => {
    const list = [...(children.get(parent) ?? [])].sort((a, b) => a.start - b.start);
    for (const span of list) {
      if (seen.has(span.id)) continue;
      seen.add(span.id);
      rows.push({ span, depth });
      walk(span.id, depth + 1);
    }
  };

  walk(null, 0);

  for (const span of trace.spans) {
    if (!seen.has(span.id) && span.id !== sole?.id) {
      seen.add(span.id);
      rows.push({ span, depth: 1 });
    }
  }

  return rows;
}

export function subtreeOf(trace, id, rows = rowsOf(trace)) {
  const at = rows.findIndex((row) => row.span.id === id);
  const head = rows[at];
  if (head === undefined) return [];
  const out = [head.span];
  for (const row of rows.slice(at + 1)) {
    if (row.depth <= head.depth) break;
    out.push(row.span);
  }
  return out;
}

export function isToolCall(span) {
  return span.kind === "tool" || (span.kind === "agent" && !span.id.startsWith(AGENT_PREFIX));
}

export function figuresOf(spans, now) {
  const head = spans[0];
  const start = head?.start ?? 0;
  let end = start;
  let cost = null;
  let tokensIn = 0;
  let tokensOut = 0;
  let modelCalls = 0;
  let toolCalls = 0;
  let errors = 0;

  for (const span of spans) {
    end = Math.max(end, displayEnd(span, now));
    if (span.cost !== null) cost = (cost ?? 0) + span.cost;
    if (span.usage !== null) {
      tokensIn += span.usage.input + span.usage.cacheRead + span.usage.cacheWrite;
      tokensOut += span.usage.output;
    }
    modelCalls += span.kind === "model" ? 1 : 0;
    toolCalls += isToolCall(span) ? 1 : 0;
    errors += span.isError ? 1 : 0;
  }

  return { duration: end - start, cost, tokensIn, tokensOut, modelCalls, toolCalls, errors };
}

export function formatDuration(ms) {
  const safe = Math.max(0, ms);
  if (safe < 1000) return `${Math.round(safe)}ms`;
  const seconds = safe / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  const whole = Math.floor(seconds);
  if (whole < 60) return `${whole}s`;
  if (whole < 3600) return `${Math.floor(whole / 60)}m ${String(whole % 60).padStart(2, "0")}s`;
  return `${Math.floor(whole / 3600)}h ${String(Math.floor((whole % 3600) / 60)).padStart(2, "0")}m`;
}

export function formatTick(seconds) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) {
    const rest = seconds % 60;
    return rest === 0 ? `${seconds / 60}m` : `${Math.floor(seconds / 60)}m ${rest}s`;
  }
  const minutes = Math.floor((seconds % 3600) / 60);
  return minutes === 0 ? `${Math.floor(seconds / 3600)}h` : `${Math.floor(seconds / 3600)}h ${minutes}m`;
}

export function formatCost(usd) {
  if (usd === null) return "";
  if (usd === 0) return "$0";
  if (usd < 0.01) return "<$0.01";
  if (usd < 100) return `$${usd.toFixed(2)}`;
  return `$${Math.round(usd)}`;
}

export function formatTokens(count) {
  if (count < 1000) return String(count);
  if (count < 1e6) return `${(count / 1e3).toFixed(count < 1e4 ? 1 : 0)}K`;
  return `${(count / 1e6).toFixed(1)}M`;
}

const DOMAINS = [
  5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240, 300, 450, 600, 900, 1200, 1800, 2700, 3600, 5400, 7200, 10800, 14400,
  21600, 43200, 86400,
];

export function domainOf(extent) {
  const wanted = (extent * 1.1) / 1000;
  return (DOMAINS.find((seconds) => seconds >= wanted) ?? Math.ceil(wanted / 86400) * 86400) * 1000;
}

const STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400];

export function ticksOf(domain, cells) {
  const seconds = domain / 1000;
  const room = Math.max(1, Math.floor(cells / 8));
  const step = STEPS.find((one) => seconds / one <= room) ?? seconds;
  const ticks = [];
  for (let at = 0; at < seconds; at += step) ticks.push(at);
  return ticks;
}

export function promptLine(trace) {
  const line = String(trace.prompt ?? "")
    .split(/\r?\n/)
    .map((one) => one.trim())
    .find((one) => one !== "");
  return line === undefined || line.startsWith("<") ? "A request without a typed prompt" : line;
}

export function rowCosts(trace) {
  const parents = new Map(trace.spans.map((span) => [span.id, span.id === trace.id ? null : span.parent]));
  const sums = new Map();
  for (const span of trace.spans) {
    if (span.cost === null) continue;
    let id = span.id;
    const seen = new Set();
    while (id !== null && id !== undefined && !seen.has(id)) {
      seen.add(id);
      sums.set(id, (sums.get(id) ?? 0) + span.cost);
      id = parents.get(id);
    }
  }
  return sums;
}

export function slowestLeaf(spans, now) {
  let best = null;
  for (const span of spans) {
    if (span.kind !== "model" && span.kind !== "tool") continue;
    if (best === null || displayEnd(span, now) - span.start > displayEnd(best, now) - best.start) best = span;
  }
  return best === null ? null : best.id;
}

export function followedIndex(traces) {
  let index = traces.length - 1;
  let latest = -Infinity;
  traces.forEach((trace, at) => {
    for (const span of trace.spans) {
      if (span.start >= latest) {
        latest = span.start;
        index = at;
      }
    }
  });
  return index;
}
