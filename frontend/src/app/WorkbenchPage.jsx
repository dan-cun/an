import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AuditOutlined,
  BranchesOutlined,
  DownloadOutlined,
  FileTextOutlined,
  PlusOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  TeamOutlined,
} from '@ant-design/icons'
import { Alert, App, Button, Empty, Segmented, Space, Statistic, Steps, Tag, Typography } from 'antd'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  eventSocketUrl,
  evaluationEventSocketUrl,
  evaluationReportUrl,
  getEvaluation,
  getEvaluationByRun,
  getEvaluationScore,
  getLedger,
  getReport,
  getRun,
  listRuns,
  submitApproval,
  thoughtProcessUrl,
  listModules,
} from '../api.js'
import { AgentNetwork } from './AgentNetwork.jsx'
import { AIThoughtTimeline } from './AIThoughtTimeline.jsx'
import { RuntimeStream } from './RuntimeStream.jsx'
import {
  localizeFinding,
  localizePublicText,
  severityLabels,
} from './localization.js'
import { compactId, deriveNetwork } from './runtimeModel.js'
import { StatusTag } from './StatusTag.jsx'
import { TaskModal } from './TaskModal.jsx'
import { ModuleFlow } from './ModuleFlow.jsx'
import { BlackboardGraph } from './BlackboardGraph.jsx'

const { Text, Title, Paragraph } = Typography
const EVALUATION_TERMINAL = new Set([
  'SCORED', 'UNSCORABLE_NO_GOLD', 'INPUT_MISMATCH', 'AGENT_FAILED', 'SCORING_FAILED', 'VERIFIER_REQUIRED',
])
const STATUS_LABELS = {
  INPUT_VALIDATING: '校验输入', AGENT_QUEUED: 'Agent 排队', AGENT_RUNNING: '实时分析',
  REPORT_READY: '报告就绪', SCORE_QUEUED: '评分排队', SCORING: '独立评分', SCORED: '评分完成',
  VERIFIER_REQUIRED: '等待私有验证', INPUT_MISMATCH: '输入不匹配', AGENT_FAILED: '分析失败',
  SCORING_FAILED: '评分失败', UNSCORABLE_NO_GOLD: '无 Gold，不可评分',
}

function evaluationStep(status) {
  const order = ['INPUT_VALIDATING', 'AGENT_QUEUED', 'AGENT_RUNNING', 'REPORT_READY', 'SCORE_QUEUED', 'SCORING', 'SCORED']
  if (status === 'VERIFIER_REQUIRED') return 6
  const index = order.indexOf(status)
  return index < 0 ? 0 : Math.min(3, index < 3 ? index : index < 5 ? 2 : 3)
}

function ScorePanel({ evaluation, score }) {
  if (!evaluation) return <div className="score-empty">
    <SafetyCertificateOutlined />
    <b>评分面板</b>
    <span>普通上传任务只生成分析报告；请选择 Test3.0 已注册题目以启动独立评分。</span>
  </div>
  const task = score?.task
  const failed = ['INPUT_MISMATCH', 'AGENT_FAILED', 'SCORING_FAILED'].includes(evaluation.status)
  return <div className="score-panel">
    <div className="score-heading">
      <span><SafetyCertificateOutlined /><b>Test3.0 单题评分</b></span>
      <Tag color={evaluation.status === 'SCORED' ? 'success' : failed ? 'error' : 'processing'}>
        {STATUS_LABELS[evaluation.status] || evaluation.status}
      </Tag>
    </div>
    <Steps
      size="small"
      current={evaluationStep(evaluation.status)}
      status={failed ? 'error' : evaluation.status === 'SCORED' ? 'finish' : 'process'}
      items={[{ title: '校验' }, { title: '分析' }, { title: '投影报告' }, { title: '评分' }]}
    />
    <div className="score-metrics">
      <Statistic
        title="当前题得分"
        value={evaluation.task_score ?? '--'}
        precision={typeof evaluation.task_score === 'number' ? 2 : undefined}
        suffix={typeof evaluation.task_score === 'number' ? '/ 100' : ''}
      />
      <span><small>题目</small><b>{evaluation.benchmark_task_id}</b></span>
      <span><small>判分器</small><b>{task?.score_status || '等待结果'}</b></span>
      <span><small>题目状态</small><b>{task?.completed === true ? '已完成' : task?.completed === false ? '未完成' : '等待结果'}</b></span>
    </div>
    {task?.components && Object.keys(task.components).length > 0 && <div className="score-components">
      {Object.entries(task.components).map(([name, value]) => <span key={name}><small>{name}</small><b>{Number(value).toFixed(1)}</b></span>)}
    </div>}
    {evaluation.status === 'VERIFIER_REQUIRED' && <Alert
      type="warning"
      showIcon
      title="该补丁题需要私有验证回执"
      description="当前不会伪造分数；请在隔离评分端完成补丁验证后再生成正式结果。"
    />}
    {evaluation.error_message && <Alert type="error" showIcon title={evaluation.error_code} description={evaluation.error_message} />}
    <Alert
      type="info"
      showIcon
      title="这是单题结果，不是 Full60 正式综合分"
      description={`评分器报告状态：${evaluation.report_status || '等待生成'}。私有 Gold、私有路径与评分日志不会发送到浏览器。`}
    />
    {evaluation.report_available && <Button
      block
      icon={<DownloadOutlined />}
      href={evaluationReportUrl(evaluation.evaluation_id)}
      target="_blank"
    >下载脱敏评分报告</Button>}
  </div>
}

export function WorkbenchPage() {
  const { message } = App.useApp()
  const navigate = useNavigate()
  const location = useLocation()
  const [runs, setRuns] = useState([])
  const [selectedId, setSelectedId] = useState('')
  const [run, setRun] = useState(null)
  const [events, setEvents] = useState([])
  const [report, setReport] = useState(null)
  const [evaluation, setEvaluation] = useState(null)
  const [score, setScore] = useState(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [view, setView] = useState('stream')
  const [streamConnected, setStreamConnected] = useState(false)
  const [modules, setModules] = useState([])
  const socketRef = useRef(null)
  const evaluationSocketRef = useRef(null)
  const lastSequence = useRef(0)
  const lastEvaluationSequence = useRef(0)

  const refreshRuns = useCallback(async () => {
    const data = await listRuns()
    setRuns(data.runs || [])
    if (!selectedId && data.runs?.length) setSelectedId(data.runs[0].run_id)
  }, [selectedId])

  const refreshEvaluation = useCallback(async (runId = selectedId, knownEvaluationId = null) => {
    if (!runId && !knownEvaluationId) return
    try {
      const next = knownEvaluationId ? await getEvaluation(knownEvaluationId) : await getEvaluationByRun(runId)
      setEvaluation(next)
      if (next.score_available || next.status === 'VERIFIER_REQUIRED') {
        try { setScore(await getEvaluationScore(next.evaluation_id)) } catch { setScore(null) }
      } else setScore(null)
    } catch { setEvaluation(null); setScore(null) }
  }, [selectedId])

  const refreshSelected = useCallback(async () => {
    if (!selectedId) return
    const [nextRun, ledger] = await Promise.all([getRun(selectedId), getLedger(selectedId)])
    setRun(nextRun)
    setEvents(ledger.events || [])
    lastSequence.current = Math.max(0, ...(ledger.events || []).map((item) => item.sequence))
    try { setReport(await getReport(selectedId)) } catch { setReport(null) }
    await refreshEvaluation(selectedId)
  }, [selectedId, refreshEvaluation])

  useEffect(() => { refreshRuns().catch((error) => message.error(error.message)) }, [])
  useEffect(() => { listModules().then((data) => setModules(data.modules || [])).catch(() => {}) }, [])
  useEffect(() => {
    const params = new URLSearchParams(location.search)
    if (params.get('create') === '1') setModalOpen(true)
    if (params.get('run')) setSelectedId(params.get('run'))
  }, [location.search])
  useEffect(() => {
    if (!selectedId) { setRun(null); setEvents([]); setEvaluation(null); setScore(null); return undefined }
    refreshSelected().catch((error) => message.error(`读取任务失败：${error.message}`))
    const timer = setInterval(() => {
      refreshSelected().catch(() => {})
      refreshRuns().catch(() => {})
    }, 4000)
    return () => clearInterval(timer)
  }, [selectedId, refreshSelected])

  useEffect(() => {
    socketRef.current?.close()
    if (!selectedId) return undefined
    let disposed = false
    let reconnectTimer
    const connect = () => {
      if (disposed) return
      const socket = new WebSocket(eventSocketUrl(selectedId, lastSequence.current))
      socketRef.current = socket
      socket.onopen = () => setStreamConnected(true)
      socket.onmessage = ({ data }) => {
        try {
          const event = JSON.parse(data)
          lastSequence.current = Math.max(lastSequence.current, event.sequence || 0)
          setEvents((current) => current.some((item) => item.event_id === event.event_id)
            ? current : [...current, event].sort((a, b) => a.sequence - b.sequence))
          if (['agent.completed', 'agent.failed', 'report.generated', 'run.failed'].includes(event.event_type)) {
            refreshSelected().catch(() => {})
          }
        } catch { message.error('收到无法解析的实时事件') }
      }
      socket.onclose = () => {
        setStreamConnected(false)
        if (!disposed) reconnectTimer = window.setTimeout(connect, 1200)
      }
      socket.onerror = () => setStreamConnected(false)
    }
    connect()
    return () => {
      disposed = true
      window.clearTimeout(reconnectTimer)
      socketRef.current?.close()
      setStreamConnected(false)
    }
  }, [selectedId])

  useEffect(() => {
    evaluationSocketRef.current?.close()
    if (!evaluation?.evaluation_id || EVALUATION_TERMINAL.has(evaluation.status)) return undefined
    let disposed = false
    let reconnectTimer
    const connect = () => {
      if (disposed) return
      const socket = new WebSocket(evaluationEventSocketUrl(evaluation.evaluation_id, lastEvaluationSequence.current))
      evaluationSocketRef.current = socket
      socket.onmessage = ({ data }) => {
        try {
          const event = JSON.parse(data)
          lastEvaluationSequence.current = Math.max(lastEvaluationSequence.current, event.sequence || 0)
          refreshEvaluation(selectedId, evaluation.evaluation_id).catch(() => {})
        } catch { /* Polling remains as a fallback. */ }
      }
      socket.onclose = () => { if (!disposed) reconnectTimer = window.setTimeout(connect, 1500) }
    }
    connect()
    return () => { disposed = true; window.clearTimeout(reconnectTimer); evaluationSocketRef.current?.close() }
  }, [evaluation?.evaluation_id, evaluation?.status, selectedId, refreshEvaluation])

  const network = useMemo(() => deriveNetwork(events, run?.status), [events, run?.status])
  const auditCoverage = useMemo(
    () => [...events].reverse().find((event) => event.event_type === 'tool.completed')?.payload?.coverage || null,
    [events],
  )

  async function approval(decision) {
    const pending = run?.pending_approval
    if (!pending) return
    await submitApproval(run.run_id, pending.request_id, { decision, actor: 'web-operator', reason: `operator ${decision}` })
    refreshSelected()
  }

  async function created({ runId, evaluationId }) {
    setModalOpen(false)
    setRun(null); setEvents([]); setReport(null); setScore(null)
    lastSequence.current = 0; lastEvaluationSequence.current = 0
    setSelectedId(runId); setView('stream')
    if (evaluationId) await refreshEvaluation(runId, evaluationId)
    await refreshRuns()
    message.success(`任务 ${compactId(runId)} 已进入执行队列`)
  }

  return <div className="workbench-grid">
    <TaskModal open={modalOpen} onClose={() => setModalOpen(false)} onCreated={created} />
    <aside className="glass-panel session-panel">
      <div className="panel-heading"><div><Text className="panel-kicker">RUNS</Text><Title level={4}>任务流程</Title></div><Button type="text" icon={<ReloadOutlined />} onClick={refreshRuns} /></div>
      <Button type="primary" icon={<PlusOutlined />} block onClick={() => setModalOpen(true)}>新建任务</Button>
      <div className="session-list">{runs.length ? runs.map((item) => <button
        type="button" key={item.run_id} className={`session-item ${selectedId === item.run_id ? 'is-active' : ''}`}
        onClick={() => setSelectedId(item.run_id)}
      ><span><b>{item.name || (item.scenario === 'unknown' ? '等待场景识别' : item.scenario)}</b><small>{item.name && item.scenario !== 'unknown' ? `${item.scenario} · ` : ''}{compactId(item.run_id)}</small></span><StatusTag status={item.status} /></button>) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无任务" />}</div>
    </aside>

    <section className="glass-panel conversation-panel">
      <div className="panel-heading"><div><Text className="panel-kicker">ACTIVE RUN</Text><Title level={4}>{run ? `${run.name || run.scenario} · ${compactId(run.run_id)}` : '实时协作等待任务'}</Title></div><Space wrap>
        <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => setModalOpen(true)}>新建任务</Button>
        <Segmented size="small" value={view} onChange={setView} options={[
          { value: 'stream', label: 'AI 实时流', icon: <TeamOutlined /> },
          { value: 'graph', label: '探索路径', icon: <BranchesOutlined /> },
          { value: 'thinking', label: '执行摘要', icon: <AuditOutlined /> },
          { value: 'result', label: '任务结果', icon: <FileTextOutlined /> },
        ]} />
        {run && <StatusTag status={run.status} />}
        <Button type="text" title="打开审计回放" icon={<AuditOutlined />} onClick={() => navigate(selectedId ? `/audit/${selectedId}` : '/audit')} />
      </Space></div>
      <div className="collaboration-strip">{network.roles.map((role, index) => <React.Fragment key={role.id}>{index > 0 && <span>→</span>}<span className={`is-${role.status}`}>{role.shortName}</span></React.Fragment>)}</div>
      <ModuleFlow run={run} events={events} />
      {run?.pending_approval && <Alert className="approval-alert" type="warning" showIcon title={`步骤 ${run.pending_approval.step_id} 等待审批`} description={<Space><Button type="primary" onClick={() => approval('approve')}>批准</Button><Button danger onClick={() => approval('deny')}>拒绝</Button></Space>} />}
      {view === 'result' && run && <Alert className="coverage-alert" type={auditCoverage?.scanned_file_count ? 'success' : 'warning'} showIcon title={auditCoverage?.scanned_file_count ? `实际审计覆盖 ${auditCoverage.scanned_file_count}/${auditCoverage.input_file_count} 个文件` : '缺少实际文件覆盖证据'} description={auditCoverage?.scanned_file_count ? `${auditCoverage.skipped_file_count || 0} 个不支持或二进制文件未扫描。` : '不能仅凭工具返回成功判定全部材料已完成审计。'} />}
      {view === 'stream' ? <RuntimeStream events={events} connected={streamConnected} /> : view === 'graph' ? <BlackboardGraph run={run} events={events} /> : view === 'thinking' ? <AIThoughtTimeline events={events} runStatus={run?.status} downloadUrl={run ? thoughtProcessUrl(run.run_id) : ''} /> : report ? <div className="report-view">
        <div className="report-hero"><Text className="panel-kicker">安全审计报告</Text><Title level={3}>{localizePublicText(report.executive_summary)}</Title><Paragraph>{report.limitations?.map(localizePublicText).join('；') || '所有结论均已通过证据引用验证。'}</Paragraph></div>
        {report.findings?.map(localizeFinding).map((finding) => <article className="finding-card" key={finding.finding_id}><span className={`severity is-${finding.severity.toLowerCase()}`}>{severityLabels[finding.severity] || finding.severity}</span><div><b>{finding.title}</b><p>{finding.description}</p>{finding.remediation && <p className="finding-remediation"><strong>修复建议：</strong>{finding.remediation}</p>}<small>{finding.path}{finding.line ? `:${finding.line}` : ''} · 证据 {(finding.evidence_ids || []).join(', ')}</small></div></article>)}
      </div> : <Empty description="报告将在运行结束后生成" />}
    </section>

    <aside className="glass-panel inspector-panel">
      <div className="panel-heading"><div><Text className="panel-kicker">EVALUATION</Text><Title level={4}>评分与协作</Title></div><SafetyCertificateOutlined className="heading-icon" /></div>
      <ScorePanel evaluation={evaluation} score={score} />
      <div className="inspector-divider"><TeamOutlined /> 智能体网络</div>
      <AgentNetwork network={network} eventCount={events.length} />
      <div className="inspector-divider">模块状态</div>
      <div className="module-status-list">{modules.map((module) => <div className="module-status" key={module.id}><span><i className={module.available ? 'status-dot is-on' : 'status-dot'} />{module.name}</span><small>{module.available ? '已就绪' : '不可用'}</small></div>)}</div>
    </aside>
  </div>
}
