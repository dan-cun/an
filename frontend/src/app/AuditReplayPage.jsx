import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  CaretRightOutlined,
  PauseOutlined,
  RedoOutlined,
  ReloadOutlined,
  StepForwardOutlined,
} from '@ant-design/icons'
import { Alert, Button, Empty, Progress, Select, Space, Spin, Tag, Typography } from 'antd'
import { useNavigate, useParams } from 'react-router-dom'
import { getLedger, getRun, listRuns, thoughtProcessUrl } from '../api.js'
import { AgentNetwork } from './AgentNetwork.jsx'
import { AIThoughtTimeline } from './AIThoughtTimeline.jsx'
import { RuntimeStream } from './RuntimeStream.jsx'
import { compactId, deriveNetwork } from './runtimeModel.js'
import { StatusTag } from './StatusTag.jsx'

const { Text, Title } = Typography
function replayDelay(events, cursor, speed) {
  if (cursor <= 0) return 0
  const previous = new Date(events[cursor - 1]?.timestamp || 0).getTime()
  const next = new Date(events[cursor]?.timestamp || 0).getTime()
  const observed = Number.isFinite(previous) && Number.isFinite(next) ? Math.max(20, next - previous) : 650
  return Math.min(3000, Math.max(20, observed / speed))
}

export function AuditReplayPage() {
  const { runId } = useParams()
  const navigate = useNavigate()
  const [runs, setRuns] = useState([])
  const [events, setEvents] = useState([])
  const [run, setRun] = useState(null)
  const [chainValid, setChainValid] = useState(null)
  const [loadingRuns, setLoadingRuns] = useState(true)
  const [loadingReplay, setLoadingReplay] = useState(false)
  const [error, setError] = useState('')
  const [cursor, setCursor] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)

  const refreshRuns = useCallback(async () => {
    setLoadingRuns(true)
    try {
      const data = await listRuns()
      setRuns((data.runs || []).filter((item) => item.status === 'completed'))
    } finally {
      setLoadingRuns(false)
    }
  }, [])

  useEffect(() => {
    refreshRuns().catch((cause) => setError(cause.message))
  }, [refreshRuns])

  useEffect(() => {
    let disposed = false
    setPlaying(false)
    setCursor(0)
    setEvents([])
    setRun(null)
    setChainValid(null)
    setError('')
    if (!runId) return () => { disposed = true }
    setLoadingReplay(true)
    Promise.all([getRun(runId), getLedger(runId)]).then(([nextRun, ledger]) => {
      if (disposed) return
      setRun(nextRun)
      setEvents((ledger.events || []).sort((left, right) => left.sequence - right.sequence))
      setChainValid(Boolean(ledger.chain_valid))
    }).catch((cause) => {
      if (!disposed) setError(cause.message)
    }).finally(() => {
      if (!disposed) setLoadingReplay(false)
    })
    return () => { disposed = true }
  }, [runId])

  useEffect(() => {
    if (!playing || !events.length) return undefined
    if (cursor >= events.length) {
      setPlaying(false)
      return undefined
    }
    const timer = window.setTimeout(() => {
      setCursor((current) => Math.min(events.length, current + 1))
    }, replayDelay(events, cursor, speed))
    return () => window.clearTimeout(timer)
  }, [playing, cursor, speed, events])

  const visibleEvents = useMemo(() => events.slice(0, cursor), [events, cursor])
  const replayStatus = cursor >= events.length ? run?.status : 'running'
  const network = useMemo(
    () => deriveNetwork(visibleEvents, replayStatus),
    [visibleEvents, replayStatus],
  )
  const progress = events.length ? Math.round(cursor / events.length * 100) : 0

  function startOrPause() {
    if (!events.length) return
    if (playing) {
      setPlaying(false)
      return
    }
    if (cursor >= events.length) setCursor(0)
    setPlaying(true)
  }

  function reset() {
    setPlaying(false)
    setCursor(0)
  }

  function step() {
    setPlaying(false)
    setCursor((current) => Math.min(events.length, current + 1))
  }

  return <div className="replay-workspace">
    <aside className="glass-panel replay-run-panel">
      <div className="panel-heading">
        <div><Text className="panel-kicker">COMPLETED RUNS</Text><Title level={4}>已完成任务流程</Title></div>
        <Button type="text" icon={<ReloadOutlined />} loading={loadingRuns} onClick={() => refreshRuns().catch((cause) => setError(cause.message))} />
      </div>
      <div className="replay-run-list">
        {runs.length ? runs.map((item) => <button
          type="button"
          key={item.run_id}
          className={`session-item ${runId === item.run_id ? 'is-active' : ''}`}
          onClick={() => navigate(`/audit/${item.run_id}`)}
        >
          <span>
            <b>{item.name || (item.scenario === 'unknown' ? '未命名任务' : item.scenario)}</b>
            <small>{item.scenario !== 'unknown' ? `${item.scenario} · ` : ''}{compactId(item.run_id)}</small>
          </span>
          <StatusTag status={item.status} />
        </button>) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无已完成任务" />}
      </div>
    </aside>

    <main className="replay-main">
      {error && <Alert type="error" showIcon closable title="无法读取审计回放" description={error} onClose={() => setError('')} />}
      {!runId ? <div className="glass-panel replay-empty"><Empty description="请从左侧选择一个已完成任务，然后点击启动进行流程回放" /></div>
        : loadingReplay ? <div className="glass-panel replay-empty"><Spin /> 正在读取持久化账本…</div>
          : !events.length ? <div className="glass-panel replay-empty"><Empty description="该任务没有可回放的账本事件" /></div>
            : <>
              <div className="page-intro replay-intro">
                <div>
                  <Text className="panel-kicker">AUDIT PROCESS REPLAY</Text>
                  <Title level={2}>{run?.name || run?.scenario || '任务流程回放'}</Title>
                  <p>按照首次运行的事件顺序和相对时间同步重放 AI 实时流、AI 协作图与执行摘要。</p>
                </div>
                <div className="intro-tags">
                  <Tag color={chainValid ? 'success' : 'error'}>{chainValid ? '账本链校验通过' : '账本链校验失败'}</Tag>
                  <Tag>{run?.scenario} · {compactId(runId)}</Tag>
                </div>
              </div>

              <section className="glass-panel playback-bar">
                <Space wrap>
                  <Button type="primary" icon={playing ? <PauseOutlined /> : <CaretRightOutlined />} onClick={startOrPause}>
                    {playing ? '暂停' : cursor > 0 && cursor < events.length ? '继续' : '启动'}
                  </Button>
                  <Button icon={<StepForwardOutlined />} onClick={step} disabled={cursor >= events.length}>单步</Button>
                  <Button icon={<RedoOutlined />} onClick={reset}>重新开始</Button>
                  <Select value={speed} onChange={setSpeed} options={[0.5, 1, 2, 4, 8].map((value) => ({ value, label: `${value}×` }))} />
                </Space>
                <div className="playback-progress">
                  <Progress percent={progress} showInfo={false} strokeColor={{ from: '#55d9ff', to: '#a979ff' }} />
                  <span>{cursor} / {events.length} 个事件 · {progress}%</span>
                </div>
              </section>

              <div className="replay-stage-grid">
                <section className="glass-panel replay-stage is-stream">
                  <div className="panel-heading"><div><Text className="panel-kicker">LIVE STREAM REPLAY</Text><Title level={4}>AI 实时流</Title></div><Tag color={playing ? 'processing' : cursor >= events.length ? 'success' : 'default'}>{playing ? '回放中' : cursor >= events.length ? '已完成' : '等待启动'}</Tag></div>
                  <RuntimeStream events={visibleEvents} replaying={playing} replay />
                </section>
                <section className="glass-panel replay-stage is-network">
                  <div className="panel-heading"><div><Text className="panel-kicker">AGENT COLLABORATION</Text><Title level={4}>AI 协作图</Title></div><Tag>{network.completed} / {network.roles.length}</Tag></div>
                  <AgentNetwork network={network} eventCount={visibleEvents.length} />
                </section>
                <section className="glass-panel replay-stage is-summary">
                  <div className="panel-heading"><div><Text className="panel-kicker">EXECUTION SUMMARY</Text><Title level={4}>执行摘要</Title></div><Tag color={cursor >= events.length ? 'success' : 'processing'}>{cursor >= events.length ? '流程已重现' : '随回放更新'}</Tag></div>
                  <AIThoughtTimeline events={visibleEvents} runStatus={replayStatus} downloadUrl={cursor >= events.length ? thoughtProcessUrl(runId) : ''} />
                </section>
              </div>
            </>}
    </main>
  </div>
}
