import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AuditOutlined,
  BranchesOutlined,
  FileTextOutlined,
  PlusOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  TeamOutlined,
} from '@ant-design/icons'
import { Alert, App, Button, Empty, Segmented, Space, Statistic, Typography } from 'antd'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  eventSocketUrl,
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
function TaskStatusPanel({ run, events }) {
  if (!run) return <div className="score-empty">
    <SafetyCertificateOutlined />
    <b>任务状态</b>
    <span>新建任务后，系统会在这里显示模块路由、执行进度和证据统计。</span>
  </div>
  const routeLabels = { code_audit: '代码审计', reverse: '逆向分析', penetration: '渗透测试', unsupported: '人工研判' }
  const externalLabels = {
    submitted: '已提交，等待外部执行',
    running: '外部渗透执行中',
    completed: '外部目标已确认完成',
    complete: '外部目标已确认完成',
    succeeded: '外部目标已确认完成',
    success: '外部目标已确认完成',
    failed: '外部执行失败',
    denied: '外部执行被拒绝',
    timeout: '外部执行超时',
    unavailable: '外部状态不可用',
  }
  const externalStatus = run.external_execution?.status
  const externalText = externalLabels[externalStatus] || (run.module_route === 'penetration' ? '等待外部渗透状态' : '不适用')
  return <div className="score-panel task-status-panel">
    <div className="score-heading"><span><SafetyCertificateOutlined /><b>任务状态</b></span><StatusTag status={run.status} /></div>
    <div className="score-metrics">
      <Statistic title="执行步骤" value={run.current_step ?? 0} suffix={`/ ${run.total_steps ?? 0}`} />
      <span><small>分析模块</small><b>{routeLabels[run.module_route] || run.module_route || '待识别'}</b></span>
      <span><small>输入材料</small><b>{run.budget?.tool_calls_used ?? 0} 次工具调用</b></span>
      <span><small>账本事件</small><b>{events.length}</b></span>
      <span><small>外部执行</small><b>{externalText}</b></span>
    </div>
    <Alert type={run.module_route === 'penetration' && !['completed', 'complete', 'succeeded', 'success', 'failed', 'denied', 'timeout', 'unavailable'].includes(externalStatus) ? 'warning' : 'info'} showIcon title={run.module_route === 'penetration' ? externalText : '统一文件分析流程'} description={run.module_route === 'penetration' ? '仅在 Cairn 项目进入终态且黑板存在目标完成证据后，任务才会标记为完成。' : '所有题目通过单文件分析、AI辅助文件分析或题库格式化文件分析进入对应安全模块；结果以可验证证据为准。'} />
  </div>
}

export function WorkbenchPage() {
  const { message } = App.useApp()
  const navigate = useNavigate()
  const location = useLocation()
  const [runs, setRuns] = useState([])
  const [selectedId, setSelectedId] = useState(
    () => new URLSearchParams(location.search).get('run') || '',
  )
  const [run, setRun] = useState(null)
  const [events, setEvents] = useState([])
  const [report, setReport] = useState(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [view, setView] = useState('stream')
  const [streamConnected, setStreamConnected] = useState(false)
  const [modules, setModules] = useState([])
  const socketRef = useRef(null)
  const lastSequence = useRef(0)
  const refreshToken = useRef(0)

  const refreshRuns = useCallback(async () => {
    const data = await listRuns()
    setRuns(data.runs || [])
    if (data.runs?.length) {
      setSelectedId((currentId) => currentId || data.runs[0].run_id)
    }
  }, [])

  const refreshSelected = useCallback(async () => {
    if (!selectedId) return
    const token = ++refreshToken.current
    const [nextRun, ledger] = await Promise.all([getRun(selectedId), getLedger(selectedId)])
    // An event-triggered refresh can overtake the timer refresh.  Discard an
    // older response so a slow request cannot roll the UI back to stale state.
    if (token !== refreshToken.current) return
    setRun(nextRun)
    setEvents(ledger.events || [])
    lastSequence.current = Math.max(0, ...(ledger.events || []).map((item) => item.sequence))
    // A report is a terminal artifact.  Avoid repeatedly requesting a 409
    // while the exploration path is still running, and never present an
    // early/partial report as the final result.
    const terminal = ['completed', 'partial', 'failed', 'denied'].includes(nextRun.status)
    if (terminal) {
      try {
        const nextReport = await getReport(selectedId)
        if (token === refreshToken.current) setReport(nextReport)
      } catch {
        if (token === refreshToken.current) setReport(null)
      }
    } else {
      setReport(null)
    }
  }, [selectedId])

  const clearMissingRun = useCallback(async () => {
    socketRef.current?.close()
    setRun(null)
    setEvents([])
    setReport(null)
    setSelectedId('')
    const params = new URLSearchParams(location.search)
    params.delete('run')
    navigate({ pathname: location.pathname, search: params.toString() }, { replace: true })
    await refreshRuns()
  }, [location.pathname, location.search, navigate, refreshRuns])

  useEffect(() => { refreshRuns().catch((error) => message.error(error.message)) }, [])
  useEffect(() => { listModules().then((data) => setModules(data.modules || [])).catch(() => {}) }, [])
  useEffect(() => {
    const params = new URLSearchParams(location.search)
    if (params.get('create') === '1') setModalOpen(true)
    if (params.get('run')) setSelectedId(params.get('run'))
  }, [location.search])
  useEffect(() => {
    if (!selectedId) { setRun(null); setEvents([]); return undefined }
    refreshSelected().catch((error) => {
      if (error.status === 404) {
        clearMissingRun().catch(() => {})
        return
      }
      message.error(`读取任务失败：${error.message}`)
    })
    const timer = setInterval(() => {
      refreshSelected().catch(() => {})
      refreshRuns().catch(() => {})
    }, ['completed', 'partial', 'failed', 'denied'].includes(run?.status) ? 6000 : 1500)
    return () => clearInterval(timer)
  }, [selectedId, refreshSelected, clearMissingRun])

  useEffect(() => {
    socketRef.current?.close()
    if (!selectedId || run?.run_id !== selectedId) return undefined
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
          if ([
            'agent.completed', 'agent.failed', 'tool.started', 'tool.completed',
            'analysis.completed', 'verification.completed', 'report.generated',
            'run.failed', 'penetration.status', 'penetration.terminal',
            'exploration.updated', 'exploration.completed',
          ].includes(event.event_type)) {
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
  }, [selectedId, run?.run_id])

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

  async function created({ runId }) {
    setModalOpen(false)
    setRun(null); setEvents([]); setReport(null)
    lastSequence.current = 0
    setSelectedId(runId); setView('stream')
    await refreshRuns()
    message.success(`任务 ${compactId(runId)} 已进入执行队列`)
  }

  return <div className="workbench-grid">
    <TaskModal open={modalOpen} onClose={() => setModalOpen(false)} onCreated={created} />
    <aside className={`glass-panel session-panel ${view === 'graph' ? 'is-graph-hidden' : ''}`}>
      <div className="panel-heading"><div><Text className="panel-kicker">RUNS</Text><Title level={4}>任务流程</Title></div><Button type="text" icon={<ReloadOutlined />} onClick={refreshRuns} /></div>
      <Button type="primary" icon={<PlusOutlined />} block onClick={() => setModalOpen(true)}>新建任务</Button>
      <div className="session-list">{runs.length ? runs.map((item) => <button
        type="button" key={item.run_id} className={`session-item ${selectedId === item.run_id ? 'is-active' : ''}`}
        onClick={() => setSelectedId(item.run_id)}
      ><span><b>{item.name || (item.scenario === 'unknown' ? '等待场景识别' : item.scenario)}</b><small>{item.name && item.scenario !== 'unknown' ? `${item.scenario} · ` : ''}{compactId(item.run_id)}</small></span><StatusTag status={item.status} /></button>) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无任务" />}</div>
    </aside>

    <section className={`glass-panel conversation-panel ${view === 'graph' ? 'is-graph' : ''}`}>
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
      {view === 'stream' ? <RuntimeStream events={events} connected={streamConnected} active={Boolean(selectedId)} /> : view === 'graph' ? <BlackboardGraph run={run} events={events} /> : view === 'thinking' ? <AIThoughtTimeline events={events} runStatus={run?.status} downloadUrl={run ? thoughtProcessUrl(run.run_id) : ''} /> : report ? <div className="report-view">
        <div className="report-hero"><Text className="panel-kicker">安全审计报告</Text><Title level={3}>{localizePublicText(report.executive_summary)}</Title><Paragraph>{report.limitations?.map(localizePublicText).join('；') || '所有结论均已通过证据引用验证。'}</Paragraph></div>
        {report.findings?.map(localizeFinding).map((finding) => <article className="finding-card" key={finding.finding_id}><span className={`severity is-${finding.severity.toLowerCase()}`}>{severityLabels[finding.severity] || finding.severity}</span><div><b>{finding.title}</b><p>{finding.description}</p>{finding.remediation && <p className="finding-remediation"><strong>修复建议：</strong>{finding.remediation}</p>}<small>{finding.path}{finding.line ? `:${finding.line}` : ''} · 证据 {(finding.evidence_ids || []).join(', ')}</small></div></article>)}
      </div> : <Empty description={run && !['completed', 'partial', 'failed', 'denied'].includes(run.status) ? '探索路径尚未完成，结果生成已延迟' : '报告将在运行结束后生成'} />}
    </section>

    <aside className={`glass-panel inspector-panel ${view === 'graph' ? 'is-graph-hidden' : ''}`}>
      <div className="panel-heading"><div><Text className="panel-kicker">TASK STATUS</Text><Title level={4}>任务状态与协作</Title></div><SafetyCertificateOutlined className="heading-icon" /></div>
      <TaskStatusPanel run={run} events={events} />
      <div className="inspector-divider"><TeamOutlined /> 智能体网络</div>
      <AgentNetwork network={network} eventCount={events.length} />
      <div className="inspector-divider">模块状态</div>
      <div className="module-status-list">{modules.map((module) => <div className="module-status" key={module.id}><span><i className={module.available ? 'status-dot is-on' : 'status-dot'} />{module.name}</span><small>{module.available ? '已就绪' : '不可用'}</small></div>)}</div>
    </aside>
  </div>
}
