const viteEnv = import.meta.env || {}
const API_BASE = (viteEnv.VITE_API_BASE_URL || '').replace(/\/$/, '')

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...(options.headers || {}),
    },
  })
  if (!response.ok) {
    const raw = await response.text()
    let detail = raw
    try {
      detail = JSON.parse(raw).detail || raw
    } catch {
      // Preserve plain-text server errors.
    }
    throw new Error(detail || `请求失败 (${response.status})`)
  }
  return response.status === 204 ? null : response.json()
}

export const health = () => request('/health')
export const getModelConfig = () => request('/api/v1/model-config')
export const getModelUsage = () => request('/api/v1/model-usage')
export const testModelConfig = (payload) => request('/api/v1/model-config/test', { method: 'POST', body: JSON.stringify(payload) })
export const updateModelConfig = (payload) => request('/api/v1/model-config', { method: 'PUT', body: JSON.stringify(payload) })

function socketUrl(path, params = {}, location = window.location) {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const configured = viteEnv.VITE_WS_BASE_URL?.trim()
  const base = configured ? new URL(configured, location.origin) : new URL(location.origin)
  base.protocol = protocol
  base.pathname = path
  base.search = new URLSearchParams(params).toString()
  return base.toString()
}

export const modelUsageSocketUrl = (location = window.location) => socketUrl('/api/v1/model-usage/events', {}, location)
export const listRuns = () => request('/api/v1/runs')
export const getRun = (runId) => request(`/api/v1/runs/${encodeURIComponent(runId)}`)
export const getReport = (runId) => request(`/api/v1/runs/${encodeURIComponent(runId)}/report`)
export const thoughtProcessUrl = (runId) =>
  `${API_BASE}/api/v1/runs/${encodeURIComponent(runId)}/thoughts/export`
export async function getLedger(runId, afterSequence = 0) {
  const events = []
  let cursor = afterSequence
  let chainValid = true
  while (true) {
    const page = await request(`/api/v1/runs/${encodeURIComponent(runId)}/ledger?after_sequence=${cursor}&limit=5000`)
    const next = page.events || []
    events.push(...next)
    chainValid = chainValid && page.chain_valid === true
    const lastSequence = next.at(-1)?.sequence
    if (next.length < 5000 || !Number.isInteger(lastSequence) || lastSequence <= cursor) break
    cursor = lastSequence
  }
  return { schema_version: '1.0', run_id: runId, events, chain_valid: chainValid }
}

export async function uploadFile(file) {
  const body = new FormData()
  body.append('file', file, file.name)
  return request('/api/v1/uploads', { method: 'POST', body })
}

export const createTask = (payload) =>
  request('/api/v1/tasks', { method: 'POST', body: JSON.stringify(payload) })
export const classifyTask = (payload) =>
  request('/api/v1/tasks/classify', { method: 'POST', body: JSON.stringify(payload) })
export const listModules = () => request('/api/v1/modules')

export const inspectQuestionBank = (payload) =>
  request('/api/v1/question-banks/inspect', { method: 'POST', body: JSON.stringify(payload) })

export const getQuestionBankInspection = (bankId) =>
  request(`/api/v1/question-banks/${encodeURIComponent(bankId)}/inspection`)

export function questionBankEventSocketUrl(bankId, location = window.location) {
  return socketUrl(`/api/v1/question-banks/${encodeURIComponent(bankId)}/events`, {}, location)
}

export const confirmQuestionBank = (bankId, payload) =>
  request(`/api/v1/question-banks/${encodeURIComponent(bankId)}/confirm`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })

export const listBenchmarkTasks = () => request('/api/v1/benchmark/tasks')
export const createEvaluation = (payload) =>
  request('/api/v1/evaluations', { method: 'POST', body: JSON.stringify(payload) })
export const getEvaluation = (evaluationId) =>
  request(`/api/v1/evaluations/${encodeURIComponent(evaluationId)}`)
export const getEvaluationByRun = (runId) =>
  request(`/api/v1/evaluations/by-run/${encodeURIComponent(runId)}`)
export const getEvaluationScore = (evaluationId) =>
  request(`/api/v1/evaluations/${encodeURIComponent(evaluationId)}/score`)
export const evaluationReportUrl = (evaluationId) =>
  `${API_BASE}/api/v1/evaluations/${encodeURIComponent(evaluationId)}/report`

export const submitApproval = (runId, requestId, payload) =>
  request(`/api/v1/runs/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(requestId)}`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })

export function eventSocketUrl(runId, afterSequence = 0, location = window.location) {
  return socketUrl(`/api/v1/runs/${encodeURIComponent(runId)}/events`, { after_sequence: String(afterSequence) }, location)
}

export function evaluationEventSocketUrl(evaluationId, afterSequence = 0, location = window.location) {
  return socketUrl(
    `/api/v1/evaluations/${encodeURIComponent(evaluationId)}/events`,
    { after_sequence: String(afterSequence) },
    location,
  )
}

export function terminalStatus(status) {
  return ['completed', 'partial', 'failed', 'denied'].includes(status)
}
