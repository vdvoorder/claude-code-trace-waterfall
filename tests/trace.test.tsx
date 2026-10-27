import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import type { Trace } from '../types'
import {
  addSpan,
  barCells,
  completeMain,
  continueRequest,
  costOf,
  describeTool,
  formatDuration,
  modelLabel,
  rowsOf,
  startRequest,
} from '../hooks/trace'

const PANE = {
  plugin: 'trace-waterfall',
  component: 'Pane',
  requestId: 'trace',
  props: {
    title: 'Trace',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

test('bar ends land on eighths of a cell', async () => {
  const cells = barCells(4, 20, 4).map(cell => `${cell.glyph}${cell.mode}`)

  expect(cells).toEqual(['▌inverse', '█solid', '▌solid', ' empty'])
})

test('a request with one turn draws its calls under the Request row', async () => {
  const rowsAt = (traces: Trace[]): string[] =>
    traces.flatMap(trace => rowsOf(trace).map(row => `${row.span.id} ${row.depth}`))
  const started = startRequest([], 't1', 'Fix the build', 1000)
  const read = addSpan(started, { trace: 'request:t1', span: 't1' }, { id: 'r1', kind: 'tool', name: 'Read', details: [], start: 1200 }, null)
  const failed = completeMain(read, 't1', 5000, true)

  expect(rowsAt(failed)).toEqual(['request:t1 0', 'r1 1'])
  expect(failed.flatMap(trace => rowsOf(trace).slice(0, 1).map(row => [row.span.end, row.span.isError]))).toEqual([[5000, true]])

  const later = continueRequest(failed, 'request:t1', 't2', 'after a background task', 9000)

  expect(rowsAt(later)).toEqual(['request:t1 0', 't1 1', 'r1 2', 't2 1'])
})

test('names, prices and durations', async () => {
  expect(modelLabel('claude-opus-5-5')).toBe('Opus 5.5')
  expect(modelLabel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
  expect(costOf('claude-opus-5-5', { input: 1e6, output: 1e6, cacheRead: 0, cacheWrite: 0 })).toBe(24)
  expect(costOf('some-other-model', { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 })).toBe(null)
  expect(costOf('claude-sonnet-5-5', { input: 0, output: 0, cacheRead: 1e6, cacheWrite: 0 })).toBe(0.1)
  expect(Math.round((costOf('claude-haiku-5-5', { input: 50_000, output: 1e6, cacheRead: 50_000, cacheWrite: 0 }) ?? 0) * 1e4) / 1e4).toBe(0.5055)
  expect(Math.round((costOf('claude-haiku-5-5', { input: 50_000, output: 1e6, cacheRead: 50_001, cacheWrite: 0 }) ?? 0) * 1e4) / 1e4).toBe(2.5275)
  expect(formatDuration(6900)).toBe('6.9s')
  expect(formatDuration(83000)).toBe('1m 23s')
  expect(describeTool('Bash', { command: 'git status', description: 'Show status' }).details).toEqual([
    'Show status',
    'git status',
    'git',
  ])
  expect(describeTool('mcp__fabric__list_items', {})).toEqual({ name: 'list_items', details: ['fabric'] })
})

test('the model can reopen the pane', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))

  const ran = await $.tool.call({ tool: 'mcp__trace-waterfall__open_pane' } as never)

  expect((ran as { result?: unknown }).result).toBe('The Trace pane is open.')
})

test('a running call grows every second with no new event', async ($, on) => {
  const clock = mock.clock(on, { now: 2_000_000 })

  on('command.register', () => ({ value: { command: 'trace-waterfall' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__trace-waterfall__open_pane' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('config.list', () => ({ value: [] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('tool.call', async () => {
    await clock.sleep(60_000)

    return { result: {} }
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'Run the checkout tests', turnId: 'live' })
  await clock.settle()
  void $.tool.call({ tool: 'Bash', tool_use_id: 'b1', command: 'npm test', description: 'Run the checkout tests' })
  await clock.advance(3000)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect(await ui.find({ type: 'Text', text: /running/ })).toBeDefined()
  expect((await ui.find({ key: 'b1' }))?.text).toMatch(/Bash Run the checkout tests.* 3\.0s/)

  await clock.advance(1000)
  expect((await ui.find({ key: 'b1' }))?.text).toMatch(/ 4\.0s/)

  await clock.advance(60_000)
  await ui.unmount()
})

test('a turn draws one row per span, nested, and a press selects a row', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })

  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', async (_, e) => {
    if (e.tool === 'Agent') await clock.sleep(2000)

    return { result: {} }
  })
  on('config.list', () => ({ value: [] }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  const logged: string[] = []
  on('ui.log', (_, e) => {
    logged.push(JSON.stringify(e))

    return { value: undefined }
  })
  on('turn.step', async function* (_, e) {
    await clock.sleep(6400)

    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: {
        model: 'claude-opus-5-5',
        input_tokens: 1000,
        output_tokens: 500,
        cache_read_input_tokens: 100000,
        cache_creation_input_tokens: 2000,
      },
    }
  })

  await $.turn.start({ text: 'Launch the pricing page', turnId: 't1' })
  await clock.advance(500)

  const step = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })

  const drained = (async () => {
    for await (const chunk of step) {
      void chunk
    }
  })()

  await clock.advance(6400)
  await drained
  await $.tool.call({ tool: 'Read', tool_use_id: 'r1', file_path: 'C:/git/app/src/pricing.py' })
  await clock.advance(1000)
  const agentCall = $.tool.call({
    tool: 'Agent',
    tool_use_id: 'ag1',
    description: 'Find the coupon code',
    prompt: 'Find where coupons are handled',
    subagent_type: 'Explore',
  })
  await clock.settle()
  await $.turn.start({ text: 'Find where coupons are handled', turnId: 't2', agentId: 'a1' })
  await clock.settle()
  const inAgent = { agentId: 'a1' }
  await $.tool.call({ tool: 'Grep', tool_use_id: 'g1', pattern: 'coupon', ...inAgent })
  await clock.advance(1999)
  await $.turn.complete({
    answer: 'done',
    durationMs: 2000,
    isAborted: false,
    turnId: 't2',
    agentId: 'a1',
    reason: 'answer',
  })
  await clock.advance(1)
  await agentCall
  await $.turn.complete({ answer: 'done', durationMs: 10000, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(3000)

  const handBack = '<agent-message from="a1">The coupon code is in checkout.py</agent-message>'

  await $.prompt.submit({ text: handBack, wait: false, origin: { kind: 'task-notification' }, isMeta: true })
  await $.turn.start({ text: handBack, turnId: 't3' })
  await clock.advance(1500)
  await $.turn.complete({ answer: 'done', durationMs: 1500, isAborted: false, turnId: 't3', reason: 'answer' })
  await clock.settle()
  expect(logged).toEqual([])

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const rows = (await ui.findAll({ type: 'Button' })).map(found => found.key)

    expect(rows).toEqual(['earlier', 'later', 'request:t1', 't1', 'step:t1:0', 'r1', 'ag1', 'g1', 't3'])
    expect(await ui.find({ type: 'Text', text: /Request 1 of 1/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Launch the pricing page/ })).toBeDefined()
    expect((await ui.find({ key: 'request:t1' }))?.text).toMatch(/Request.* 14s/)
    expect((await ui.find({ key: 't3' }))?.text).toMatch(/Turn after an agent message.* 1\.5s/)
    expect((await ui.find({ key: 'step:t1:0' }))?.text).toMatch(/Model call Opus 5\.5.*6\.4s +\$0\.04/)
    expect((await ui.find({ key: 'r1' }))?.text).toMatch(/Read src\/pricing\.py/)
    expect(await ui.find({ type: 'Text', text: /Whole request/ })).toBeDefined()

    await ui.press({ key: 'r1' })
    expect(await ui.find({ type: 'Text', text: /Selected/ })).toBeDefined()
    await ui.press({ key: 'r1' })
    expect(await ui.find({ type: 'Text', text: /Whole request/ })).toBeDefined()
    await ui.unmount()
  }
})

function startStandIns(on: Parameters<TestBody>[1], opened: string[]): void {
  on('command.register', () => ({ value: { command: 'trace-waterfall' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__trace-waterfall__open_pane' } }))
  on('ui.open', (_, e) => {
    opened.push(e.id)

    return { value: { isPlaced: true } }
  })
  on('config.list', () => ({ value: [] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
}

test('the pane opens when a session starts', async ($, on) => {
  const opened: string[] = []

  mock.clock(on, { now: 1_000 })
  startStandIns(on, opened)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  expect(opened).toEqual(['trace'])
})

test('Open at start off: the pane waits for /trace-waterfall', { options: { start: 'off' } }, async ($, on) => {
  const opened: string[] = []

  mock.clock(on, { now: 1_000 })
  startStandIns(on, opened)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  expect(opened).toEqual([])

  const ran = await $.command.run({
    command: 'trace-waterfall',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })

  expect(opened).toEqual(['trace'])
  expect((ran as { text?: string }).text).toBe('Trace pane opened.')
})

test('an agent started inside a subagent is drawn under it, and a failed agent call counts as an error', async ($, on) => {
  const clock = mock.clock(on, { now: 3_000_000 })
  const runs: Record<string, number> = { ag1: 8000, ag2: 3000 }

  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('config.list', () => ({ value: [] }))
  on('tool.call', async (_, e) => {
    if (e.tool !== 'Agent') return { result: {} }

    await clock.sleep(runs[e.tool_use_id ?? ''] ?? 0)

    return e.tool_use_id === 'ag2' ? { result: 'The agent stopped', isError: true } : { result: {} }
  })

  await $.turn.start({ text: 'Audit the checkout', turnId: 't1' })
  const outer = $.tool.call({
    tool: 'Agent',
    tool_use_id: 'ag1',
    description: 'Audit the checkout',
    prompt: 'Audit the checkout code',
    subagent_type: 'general-purpose',
  })
  await clock.settle()
  await $.turn.start({ text: 'Audit the checkout code', turnId: 't2', agentId: 'a1' })
  await clock.advance(500)
  const inner = $.tool.call({
    tool: 'Agent',
    tool_use_id: 'ag2',
    description: 'Find the coupons',
    prompt: 'Find the coupon code',
    subagent_type: 'Explore',
    agentId: 'a1',
  })
  await clock.settle()
  await $.turn.start({ text: 'Find the coupon code', turnId: 't3', agentId: 'a2' })
  await $.tool.call({ tool: 'Grep', tool_use_id: 'g2', pattern: 'coupon', agentId: 'a2' })
  await clock.advance(2999)
  await $.turn.complete({ answer: 'stopped', durationMs: 3000, isAborted: false, turnId: 't3', agentId: 'a2', reason: 'answer' })
  await clock.advance(1)
  await inner
  await clock.advance(4000)
  await $.turn.complete({ answer: 'done', durationMs: 7500, isAborted: false, turnId: 't2', agentId: 'a1', reason: 'answer' })
  await clock.advance(500)
  await outer
  await $.turn.complete({ answer: 'done', durationMs: 8000, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const rows = (await ui.findAll({ type: 'Button' })).map(found => found.key)

  expect(rows).toEqual(['earlier', 'later', 'request:t1', 'ag1', 'ag2', 'g2'])
  expect((await ui.find({ key: 'ag2' }))?.text).toMatch(/3\.0s/)
  expect((await ui.find({ key: 'ag1' }))?.text).toMatch(/8\.0s/)
  expect(await ui.find({ type: 'Text', text: /Errors +1/ })).toBeDefined()
  await ui.unmount()
})
