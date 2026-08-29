import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  CodeOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  StopOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons'
import { Alert, App, Button, Empty, Input, Select, Tag, Typography } from 'antd'
import {
  getIncidentActions,
  getIncidentApprovals,
  getIncidentCommands,
  getIncidentLogs,
  getIncidentStatus,
  incidentEventSocketUrl,
  resolveIncidentApproval,
  startIncidentMonitor,
  stopIncidentMonitor,
  submitIncidentCommand,
} from '../api.js'

const { Title, Text } = Typography

const phaseSteps = [
  ['监测', '持续发现'],
  ['分析', '关联证据'],
  ['遏制', '审批后执行'],
  ['恢复', '验证闭环'],
]

export function IncidentResponsePage() {
  const { message } = App.useApp()
  const [status, setStatus] = useState(null)
  const [logs, setLogs] = useState([])
  const [actions, setActions] = useState([])
  const [approvals, setApprovals] = useState([])
  const [commandGroups, setCommandGroups] = useState([])
  const [command, setCommand] = useState('collect_evidence')
  const [target, setTarget] = useState('测试环境')
  const [reason, setReason] = useState('')
  const [loading, setLoading] = useState(false)
  const socketRef = useRef(null)

  const refresh = useCallback(async () => {
    try {
      const [nextStatus, nextLogs, nextActions, nextApprovals, nextCommands] = await Promise.all([
        getIncidentStatus(), getIncidentLogs(), getIncidentActions(), getIncidentApprovals(), getIncidentCommands(),
      ])
      setStatus(nextStatus)
      setLogs(nextLogs.logs || [])
      setActions(nextActions.actions || [])
      setApprovals(nextApprovals.approvals || [])
      setCommandGroups(nextCommands.groups || [])
    } catch (error) {
      message.error(`读取应急响应状态失败：${error.message}`)
    }
  }, [message])

  useEffect(() => {
    refresh()
    const timer = window.setInterval(refresh, 5000)
    let socket
    try {
      socket = new WebSocket(incidentEventSocketUrl())
      socketRef.current = socket
      socket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data)
          if (data.type === 'incident.snapshot') setStatus(data.payload)
          if (data.type === 'incident.event') {
            setLogs((items) => [data.payload, ...items.filter((item) => item.sequence !== data.payload.sequence)].slice(0, 100))
            refresh()
          }
        } catch { /* ignore malformed event */ }
      }
    } catch { /* polling remains available */ }
    return () => { window.clearInterval(timer); socket?.close(); socketRef.current = null }
  }, [refresh])

  const monitorRunning = Boolean(status?.running)
  const pendingApprovals = useMemo(() => approvals.filter((item) => item.status === 'pending'), [approvals])

  const toggleMonitor = async () => {
    setLoading(true)
    try {
      const next = monitorRunning ? await stopIncidentMonitor() : await startIncidentMonitor()
      setStatus(next)
      message.success(monitorRunning ? '监测模型已停止' : '监测模型已启动')
    } catch (error) { message.error(error.message) } finally { setLoading(false) }
  }

  const sendCommand = async () => {
    setLoading(true)
    try {
      await submitIncidentCommand({ command, target, reason })
      setReason('')
      await refresh()
      message.success('命令已提交，按风险等级进入执行或审批队列')
    } catch (error) { message.error(error.message) } finally { setLoading(false) }
  }

  const resolve = async (approvalId, decision) => {
    try { await resolveIncidentApproval(approvalId, { decision }); await refresh(); message.success(decision === 'approve' ? '命令已批准并执行' : '命令已拒绝') }
    catch (error) { message.error(error.message) }
  }

  return <div className="incident-page">
    <section className="command-hero incident-hero">
      <div><Text className="panel-kicker">INCIDENT RESPONSE / LOCAL TEST ENVIRONMENT</Text><Title level={2}>应急响应</Title><p>统一监测、证据分析、处置审批与恢复验证。高风险动作始终需要人工确认。</p></div>
      <div className="command-actions"><Tag color={monitorRunning ? 'success' : 'default'}>{monitorRunning ? 'MONITORING' : 'IDLE'}</Tag><Button type="primary" icon={monitorRunning ? <StopOutlined /> : <PlayCircleOutlined />} loading={loading} onClick={toggleMonitor}>{monitorRunning ? '停止监测' : '启动监测模型'}</Button></div>
    </section>

    <section className="incident-metrics">
      <Metric icon={<SafetyCertificateOutlined />} label="运行状态" value={monitorRunning ? 'ACTIVE' : 'IDLE'} hint={status?.safe_mode ? '安全模式已启用' : '等待连接'} />
      <Metric icon={<AlertOutlined />} label="监测事件" value={logs.length} hint={status?.last_scan_at ? `最近扫描 ${formatTime(status.last_scan_at)}` : '尚未扫描'} tone="blue" />
      <Metric icon={<ClockCircleOutlined />} label="待审批命令" value={pendingApprovals.length} hint="R2 状态变更动作" tone="gold" />
      <Metric icon={<CheckCircleOutlined />} label="已完成动作" value={actions.filter((item) => item.status === 'completed').length} hint="可审计执行记录" tone="green" />
    </section>

    <section className="incident-grid">
      <article className="glass-panel incident-monitor-card"><PanelHeading kicker="MONITORING LOG" title="监测日志" icon={<ReloadOutlined />} onClick={refresh} />
        <div className="incident-log-list">{logs.length ? logs.map((item) => <div className={`incident-log-row is-${item.level}`} key={item.sequence}><i /><div><header><b>{item.message}</b><small>{formatTime(item.timestamp)}</small></header><span>{item.phase} · {item.event_type}</span></div></div>) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="等待监测事件" />}</div>
      </article>

      <article className="glass-panel incident-flow-card"><PanelHeading kicker="RESPONSE PIPELINE" title="应急处理流程" icon={<ThunderboltOutlined />} />
        <div className="incident-flow">{phaseSteps.map(([name, hint], index) => <React.Fragment key={name}><div className={`incident-flow-node ${monitorRunning && index === 0 ? 'is-active' : index === 0 && logs.length ? 'is-done' : ''}`}><b>{String(index + 1).padStart(2, '0')}</b><span>{name}</span><small>{hint}</small></div>{index < phaseSteps.length - 1 && <div className="incident-flow-edge" />}</React.Fragment>)}</div>
        <div className="incident-action-list">{actions.length ? actions.slice(0, 6).map((item) => <div className="incident-action-row" key={item.action_id}><CodeOutlined /><span><b>{item.label}</b><small>{item.target} · {formatTime(item.created_at)}</small></span><Tag color={item.status === 'completed' ? 'success' : item.status === 'awaiting_approval' ? 'warning' : 'default'}>{actionLabel(item.status)}</Tag></div>) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无处置动作" />}</div>
      </article>

      <article className="glass-panel incident-command-card"><PanelHeading kicker="MONITORING + RESPONSE COMMANDS" title="命令面板" icon={<CodeOutlined />} />
        <div className="incident-command-form"><Alert type="info" showIcon message="选择实时监测或应急处置命令。所有动作仅作用于测试环境；高风险处置必须审批。" /><label>命令类型<Select value={command} onChange={setCommand} options={commandGroups.map((group) => ({ label: group.label, options: group.commands.map((item) => ({ value: item.value, label: `${item.label}${item.risk_level >= 2 ? '（需审批）' : '（只读）'}` })) }))} /></label><label>目标<Input value={target} onChange={(event) => setTarget(event.target.value)} /></label><label>说明<Input.TextArea rows={3} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="填写监测范围或处置原因（可选）" /></label><Button type="primary" block icon={<CodeOutlined />} loading={loading} onClick={sendCommand}>提交命令</Button></div>
      </article>

      <article className="glass-panel incident-approval-card"><PanelHeading kicker="HUMAN-IN-THE-LOOP" title="需要审批命令" icon={<PauseCircleOutlined />} /><div className="incident-approval-list">{pendingApprovals.length ? pendingApprovals.map((item) => <div className="incident-approval-row" key={item.approval_id}><div><b>{item.command}</b><small>{item.target} · 风险 R{item.risk_level}</small><p>{item.reason}</p></div><span><Button size="small" type="primary" onClick={() => resolve(item.approval_id, 'approve')}>批准</Button><Button size="small" danger onClick={() => resolve(item.approval_id, 'deny')}>拒绝</Button></span></div>) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前没有待审批命令" />}</div></article>
    </section>
  </div>
}

function PanelHeading({ kicker, title, icon, onClick }) { return <header className="panel-heading compact-heading"><div><Text className="panel-kicker">{kicker}</Text><Title level={4}>{title}</Title></div>{onClick ? <Button type="text" icon={icon} onClick={onClick} /> : <span className="heading-icon">{icon}</span>}</header> }
function Metric({ icon, label, value, hint, tone = 'cyan' }) { return <div className={`incident-metric is-${tone}`}><i>{icon}</i><span><small>{label}</small><b>{value}</b><em>{hint}</em></span></div> }
function formatTime(value) { if (!value) return '--'; try { return new Date(value).toLocaleTimeString('zh-CN', { hour12: false }) } catch { return value } }
function actionLabel(value) { return { completed: '已完成', awaiting_approval: '待审批', approved: '已批准', denied: '已拒绝', queued: '队列中' }[value] || value }
