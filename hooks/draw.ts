import type { Span, Theme, Trace } from '../types'
import {
  barCells,
  displayEnd,
  domainOf,
  formatCost,
  formatDuration,
  formatTick,
  isLive,
  rowsOf,
  ticksOf,
} from './trace'

export type Run = { text: string; color?: string; inverse?: boolean; dim?: boolean; bold?: boolean }

export type ChartRow = { id: string; runs: Run[] }

export type Chart = { axis: Run[]; rows: ChartRow[] }

export type Palette = { model: string; tool: string; error: string; neutral: string }

export const PALETTES: Record<Theme, Palette> = {
  dark: { model: '#8B7BFF', tool: '#1FA2B8', error: '#E5504A', neutral: '#7A7A78' },
  light: { model: '#6650E0', tool: '#0086A3', error: '#C8352F', neutral: '#858583' },
}

export const GRID_COLOR = 'subtle'
export const NOW_COLOR = 'suggestion'
export const INK_COLOR = 'text'

const GUTTER = 2
const DURATION_WIDTH = 7
const COST_WIDTH = 6
const MIN_TIMELINE = 8
const MIN_LABEL = 12
const MAX_LABEL = 34
const INDENT = 2
const MAX_INDENT_DEPTH = 4
const COST_FROM_WIDTH = 56

export type Layout = { label: number; timeline: number; hasCost: boolean }

export function indentOf(depth: number): number {
  return Math.min(depth, MAX_INDENT_DEPTH) * INDENT
}

export function layoutOf(width: number, nameWidth: number): Layout {
  const hasCost = width >= COST_FROM_WIDTH
  const numbers = DURATION_WIDTH + (hasCost ? 2 + COST_WIDTH : 0)
  const fixed = GUTTER + 1 + 1 + numbers
  const wanted = Math.max(MIN_LABEL, nameWidth, Math.min(Math.round(width * 0.36), MAX_LABEL))
  const label = Math.min(wanted, width - fixed - MIN_TIMELINE)

  if (label < nameWidth) {
    return { label: Math.max(nameWidth, width - fixed), timeline: 0, hasCost }
  }

  return { label, timeline: width - fixed - label, hasCost }
}

export function colorOf(span: Span, palette: Palette): string {
  if (span.isError) {
    return palette.error
  }

  if (span.kind === 'model') {
    return palette.model
  }

  return span.kind === 'tool' ? palette.tool : palette.neutral
}

function sameStyle(a: Run, b: Run): boolean {
  return a.color === b.color && a.inverse === b.inverse && a.dim === b.dim && a.bold === b.bold
}

export function merged(runs: Run[]): Run[] {
  const out: Run[] = []

  for (const run of runs) {
    const last = out[out.length - 1]

    if (run.text === '') {
      continue
    }

    if (last !== undefined && sameStyle(last, run)) {
      out[out.length - 1] = { ...last, text: last.text + run.text }
    } else {
      out.push({ ...run })
    }
  }

  return out
}

function labelRuns(span: Span, depth: number, width: number, isSelected: boolean): Run[] {
  const indent = ' '.repeat(indentOf(depth))
  const used = indent.length + span.name.length
  const detail = span.details.find(text => used + 1 + text.length <= width)
  const pad = width - used - (detail === undefined ? 0 : detail.length + 1)

  return [
    { text: indent },
    { text: span.name, bold: isSelected || undefined },
    { text: detail === undefined ? '' : ` ${detail}`, dim: true },
    { text: ' '.repeat(Math.max(0, pad)) },
  ]
}

function slowestLeaf(spans: Span[], now: number): string | null {
  let best: Span | null = null

  for (const span of spans) {
    if (span.kind !== 'model' && span.kind !== 'tool') {
      continue
    }

    if (best === null || displayEnd(span, now) - span.start > displayEnd(best, now) - best.start) {
      best = span
    }
  }

  return best === null ? null : best.id
}

export function rowCosts(trace: Trace): Map<string, number> {
  const parents = new Map(trace.spans.map(span => [span.id, span.id === trace.id ? null : span.parent]))
  const sums = new Map<string, number>()

  for (const span of trace.spans) {
    if (span.cost === null) {
      continue
    }

    let id: string | null | undefined = span.id
    const seen = new Set<string>()

    while (id !== null && id !== undefined && !seen.has(id)) {
      seen.add(id)
      sums.set(id, (sums.get(id) ?? 0) + span.cost)
      id = parents.get(id)
    }
  }

  return sums
}

export function nameWidthOf(trace: Trace): number {
  return rowsOf(trace).reduce((widest, row) => Math.max(widest, indentOf(row.depth) + row.span.name.length), 0)
}

export function chartOf(trace: Trace, now: number, width: number, palette: Palette, selected: string | null): Chart {
  const rows = rowsOf(trace)
  const layout = layoutOf(width, nameWidthOf(trace))
  const live = isLive(trace)
  const last = Math.max(trace.start, ...trace.spans.map(span => displayEnd(span, now)))
  const extent = Math.max(1000, last - trace.start)
  const domain = domainOf(extent)
  const cells = layout.timeline
  const ticks = ticksOf(domain, cells)
  const column = (at: number): number => Math.floor(((at - trace.start) / domain) * cells)
  const eighth = (at: number): number => Math.round(((at - trace.start) / domain) * cells * 8)
  const gridColumns = new Set(ticks.filter(tick => tick > 0).map(tick => Math.floor(((tick * 1000) / domain) * cells)))
  const nowColumn = live ? column(now) : -1
  const slowest = slowestLeaf(trace.spans, now)
  const costs = rowCosts(trace)

  const axisLine = Array.from({ length: cells }, () => ' ')
  let free = 0

  for (const tick of ticks) {
    const at = Math.floor(((tick * 1000) / domain) * cells)
    const text = formatTick(tick)

    if (at >= free && at + text.length <= cells) {
      text.split('').forEach((char, index) => {
        axisLine[at + index] = char
      })
      free = at + text.length + 1
    }
  }

  const heads = 'time'.padStart(DURATION_WIDTH) + (layout.hasCost ? '  ' + 'cost'.padStart(COST_WIDTH) : '')
  const axis = merged([
    { text: ' '.repeat(GUTTER + layout.label + 1) },
    { text: cells > 0 ? axisLine.join('') + ' ' : '', dim: true },
    { text: heads, dim: true },
  ])

  const chartRows = rows.map(({ span, depth }) => {
    const isSelected = span.id === selected
    const color = colorOf(span, palette)
    const end = span.id === trace.id ? last : displayEnd(span, now)
    const runs: Run[] = isSelected ? [{ text: '▌', color: INK_COLOR }, { text: ' ' }] : [{ text: '  ' }]

    runs.push(...labelRuns(span, depth, layout.label, isSelected), { text: ' ' })

    if (cells > 0) {
      barCells(eighth(span.start), eighth(end), cells).forEach((cell, index) => {
        if (cell.mode === 'solid') {
          runs.push({ text: cell.glyph, color })
        } else if (cell.mode === 'inverse') {
          runs.push({ text: cell.glyph, color, inverse: true })
        } else if (index === nowColumn) {
          runs.push({ text: '│', color: NOW_COLOR })
        } else if (gridColumns.has(index)) {
          runs.push({ text: '┊', color: GRID_COLOR })
        } else {
          runs.push({ text: ' ' })
        }
      })
      runs.push({ text: ' ' })
    }

    runs.push({ text: formatDuration(end - span.start).padStart(DURATION_WIDTH), bold: span.id === slowest || undefined })

    if (layout.hasCost) {
      runs.push({ text: '  ' + formatCost(costs.get(span.id) ?? null).padStart(COST_WIDTH) })
    }

    return { id: span.id, runs: merged(runs) }
  })

  return { axis, rows: chartRows }
}
