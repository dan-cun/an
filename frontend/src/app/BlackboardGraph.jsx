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
import { Alert, Button, Empty, Select, Spin, Tag, Tooltip } from 'antd'
import cytoscape from 'cytoscape'
import dagre from 'cytoscape-dagre'
import { getPenetrationGraph } from '../api.js'

cytoscape.use(dagre)

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
  return [
    ...(graph.nodes || []).map((node) => ({
      group: 'nodes',
      data: { ...node, displayLabel: textLabel(node) },
      classes: `type-${node.type} status-${node.status || 'waiting'}`,
    })),
    ...(graph.edges || []).map((edge) => ({
      group: 'edges',
      data: edge,
      classes: `edge-${edge.type} status-${edge.status || 'waiting'}`,
    })),
  ]
}

const CY_STYLE = [
  {
    selector: 'node',
    style: {
      width: 210,
      height: 96,
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
      'text-max-width': 180,
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
      'curve-style': 'bezier',
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
  const [selectedNode, setSelectedNode] = useState(null)
  const [direction, setDirection] = useState('LR')
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const penetration = run?.module_route === 'penetration'

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
    setSelectedNode(null)
    setError('')
    if (!penetration || !run?.run_id) return undefined
    refresh()
    const timer = window.setInterval(() => refresh(true), 3000)
    return () => window.clearInterval(timer)
  }, [penetration, run?.run_id, refresh])

  const graph = useMemo(
    () => penetration ? (remoteGraph || { nodes: [], edges: [] }) : fallbackGraph(run, events),
    [penetration, remoteGraph, run, events],
  )

  const runLayout = useCallback((fit = false) => {
    const cy = cyRef.current
    if (!cy || cy.nodes().empty()) return
    cy.layout({
      name: 'dagre',
      rankDir: direction,
      nodeSep: 32,
      rankSep: 80,
      edgeSep: 18,
      padding: 80,
      animate: false,
      fit: false,
    }).run()
    if (fit) cy.fit(cy.elements(), 72)
  }, [direction])

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
    cy.on('tap', 'node', (event) => setSelectedNode({ ...event.target.data() }))
    cy.on('tap', (event) => { if (event.target === cy) setSelectedNode(null) })
    cyRef.current = cy
    return () => { cy.destroy(); cyRef.current = null }
  }, [])

  useEffect(() => {
    const cy = cyRef.current
    if (!cy) return
    const nextProject = remoteGraph?.project_id || run?.run_id || 'fallback'
    const firstForProject = projectRef.current !== nextProject
    const selectedId = selectedNode?.id
    cy.batch(() => {
      cy.elements().remove()
      cy.add(graphElements(graph))
    })
    runLayout(firstForProject)
    if (selectedId) {
      const selected = cy.getElementById(selectedId)
      if (selected.nonempty()) selected.select()
      else setSelectedNode(null)
    }
    projectRef.current = nextProject
  }, [graph, remoteGraph?.project_id, run?.run_id, runLayout])

  useEffect(() => { runLayout(true) }, [direction, runLayout])

  const zoom = (factor) => {
    const cy = cyRef.current
    if (!cy) return
    const center = { x: cy.width() / 2, y: cy.height() / 2 }
    cy.zoom({ level: Math.min(2.6, Math.max(0.15, cy.zoom() * factor)), renderedPosition: center })
  }

  if (!run) return <div className="blackboard-empty"><Empty description="选择任务后显示探索路径" /></div>

  const currentMeta = selectedNode ? (TYPE_META[selectedNode.type] || TYPE_META.fact) : null
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
      <em>滚轮缩放 · 拖拽平移 · 点击节点查看 AI 依据</em>
    </div>
    {error && <Alert className="blackboard-error" type="warning" showIcon title="实时黑板暂不可用" description={error} action={<Button size="small" onClick={() => refresh()}>重试</Button>} />}
    <div className="blackboard-graph-shell">
      <div className="blackboard-toolbar">
        <Tooltip title="缩小"><Button aria-label="缩小黑板" icon={<MinusOutlined />} onClick={() => zoom(0.82)} /></Tooltip>
        <Tooltip title="放大"><Button aria-label="放大黑板" icon={<PlusOutlined />} onClick={() => zoom(1.22)} /></Tooltip>
        <Tooltip title="适配窗口"><Button aria-label="适配黑板到窗口" icon={<ExpandOutlined />} onClick={() => cyRef.current?.fit(cyRef.current.elements(), 72)} /></Tooltip>
        <Select aria-label="黑板布局方向" value={direction} onChange={setDirection} options={[{ value: 'LR', label: '从左到右' }, { value: 'TB', label: '从上到下' }]} />
        {penetration && <Tooltip title="立即同步"><Button aria-label="刷新黑板" loading={refreshing} icon={<ReloadOutlined />} onClick={() => refresh()} /></Tooltip>}
      </div>
      <div className="blackboard-grid-lines" />
      <div ref={containerRef} className="blackboard-cytoscape" data-testid="penetration-blackboard-canvas" />
      {penetration && refreshing && !remoteGraph && <div className="blackboard-loading"><Spin /><span>正在读取 AI 黑板…</span></div>}
      {penetration && remoteGraph && !remoteGraph.linked && !refreshing && <div className="blackboard-loading"><RobotOutlined /><span>任务正在提交，收到 project_id 后将自动绘图</span></div>}
      {linked && graph.nodes?.length === 0 && !refreshing && <div className="blackboard-loading"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="黑板暂无节点" /></div>}
      <aside className={`blackboard-node-detail ${selectedNode ? 'is-open' : ''}`}>
        {selectedNode ? <>
          <div className="node-detail-heading"><i style={{ color: currentMeta.color }}>{currentMeta.icon}</i><span><small>NODE DETAIL</small><b>{currentMeta.label}</b></span><Tag>{selectedNode.raw_id}</Tag></div>
          <p>{selectedNode.description || selectedNode.label}</p>
          <dl>
            <div><dt>状态</dt><dd>{STATUS_LABELS[selectedNode.status] || selectedNode.status}</dd></div>
            <div><dt>来源</dt><dd>{selectedNode.ai_generated ? 'AI 思考产出' : '题目/操作员输入'}</dd></div>
            {selectedNode.creator && <div><dt>创建者</dt><dd>{selectedNode.creator}</dd></div>}
            {selectedNode.worker && <div><dt>执行 Worker</dt><dd>{selectedNode.worker}</dd></div>}
            {selectedNode.concluded_at && <div><dt>结论时间</dt><dd>{new Date(selectedNode.concluded_at).toLocaleString('zh-CN')}</dd></div>}
          </dl>
        </> : <div className="node-detail-empty"><BranchesOutlined /><b>选择一个节点</b><span>查看事实来源、AI 意图、执行状态与结论时间</span></div>}
      </aside>
    </div>
    <footer className="blackboard-footer">
      <span><b>{graph.nodes?.length || 0}</b> 节点</span><span><b>{graph.edges?.length || 0}</b> 关系</span>
      {remoteGraph?.fetched_at && <span>最近同步 {new Date(remoteGraph.fetched_at).toLocaleTimeString('zh-CN')}</span>}
      <em>{penetration ? '图中事实、意图与猜想均来自实时黑板；仅节点类别和中文标记由前端归一化。' : '该模块非黑板架构，当前显示结构化流程投影。'}</em>
    </footer>
  </div>
}
