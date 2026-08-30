import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getIncidentLogs, getIncidentStatus, listRuns } from '../api.js'
import { RobotCanvas } from './RobotCanvas.jsx'
import './cockpit.css'

const scenes = [
  ['code_audit', '代码审计'],
  ['reverse_triage', '逆向分析'],
  ['penetration_test', '渗透测试'],
  ['incident_response', '应急响应'],
]
const trend = [18, 24, 15, 32, 27, 39, 34]
const trendLabels = ['周一', '周二', '周三', '周四', '周五', '周六', '今日']
const sources = [
  ['203.0.113.42', '境外节点', 31], ['198.51.100.17', '匿名网络', 24],
  ['192.0.2.88', '测试网段', 18], ['203.0.113.9', '境外节点', 12], ['198.51.100.44', '匿名网络', 9],
]
const assets = [
  ['公网 API 网关', '10.10.2.15', 42, '高危'], ['样本分析节点', '10.10.3.21', 27, '中危'],
  ['比赛靶场服务器', '10.10.4.8', 19, '中危'], ['日志汇聚节点', '10.10.1.10', 11, '低危'], ['代码仓库', '10.10.1.22', 8, '低危'],
]

export function CockpitPage() {
  const navigate = useNavigate()
  const [runs, setRuns] = useState([])
  const [incident, setIncident] = useState({ running: true, pending_approvals: 2 })
  const [logs, setLogs] = useState([])
  const [lastUpdated, setLastUpdated] = useState(null)

  const refresh = useCallback(async () => {
    const results = await Promise.allSettled([listRuns(), getIncidentStatus(), getIncidentLogs(20)])
    if (results[0].status === 'fulfilled') setRuns(results[0].value.runs || [])
    if (results[1].status === 'fulfilled') setIncident(results[1].value)
    if (results[2].status === 'fulfilled') setLogs(results[2].value.logs || [])
    setLastUpdated(new Date())
  }, [])

  useEffect(() => {
    refresh()
    const timer = window.setInterval(refresh, 10000)
    return () => window.clearInterval(timer)
  }, [refresh])

  const counts = useMemo(() => {
    const next = Object.fromEntries(scenes.map(([key]) => [key, 0]))
    runs.forEach((run) => { if (next[run.scenario] !== undefined) next[run.scenario] += 1 })
    if (!runs.length) Object.assign(next, { code_audit: 12, reverse_triage: 8, penetration_test: 6, incident_response: 9 })
    return next
  }, [runs])
  const activeRuns = runs.filter((run) => !['completed', 'partial', 'failed', 'denied'].includes(run.status)).length
  const pending = (incident?.pending_approvals || 0) + runs.filter((run) => ['waiting_approval', 'failed', 'partial'].includes(run.status)).length
  const score = Math.min(100, 38 + pending * 4 + (incident?.running ? 0 : 8))
  const level = score > 65 ? '高' : score > 45 ? '中' : '低'
  const task = incident?.running ? (activeRuns ? `正在编排 ${activeRuns} 个安全任务` : '正在执行环境巡检') : '监测模型处于待命状态'
  const go = (path) => navigate(path)

  return <div className="hero-shell cockpit-host">
    <RobotCanvas />
    <section className="cockpit-overlay">
      <header className="cockpit-head"><div><span className="cockpit-kicker">SECURITY OPERATIONS / COMMAND CENTER</span><h1>安全运营驾驶舱</h1><p>统一汇聚告警、资产、任务与处置状态，实时呈现当前测试环境安全态势。</p></div><div className="cockpit-risk"><span>风险等级 {level}</span><b>{score}</b><small>/ 100</small></div></header>
      <div className="cockpit-metrics">
        <Metric label="今日告警" value={logs.length || 20} hint="较昨日 ↑+12%" onClick={() => go('/incident-response')} />
        <Metric label="历史告警" value={Math.max(128, (runs.length || 32) * 4)} hint="累计记录" onClick={() => go('/incident-response')} />
        <Metric label="未处置事件" value={pending || 2} hint="需要关注" tone="gold" onClick={() => go('/incident-response')} />
      </div>
      <div className="cockpit-grid">
        <aside className="cockpit-left"><section className="cockpit-card scene-card"><CardTitle kicker="SCENE DISTRIBUTION" title="四个方向的内容" icon="↗" /><div className="scene-list">{scenes.map(([key, label]) => <button className="scene-row" type="button" key={key} onClick={() => go('/workbench')}><span><i className={`dot ${key}`} />{label}</span><b>{counts[key]}</b><i className="bar"><em style={{ width: `${Math.min(100, counts[key] * 5)}%` }} /></i></button>)}</div><CardTitle kicker="7-DAY TREND" title="最近七日处理趋势" icon="↗" /><button id="cockpit-trend" className="trend-chart" type="button" onClick={() => go('/workbench')}>{trend.map((value, index) => <span title={`总数量：${value}`} key={trendLabels[index]}><i style={{ height: `${value * 2.1}px` }} /><small>{trendLabels[index]}</small></span>)}</button></section></aside>
        <main className="cockpit-center"><div className="assistant-label"><span />智能运营助手 <small>{incident?.running ? '在线工作' : '待命'}</small></div><div className="task-dialog"><header><span />实时工作任务</header><div><b>{task}</b><small>{lastUpdated ? `更新于 ${lastUpdated.toLocaleTimeString('zh-CN', { hour12: false })}` : '等待连接'}</small></div><nav><i className="done">输入</i><u /><i className={activeRuns ? 'active' : ''}>分析</i><u /><i>验证</i><u /><i>报告</i></nav></div><p className="center-hint">点击左侧场景进入任务编排，点击上方告警进入应急响应</p></main>
        <aside className="cockpit-right"><section className="cockpit-card rank-card"><CardTitle kicker="THREAT INTELLIGENCE" title="攻击源 Top 5" icon="♨" /><div className="rank-list">{sources.map((item, index) => <RankRow item={item} index={index} key={item[0]} />)}</div><CardTitle kicker="TARGET ASSETS" title="被攻击资产 Top 5" icon="▣" /><div className="rank-list">{assets.map((item, index) => <RankRow item={item} index={index} key={item[0]} asset />)}</div></section><section className="cockpit-card capacity-card"><CardTitle kicker="ASSET & TOOL COVERAGE" title="当前电脑的高危资产" icon="⌘" /><div className="capacity-list"><div><b>3</b><small>高危资产</small></div><div><b>12</b><small>已接入工具</small></div><div><b>28</b><small>在线节点</small></div></div><div className="coverage"><label>资产基线覆盖 <span><i style={{ width: '86%' }} /><b>86%</b></span></label><label>日志接入覆盖 <span><i className="green" style={{ width: '72%' }} /><b>72%</b></span></label></div></section></aside>
      </div>
      <footer className="cockpit-summary"><span>↑</span><div><i>ONE-LINE ASSESSMENT</i><b>当前整体风险中等，主要风险来自 3 台公网服务器的异常登录行为。</b><p>系统已完成 {runs.length || 35} 个安全任务处理，{incident?.running ? '实时监测模型正在持续巡检。' : '监测模型处于待命状态。'}</p></div><button type="button" onClick={refresh}>刷新态势</button></footer>
    </section>
  </div>
}

function CardTitle({ kicker, title, icon }) { return <div className="card-title"><span><i>{kicker}</i><b>{title}</b></span><em>{icon}</em></div> }
function Metric({ label, value, hint, tone = 'cyan', onClick }) { return <button className={`metric ${tone}`} type="button" onClick={onClick}><span>{label}</span><b>{value}</b><small>{hint}</small></button> }
function RankRow({ item, index, asset = false }) { return <div className="rank-row"><small>{String(index + 1).padStart(2, '0')}</small><span><b>{item[0]}</b><i>{asset ? item[1] : item[1]}</i></span><strong className={item[3] === '高危' ? 'danger' : ''}>{item[2]}<em> 次</em></strong></div> }
