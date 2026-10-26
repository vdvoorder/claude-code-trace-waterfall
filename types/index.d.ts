export type SpanKind = 'turn' | 'agent' | 'model' | 'tool'

export type SpanUsage = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export type Span = {
  id: string
  parent: string | null
  kind: SpanKind
  name: string
  details: string[]
  loop: string | null
  start: number
  end: number
  pending: number
  isError: boolean
  model: string | null
  usage: SpanUsage | null
  cost: number | null
  prompt: string | null
  agentId: string | null
}

export type Trace = {
  id: string
  prompt: string
  start: number
  spans: Span[]
}

export type AgentLink = { trace: string; span: string }

export type Theme = 'dark' | 'light'

declare module 'claude-code' {
  interface PluginState {
    'trace-waterfall': {
      traces: Trace[]
      agents: Record<string, AgentLink>
      main: AgentLink | null
      view: string | null
      selected: string | null
      now: number
      theme: Theme
    }
  }
}
