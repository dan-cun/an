import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ApiOutlined,
  AuditOutlined,
  BookOutlined,
  BranchesOutlined,
  DatabaseOutlined,
  DeploymentUnitOutlined,
  FileTextOutlined,
  PlusOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  TeamOutlined,
} from '@ant-design/icons'
import { Alert, App, Button, Drawer, Empty, Segmented, Space, Statistic, Tag, Typography } from 'antd'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  eventSocketUrl,
  getLedger,
  getReport,
  refreshRunReport,
  getRun,
  listRuns,
  submitApproval,
  thoughtProcessUrl,
  listModules,
  listExperiences,
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
import { AssetCoverageGraph } from './AssetCoverageGraph.jsx'

const { Text, Title, Paragraph } = Typography

const assetRouteLabels = {
  code_audit: '代码审计',
  reverse: '逆向分析',
  penetration: '渗透测试',
  incident_response: '应急响应',
  unsupported: '人工研判',
}

const recommendedTools = {
  code_audit: [
    ['workspace_security_audit', '工作区文件清单、规则扫描与覆盖率核验'],
    ['bandit_python_audit', 'Python 安全规则与危险调用检查'],
    ['evidence_review', 'AI 证据复核与误报筛选'],
  ],
  reverse: [
    ['reverse_module', 'PE/ELF 样本静态分诊与结构识别'],
    ['binary_inventory', '哈希、文件格式及字符串资产整理'],
    ['evidence_review', '逆向结论与证据引用复核'],
  ],
  penetration: [
    ['penetration_module', '向已授权 Cairn 项目提交渗透工作流'],
    ['target_scope_guard', '目标范围和授权边界检查'],
    ['blackboard_sync', '探索路径、事实和目标状态同步'],
  ],
  incident_response: [
    ['incident_monitor', '安全事件与主机日志持续监测'],
    ['incident_triage', '事件分级、关联与影响面研判'],
    ['approval_guard', '高风险处置动作审批保护'],
  ],
  unsupported: [
    ['workspace_inventory', '输入材料和可分析资产清点'],
    ['route_classifier', '任务类型识别与模块路由'],
    ['evidence_review', '人工研判前的证据整理'],
  ],
}

const fallbackExperienceTemplates = {
  code_audit: ['先建立完整文件清单，再依据语言和依赖选择审计工具。', '结论必须关联到文件、行号和可复核证据，未扫描文件需单独说明。'],
  reverse: ['先确认样本格式、架构、哈希和保护特征，再进入字符串与控制流分析。', '静态结论应与可执行行为或反编译证据交叉验证。'],
  penetration: ['先确认授权范围和目标可达性，再由黑板事实推动下一步探索。', '只有外部项目进入终态且目标证据成立后，才生成完成结论。'],
  incident_response: ['先保留原始日志和时间线，再进行事件分级与影响面确认。', '高风险处置动作必须通过审批并留下可审计记录。'],
  unsupported: ['先整理输入材料和任务目标，再选择最接近的安全分析模块。', '无法自动判断的结论应保留为待人工确认，不以占位内容冒充证据。'],
}

function displayToolStatus(status) {
  if (status === 'success' || status === 'completed') return ['已完成', 'success']
  if (status === 'running') return ['执行中', 'processing']
  if (status === 'ready') return ['候选', 'blue']
  return [status || '未知', 'error']
}

function AssetUsageDrawer({ open, onClose, loading, events, experiences, run, runs }) {
  const actualTools = useMemo(() => {
    const completions = events.filter((event) => event.event_type === 'tool.completed')
    return events
      .filter((event) => event.event_type === 'tool.started' && event.payload?.tool)
      .map((event) => {
        const tool = String(event.payload.tool)
        const result = completions.find((item) => item.sequence > event.sequence && item.payload?.tool === tool)
        return {
          tool,
          description: '任务账本记录的实际工具调用',
          version: event.payload.tool_version,
          status: result?.payload?.status || 'running',
          duration: result?.payload?.duration_ms,
          timestamp: event.timestamp,
          placeholder: false,
        }
      })
  }, [events])

  const toolCalls = useMemo(() => {
    if (actualTools.length) return actualTools
    const route = run?.module_route || 'unsupported'
    return (recommendedTools[route] || recommendedTools.unsupported).map(([tool, description], index) => ({
      tool,
      description,
      version: index === 0 ? '内置适配器' : '推荐能力',
      status: 'ready',
      placeholder: true,
    }))
  }, [actualTools, run?.module_route])

  const displayExperiences = useMemo(() => {
    if (experiences.length) return experiences.slice(0, 8)
    const route = run?.module_route || 'unsupported'
    const routeLabel = assetRouteLabels[route] || route
    const completedRuns = (runs || []).filter((item) => ['completed', 'partial', 'failed', 'denied'].includes(item.status))
    const relatedRuns = completedRuns.filter((item) => item.module_route === route).slice(0, 3)
    const fromRuns = relatedRuns.map((task, index) => ({
      experience_id: `display:${task.run_id}`,
      title: `${task.name || routeLabel} · 历史任务经验`,
      summary: `根据历史${routeLabel}任务轨迹生成的展示建议：先确认输入和授权边界，再复核工具输出及关键证据。`,
      source_type: 'display',
      source_title: task.name || `历史任务 ${index + 1}`,
      confidence: 0.78,
      verified: false,
      displayOnly: true,
    }))
    if (fromRuns.length) return fromRuns
    return (fallbackExperienceTemplates[route] || fallbackExperienceTemplates.unsupported).map((summary, index) => ({
      experience_id: `scaffold:${route}:${index}`,
      title: `${routeLabel} · ${index === 0 ? '分析准备' : '结果复核'}`,
      summary,
      source_type: 'scaffold',
      source_title: '前端展示架子',
      confidence: 0.72,
      verified: false,
      displayOnly: true,
    }))
  }, [experiences, run?.module_route, runs])

  const actualToolCount = actualTools.length
  const routeLabel = assetRouteLabels[run?.module_route] || '通用安全分析'

  return <Drawer
    title={<span className="asset-drawer-title"><DatabaseOutlined /> 资产调用</span>}
    placement="right"
    width="min(480px, 100vw)"
    open={open}
    onClose={onClose}
    destroyOnHidden
  >
    <div className="asset-drawer">
      <Alert type="info" showIcon title={run ? `${routeLabel}资产视图` : '通用资产预览'} description={actualToolCount ? '工具卡来自当前任务账本；引用经验优先采用任务检索记录。' : '当前没有实际工具调用，以下内容为该模块的候选工具与经验展示架子。'} />
      <section className="asset-section">
        <header><div><Text className="panel-kicker">RUNTIME ASSETS</Text><Title level={5}>AI 使用的工具</Title></div><Tag color={actualToolCount ? 'blue' : 'default'}>{actualToolCount ? `${actualToolCount} 次实际调用` : `${toolCalls.length} 个候选工具`}</Tag></header>
        {loading && <div className="asset-empty"><ApiOutlined />正在读取任务资产，候选工具架子已就绪。</div>}
        <div className="asset-tool-list">
          {toolCalls.map((item, index) => {
            const [statusLabel, statusColor] = displayToolStatus(item.status)
            return <article className={`asset-tool-row ${item.placeholder ? 'is-display-only' : ''}`} key={`${item.tool}-${item.timestamp || 'fallback'}-${index}`}>
              <span className="asset-icon"><ApiOutlined /></span>
              <div><b>{item.tool}</b><small>{item.version || '运行时工具'}{item.duration != null ? ` · ${item.duration} ms` : ''}</small><p>{item.description}</p></div>
              <Tag color={statusColor}>{statusLabel}</Tag>
            </article>
          })}
        </div>
      </section>

      <section className="asset-section">
        <header><div><Text className="panel-kicker">RETRIEVED MEMORY</Text><Title level={5}>引用经验</Title></div><Tag color={experiences.length ? 'gold' : 'blue'}>{displayExperiences.length} 条</Tag></header>
        {loading && <div className="asset-empty"><BookOutlined />正在读取经验库，展示经验架子已就绪。</div>}
        <div className="asset-memory-list">
          {displayExperiences.map((item) => <article className={`asset-memory-row ${item.displayOnly ? 'is-display-only' : ''}`} key={item.experience_id}>
            <span className="asset-icon is-memory"><BookOutlined /></span>
            <div><b>{item.title}</b><p>{item.summary}</p><small>{item.source_type === 'manual' ? '人工经验' : `来源：${item.source_title || '历史任务'}`} · 置信度 {Math.round((item.confidence || 0) * 100)}%</small></div>
            {item.displayOnly ? <Tag>展示内容</Tag> : item.verified ? <Tag color="success">已验证</Tag> : <Tag color="warning">待复核</Tag>}
          </article>)}
        </div>
      </section>
    </div>
  </Drawer>
}

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
  const [refreshingReport, setRefreshingReport] = useState(false)
  const [experiences, setExperiences] = useState([])
  const [assetDrawerOpen, setAssetDrawerOpen] = useState(false)
  const [assetLoading, setAssetLoading] = useState(false)
  const [assetExperiences, setAssetExperiences] = useState([])
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
    const ledgerEvents = ledger.events || []
    const uniqueEvents = ledgerEvents.filter((item, index, all) => index === all.findIndex((candidate) => candidate.event_id === item.event_id || candidate.sequence === item.sequence))
    setEvents(uniqueEvents)
    lastSequence.current = Math.max(0, ...uniqueEvents.map((item) => item.sequence))
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
    if (!run?.module_route) { setExperiences([]); return undefined }
    let cancelled = false
    listExperiences({ module_route: run.module_route, limit: 200 })
      .then((data) => { if (!cancelled) setExperiences(data.experiences || []) })
      .catch(() => { if (!cancelled) setExperiences([]) })
    return () => { cancelled = true }
  }, [run?.module_route])
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
          setEvents((current) => current.some((item) => item.event_id === event.event_id || item.sequence === event.sequence)
            ? current : [...current, event].sort((a, b) => a.sequence - b.sequence))
          if ([
            'agent.completed', 'agent.failed', 'tool.started', 'tool.completed',
            'analysis.completed', 'verification.completed', 'report.generated', 'report.refreshed',
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
  const isGraphView = view === 'graph' || view === 'coverage'
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

  async function openAssetDrawer() {
    setAssetDrawerOpen(true)
    setAssetLoading(true)
    try {
      const data = await listExperiences({ module_route: run?.module_route, limit: 30 })
      const allExperiences = data.experiences || []
      const usedIds = new Set(events
        .filter((event) => event.event_type === 'knowledge.retrieved')
        .flatMap((event) => event.payload?.experience_ids || []))
      const retrieved = usedIds.size
        ? allExperiences.filter((item) => usedIds.has(item.experience_id))
        : allExperiences.slice(0, 8)
      setAssetExperiences(retrieved.length ? retrieved : allExperiences.slice(0, 8))
    } catch (error) {
      setAssetExperiences([])
      message.warning(`经验接口暂不可用，已显示候选资产架子：${error.message}`)
    } finally {
      setAssetLoading(false)
    }
  }

  async function refreshLatestResult() {
    if (!selectedId || run?.module_route !== 'penetration') return
    setRefreshingReport(true)
    try {
      await refreshRunReport(selectedId)
      await refreshSelected()
      message.success('已同步渗透模块最新结果')
    } catch (error) {
      message.error(`同步最新内容失败：${error.message}`)
    } finally {
      setRefreshingReport(false)
    }
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
    <AssetUsageDrawer open={assetDrawerOpen} onClose={() => setAssetDrawerOpen(false)} loading={assetLoading} events={events} experiences={assetExperiences} run={run} runs={runs} />
    <aside className={`glass-panel session-panel ${isGraphView ? 'is-graph-hidden' : ''}`}>
      <div className="panel-heading"><div><Text className="panel-kicker">RUNS</Text><Title level={4}>任务流程</Title></div><Button type="text" icon={<ReloadOutlined />} onClick={refreshRuns} /></div>
      <Button type="primary" icon={<PlusOutlined />} block onClick={() => setModalOpen(true)}>新建任务</Button>
      <div className="session-list">{runs.length ? runs.map((item) => <button
        type="button" key={item.run_id} className={`session-item ${selectedId === item.run_id ? 'is-active' : ''}`}
        onClick={() => setSelectedId(item.run_id)}
      ><span><b>{item.name || (item.scenario === 'unknown' ? '等待场景识别' : item.scenario)}</b><small>{item.name && item.scenario !== 'unknown' ? `${item.scenario} · ` : ''}{compactId(item.run_id)}</small></span><StatusTag status={item.status} /></button>) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无任务" />}</div>
    </aside>

    <section className={`glass-panel conversation-panel ${isGraphView ? 'is-graph' : ''}`}>
      <div className="panel-heading"><div><Text className="panel-kicker">ACTIVE RUN</Text><Title level={4}>{run ? `${run.name || run.scenario} · ${compactId(run.run_id)}` : '实时协作等待任务'}</Title></div><Space wrap>
        <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => setModalOpen(true)}>新建任务</Button>
        <Segmented size="small" value={view} onChange={setView} options={[
          { value: 'stream', label: 'AI 实时流', icon: <TeamOutlined /> },
          { value: 'graph', label: '探索路径', icon: <BranchesOutlined /> },
          { value: 'coverage', label: '资产覆盖图', icon: <DeploymentUnitOutlined /> },
          { value: 'thinking', label: '执行摘要', icon: <AuditOutlined /> },
          { value: 'result', label: '任务结果', icon: <FileTextOutlined /> },
        ]} />
        {run && <StatusTag status={run.status} />}
        {run?.module_route === 'penetration' && <Button size="small" icon={<ReloadOutlined />} loading={refreshingReport} onClick={refreshLatestResult}>刷新最新内容</Button>}
        <Button size="small" icon={<DatabaseOutlined />} onClick={openAssetDrawer}>资产调用</Button>
        <Button type="text" title="打开审计回放" icon={<AuditOutlined />} onClick={() => navigate(selectedId ? `/audit/${selectedId}` : '/audit')} />
      </Space></div>
      <div className="collaboration-strip">{network.roles.map((role, index) => <React.Fragment key={role.id}>{index > 0 && <span>→</span>}<span className={`is-${role.status}`}>{role.shortName}</span></React.Fragment>)}</div>
      <ModuleFlow run={run} events={events} />
      {run?.pending_approval && <Alert className="approval-alert" type="warning" showIcon title={`步骤 ${run.pending_approval.step_id} 等待审批`} description={<Space><Button type="primary" onClick={() => approval('approve')}>批准</Button><Button danger onClick={() => approval('deny')}>拒绝</Button></Space>} />}
      {view === 'result' && run && <Alert className="coverage-alert" type={auditCoverage?.scanned_file_count ? 'success' : 'warning'} showIcon title={auditCoverage?.scanned_file_count ? `实际审计覆盖 ${auditCoverage.scanned_file_count}/${auditCoverage.input_file_count} 个文件` : '缺少实际文件覆盖证据'} description={auditCoverage?.scanned_file_count ? `${auditCoverage.skipped_file_count || 0} 个不支持或二进制文件未扫描。` : '不能仅凭工具返回成功判定全部材料已完成审计。'} />}
      {view === 'stream' ? <RuntimeStream events={events} connected={streamConnected} active={Boolean(selectedId)} /> : view === 'graph' ? <BlackboardGraph run={run} events={events} /> : view === 'coverage' ? <AssetCoverageGraph run={run} events={events} experiences={experiences} /> : view === 'thinking' ? <AIThoughtTimeline events={events} runStatus={run?.status} downloadUrl={run ? thoughtProcessUrl(run.run_id) : ''} /> : report ? <div className="report-view">
        <div className="report-hero"><Text className="panel-kicker">安全审计报告</Text><Title level={3}>{localizePublicText(report.executive_summary)}</Title><Paragraph>{report.limitations?.map(localizePublicText).join('；') || '所有结论均已通过证据引用验证。'}</Paragraph></div>
        {report.findings?.map(localizeFinding).map((finding) => <article className="finding-card" key={finding.finding_id}><span className={`severity is-${finding.severity.toLowerCase()}`}>{severityLabels[finding.severity] || finding.severity}</span><div><b>{finding.title}</b><p>{finding.description}</p>{finding.remediation && <p className="finding-remediation"><strong>修复建议：</strong>{finding.remediation}</p>}<small>{finding.path}{finding.line ? `:${finding.line}` : ''} · 证据 {(finding.evidence_ids || []).join(', ')}</small></div></article>)}
      </div> : <Empty description={run && !['completed', 'partial', 'failed', 'denied'].includes(run.status) ? '探索路径尚未完成，结果生成已延迟' : '报告将在运行结束后生成'} />}
    </section>

    <aside className={`glass-panel inspector-panel ${isGraphView ? 'is-graph-hidden' : ''}`}>
      <div className="panel-heading"><div><Text className="panel-kicker">TASK STATUS</Text><Title level={4}>任务状态与协作</Title></div><SafetyCertificateOutlined className="heading-icon" /></div>
      <TaskStatusPanel run={run} events={events} />
      <div className="inspector-divider"><TeamOutlined /> 智能体网络</div>
      <AgentNetwork network={network} eventCount={events.length} />
      <div className="inspector-divider">模块状态</div>
      <div className="module-status-list">{modules.map((module) => <div className="module-status" key={module.id}><span><i className={module.available ? 'status-dot is-on' : 'status-dot'} />{module.name}</span><small>{module.available ? '已就绪' : '不可用'}</small></div>)}</div>
    </aside>
  </div>
}
