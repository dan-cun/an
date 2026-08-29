import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertOutlined,
  ApiOutlined,
  ArrowUpOutlined,
  CloudServerOutlined,
  DeploymentUnitOutlined,
  EnvironmentOutlined,
  FireOutlined,
  HistoryOutlined,
  RadarChartOutlined,
  SafetyCertificateOutlined,
  ToolOutlined,
} from '@ant-design/icons'
import { Button, Progress, Tag, Tooltip, Typography } from 'antd'
import { useNavigate } from 'react-router-dom'
import { getIncidentLogs, getIncidentStatus, listRuns } from '../api.js'
import { RobotWidget } from './RobotWidget.jsx'

const { Title, Text } = Typography
const fallbackTrend = [18, 24, 15, 32, 27, 39, 34]
const trendLabels = ['周一', '周二', '周三', '周四', '周五', '周六', '今日']
const sceneLabels = { code_audit: '代码审计', reverse_triage: '逆向分析', penetration_test: '渗透测试', incident_response: '应急响应' }
const sources = [{ name: '203.0.113.42', count: 31, location: '境外节点' }, { name: '198.51.100.17', count: 24, location: '匿名网络' }, { name: '192.0.2.88', count: 18, location: '测试网段' }, { name: '203.0.113.9', count: 12, location: '境外节点' }, { name: '198.51.100.44', count: 9, location: '匿名网络' }]
const assets = [{ name: '公网 API 网关', address: '10.10.2.15', count: 42, risk: '高危' }, { name: '样本分析节点', address: '10.10.3.21', count: 27, risk: '中危' }, { name: '比赛靶场服务器', address: '10.10.4.8', count: 19, risk: '中危' }, { name: '日志汇聚节点', address: '10.10.1.10', count: 11, risk: '低危' }, { name: '代码仓库', address: '10.10.1.22', count: 8, risk: '低危' }]

export function CockpitPage() {
  const navigate = useNavigate()
  const [runs, setRuns] = useState([])
  const [incident, setIncident] = useState(null)
  const [logs, setLogs] = useState([])
  const [lastUpdated, setLastUpdated] = useState(null)
  const refresh = useCallback(async () => {
    const [runData, incidentData, logData] = await Promise.allSettled([listRuns(), getIncidentStatus(), getIncidentLogs(20)])
    if (runData.status === 'fulfilled') setRuns(runData.value.runs || [])
    if (incidentData.status === 'fulfilled') setIncident(incidentData.value)
    if (logData.status === 'fulfilled') setLogs(logData.value.logs || [])
    setLastUpdated(new Date())
  }, [])
  useEffect(() => { refresh(); const timer = window.setInterval(refresh, 10000); return () => window.clearInterval(timer) }, [refresh])
  const sceneCounts = useMemo(() => {
    const counts = Object.fromEntries(Object.keys(sceneLabels).map((key) => [key, 0]))
    runs.forEach((run) => { if (run.scenario && counts[run.scenario] !== undefined) counts[run.scenario] += 1 })
    if (!runs.length) Object.assign(counts, { code_audit: 12, reverse_triage: 8, penetration_test: 6, incident_response: 9 })
    return counts
  }, [runs])
  const activeRuns = runs.filter((run) => !['completed', 'partial', 'failed', 'denied'].includes(run.status)).length
  const unresolved = (incident?.pending_approvals || 0) + runs.filter((run) => ['waiting_approval', 'failed', 'partial'].includes(run.status)).length
  const riskScore = Math.min(100, 38 + unresolved * 4 + (incident?.running ? 0 : 8))
  const totalProcessed = runs.length || 35
  const robotTask = incident?.running ? (activeRuns ? `正在编排 ${activeRuns} 个安全任务` : '正在执行环境巡检') : '点击机器人查看实时任务'

  return <div className="cockpit-page">
    <div className="cockpit-ambient"><RobotWidget task={robotTask} onInteract={refresh} /></div>
    <section className="cockpit-header"><div><Text className="panel-kicker">SECURITY OPERATIONS / COMMAND CENTER</Text><Title level={2}>安全运营驾驶舱</Title><p>统一汇聚告警、资产、任务与处置状态，实时呈现当前测试环境安全态势。</p></div><div className="cockpit-header-status"><Tag color={riskScore > 65 ? 'error' : riskScore > 45 ? 'warning' : 'success'}>风险等级 {riskScore > 65 ? '高' : riskScore > 45 ? '中' : '低'}</Tag><div className="risk-score"><span>当前风险评分</span><b>{riskScore}</b><small>/ 100</small></div></div></section>
    <section className="cockpit-top-metrics" aria-label="告警概览"><MetricButton icon={<AlertOutlined />} label="今日告警" value={logs.length || 20} hint="较昨日" trend="+12%" onClick={() => navigate('/incident-response')} /><MetricButton icon={<HistoryOutlined />} label="历史告警" value={Math.max(128, totalProcessed * 4)} hint="累计记录" onClick={() => navigate('/incident-response')} /><MetricButton icon={<SafetyCertificateOutlined />} label="未处置事件" value={unresolved || 2} hint="需要关注" tone="gold" onClick={() => navigate('/incident-response')} /></section>
    <section className="cockpit-layout">
      <aside className="cockpit-left"><article className="glass-panel cockpit-card cockpit-scenes"><PanelHeading icon={<DeploymentUnitOutlined />} kicker="SCENE DISTRIBUTION" title="四个方向的内容" /><div className="scene-list">{Object.entries(sceneLabels).map(([key, label]) => <button className="scene-row" key={key} type="button" onClick={() => navigate('/workbench')}><span><i className={`scene-dot is-${key}`} /><b>{label}</b></span><strong>{sceneCounts[key]}</strong><Progress percent={Math.min(100, sceneCounts[key] * 5)} showInfo={false} size="small" /></button>)}</div><PanelHeading icon={<RadarChartOutlined />} kicker="7-DAY TREND" title="最近七日处理趋势" /><button className="trend-chart" type="button" onClick={() => navigate('/workbench')}>{fallbackTrend.map((value, index) => <Tooltip title={`总数量：${value}`} key={trendLabels[index]}><span className="trend-column"><i style={{ height: `${value * 2.1}px` }} /><small>{trendLabels[index]}</small></span></Tooltip>)}</button></article></aside>
      <main className="cockpit-center"><div className="cockpit-center-label"><span className="robot-pulse" /> 智能运营助手 <small>{incident?.running ? '在线工作' : '待命'}</small></div><div className="robot-task-dialog"><header><span className="robot-dialog-dot" /> 实时工作任务</header><div className="robot-task-line"><b>{robotTask}</b><small>{lastUpdated ? `更新于 ${lastUpdated.toLocaleTimeString('zh-CN', { hour12: false })}` : '等待连接'}</small></div><div className="robot-task-steps"><span className="is-done">输入</span><i /><span className={activeRuns ? 'is-active' : ''}>分析</span><i /><span>验证</span><i /><span>报告</span></div></div><p className="cockpit-center-hint">点击左侧场景进入任务编排，点击上方告警进入应急响应</p></main>
      <aside className="cockpit-right"><article className="glass-panel cockpit-card cockpit-threats"><PanelHeading icon={<FireOutlined />} kicker="THREAT INTELLIGENCE" title="攻击源 Top 5" /><div className="rank-list">{sources.map((item, index) => <RankRow item={item} index={index} key={item.name} />)}</div><PanelHeading icon={<CloudServerOutlined />} kicker="TARGET ASSETS" title="被攻击资产 Top 5" /><div className="rank-list">{assets.map((item, index) => <RankRow item={item} index={index} key={item.name} asset />)}</div></article><article className="glass-panel cockpit-card cockpit-capacity"><PanelHeading icon={<ToolOutlined />} kicker="ASSET & TOOL COVERAGE" title="当前电脑的高危资产" /><div className="capacity-stats"><Capacity icon={<CloudServerOutlined />} value="3" label="高危资产" /><Capacity icon={<ApiOutlined />} value="12" label="已接入工具" /><Capacity icon={<EnvironmentOutlined />} value="28" label="在线节点" /></div><div className="coverage-bars"><div><span>资产基线覆盖</span><Progress percent={86} strokeColor="#61d8ff" /></div><div><span>日志接入覆盖</span><Progress percent={72} strokeColor="#61d59e" /></div></div></article></aside>
    </section>
    <section className="cockpit-summary"><div className="summary-icon"><ArrowUpOutlined /></div><div><Text className="panel-kicker">ONE-LINE ASSESSMENT</Text><b>当前整体风险中等，主要风险来自 3 台公网服务器的异常登录行为。</b><p>系统已完成 {totalProcessed} 个安全任务处理，{incident?.running ? '实时监测模型正在持续巡检，' : '监测模型处于待命状态，'}建议优先核查高危资产的登录来源并复核待审批处置动作。</p></div><Button type="text" onClick={refresh}>刷新态势</Button></section>
  </div>
}

function PanelHeading({ icon, kicker, title }) { return <header className="panel-heading compact-heading"><div><Text className="panel-kicker">{kicker}</Text><Title level={4}>{title}</Title></div><span className="heading-icon">{icon}</span></header> }
function MetricButton({ icon, label, value, hint, trend, tone = 'cyan', onClick }) { return <button className={`cockpit-metric is-${tone}`} type="button" onClick={onClick}><i>{icon}</i><span><small>{label}</small><b>{value}</b><em>{hint} {trend && <strong><ArrowUpOutlined />{trend}</strong>}</em></span></button> }
function Capacity({ icon, value, label }) { return <div><i>{icon}</i><span><b>{value}</b><small>{label}</small></span></div> }
function RankRow({ item, index, asset = false }) { return <div className="rank-row"><b>{String(index + 1).padStart(2, '0')}</b><span><strong>{item.name}</strong><small>{asset ? item.address : item.location}</small></span><em className={item.risk === '高危' ? 'is-danger' : ''}>{item.count}<small> 次</small></em></div> }
