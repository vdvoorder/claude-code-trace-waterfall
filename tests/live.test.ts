import { expect, mock, test } from 'claude-code/testing'
import type { MockClock, TestBody } from 'claude-code/testing'

import type { Trace } from '../types'
import { byteLength, fitPayload, LIVE_MAX_BYTES, livePayload, liveTarget, liveText } from '../hooks/live'
import type { LivePayload } from '../hooks/live'
import { addSpan, startRequest } from '../hooks/trace'

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

const HERDR_ON_WINDOWS = { OS: 'Windows_NT', LOCALAPPDATA: 'C:\\Users\\ruben\\AppData\\Local', HC_TERMINAL_ID: 't9' }

type Written = { path: string; at: number; file: LivePayload }

function withCalls(traces: Trace[], turnId: string, at: number, calls: number, detail: string): Trace[] {
  let out = startRequest(traces, turnId, `Request ${turnId}`, at)

  for (let index = 0; index < calls; index += 1) {
    out = addSpan(
      out,
      { trace: `request:${turnId}`, span: turnId },
      { id: `${turnId}-${index}`, kind: 'tool', name: 'Read', details: [detail], start: at + 10 + index },
      null,
    )
  }

  return out
}

function payloadOf(traces: Trace[], main: string | null = null): LivePayload {
  return livePayload({ terminal: 't9', session: 's1', written: 1_793_380_000_000, theme: 'dark', main, traces })
}

function spanIds(payload: LivePayload): string[][] {
  return payload.traces.map(trace => trace.spans.map(span => span.id))
}

function standIns(
  on: Parameters<TestBody>[1],
  session: { id: string },
  write: (path: string, text: string) => void,
): void {
  on('command.register', () => ({ value: { command: 'trace-waterfall' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__trace-waterfall__open_pane' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('config.list', () => ({ value: [] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('session.id', () => ({ value: session.id }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('fs.write', (_, e) => {
    write(e.path, e.text)

    return { value: undefined }
  })
}

function recorder(clock: MockClock, writes: Written[]): (path: string, text: string) => void {
  return (path, text) => {
    writes.push({ path, at: clock.now(), file: JSON.parse(text) as LivePayload })
  }
}

test('the live file is under LOCALAPPDATA on Windows and under the XDG state folder elsewhere', async () => {
  expect(liveTarget({ os: 'Windows_NT', localAppData: 'C:\\Users\\ruben\\AppData\\Local\\', home: 'C:\\Users\\ruben', terminal: 't9' })).toEqual({
    path: 'C:\\Users\\ruben\\AppData\\Local\\trace-waterfall\\live\\t9.json',
    terminal: 't9',
  })
  expect(liveTarget({ xdgStateHome: '/home/ruben/.state/', home: '/home/ruben', terminal: 't9' })?.path).toBe(
    '/home/ruben/.state/trace-waterfall/live/t9.json',
  )
  expect(liveTarget({ home: '/Users/ruben', terminal: 't9' })?.path).toBe('/Users/ruben/.local/state/trace-waterfall/live/t9.json')
  expect(liveTarget({ xdgStateHome: 'state', home: '/home/ruben', terminal: 't9' })?.path).toBe(
    '/home/ruben/.local/state/trace-waterfall/live/t9.json',
  )
})

test('without a Herdr terminal there is no live file', async () => {
  expect(liveTarget({ os: 'Windows_NT', localAppData: 'C:\\Users\\ruben\\AppData\\Local' })).toBeNull()
  expect(liveTarget({ home: '/home/ruben', terminal: '' })).toBeNull()
  expect(liveTarget({ home: '/home/ruben', terminal: '../t9' })).toBeNull()
  expect(liveTarget({ home: '/home/ruben', terminal: 't9/x' })).toBeNull()
  expect(liveTarget({ os: 'Windows_NT', home: 'C:\\Users\\ruben', terminal: 't9' })).toBeNull()
  expect(liveTarget({ terminal: 't9' })).toBeNull()
})

test('the live file holds the format, the terminal, the session, the time, the theme, the followed request and the traces', async () => {
  const traces = withCalls([], 't1', 1_793_380_000_000, 1, 'build.py')
  const fields = { terminal: 't9', session: 's1', written: 1_793_380_000_500, theme: 'light', traces } as const
  const file = JSON.parse(liveText(livePayload({ ...fields, main: 'request:t1' })))

  expect(Object.keys(file)).toEqual(['format', 'terminal', 'session', 'written', 'theme', 'main', 'traces'])
  expect(file).toEqual({ format: 'trace-waterfall/1', ...fields, main: 'request:t1' })
  expect(JSON.parse(liveText(livePayload({ ...fields, main: 'request:gone' }))).main).toBeNull()
  expect(JSON.parse(liveText(livePayload({ ...fields, main: null }))).main).toBeNull()
})

test('a file over the limit drops the oldest traces first, then the oldest spans of the trace left', async () => {
  const traces = withCalls(withCalls(withCalls([], 't1', 1000, 4, 'x'.repeat(1000)), 't2', 2000, 4, 'x'.repeat(1000)), 't3', 3000, 4, 'x'.repeat(1000))
  const whole = payloadOf(traces)
  const twoNewest = byteLength(JSON.stringify(payloadOf(traces.slice(1))))
  const newest = byteLength(JSON.stringify(payloadOf(traces.slice(2))))

  expect(fitPayload(whole, byteLength(JSON.stringify(whole)) + 1)).toEqual(whole)
  expect(fitPayload(whole, twoNewest + 1).traces.map(trace => trace.id)).toEqual(['request:t2', 'request:t3'])
  expect(spanIds(fitPayload(whole, newest + 1))).toEqual([['request:t3', 't3', 't3-0', 't3-1', 't3-2', 't3-3']])
  expect(spanIds(fitPayload(whole, newest))).toEqual([['request:t3', 't3-0', 't3-1', 't3-2', 't3-3']])
  expect(spanIds(fitPayload(whole, newest - 500))).toEqual([['request:t3', 't3-1', 't3-2', 't3-3']])
  expect(byteLength(liveText(whole, newest - 500))).toBeLessThan(newest - 500)
  expect(fitPayload(whole, byteLength(JSON.stringify(payloadOf([]))) + 100).traces).toEqual([])

  const followsOldest = fitPayload(payloadOf(traces, 'request:t1'), twoNewest + 100)
  const followsNewest = fitPayload(payloadOf(traces, 'request:t3'), twoNewest + 100)

  expect([followsOldest.main, followsOldest.traces.map(trace => trace.id)]).toEqual([null, ['request:t2', 'request:t3']])
  expect([followsNewest.main, followsNewest.traces.map(trace => trace.id)]).toEqual(['request:t3', ['request:t2', 'request:t3']])
})

test('the file stays under 1 MiB counted in bytes, not characters', async () => {
  const traces = withCalls(withCalls([], 't1', 1000, 500, 'é'.repeat(600)), 't2', 2000, 500, 'é'.repeat(600))
  const whole = JSON.stringify(payloadOf(traces))
  const text = liveText(payloadOf(traces))
  const file = JSON.parse(text) as LivePayload

  expect(whole.length).toBeLessThan(LIVE_MAX_BYTES)
  expect(byteLength(whole)).toBeGreaterThan(LIVE_MAX_BYTES)
  expect(byteLength(text)).toBeLessThan(LIVE_MAX_BYTES)
  expect(file.traces.map(trace => trace.id)).toEqual(['request:t2'])
  expect(file.traces[0]?.spans[0]?.id).toBe('request:t2')
  expect(file.traces[0]?.spans.at(-1)?.id).toBe('t2-499')
})

test('in a Herdr terminal the mod writes the live file at most every 300 ms and always the last state', async ($, on) => {
  const start = 1_793_380_000_000
  const clock = mock.clock(on, { now: start })
  const writes: Written[] = []

  mock.env(on, HERDR_ON_WINDOWS)
  standIns(on, { id: 'session-1' }, recorder(clock, writes))
  on('tool.call', async () => {
    await clock.sleep(100)

    return { result: {} }
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()

  expect(writes.map(one => [one.at, one.file])).toEqual([
    [start, { format: 'trace-waterfall/1', terminal: 't9', session: 'session-1', written: start, theme: 'dark', main: null, traces: [] }],
  ])
  expect(writes[0]?.path.replace(/\\/g, '/')).toEndWith('C:/Users/ruben/AppData/Local/trace-waterfall/live/t9.json')

  await $.turn.start({ text: 'Fix the build', turnId: 't1' })
  const read = $.tool.call({ tool: 'Read', tool_use_id: 'r1', file_path: 'C:/git/app/build.py' })
  await clock.advance(100)
  await read
  await clock.advance(100)

  expect(writes).toHaveLength(1)

  await clock.advance(100)

  expect(writes.map(one => one.at - start)).toEqual([0, 300])
  expect(writes[1]?.file.main).toBe('request:t1')
  expect(writes[1]?.file.traces[0]?.spans.find(span => span.id === 'r1')).toMatchObject({ end: start + 100, pending: 0 })

  await clock.advance(200)
  await $.turn.complete({ answer: 'done', durationMs: 500, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.settle()

  expect(writes).toHaveLength(2)

  await $.session.end({ reason: 'prompt_input_exit', sessionId: 'session-1', resume: { id: 'session-1' } })

  expect(writes.map(one => one.at - start)).toEqual([0, 300, 500])
  expect(writes[2]?.file.traces[0]?.spans.every(span => span.pending === 0)).toBe(true)

  await clock.advance(1000)

  expect(writes).toHaveLength(3)
})

test('after /clear the live file holds the new session and no traces', async ($, on) => {
  const clock = mock.clock(on, { now: 5_000_000 })
  const session = { id: 'session-1' }
  const writes: Written[] = []

  mock.env(on, { HOME: '/home/ruben', HC_TERMINAL_ID: 't4' })
  standIns(on, session, recorder(clock, writes))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'Fix the build', turnId: 't1' })
  await clock.advance(1000)
  await $.turn.complete({ answer: 'done', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(1000)

  expect(writes.at(-1)?.file.traces).toHaveLength(1)
  expect(writes.at(-1)?.file.main).toBe('request:t1')

  session.id = 'session-2'
  await $.session.end({ reason: 'clear', sessionId: 'session-1', resume: { id: 'session-1' } })
  await clock.advance(300)

  expect(writes.at(-1)?.path.replace(/\\/g, '/')).toEndWith('/home/ruben/.local/state/trace-waterfall/live/t4.json')
  expect([writes.at(-1)?.file.session, writes.at(-1)?.file.main, writes.at(-1)?.file.traces]).toEqual(['session-2', null, []])
})

test('outside a Herdr terminal the mod writes no file', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const writes: Written[] = []

  mock.env(on, { OS: 'Windows_NT', LOCALAPPDATA: 'C:\\Users\\ruben\\AppData\\Local' })
  standIns(on, { id: 'session-1' }, recorder(clock, writes))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'Fix the build', turnId: 't1' })
  await clock.advance(1000)
  await $.turn.complete({ answer: 'done', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' })
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 'session-1', resume: { id: 'session-1' } })
  await clock.advance(1000)

  expect(writes).toEqual([])
})

test('a live file that cannot be written leaves the session and the pane as they were', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const logged: string[] = []
  let tries = 0

  mock.env(on, HERDR_ON_WINDOWS)
  standIns(on, { id: 'session-1' }, () => {
    tries += 1

    throw new Error('The disk is full')
  })
  on('ui.log', (_, e) => {
    logged.push(JSON.stringify(e))

    return { value: undefined }
  })
  on('tool.call', () => ({ result: {} }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'Fix the build', turnId: 't1' })
  await $.tool.call({ tool: 'Read', tool_use_id: 'r1', file_path: 'C:/git/app/build.py' })
  await clock.advance(1000)
  await $.turn.complete({ answer: 'done', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(1000)

  expect(tries).toBeGreaterThan(1)
  expect(logged).toEqual([])

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect((await ui.findAll({ type: 'Button' })).map(found => found.key)).toEqual(['earlier', 'later', 'request:t1', 'r1'])
  await ui.unmount()
})
