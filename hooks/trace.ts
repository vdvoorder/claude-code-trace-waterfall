import type { AgentLink, Span, SpanKind, SpanUsage, Trace } from '../types'

export const MAX_TRACES = 20
export const MAX_SPANS = 3000
export const AGENT_PREFIX = 'agent:'
export const REQUEST_PREFIX = 'request:'

type Price = { input: number; output: number; cacheWrite: number; cacheRead: number }

const PRICES: Record<string, Price> = {
  'fable 5.1': { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 0.25 },
  'mythos 5.1': { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 0.25 },
  'fable 5': { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1 },
  'mythos 5': { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1 },
  'opus 5.5': { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
  'opus 5': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'opus 4.8': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'opus 4.7': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'opus 4.6': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'opus 4.5': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'sonnet 5.5': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.1 },
  'sonnet 5': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  'sonnet 4.6': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'sonnet 4.5': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'haiku 5.5': { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
  'haiku 4.5': { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
}

const LONG_PROMPT_PRICES: Record<string, { over: number; price: Price }> = {
  'haiku 5.5': { over: 100_000, price: { input: 0.5, output: 2.5, cacheWrite: 0.625, cacheRead: 0.05 } },
}

type ModelName = { family: string; version: string }

export function parseModel(id: string): ModelName | null {
  const found = /claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?!\d)/.exec(id)

  if (found === null || found[1] === undefined || found[2] === undefined) {
    return null
  }

  return { family: found[1], version: found[3] === undefined ? found[2] : `${found[2]}.${found[3]}` }
}

export function modelLabel(id: string): string {
  const parsed = parseModel(id)

  if (parsed === null) {
    return id
  }

  return `${parsed.family.charAt(0).toUpperCase()}${parsed.family.slice(1)} ${parsed.version}`
}

export function costOf(model: string, usage: SpanUsage): number | null {
  const parsed = parseModel(model)
  const name = parsed === null ? '' : `${parsed.family} ${parsed.version}`
  const long = LONG_PROMPT_PRICES[name]
  const prompt = usage.input + usage.cacheWrite + usage.cacheRead
  const price = long !== undefined && prompt > long.over ? long.price : PRICES[name]

  if (price === undefined) {
    return null
  }

  return (
    (usage.input * price.input +
      usage.output * price.output +
      usage.cacheWrite * price.cacheWrite +
      usage.cacheRead * price.cacheRead) /
    1e6
  )
}

function oneLine(value: unknown): string {
  if (typeof value !== 'string') {
    return ''
  }

  const trimmed = value.trim()

  return /[\r\n]/.test(trimmed) ? '' : trimmed
}

function pathForms(path: string): string[] {
  const parts = path.replace(/\\/g, '/').split('/').filter(part => part !== '')
  const last = parts[parts.length - 1]
  const parent = parts[parts.length - 2]

  if (last === undefined) {
    return []
  }

  return parent === undefined ? [last] : [`${parent}/${last}`, last]
}

function hostOf(url: string): string {
  return /^[a-z]+:\/\/([^/?#]+)/i.exec(url)?.[1] ?? ''
}

function firstWord(command: string): string {
  return command.split(/\s+/)[0] ?? ''
}

function unique(texts: string[]): string[] {
  return texts.filter((text, index) => text !== '' && texts.indexOf(text) === index)
}

export function describeTool(tool: string, input: Record<string, unknown>): { name: string; details: string[] } {
  if (tool.startsWith('mcp__')) {
    const parts = tool.split('__')

    return { name: parts.slice(2).join('__') || tool, details: unique([parts[1] ?? '']) }
  }

  const text = (key: string): string => oneLine(input[key])

  switch (tool) {
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return { name: tool, details: unique(pathForms(text('file_path') || text('notebook_path'))) }
    case 'Bash':
    case 'PowerShell': {
      const command = text('command')

      return { name: tool, details: unique([text('description'), command, firstWord(command)]) }
    }
    case 'Grep':
    case 'Glob':
      return { name: tool, details: unique([text('pattern')]) }
    case 'WebFetch':
      return { name: tool, details: unique([text('url'), hostOf(text('url'))]) }
    case 'WebSearch':
    case 'ToolSearch':
      return { name: tool, details: unique([text('query')]) }
    case 'Skill':
      return { name: tool, details: unique([text('skill')]) }
    case 'Agent':
    case 'Task':
      return { name: 'Agent', details: unique([text('description'), text('subagent_type')]) }
    case 'Workflow':
      return { name: tool, details: unique([text('name'), text('description')]) }
    default:
      return { name: tool, details: [] }
  }
}

export type NewSpan = {
  id: string
  kind: SpanKind
  name: string
  details: string[]
  start: number
  model?: string | null
  prompt?: string | null
  agentId?: string | null
  pending?: number
}

function makeSpan(fields: NewSpan, parent: string | null, loop: string | null): Span {
  return {
    id: fields.id,
    parent,
    kind: fields.kind,
    name: fields.name,
    details: fields.details,
    loop,
    start: fields.start,
    end: fields.start,
    pending: fields.pending ?? 1,
    isError: false,
    model: fields.model ?? null,
    usage: null,
    cost: null,
    prompt: fields.prompt ?? null,
    agentId: fields.agentId ?? null,
  }
}

export function startRequest(traces: Trace[], turnId: string, prompt: string, at: number): Trace[] {
  const id = REQUEST_PREFIX + turnId
  const root = makeSpan({ id, kind: 'turn', name: 'Request', details: [], start: at, pending: 0 }, null, null)
  const turn = makeSpan({ id: turnId, kind: 'turn', name: 'Turn', details: [], start: at }, id, null)
  const kept = traces.filter(trace => trace.id !== id)

  return [...kept, { id, prompt, start: at, spans: [root, turn] }].slice(-MAX_TRACES)
}

export function continueRequest(traces: Trace[], traceId: string, turnId: string, detail: string, at: number): Trace[] {
  const details = detail === '' ? [] : [detail]

  return addSpan(traces, { trace: traceId, span: traceId }, { id: turnId, kind: 'turn', name: 'Turn', details, start: at }, null)
}

export function latestTrace(traces: Trace[]): Trace | undefined {
  return traces[traces.length - 1]
}

export function findSpan(traces: Trace[], id: string): { trace: Trace; span: Span } | undefined {
  for (let index = traces.length - 1; index >= 0; index -= 1) {
    const trace = traces[index]
    const span = trace?.spans.find(one => one.id === id)

    if (trace !== undefined && span !== undefined) {
      return { trace, span }
    }
  }

  return undefined
}

export function placeOf(
  traces: Trace[],
  links: Record<string, AgentLink>,
  main: AgentLink | null,
  loop: string | null,
): AgentLink | undefined {
  const link = loop === null ? (main ?? undefined) : links[loop]

  if (link !== undefined && traces.some(trace => trace.id === link.trace && trace.spans.some(span => span.id === link.span))) {
    return link
  }

  const latest = latestTrace(traces)

  return latest === undefined ? undefined : { trace: latest.id, span: latest.id }
}

export function addSpan(traces: Trace[], place: AgentLink, fields: NewSpan, loop: string | null): Trace[] {
  return traces.map(trace => {
    if (trace.id !== place.trace || trace.spans.length >= MAX_SPANS || trace.spans.some(one => one.id === fields.id)) {
      return trace
    }

    return { ...trace, spans: [...trace.spans, makeSpan(fields, place.span, loop)] }
  })
}

export function changeSpan(traces: Trace[], id: string, change: (span: Span) => Span): Trace[] {
  const found = findSpan(traces, id)

  if (found === undefined) {
    return traces
  }

  return traces.map(trace =>
    trace.id !== found.trace.id ? trace : { ...trace, spans: trace.spans.map(span => (span.id === id ? change(span) : span)) },
  )
}

export function closeSpan(span: Span, at: number, isError: boolean): Span {
  return {
    ...span,
    pending: Math.max(0, span.pending - 1),
    end: Math.max(span.end, at),
    isError: span.isError || isError,
  }
}

export function closeLoop(trace: Trace, loop: string | null, at: number): Trace {
  return {
    ...trace,
    spans: trace.spans.map(span =>
      span.loop === loop && span.pending > 0 && (span.kind === 'model' || span.kind === 'tool')
        ? { ...span, pending: 0, end: Math.max(span.end, at) }
        : span,
    ),
  }
}

export function completeMain(traces: Trace[], id: string, at: number, isError: boolean): Trace[] {
  return traces.map(trace => {
    if (!trace.spans.some(span => span.id === id)) {
      return trace
    }

    const closed = closeLoop(trace, null, at)

    return {
      ...closed,
      spans: closed.spans.map(span => {
        if (span.id === id) {
          return { ...span, pending: 0, end: Math.max(span.end, at), isError: span.isError || isError }
        }

        if (span.kind === 'agent' && span.agentId === null && span.pending > 0) {
          return { ...span, pending: 0, end: Math.max(span.end, at) }
        }

        return span
      }),
    }
  })
}

export function displayEnd(span: Span, now: number): number {
  return span.pending > 0 ? Math.max(now, span.end, span.start) : span.end
}

export function isLive(trace: Trace): boolean {
  return trace.spans.some(span => span.pending > 0)
}

export type Row = { span: Span; depth: number }

export function rowsOf(trace: Trace): Row[] {
  const children = new Map<string | null, Span[]>()

  for (const span of trace.spans) {
    const parent = span.id === trace.id ? null : span.parent
    const list = children.get(parent) ?? []
    list.push(span)
    children.set(parent, list)
  }

  const rows: Row[] = []
  const seen = new Set<string>()

  const walk = (parent: string | null, depth: number): void => {
    const list = [...(children.get(parent) ?? [])].sort((a, b) => a.start - b.start)

    for (const span of list) {
      if (seen.has(span.id)) {
        continue
      }

      seen.add(span.id)
      rows.push({ span, depth })
      walk(span.id, depth + 1)
    }
  }

  walk(null, 0)

  for (const span of trace.spans) {
    if (!seen.has(span.id)) {
      seen.add(span.id)
      rows.push({ span, depth: 1 })
    }
  }

  return rows
}

export function subtreeOf(trace: Trace, id: string): Span[] {
  const rows = rowsOf(trace)
  const at = rows.findIndex(row => row.span.id === id)
  const head = rows[at]

  if (head === undefined) {
    return []
  }

  const out = [head.span]

  for (const row of rows.slice(at + 1)) {
    if (row.depth <= head.depth) {
      break
    }

    out.push(row.span)
  }

  return out
}

export type Figures = {
  duration: number
  cost: number | null
  tokensIn: number
  tokensOut: number
  modelCalls: number
  toolCalls: number
  errors: number
}

export function isToolCall(span: Span): boolean {
  return span.kind === 'tool' || (span.kind === 'agent' && !span.id.startsWith(AGENT_PREFIX))
}

export function figuresOf(spans: Span[], now: number): Figures {
  const head = spans[0]
  const start = head?.start ?? 0
  let end = start
  let cost: number | null = null
  let tokensIn = 0
  let tokensOut = 0
  let modelCalls = 0
  let toolCalls = 0
  let errors = 0

  for (const span of spans) {
    end = Math.max(end, displayEnd(span, now))

    if (span.cost !== null) {
      cost = (cost ?? 0) + span.cost
    }

    if (span.usage !== null) {
      tokensIn += span.usage.input + span.usage.cacheRead + span.usage.cacheWrite
      tokensOut += span.usage.output
    }

    modelCalls += span.kind === 'model' ? 1 : 0
    toolCalls += isToolCall(span) ? 1 : 0
    errors += span.isError ? 1 : 0
  }

  return { duration: end - start, cost, tokensIn, tokensOut, modelCalls, toolCalls, errors }
}

export function formatDuration(ms: number): string {
  const safe = Math.max(0, ms)

  if (safe < 1000) {
    return `${Math.round(safe)}ms`
  }

  const seconds = safe / 1000

  if (seconds < 10) {
    return `${seconds.toFixed(1)}s`
  }

  const whole = Math.floor(seconds)

  if (whole < 60) {
    return `${whole}s`
  }

  if (whole < 3600) {
    return `${Math.floor(whole / 60)}m ${String(whole % 60).padStart(2, '0')}s`
  }

  return `${Math.floor(whole / 3600)}h ${String(Math.floor((whole % 3600) / 60)).padStart(2, '0')}m`
}

export function formatTick(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`
  }

  if (seconds < 3600) {
    const rest = seconds % 60

    return rest === 0 ? `${seconds / 60}m` : `${Math.floor(seconds / 60)}m ${rest}s`
  }

  const minutes = Math.floor((seconds % 3600) / 60)

  return minutes === 0 ? `${Math.floor(seconds / 3600)}h` : `${Math.floor(seconds / 3600)}h ${minutes}m`
}

export function formatCost(usd: number | null): string {
  if (usd === null) {
    return ''
  }

  if (usd === 0) {
    return '$0'
  }

  if (usd < 0.01) {
    return '<$0.01'
  }

  if (usd < 100) {
    return `$${usd.toFixed(2)}`
  }

  return `$${Math.round(usd)}`
}

export function formatTokens(count: number): string {
  if (count < 1000) {
    return String(count)
  }

  if (count < 1e6) {
    return `${(count / 1e3).toFixed(count < 1e4 ? 1 : 0)}K`
  }

  return `${(count / 1e6).toFixed(1)}M`
}

const DOMAINS = [
  5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240, 300, 450, 600, 900, 1200, 1800, 2700, 3600, 5400, 7200, 10800, 14400,
  21600, 43200, 86400,
]

export function domainOf(extent: number): number {
  const wanted = (extent * 1.1) / 1000

  return (DOMAINS.find(seconds => seconds >= wanted) ?? Math.ceil(wanted / 86400) * 86400) * 1000
}

const STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400]

export function ticksOf(domain: number, cells: number): number[] {
  const seconds = domain / 1000
  const room = Math.max(1, Math.floor(cells / 8))
  const step = STEPS.find(one => seconds / one <= room) ?? seconds
  const ticks: number[] = []

  for (let at = 0; at < seconds; at += step) {
    ticks.push(at)
  }

  return ticks
}

export type Cell = { glyph: string; mode: 'empty' | 'solid' | 'inverse' }

const LEFT_EIGHTHS = ' ▏▎▍▌▋▊▉'

export function barCells(from: number, to: number, cells: number): Cell[] {
  const start = Math.max(0, Math.min(from, cells * 8))
  const end = Math.max(start + 1, Math.min(to, cells * 8))
  const out: Cell[] = []

  for (let cell = 0; cell < cells; cell += 1) {
    const left = Math.max(start, cell * 8)
    const right = Math.min(end, cell * 8 + 8)

    if (right <= left) {
      out.push({ glyph: ' ', mode: 'empty' })
    } else if (left === cell * 8 && right === cell * 8 + 8) {
      out.push({ glyph: '█', mode: 'solid' })
    } else if (left === cell * 8) {
      out.push({ glyph: LEFT_EIGHTHS[right - cell * 8] ?? '█', mode: 'solid' })
    } else if (right === cell * 8 + 8) {
      out.push({ glyph: LEFT_EIGHTHS[left - cell * 8] ?? ' ', mode: 'inverse' })
    } else {
      out.push({ glyph: LEFT_EIGHTHS[Math.max(1, right - left)] ?? '▏', mode: 'solid' })
    }
  }

  return out
}
