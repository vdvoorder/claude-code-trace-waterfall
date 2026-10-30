import type { Theme, Trace } from '../types'

export const LIVE_FORMAT = 'trace-waterfall/1'
export const LIVE_MAX_BYTES = 1024 * 1024
export const LIVE_INTERVAL = 300

export type LiveEnvironment = {
  os?: string
  localAppData?: string
  xdgStateHome?: string
  home?: string
  terminal?: string
}

export type LiveTarget = { path: string; terminal: string }

export type LivePayload = {
  format: typeof LIVE_FORMAT
  terminal: string
  session: string
  written: number
  theme: Theme
  main: string | null
  traces: Trace[]
}

const TERMINAL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

function folderOf(path: string | undefined): string | null {
  const trimmed = (path ?? '').replace(/[\\/]+$/, '')

  return trimmed === '' ? null : trimmed
}

export function liveTarget(env: LiveEnvironment): LiveTarget | null {
  const terminal = env.terminal ?? ''

  if (!TERMINAL_NAME.test(terminal)) {
    return null
  }

  if (env.os === 'Windows_NT') {
    const local = folderOf(env.localAppData)

    return local === null ? null : { path: `${local}\\trace-waterfall\\live\\${terminal}.json`, terminal }
  }

  const state = env.xdgStateHome?.startsWith('/') ? folderOf(env.xdgStateHome) : null
  const home = folderOf(env.home)
  const base = state ?? (home === null ? null : `${home}/.local/state`)

  return base === null ? null : { path: `${base}/trace-waterfall/live/${terminal}.json`, terminal }
}

export function livePayload(fields: Omit<LivePayload, 'format'>): LivePayload {
  return {
    format: LIVE_FORMAT,
    terminal: fields.terminal,
    session: fields.session,
    written: fields.written,
    theme: fields.theme,
    main: fields.main,
    traces: fields.traces,
  }
}

function withMain(payload: LivePayload): LivePayload {
  return payload.main === null || payload.traces.some(trace => trace.id === payload.main) ? payload : { ...payload, main: null }
}

const encoder = new TextEncoder()

export function byteLength(text: string): number {
  return encoder.encode(text).length
}

function sizeOf(value: unknown): number {
  return byteLength(JSON.stringify(value))
}

function listSize(sizes: number[]): number {
  return sizes.reduce((sum, size) => sum + size, 0) + Math.max(0, sizes.length - 1)
}

function trimSpans(trace: Trace, room: number): Trace | null {
  const shell = sizeOf({ ...trace, spans: [] })
  const sizes = trace.spans.map(sizeOf)
  const oldestFirst = trace.spans
    .map((span, index) => ({ span, index }))
    .filter(({ span }) => span.id !== trace.id)
    .sort((a, b) => a.span.start - b.span.start)
  const dropped = new Set<number>()
  let total = sizes.reduce((sum, size) => sum + size, 0)
  let count = trace.spans.length
  const sizeNow = (): number => shell + total + Math.max(0, count - 1)

  for (const { index } of oldestFirst) {
    if (sizeNow() < room) {
      break
    }

    dropped.add(index)
    total -= sizes[index] ?? 0
    count -= 1
  }

  return sizeNow() < room ? { ...trace, spans: trace.spans.filter((_, index) => !dropped.has(index)) } : null
}

export function fitPayload(payload: LivePayload, limit: number = LIVE_MAX_BYTES): LivePayload {
  const whole = withMain(payload)

  if (sizeOf(whole) < limit) {
    return whole
  }

  const head = sizeOf({ ...whole, traces: [] })
  const sizes = whole.traces.map(sizeOf)
  let first = 0

  while (whole.traces.length - first > 1 && head + listSize(sizes.slice(first)) >= limit) {
    first += 1
  }

  const kept = whole.traces.slice(first)

  if (head + listSize(sizes.slice(first)) < limit) {
    return withMain({ ...whole, traces: kept })
  }

  const oldest = kept[0]
  const trimmed = oldest === undefined ? null : trimSpans(oldest, limit - head)

  return withMain({ ...whole, traces: trimmed === null ? [] : [trimmed] })
}

export function liveText(payload: LivePayload, limit: number = LIVE_MAX_BYTES): string {
  const whole = withMain(payload)
  const text = JSON.stringify(whole)

  return byteLength(text) < limit ? text : JSON.stringify(fitPayload(whole, limit))
}
