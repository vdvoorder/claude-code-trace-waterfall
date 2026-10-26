import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, TurnStepResult } from 'claude-code'

import type { AgentLink, Theme, Trace } from '../types'
import { chartOf, INK_COLOR, NOW_COLOR, PALETTES } from './draw'
import type { Palette, Run } from './draw'
import {
  AGENT_PREFIX,
  addSpan,
  changeSpan,
  closeLoop,
  closeSpan,
  completeMain,
  continueRequest,
  costOf,
  describeTool,
  figuresOf,
  findSpan,
  formatCost,
  formatDuration,
  formatTokens,
  isLive,
  latestTrace,
  modelLabel,
  placeOf,
  REQUEST_PREFIX,
  startRequest,
  subtreeOf,
} from './trace'
import type { Figures, NewSpan } from './trace'

const PLUGIN = 'trace-waterfall'
const PANE = 'trace'
const COMMAND = 'trace-waterfall'
const TITLE = 'Trace'
const OPEN_TOOL = 'open_pane'
const AGENT_TOOLS = /^(Agent|Task|Workflow)$/
const OTHER_TOOLS = /^(?!(Agent|Task|Workflow)$)/

const traces = atom({ plugin: 'trace-waterfall', key: 'traces' } as const, [])
const agents = atom({ plugin: 'trace-waterfall', key: 'agents' } as const, {})
const main = atom({ plugin: 'trace-waterfall', key: 'main' } as const, null)
const view = atom({ plugin: 'trace-waterfall', key: 'view' } as const, null)
const selected = atom({ plugin: 'trace-waterfall', key: 'selected' } as const, null)
const now = atom({ plugin: 'trace-waterfall', key: 'now' } as const, 0)
const theme = atom({ plugin: 'trace-waterfall', key: 'theme' } as const, 'dark')

const REQUEST_ORIGINS = new Set(['composer', 'bridge', 'sdk', 'scheduled-trigger'])

type Arrival = { isRequest: boolean; text: string; detail: string; agentId: string | null }

let queue: Promise<unknown> = Promise.resolve()
let upcoming: Arrival | null = null
const reported = new Set<string>()

function arrivalOf(kind: string | null, text: string): Arrival {
  const agentId = /<agent-message from="([^"]+)"/.exec(text)?.[1] ?? null

  if (kind === null ? !text.trimStart().startsWith('<') : REQUEST_ORIGINS.has(kind)) {
    return { isRequest: true, text, detail: '', agentId: null }
  }

  if (agentId !== null || kind === 'peer' || kind === 'peer-send-message' || kind === 'coordinator') {
    return { isRequest: false, text, detail: 'after an agent message', agentId }
  }

  if (kind === 'task-notification') {
    return { isRequest: false, text, detail: 'after a background task', agentId }
  }

  return { isRequest: false, text, detail: 'without a typed prompt', agentId }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function inOrder($: EngineInterface, label: string, job: () => Promise<unknown>): Promise<void> {
  const run = queue.then(job).then(
    () => undefined,
    error => {
      if (!reported.has(label)) {
        reported.add(label)
        $.ui.log(`${PLUGIN}: ${label} failed: ${reasonOf(error).replace(/\s+/g, ' ').slice(0, 300)}`)
      }
    },
  )
  queue = run

  return run
}

function stamp($: EngineInterface): Promise<number> {
  return $.clock.now().catch(() => Date.now())
}

function toTheme(value: unknown): Theme {
  return String(value).startsWith('light') ? 'light' : 'dark'
}

async function refreshTheme($: EngineInterface): Promise<void> {
  const row = (await $.config.list()).find(one => one.key === 'theme')
  const wanted = toTheme(row?.value)

  if ((await read($, theme)) !== wanted) {
    await update($, theme, () => wanted)
  }
}

async function startMainTurn($: EngineInterface, turnId: string, text: string, arrival: Arrival, at: number): Promise<void> {
  const held = await read($, traces)
  const links = await read($, agents)
  const latest = latestTrace(held)

  if (arrival.isRequest || latest === undefined) {
    await update($, traces, current => startRequest(current, turnId, arrival.text || text, at))
    await update($, main, () => ({ trace: REQUEST_PREFIX + turnId, span: turnId }))

    return
  }

  const owner = arrival.agentId === null ? undefined : links[arrival.agentId]?.trace
  const traceId = owner !== undefined && held.some(trace => trace.id === owner) ? owner : latest.id

  await update($, traces, current => continueRequest(current, traceId, turnId, arrival.detail, at))
  await update($, main, () => ({ trace: traceId, span: turnId }))
}

async function openSpan($: EngineInterface, loop: string | null, fields: NewSpan): Promise<void> {
  const links = await read($, agents)
  const current = await read($, main)

  await update($, traces, held => {
    const place = placeOf(held, links, current, loop)

    return place === undefined ? held : addSpan(held, place, fields, loop)
  })
}

async function endSpan($: EngineInterface, id: string, at: number, isError: boolean): Promise<void> {
  await update($, traces, held => changeSpan(held, id, span => closeSpan(span, at, isError)))
}

async function endStep($: EngineInterface, id: string, at: number, result: TurnStepResult | undefined): Promise<void> {
  await update($, traces, held =>
    changeSpan(held, id, span => {
      const closed = closeSpan(span, at, false)
      const usage = result?.usage

      if (usage === null || usage === undefined) {
        return closed
      }

      const counts = {
        input: usage.input_tokens,
        output: usage.output_tokens,
        cacheRead: usage.cache_read_input_tokens,
        cacheWrite: usage.cache_creation_input_tokens,
      }

      return {
        ...closed,
        model: usage.model,
        details: [modelLabel(usage.model)],
        usage: counts,
        cost: costOf(usage.model, counts),
      }
    }),
  )
}

function linkedSpans(links: Record<string, AgentLink>): Set<string> {
  return new Set(Object.values(links).map(link => link.span))
}

async function startAgentTurn($: EngineInterface, agentId: string, prompt: string, at: number): Promise<void> {
  const links = await read($, agents)
  let link = links[agentId]

  if (link === undefined) {
    const held = await read($, traces)
    const taken = linkedSpans(links)

    for (let index = held.length - 1; index >= 0 && link === undefined; index -= 1) {
      const trace = held[index]
      const match = trace?.spans.find(
        span => span.kind === 'agent' && span.prompt !== null && span.prompt === prompt && !taken.has(span.id),
      )

      if (trace !== undefined && match !== undefined) {
        link = { trace: trace.id, span: match.id }
      }
    }
  }

  if (link === undefined) {
    const place = placeOf(await read($, traces), links, await read($, main), null)

    if (place === undefined) {
      return
    }

    const id = AGENT_PREFIX + agentId
    link = { trace: place.trace, span: id }
    await update($, traces, current =>
      addSpan(current, place, { id, kind: 'agent', name: 'Agent', details: [], start: at, agentId, pending: 0 }, null),
    )
  }

  const found = link

  await update($, agents, current => ({ ...current, [agentId]: found }))
  await update($, traces, held =>
    changeSpan(held, found.span, span => ({ ...span, agentId, pending: span.pending + 1, end: Math.max(span.end, at) })),
  )
}

async function linkAgent(
  $: EngineInterface,
  agentId: string,
  toolUseId: string,
  description: string,
  subagentType: string,
  model: string,
  at: number,
): Promise<void> {
  if ((await read($, agents))[agentId] !== undefined) {
    return
  }

  const held = await read($, traces)
  const found = findSpan(held, toolUseId)

  if (found === undefined) {
    return
  }

  if (found.span.kind === 'agent' && found.span.agentId === null) {
    await update($, agents, current => ({ ...current, [agentId]: { trace: found.trace.id, span: found.span.id } }))
    await update($, traces, current => changeSpan(current, found.span.id, span => ({ ...span, agentId, model })))

    return
  }

  const id = AGENT_PREFIX + agentId
  const details = [description, subagentType].filter(text => text !== '')

  await update($, traces, current =>
    addSpan(current, { trace: found.trace.id, span: found.span.id }, { id, kind: 'agent', name: 'Agent', details, start: at, model, agentId, pending: 0 }, null),
  )
  await update($, agents, current => ({ ...current, [agentId]: { trace: found.trace.id, span: id } }))
}

async function completeAgent($: EngineInterface, agentId: string, at: number): Promise<void> {
  const link = (await read($, agents))[agentId]

  if (link === undefined) {
    return
  }

  await update($, traces, held =>
    changeSpan(
      held.map(trace => (trace.id === link.trace ? closeLoop(trace, agentId, at) : trace)),
      link.span,
      span => closeSpan(span, at, false),
    ),
  )
}

async function tick($: EngineInterface): Promise<void> {
  if (!(await read($, traces)).some(isLive)) {
    return
  }

  const at = await stamp($)
  await update($, now, () => at)
}

function followedIndex(list: Trace[], current: AgentLink | null): number {
  const found = current === null ? -1 : list.findIndex(trace => trace.id === current.trace)

  return found < 0 ? list.length - 1 : found
}

async function moveView($: EngineInterface, step: number): Promise<void> {
  const list = await read($, traces)
  const followed = followedIndex(list, await read($, main))

  await update($, view, current => {
    const found = current === null ? followed : list.findIndex(trace => trace.id === current)
    const target = Math.min(list.length - 1, Math.max(0, (found < 0 ? followed : found) + step))

    return target === followed ? null : (list[target]?.id ?? null)
  })
  await update($, selected, () => null)
}

function promptLine(trace: Trace): string {
  const line = trace.prompt
    .split(/\r?\n/)
    .map(one => one.trim())
    .find(one => one !== '')

  return line === undefined || line.startsWith('<') ? 'A request without a typed prompt' : line
}

type Item = { label: string; value: string; width: number; swatch?: string }

function itemsOf(figures: Figures, palette: Palette): Item[] {
  return [
    { label: 'Duration', value: formatDuration(figures.duration), width: 7 },
    { label: 'Cost', value: formatCost(figures.cost) || 'none', width: 6 },
    { label: 'Tokens in', value: formatTokens(figures.tokensIn), width: 6 },
    { label: 'out', value: formatTokens(figures.tokensOut), width: 6 },
    { label: 'Model calls', value: String(figures.modelCalls), width: 4, swatch: palette.model },
    { label: 'Tool calls', value: String(figures.toolCalls), width: 4, swatch: palette.tool },
    { label: 'Errors', value: String(figures.errors), width: 3, swatch: palette.error },
  ]
}

export const register: Register = (on, options) => {
  const opensAtStart = options?.start !== 'off'

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Show where the time of each request goes, as a waterfall in a side pane',
    })
    await $.tool.register({
      name: OPEN_TOOL,
      description:
        'Opens the Trace pane beside the chat: a live waterfall of where the time of each request goes. Call it when the person asks to see, show or reopen the trace, the waterfall or the Gantt pane.',
    })
    await refreshTheme($).catch(() => undefined)
    $.clock.every(1000, () => {
      void tick($).catch(() => undefined)
    })
    if (opensAtStart) void $.ui.open({ id: PANE, title: TITLE })

    return next(e)
  })

  on('command.run', { command: COMMAND }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: TITLE })

    return { text: opened.isPlaced ? 'Trace pane opened.' : `The trace pane waits: ${opened.reason}` }
  })

  on('config.set', { key: 'theme' }, async ($, e, next) => {
    const changed = await next(e)

    if (changed.deny === undefined) {
      void inOrder($, 'storing the theme', () => update($, theme, () => toTheme(changed.value)))
    }

    return changed
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await inOrder($, 'clearing the traces', async () => {
        await update($, traces, () => [])
        await update($, agents, () => ({}))
        await update($, main, () => null)
        await update($, view, () => null)
        await update($, selected, () => null)
      })
    }

    return next(e)
  })

  on('prompt.submit', ($, e, next) => {
    if (e.turnId === undefined) {
      const typed = e.command === undefined ? e.text : `/${e.command.name} ${e.command.args}`.trim()
      upcoming = arrivalOf(e.origin.kind, typed)
    }

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    const at = await stamp($)
    const agentId = e.agentId

    if (agentId === undefined) {
      const arrival = upcoming ?? arrivalOf(null, e.text)
      upcoming = null
      void inOrder($, 'starting a turn', () => startMainTurn($, e.turnId, e.text, arrival, at))
      void inOrder($, 'reading the theme', () => refreshTheme($))
    } else {
      void inOrder($, 'starting an agent turn', () => startAgentTurn($, agentId, e.text, at))
    }

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const at = await stamp($)
    const id = `step:${e.turnId}:${e.index}`
    const loop = e.agentId ?? null
    let result: TurnStepResult | undefined

    void inOrder($, 'starting a model call', () =>
      openSpan($, loop, { id, kind: 'model', name: 'Model call', details: [modelLabel(e.model)], start: at, model: e.model }),
    )

    try {
      result = yield* next(e)

      return result
    } finally {
      const end = await stamp($)
      void inOrder($, 'ending a model call', () => endStep($, id, end, result))
    }
  })

  on('turn.complete', async ($, e, next) => {
    const at = await stamp($)
    const agentId = e.agentId

    if (agentId === undefined) {
      const isError = e.reason === 'error' || e.reason === 'refusal'
      void inOrder($, 'ending a turn', () => update($, traces, held => completeMain(held, e.turnId, at, isError)))
    } else {
      void inOrder($, 'ending an agent turn', () => completeAgent($, agentId, at))
    }

    return next(e)
  })

  on('tool.call', { tool: /^mcp__trace-waterfall__open_pane$/ }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: TITLE })

    return { result: opened.isPlaced ? 'The Trace pane is open.' : `The Trace pane waits: ${opened.reason}` }
  })

  on('tool.call', { tool: OTHER_TOOLS }, async ($, e, next) => {
    const at = await stamp($)
    const id = e.tool_use_id ?? `tool:${String(e.tool)}:${at}`
    const { name, details } = describeTool(String(e.tool), e as unknown as Record<string, unknown>)
    let isError = true

    void inOrder($, 'starting a tool call', () => openSpan($, e.agentId ?? null, { id, kind: 'tool', name, details, start: at }))

    try {
      const ran = await next(e)
      isError = ran.deny !== undefined || ran.isError === true

      return ran
    } finally {
      const end = await stamp($)
      void inOrder($, 'ending a tool call', () => endSpan($, id, end, isError))
    }
  })

  on('tool.call', { tool: AGENT_TOOLS }, async ($, e, next) => {
    const at = await stamp($)
    const input = e as unknown as Record<string, unknown>
    const id = e.tool_use_id ?? `tool:${String(e.tool)}:${at}`
    const { name, details } = describeTool(String(e.tool), input)
    const prompt = typeof input.prompt === 'string' ? input.prompt : null
    const kind = e.tool === 'Workflow' ? 'tool' : 'agent'
    let isError = true

    void inOrder($, 'starting an agent call', () => openSpan($, e.agentId ?? null, { id, kind, name, details, start: at, prompt }))

    try {
      const ran = await next(e)
      isError = ran.deny !== undefined || ran.isError === true

      return ran
    } finally {
      const end = await stamp($)
      void inOrder($, 'ending an agent call', () => endSpan($, id, end, isError))
    }
  })

  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)

    if (spawned.deny === undefined && spawned.agentId !== undefined) {
      const agentId = spawned.agentId
      const at = await stamp($)

      void inOrder($, 'linking an agent', () =>
        linkAgent($, agentId, e.tool_use_id, e.description, e.subagentType, spawned.model, at),
      )
    }

    return spawned
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)

    const textOf = (run: Run) => (
      <Text color={run.color} inverse={run.inverse} dimColor={run.dim} bold={run.bold}>
        {run.text}
      </Text>
    )

    try {
      const held = await read($, traces)

      if (held.length === 0) {
        return <Text dimColor>No request has run yet in this session.</Text>
      }

      const viewed = await read($, view)
      const found = viewed === null ? -1 : held.findIndex(trace => trace.id === viewed)
      const index = found < 0 ? followedIndex(held, await read($, main)) : found
      const trace = held[index]

      if (trace === undefined) {
        return <Text dimColor>No request has run yet in this session.</Text>
      }

      const live = isLive(trace)
      const at = live ? await read($, now) : 0
      const palette = PALETTES[await read($, theme)]
      const chosen = await read($, selected)
      const selectedId = chosen !== null && trace.spans.some(span => span.id === chosen) ? chosen : null
      const scope = selectedId === null ? trace.spans : subtreeOf(trace, selectedId)
      const figures = figuresOf(scope, at)
      const chart = chartOf(trace, at, Math.max(24, e.props.bodyColumns), palette, selectedId)
      const isFirst = index === 0
      const isLast = index === held.length - 1

      return (
        <Box flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between">
            <Text bold>
              {`Request ${index + 1} of ${held.length}`}
              {live ? <Text color={NOW_COLOR}> running</Text> : ''}
            </Text>
            <Box flexDirection="row" columnGap={1}>
              <Button
                key="earlier"
                label="◀ Earlier"
                dimColor={isFirst || undefined}
                onPress={() => (isFirst ? undefined : moveView($, -1))}
              />
              <Button
                key="later"
                label="Later ▶"
                dimColor={isLast || undefined}
                onPress={() => (isLast ? undefined : moveView($, 1))}
              />
            </Box>
          </Box>
          <Text dimColor>{promptLine(trace)}</Text>
          <Box flexDirection="row" flexWrap="wrap" columnGap={3}>
            <Text bold>{(selectedId === null ? 'Whole request' : 'Selected').padEnd(13)}</Text>
            {itemsOf(figures, palette).map(item => (
              <Text>
                {item.swatch === undefined ? '' : <Text color={item.swatch}>■ </Text>}
                <Text dimColor>{`${item.label} `}</Text>
                {item.value.padStart(item.width)}
              </Text>
            ))}
          </Box>
          <Text> </Text>
          <Text>{chart.axis.map(textOf)}</Text>
          {chart.rows.map(row => (
            <Button
              key={row.id}
              plain
              onPress={() => update($, selected, current => (current === row.id ? null : row.id))}
            >
              {row.runs.map(textOf)}
            </Button>
          ))}
        </Box>
      )
    } catch (error) {
      return <Text color={INK_COLOR}>{`The trace could not be drawn: ${reasonOf(error).replace(/\s+/g, ' ').slice(0, 300)}`}</Text>
    }
  })
}
