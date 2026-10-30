export const PALETTES = {
  dark: { model: "#8B7BFF", tool: "#1FA2B8", error: "#E5504A", neutral: "#7A7A78" },
  light: { model: "#6650E0", tool: "#0086A3", error: "#C8352F", neutral: "#858583" },
};

export const GUTTER = 2;
export const DURATION_WIDTH = 7;
export const COST_WIDTH = 6;
const MIN_TIMELINE = 8;
const MIN_LABEL = 12;
const MAX_LABEL = 34;
const INDENT = 2;
const MAX_INDENT_DEPTH = 4;
const COST_FROM_WIDTH = 56;

export function indentOf(depth) {
  return Math.min(depth, MAX_INDENT_DEPTH) * INDENT;
}

export function layoutOf(width, nameWidth) {
  const hasCost = width >= COST_FROM_WIDTH;
  const numbers = DURATION_WIDTH + (hasCost ? 2 + COST_WIDTH : 0);
  const fixed = GUTTER + 1 + 1 + numbers;
  const wanted = Math.max(MIN_LABEL, nameWidth, Math.min(Math.round(width * 0.36), MAX_LABEL));
  const label = Math.min(wanted, width - fixed - MIN_TIMELINE);
  if (label < nameWidth) return { label: Math.max(nameWidth, width - fixed), timeline: 0, hasCost };
  return { label, timeline: width - fixed - label, hasCost };
}

export function colorOf(span, palette) {
  if (span.isError) return palette.error;
  if (span.kind === "model") return palette.model;
  return span.kind === "tool" ? palette.tool : palette.neutral;
}

export function nameWidthOf(rows) {
  return rows.reduce((widest, row) => Math.max(widest, indentOf(row.depth) + row.span.name.length), 0);
}

export function detailOf(span, depth, width) {
  const used = indentOf(depth) + span.name.length;
  return span.details.find((text) => used + 1 + text.length <= width);
}
