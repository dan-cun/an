import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AimOutlined,
  BranchesOutlined,
  BugOutlined,
  BulbOutlined,
  CheckCircleOutlined,
  ExpandOutlined,
  FileSearchOutlined,
  MinusOutlined,
  PlusOutlined,
  ReloadOutlined,
  RobotOutlined,
} from '@ant-design/icons'
import { Alert, Button, Empty, Modal, Spin, Tag, Tooltip } from 'antd'
import cytoscape from 'cytoscape'
import { getPenetrationGraph } from '../api.js'

const TYPE_META = {
  origin: { label: '起点', color: '#8da0ae', icon: <AimOutlined /> },
  goal: { label: '目标', color: '#50d5a0', icon: <CheckCircleOutlined /> },
  intent: { label: '意图', color: '#5b84ff', icon: <BranchesOutlined /> },
  worker: { label: 'Worker', color: '#55cbea', icon: <RobotOutlined /> },
  fact: { label: '事实', color: '#f2ad45', icon: <FileSearchOutlined /> },
  vulnerability: { label: '漏洞', color: '#ff5f74', icon: <BugOutlined /> },
  hypothesis: { label: '猜想', color: '#a879ff', icon: <RobotOutlined /> },
  hint: { label: '提示', color: '#cf71ff', icon: <BulbOutlined /> },
  execute: { label: '执行', color: '#55cbea', icon: <RobotOutlined /> },
}

const STATUS_LABELS = { confirmed: '已确认', exploring: '当前探索', waiting: '等待' }

function textLabel(node) {
  const meta = TYPE_META[node.type] || TYPE_META.fact
  const content = String(node.label || node.raw_id || node.id).replace(/\s+/g, ' ').trim()
  const shortened = content.length > 74 ? `${content.slice(0, 72)}…` : content
  return `${meta.label}  ·  ${node.raw_id || ''}\n${shortened}`
}

// FRONTEND CUSTOMIZATION: derive a bounded node size from the AI-produced text.
// This keeps long facts readable without allowing one node to break the LR graph.
function nodeDimensions(node) {
  const text = textLabel(node)
  const width = Math.max(220, Math.min(360, 220 + Math.ceil(text.length / 24) * 12))
  // Count wrapped lines conservatively (Chinese text is wider than ASCII) and
  // reserve vertical space for the type/id line. This prevents Cytoscape from
  // painting labels outside the rounded rectangle.
  const lines = Math.max(3, Math.min(11, text.split('\n').reduce((total, line) => total + Math.ceil(line.length / 24), 0)))
  const height = Math.max(112, Math.min(230, 56 + lines * 19))
  return { nodeWidth: width, nodeHeight: height, textMaxWidth: width - 28 }
}

// FRONTEND CUSTOMIZATION: fixed semantic columns keep the blackboard readable
// even when the backend adds branching intents or multiple facts. Nodes in one
// column are stacked with a calculated vertical gap, so cards never overlap.
const STAGE_BY_TYPE = { origin: 0, hint: 0, intent: 1, hypothesis: 1, worker: 2, fact: 3, vulnerability: 3, execute: 2, goal: 4 }
const EDGE_LABELS = { 'intent-chain': '意图链', 'worker-assignment': '执行', 'worker-output': '产出', produces: '产出', hypothesis: '猜想', hint: '提示' }
function stagedPositions(nodes) {
  const columns = new Map()
  nodes.forEach((node) => {
    const stage = STAGE_BY_TYPE[node.type] ?? 2
    if (!columns.has(stage)) columns.set(stage, [])
    columns.get(stage).push(node)
  })
  const positions = {}
  const columnGap = 430
  for (const [stage, column] of columns.entries()) {
    const ordered = [...column].sort((a, b) => String(a.raw_id || a.id).localeCompare(String(b.raw_id || b.id)))
    const heights = ordered.map((node) => node.nodeHeight || 150)
    const total = heights.reduce((sum, height) => sum + height, 0) + Math.max(0, ordered.length - 1) * 86
    let y = -total / 2
    ordered.forEach((node, index) => {
      const height = heights[index]
      positions[node.id] = { x: stage * columnGap, y: y + height / 2 }
      y += height + 86
    })
  }
  return positions
}

function fallbackGraph(run, events) {
  if (!run) return { nodes: [], edges: [] }
  const has = (type) => events.some((event) => event.event_type === type)
  const definitions = [
    { id: 'fallback:origin', raw_id: 'origin', type: 'origin', label: run.name || '上传材料', status: 'confirmed' },
    { id: 'fallback:intent', raw_id: 'intent', type: 'intent', label: `${run.routing?.primary_type || run.scenario} 分析路线`, status: has('plan.created') ? 'confirmed' : 'exploring' },
    { id: 'fallback:execute', raw_id: 'execute', type: 'execute', label: '受控模块适配器', status: has('tool.completed') ? 'confirmed' : has('tool.started') ? 'exploring' : 'waiting' },
    { id: 'fallback:fact', raw_id: 'evidence', type: 'fact', label: 'Finding / Evidence', status: has('analysis.completed') ? 'confirmed' : has('tool.completed') ? 'exploring' : 'waiting' },
    { id: 'fallback:goal', raw_id: 'goal', type: 'goal', label: '独立校验与报告', status: has('report.generated') ? 'confirmed' : has('verification.completed') ? 'exploring' : 'waiting' },
  ]
  return {
    nodes: definitions,
    edges: definitions.slice(0, -1).map((node, index) => ({
      id: `fallback-edge:${index}`,
      source: node.id,
      target: definitions[index + 1].id,
      type: index === 0 ? 'intent-chain' : 'produces',
      label: index === 0 ? '意图链' : '产出',
      status: node.status,
    })),
  }
}

function graphElements(graph) {
  const nodeElements = (graph.nodes || []).map((node) => ({
      group: 'nodes',
      data: { ...node, ...nodeDimensions(node), displayLabel: textLabel(node) },
      classes: `type-${node.type} status-${node.status || 'waiting'}`,
    }))
  const positions = stagedPositions(nodeElements.map((element) => element.data))
  nodeElements.forEach((element) => { element.position = positions[element.data.id] })
  return [
    ...nodeElements,
    ...(graph.edges || []).map((edge) => ({
      group: 'edges',
      // Keep relationship captions short; full evidence remains in the
      // double-click node modal instead of colliding with lines.
      data: { ...edge, label: EDGE_LABELS[edge.type] || String(edge.label || '').slice(0, 12) },
      classes: `edge-${edge.type} status-${edge.status || 'waiting'}`,
    })),
  ]
}

const CY_STYLE = [
  {
    selector: 'node',
    style: {
      width: 'data(nodeWidth)',
      height: 'data(nodeHeight)',
      shape: 'round-rectangle',
      'background-color': '#151c21',
      'border-width': 1.5,
      'border-color': '#45545e',
      label: 'data(displayLabel)',
      color: '#dbe6eb',
      'font-family': 'Microsoft YaHei',
      'font-size': 11,
      'font-weight': 600,
      'text-wrap': 'wrap',
      'text-max-width': 'data(textMaxWidth)',
      'text-valign': 'center',
      'text-halign': 'center',
      'line-height': 1.45,
      'overlay-opacity': 0,
    },
  },
  { selector: 'node.type-origin', style: { 'border-color': '#8da0ae', 'background-color': '#192126' } },
  { selector: 'node.type-goal', style: { 'border-color': '#50d5a0', 'background-color': '#11251f' } },
  { selector: 'node.type-intent', style: { 'border-color': '#5b84ff', 'background-color': '#141d35' } },
  { selector: 'node.type-worker', style: { 'border-color': '#55cbea', 'background-color': '#13252c' } },
  { selector: 'node.type-fact', style: { 'border-color': '#f2ad45', 'background-color': '#282015' } },
  { selector: 'node.type-vulnerability', style: { 'border-color': '#ff5f74', 'background-color': '#2d171d' } },
  { selector: 'node.type-hypothesis', style: { 'border-color': '#a879ff', 'background-color': '#221832', 'border-style': 'dashed' } },
  { selector: 'node.type-hint', style: { 'border-color': '#cf71ff', 'background-color': '#271830', 'border-style': 'dotted' } },
  { selector: 'node.type-execute', style: { 'border-color': '#55cbea', 'background-color': '#13252c' } },
  {
    selector: 'node.status-exploring',
    style: {
      'border-width': 3,
      'underlay-color': '#62d9ff',
      'underlay-opacity': 0.16,
      'underlay-padding': 10,
    },
  },
  { selector: 'node.status-waiting', style: { opacity: 0.64 } },
  {
    selector: 'node:selected',
    style: {
      'border-width': 4,
      'border-color': '#e8fbff',
      'underlay-color': '#62d9ff',
      'underlay-opacity': 0.22,
      'underlay-padding': 12,
    },
  },
  {
    selector: 'edge',
    style: {
      width: 1.8,
      'line-color': '#596d78',
      'target-arrow-color': '#596d78',
      'target-arrow-shape': 'triangle',
      'arrow-scale': 0.9,
      // Orthogonal routing keeps arrows out of node bodies in dense stages.
      'curve-style': 'taxi',
      'taxi-direction': 'horizontal',
      'taxi-turn-min-distance': 28,
      label: 'data(label)',
      color: '#718690',
      'font-size': 8,
      'text-background-color': '#090e12',
      'text-background-opacity': 0.86,
      'text-background-padding': 3,
      'text-rotation': 'autorotate',
      'overlay-opacity': 0,
    },
  },
  { selector: 'edge.edge-intent-chain', style: { 'line-color': '#627cff', 'target-arrow-color': '#627cff' } },
  { selector: 'edge.edge-worker-assignment', style: { 'line-color': '#55cbea', 'target-arrow-color': '#55cbea', 'line-style': 'dashed' } },
  { selector: 'edge.edge-worker-output', style: { 'line-color': '#55cbea', 'target-arrow-color': '#55cbea' } },
  { selector: 'edge.edge-produces', style: { 'line-color': '#e5a33e', 'target-arrow-color': '#e5a33e' } },
  { selector: 'edge.edge-hypothesis', style: { 'line-color': '#a879ff', 'target-arrow-color': '#a879ff', 'line-style': 'dashed' } },
  { selector: 'edge.edge-hint', style: { 'line-color': '#cf71ff', 'target-arrow-color': '#cf71ff', 'line-style': 'dotted' } },
  { selector: 'edge.status-waiting', style: { opacity: 0.48 } },
  { selector: 'edge:selected', style: { width: 3.5, color: '#e8fbff', 'line-color': '#62d9ff', 'target-arrow-color': '#62d9ff' } },
]

export function BlackboardGraph({ run, events = [] }) {
  const containerRef = useRef(null)
  const cyRef = useRef(null)
  const projectRef = useRef(null)
  const [remoteGraph, setRemoteGraph] = useState(null)
  const [modalNode, setModalNode] = useState(null)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const penetration = run?.module_route === 'penetration'
  const latestExplorationSequence = useMemo(
    () => [...events].reverse().find((event) => ['penetration.status', 'exploration.updated', 'exploration.completed'].includes(event.event_type))?.sequence || 0,
    [events],
  )

  const refresh = useCallback(async (quiet = false) => {
    if (!penetration || !run?.run_id) return
    if (!quiet) setRefreshing(true)
    try {
      const next = await getPenetrationGraph(run.run_id)
      setRemoteGraph(next)
      setError('')
    } catch (reason) {
      setError(reason.message || '读取渗透黑板失败')
    } finally {
      if (!quiet) setRefreshing(false)
    }
  }, [penetration, run?.run_id])

  useEffect(() => {
    setRemoteGraph(null)
    setModalNode(null)
    setError('')
    if (!penetration || !run?.run_id) return undefined
    refresh()
    const timer = window.setInterval(() => refresh(true), 3000)
    return () => window.clearInterval(timer)
  }, [penetration, run?.run_id, refresh])

  // Event-driven refresh removes the visual lag caused by waiting for the
  // three-second timer.  The timer remains as a recovery path for missed
  // events or a temporarily unavailable Cairn response.
  useEffect(() => {
    if (penetration && latestExplorationSequence) refresh(true)
  }, [penetration, latestExplorationSequence, refresh])

  const graph = useMemo(
    () => penetration ? (remoteGraph || { nodes: [], edges: [] }) : fallbackGraph(run, events),
    [penetration, remoteGraph, run, events],
  )

  const runLayout = useCallback((fit = false) => {
    const cy = cyRef.current
    if (!cy || cy.nodes().empty()) return
    cy.layout({
      // FRONTEND CUSTOMIZATION: semantic stage positions are supplied in
      // graphElements; preset layout preserves those columns and spacing.
      name: 'preset',
      padding: 80,
      animate: false,
      fit: false,
    }).run()
    if (fit) cy.fit(cy.elements(), 72)
  }, [])

  useEffect(() => {
    if (!containerRef.current || cyRef.current) return undefined
    const cy = cytoscape({
      container: containerRef.current,
      elements: [],
      style: CY_STYLE,
      minZoom: 0.15,
      maxZoom: 2.6,
      boxSelectionEnabled: true,
      selectionType: 'single',
      autoungrabify: false,
    })
    cy.on('tap', 'node', (event) => {
      cy.elements().unselect()
      event.target.select()
    })
    // FRONTEND CUSTOMIZATION: node content is intentionally shown on double-click.
    cy.on('dbltap', 'node', (event) => setModalNode({ ...event.target.data() }))
    cy.on('tap', (event) => { if (event.target === cy) cy.elements().unselect() })
    cyRef.current = cy
    return () => { cy.destroy(); cyRef.current = null }
  }, [])

  useEffect(() => {
    const cy = cyRef.current
    if (!cy) return
    const nextProject = remoteGraph?.project_id || run?.run_id || 'fallback'
    const firstForProject = projectRef.current !== nextProject
    cy.batch(() => {
      cy.elements().remove()
      cy.add(graphElements(graph))
    })
    runLayout(firstForProject)
    projectRef.current = nextProject
    setModalNode(null)
  }, [graph, remoteGraph?.project_id, run?.run_id, runLayout])

  const zoom = (factor) => {
    const cy = cyRef.current
    if (!cy) return
    const center = { x: cy.width() / 2, y: cy.height() / 2 }
    cy.zoom({ level: Math.min(2.6, Math.max(0.15, cy.zoom() * factor)), renderedPosition: center })
  }

  if (!run) return <div className="blackboard-empty"><Empty description="选择任务后显示探索路径" /></div>

  const currentMeta = modalNode ? (TYPE_META[modalNode.type] || TYPE_META.fact) : null
  const linked = !penetration || remoteGraph?.linked
  return <div className="blackboard-view penetration-blackboard">
    <header className="blackboard-header">
      <div><span>{penetration ? 'LIVE FACT - INTENT GRAPH' : 'WORKFLOW PROJECTION'}</span><b>{penetration ? 'AI 实时黑板探索模型' : '模块流程投影'}</b></div>
      <div className="blackboard-runtime-state">
        <i className={error ? 'is-error' : linked ? 'is-live' : ''} />
        <span>{error ? '渗透引擎连接异常' : linked ? `实时同步 · ${remoteGraph?.project_id || run.run_id.slice(0, 8)}` : '等待渗透项目回执'}</span>
      </div>
    </header>
    <div className="blackboard-type-legend">
      {Object.entries(TYPE_META).filter(([type]) => type !== 'execute' || !penetration).map(([type, meta]) => <span key={type}><i style={{ background: meta.color }} />{meta.label}</span>)}
      <em>滚轮缩放 · 拖拽平移 · 双击节点查看 AI 依据</em>
    </div>
    {error && <Alert className="blackboard-error" type="warning" showIcon title="实时黑板暂不可用" description={error} action={<Button size="small" onClick={() => refresh()}>重试</Button>} />}
    <div className="blackboard-graph-shell">
      <div className="blackboard-toolbar">
        <Tooltip title="缩小"><Button aria-label="缩小黑板" icon={<MinusOutlined />} onClick={() => zoom(0.82)} /></Tooltip>
        <Tooltip title="放大"><Button aria-label="放大黑板" icon={<PlusOutlined />} onClick={() => zoom(1.22)} /></Tooltip>
        <Tooltip title="适配窗口"><Button aria-label="适配黑板到窗口" icon={<ExpandOutlined />} onClick={() => cyRef.current?.fit(cyRef.current.elements(), 72)} /></Tooltip>
        <span className="blackboard-layout-badge">从左到右</span>
        {penetration && <Tooltip title="立即同步"><Button aria-label="刷新黑板" loading={refreshing} icon={<ReloadOutlined />} onClick={() => refresh()} /></Tooltip>}
      </div>
      <div className="blackboard-grid-lines" />
      <div ref={containerRef} className="blackboard-cytoscape" data-testid="penetration-blackboard-canvas" />
      {penetration && refreshing && !remoteGraph && <div className="blackboard-loading"><Spin /><span>正在读取 AI 黑板…</span></div>}
      {penetration && remoteGraph && !remoteGraph.linked && !refreshing && <div className="blackboard-loading"><RobotOutlined /><span>任务正在提交，收到 project_id 后将自动绘图</span></div>}
      {linked && graph.nodes?.length === 0 && !refreshing && <div className="blackboard-loading"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="黑板暂无节点" /></div>}
      <Modal
        open={Boolean(modalNode)}
        title={modalNode && currentMeta ? <span className="node-modal-title"><i style={{ color: currentMeta.color }}>{currentMeta.icon}</i><span>{currentMeta.label}</span><Tag>{modalNode.raw_id}</Tag></span> : null}
        footer={null}
        onCancel={() => setModalNode(null)}
        width={560}
        centered
      >
        {modalNode && <div className="node-modal-content">
          <p>{modalNode.description || modalNode.label}</p>
          <dl>
            <div><dt>状态</dt><dd>{STATUS_LABELS[modalNode.status] || modalNode.status || '未知'}</dd></div>
            <div><dt>来源</dt><dd>{modalNode.ai_generated ? 'AI 思考产出' : '题目/操作员输入'}</dd></div>
            {modalNode.creator && <div><dt>创建者</dt><dd>{modalNode.creator}</dd></div>}
            {modalNode.worker && <div><dt>执行 Worker</dt><dd>{modalNode.worker}</dd></div>}
            {modalNode.concluded_at && <div><dt>结论时间</dt><dd>{new Date(modalNode.concluded_at).toLocaleString('zh-CN')}</dd></div>}
          </dl>
        </div>}
      </Modal>
    </div>
    <footer className="blackboard-footer">
      <span><b>{graph.nodes?.length || 0}</b> 节点</span><span><b>{graph.edges?.length || 0}</b> 关系</span>
      {remoteGraph?.fetched_at && <span>最近同步 {new Date(remoteGraph.fetched_at).toLocaleTimeString('zh-CN')}</span>}
      <em>{penetration ? '图中事实、意图与猜想均来自实时黑板；仅节点类别和中文标记由前端归一化。' : '该模块非黑板架构，当前显示结构化流程投影。'}</em>
    </footer>
  </div>
}
