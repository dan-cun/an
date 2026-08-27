export const roleCatalog = [
  { id: 'interpreter', name: '任务解释智能体', shortName: '解释', description: '识别任务场景、输入类型与授权范围', events: ['scenario.classified'] },
  { id: 'planner', name: '规划智能体', shortName: '规划', description: '生成并校验有界执行计划', events: ['plan.created', 'plan.validated', 'step.selected'] },
  { id: 'analyst', name: '分析智能体', shortName: '分析', description: '规范化工具观测、Finding 与 Evidence', events: ['analysis.completed'] },
  { id: 'verifier', name: '验证智能体', shortName: '验证', description: '检查证据引用与结论闭环', events: ['verification.completed'] },
  { id: 'reporter', name: '报告智能体', shortName: '报告', description: '生成审计报告并提交记忆候选', events: ['report.generated', 'memory.candidate'] },
]

export const eventLabels = {
  'run.queued': '任务进入队列', 'run.created': '建立运行上下文', 'input.ingested': '输入材料入库',
  'scenario.classified': '识别安全场景', 'knowledge.retrieved': '检索知识上下文', 'plan.created': '生成执行计划',
  'plan.validated': '校验执行计划', 'step.selected': '选择执行步骤', 'guardrail.evaluated': '执行安全策略检查',
  'approval.requested': '请求人工审批', 'approval.resolved': '审批处理完成', 'tool.started': '调用安全工具',
  'tool.completed': '安全工具执行完成', 'observation.recorded': '记录工具观测', 'analysis.completed': '分析安全发现',
  'verification.completed': '验证分析结论', 'reflection.completed': '反思与有限重试', 'report.generated': '生成安全报告',
  'memory.candidate': '提交记忆候选', 'run.failed': '运行失败',
  'agent.started': '智能体开始工作', 'agent.instruction': '编排器下发指令',
  'agent.thought': '智能体思考摘要', 'agent.completed': '智能体完成节点',
  'agent.failed': '智能体节点失败', 'llm.stream.started': '模型开始流式生成',
  'llm.stream.delta': '模型增量输出', 'llm.stream.completed': '模型流式输出完成', 'llm.stream.failed': '模型流式输出失败',
}

export const categoryFor = (type = '') => type.startsWith('agent.') || type.startsWith('llm.') ? 'agent' : type.includes('tool') ? 'tool' : type.includes('approval') || type.includes('guardrail') ? 'security' : type.includes('verification') ? 'verification' : type.includes('report') || type.includes('memory') ? 'report' : type.includes('plan') || type.includes('step') ? 'planning' : 'runtime'

export function projectEvent(event) {
  return { ...event, title: eventLabels[event.event_type] || event.event_type, category: categoryFor(event.event_type), summary: event.summary || event.payload?.summary || event.payload?.reason || '' }
}

export function projectStreams(events) {
  const streams = new Map()
  const messages = []
  for (const event of events) {
    const payload = event.payload || {}
    if (event.event_type === 'agent.instruction') messages.push({ ...event, kind: 'instruction', content: payload.content, agent: payload.agent_id })
    if (event.event_type === 'agent.thought') messages.push({ ...event, kind: 'thought', content: payload.summary, agent: payload.agent_id })
    if (!event.event_type.startsWith('llm.')) continue
    const traceId = payload.trace_id
    if (!traceId) continue
    const current = streams.get(traceId) || { traceId, content: '', status: 'starting', seen: new Set(), startSequence: event.sequence, sequence: event.sequence, stage: payload.stage, model: payload.model }
    current.stage = payload.stage || current.stage; current.model = payload.model || current.model; current.sequence = event.sequence
    if (event.event_type === 'llm.stream.started') current.status = 'streaming'
    if (event.event_type === 'llm.stream.delta') {
      const key = payload.index ?? event.sequence
      if (!current.seen.has(key)) {
        current.seen.add(key)
        current.content = typeof payload.content === 'string' ? payload.content : current.content + (payload.delta || '')
      }
      current.status = 'streaming'
    }
    if (event.event_type === 'llm.stream.completed') {
      current.status = 'completed'
      current.usage = payload.usage
      if (typeof payload.content === 'string') current.content = payload.content
    }
    if (event.event_type === 'llm.stream.failed') { current.status = 'failed'; current.content = payload.message || '模型调用失败，已切换到安全降级路径。' }
    streams.set(traceId, current)
  }
  const modelStreams = [...streams.values()].map(({ seen, ...item }) => ({ ...item, kind: 'model' }))
  return [...messages, ...modelStreams].sort((left, right) => left.sequence - right.sequence)
}

const thoughtStageLabels = {
  interpreter: '理解任务与输入',
  planner: '规划执行路径',
  analyst: '分析工具结果',
  verifier: '验证证据闭环',
  reporter: '形成最终结论',
}

const milestoneLabels = {
  'analysis.completed': '完成安全分析',
  'verification.completed': '完成证据验证',
  'report.generated': '生成任务报告',
  'memory.candidate': '评估记忆候选',
  'run.failed': '任务执行失败',
}

function payloadSummary(payload = {}) {
  if (payload.summary || payload.reason || payload.error) return payload.summary || payload.reason || payload.error
  const details = []
  if (payload.status) details.push(`状态：${{ success: '成功', completed: '已完成', error: '错误', failed: '失败', partial: '部分完成', denied: '已拒绝' }[payload.status] || payload.status}`)
  if (Number.isFinite(payload.finding_count)) details.push(`发现 ${payload.finding_count} 项`)
  if (Number.isFinite(payload.evidence_count)) details.push(`证据 ${payload.evidence_count} 条`)
  if (Number.isFinite(payload.duration_ms)) details.push(`耗时 ${(payload.duration_ms / 1000).toFixed(2)} 秒`)
  return details.join('，')
}

export function projectThoughtTimeline(events, runStatus) {
  const ordered = [...events].sort((left, right) => left.sequence - right.sequence)
  const items = []
  const toolStarts = new Map()
  const streams = projectStreams(ordered).filter((item) => item.kind === 'model')

  for (const event of ordered) if (event.event_type === 'tool.started') toolStarts.set(event.payload?.tool, event)

  const objective = ordered.find((event) => event.event_type === 'run.queued')
  if (objective) items.push({ id: objective.event_id, sequence: objective.sequence, kind: 'objective', title: '理解用户任务', content: objective.payload?.objective || '任务已进入执行队列。', timestamp: objective.timestamp })

  for (const event of ordered) {
    const payload = event.payload || {}
    if (event.event_type === 'agent.instruction') {
      const boundary = ordered.find((candidate) => candidate.sequence > event.sequence
        && candidate.event_type === 'agent.instruction')?.sequence ?? Number.POSITIVE_INFINITY
      const matching = ordered.filter((candidate) => candidate.sequence > event.sequence
        && candidate.sequence < boundary
        && candidate.payload?.agent_id === payload.agent_id
        && candidate.payload?.node === payload.node)
      const thought = matching.find((candidate) => candidate.event_type === 'agent.thought')
      const completed = matching.find((candidate) => ['agent.completed', 'agent.failed'].includes(candidate.event_type))
      const stepStreams = streams.filter((stream) => stream.startSequence > event.sequence && stream.startSequence < boundary)
      const successfulStreams = stepStreams.filter((stream) => stream.status !== 'failed')
      const visibleStreams = successfulStreams.length ? successfulStreams : stepStreams.slice(-1)
      items.push({
        id: event.event_id,
        sequence: event.sequence,
        kind: 'thought',
        title: thoughtStageLabels[payload.agent_id] || `${payload.agent_id || 'Agent'} 思考`,
        content: payload.content || '执行当前编排节点。',
        detail: thought?.payload?.summary,
        process: visibleStreams.map((stream) => ({ id: stream.traceId, content: stream.content, model: stream.model, status: stream.status, usage: stream.usage })),
        active: !completed,
        failed: completed?.event_type === 'agent.failed',
        agent: payload.agent_id,
        node: payload.node,
        timestamp: event.timestamp,
      })
    }
    if (event.event_type === 'tool.completed') {
      const started = toolStarts.get(payload.tool)
      items.push({ id: event.event_id, sequence: event.sequence, kind: payload.status === 'success' ? 'tool' : 'failed', title: `调用 ${payload.tool || '受控工具'}`, content: payloadSummary(payload) || '工具调用已经结束。', detail: started?.payload?.args ? `参数：${JSON.stringify(started.payload.args)}` : '', coverage: payload.coverage, timestamp: event.timestamp })
    }
    if (milestoneLabels[event.event_type]) items.push({ id: event.event_id, sequence: event.sequence, kind: event.event_type === 'run.failed' ? 'failed' : event.event_type === 'report.generated' ? 'conclusion' : 'result', title: milestoneLabels[event.event_type], content: payloadSummary(payload) || eventLabels[event.event_type], timestamp: event.timestamp })
  }

  const firstTime = ordered[0]?.timestamp ? new Date(ordered[0].timestamp).getTime() : 0
  const lastTime = ordered.at(-1)?.timestamp ? new Date(ordered.at(-1).timestamp).getTime() : firstTime
  const durationSeconds = firstTime && lastTime ? Math.max(1, Math.round((lastTime - firstTime) / 1000)) : 0
  const terminal = ['completed', 'partial', 'failed', 'denied'].includes(runStatus)
  return { items: items.sort((left, right) => left.sequence - right.sequence), durationSeconds, terminal }
}

export function deriveNetwork(events, runStatus) {
  const lifecycle = events.filter((event) => event.event_type.startsWith('agent.') && event.payload?.agent_id)
  if (lifecycle.length) {
    const latestByAgent = new Map()
    for (const event of lifecycle) latestByAgent.set(event.payload.agent_id, event)
    const roles = roleCatalog.map((role) => {
      const event = latestByAgent.get(role.id)
      const status = !event ? 'idle' : event.event_type === 'agent.started' || event.event_type === 'agent.instruction' || event.event_type === 'agent.thought' ? 'active' : event.event_type === 'agent.failed' ? 'failed' : 'completed'
      return { ...role, status, node: event?.payload?.node, activity: event?.payload?.summary || event?.payload?.content || event?.payload?.instruction }
    })
    const lastActive = [...lifecycle].reverse().find((event) => {
      const isActive = ['agent.started', 'agent.instruction', 'agent.thought'].includes(event.event_type)
      return isActive && latestByAgent.get(event.payload.agent_id) === event
    })
    return { roles, active: lastActive?.payload.agent_id || null, activeNode: lastActive?.payload.node || null, completed: roles.filter((role) => role.status === 'completed').length }
  }
  const seenTypes = new Set(events.map((event) => event.event_type)); const latestType = events.at(-1)?.event_type || ''
  const terminal = ['completed', 'partial', 'failed', 'denied'].includes(runStatus)
  const roles = roleCatalog.map((role) => { const touched = role.events.some((type) => seenTypes.has(type)); const latest = role.events.includes(latestType); return { ...role, status: latest && !terminal ? 'active' : touched ? 'completed' : 'idle' } })
  const active = roles.find((role) => role.status === 'active')?.id || null
  return { roles, active, completed: roles.filter((role) => role.status === 'completed').length }
}

export const formatTime = (value) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—'
export const compactId = (value, size = 12) => value ? String(value).slice(0, size) : '—'
