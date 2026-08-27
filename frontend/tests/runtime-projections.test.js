import test from 'node:test'
import assert from 'node:assert/strict'

import { deriveNetwork, projectStreams, projectThoughtTimeline } from '../src/app/runtimeModel.js'
import { localizeFinding, localizeModelOutput, localizePublicText, severityLabels } from '../src/app/localization.js'

const event = (sequence, event_type, payload) => ({
  event_id: `event-${sequence}`,
  sequence,
  event_type,
  payload,
})

test('projects the active agent from live lifecycle events and clears it at completion', () => {
  const started = [
    event(1, 'agent.started', { agent_id: 'interpreter', node: 'ingest' }),
    event(2, 'agent.instruction', { agent_id: 'interpreter', node: 'ingest', content: 'ingest' }),
  ]
  const active = deriveNetwork(started, 'running')
  assert.equal(active.active, 'interpreter')
  assert.equal(active.activeNode, 'ingest')
  assert.equal(active.roles.find((role) => role.id === 'interpreter').status, 'active')

  const completed = deriveNetwork([
    ...started,
    event(3, 'agent.completed', { agent_id: 'interpreter', node: 'ingest' }),
  ], 'running')
  assert.equal(completed.active, null)
  assert.equal(completed.roles.find((role) => role.id === 'interpreter').status, 'completed')
})

test('assembles model deltas and exposes terminal stream failures', () => {
  const trace = 'trace-1'
  const projected = projectStreams([
    event(1, 'llm.stream.started', { trace_id: trace, stage: 'planner', model: 'model-a' }),
    event(2, 'llm.stream.delta', { trace_id: trace, index: 1, delta: '{"answer":' }),
    event(3, 'llm.stream.delta', { trace_id: trace, index: 2, delta: '"ok"}' }),
    event(4, 'llm.stream.completed', { trace_id: trace, usage: { prompt_tokens: 4, completion_tokens: 2 } }),
    event(5, 'llm.stream.failed', { trace_id: 'trace-2', model: 'model-b', message: 'model unavailable' }),
  ])
  assert.equal(projected[0].content, '{"answer":"ok"}')
  assert.equal(projected[0].status, 'completed')
  assert.equal(projected[0].usage.prompt_tokens, 4)
  assert.equal(projected[1].status, 'failed')
  assert.equal(projected[1].content, 'model unavailable')
})

test('projects raw ledger events into a compact auditable thought timeline', () => {
  const projected = projectThoughtTimeline([
    { ...event(1, 'run.queued', { objective: 'audit source' }), timestamp: '2026-08-13T00:00:00Z' },
    event(2, 'agent.instruction', { agent_id: 'planner', node: 'plan', content: 'create a bounded plan' }),
    event(3, 'llm.stream.started', { trace_id: 'trace', stage: 'planner', model: 'model-a' }),
    event(4, 'llm.stream.delta', { trace_id: 'trace', index: 1, delta: 'public model output' }),
    event(5, 'llm.stream.completed', { trace_id: 'trace', usage: { prompt_tokens: 4 } }),
    event(6, 'agent.thought', { agent_id: 'planner', node: 'plan', summary: 'one safe tool step' }),
    event(7, 'tool.started', { tool: 'bandit', args: { target: '.' } }),
    { ...event(8, 'tool.completed', { tool: 'bandit', status: 'success', duration_ms: 800 }), timestamp: '2026-08-13T00:00:03Z' },
  ], 'completed')
  assert.equal(projected.terminal, true)
  assert.equal(projected.durationSeconds, 3)
  assert.equal(projected.items.filter((item) => item.kind === 'model').length, 0)
  assert.equal(projected.items.find((item) => item.kind === 'thought').process.length, 1)
  assert.equal(projected.items.find((item) => item.kind === 'thought').detail, 'one safe tool step')
  assert.match(projected.items.find((item) => item.kind === 'tool').content, /成功/)
})

test('nests the current public stream under its step and hides a corrected failed attempt', () => {
  const projected = projectThoughtTimeline([
    event(1, 'agent.instruction', { agent_id: 'planner', node: 'plan', content: 'plan safely' }),
    event(2, 'llm.stream.started', { trace_id: 'failed-trace', stage: 'planner', model: 'model-a' }),
    event(3, 'llm.stream.delta', { trace_id: 'failed-trace', index: 1, delta: 'obsolete sentence' }),
    event(4, 'llm.stream.failed', { trace_id: 'failed-trace', message: 'retrying' }),
    event(5, 'llm.stream.started', { trace_id: 'final-trace', stage: 'planner', model: 'model-b' }),
    event(6, 'llm.stream.delta', { trace_id: 'final-trace', index: 1, delta: 'draft sentence' }),
    event(7, 'llm.stream.completed', { trace_id: 'final-trace', content: 'corrected sentence' }),
    event(8, 'agent.thought', { agent_id: 'planner', node: 'plan', summary: 'final summary' }),
    event(9, 'agent.completed', { agent_id: 'planner', node: 'plan' }),
  ], 'completed')
  const step = projected.items.find((item) => item.kind === 'thought')
  assert.equal(step.process.length, 1)
  assert.equal(step.process[0].content, 'corrected sentence')
  assert.equal(step.detail, 'final summary')
  assert.equal(step.active, false)
})

test('localizes historical report findings and public AI summaries', () => {
  const finding = localizeFinding({
    rule_id: 'SECMIND-JAVA-SSTI',
    title: 'User-controlled input reaches a server-side template parser',
    description: 'Request input reaches template parsing.',
  })
  assert.equal(finding.title, '用户可控输入进入服务端模板解析器')
  assert.match(finding.description, /服务端模板注入/)
  assert.equal(severityLabels.CRITICAL, '严重')
  assert.match(localizePublicText('Bandit completed with 2 finding(s).'), /发现 2 个安全问题/)
  assert.match(localizeModelOutput(JSON.stringify({ steps: [{ tool_candidates: ['workspace_security_audit'] }] })), /1 个候选执行步骤/)
})
