import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  DeploymentUnitOutlined,
  ExpandOutlined,
  MinusOutlined,
  PlusOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  SearchOutlined,
} from '@ant-design/icons'
import { Alert, Button, Empty, Select, Spin, Tag, Tooltip } from 'antd'
import cytoscape from 'cytoscape'
import dagre from 'cytoscape-dagre'
import { getPenetrationGraph } from '../api.js'

cytoscape.use(dagre)

const ASSET_META = {
  company: { label: '公司', color: '#7d8da3', icon: '◈' },
  domain: { label: '根域名', color: '#6f85ff', icon: '◎' },
  subdomain: { label: '子域名', color: '#5fc8f1', icon: '⌁' },
  ip: { label: 'IP', color: '#8c9aae', icon: '⌗' },
  service: { label: '服务', color: '#f0ae4f', icon: '◉' },
  app: { label: 'App', color: '#cf68ea', icon: '▣' },
  endpoint: { label: '端点', color: '#f36c87', icon: '↗' },
  artifact: { label: '文件/证据', color: '#61d59b', icon: '▤' },
}

const CY_STYLE = [
  { selector: 'node', style: { width: 196, height: 84, shape: 'round-rectangle', 'background-color': '#111a20', 'border-width': 1.5, 'border-color': '#41515d', label: 'data(displayLabel)', color: '#dce8ed', 'font-family': 'Microsoft YaHei', 'font-size': 11, 'font-weight': 600, 'text-wrap': 'wrap', 'text-max-width': 172, 'text-valign': 'center', 'text-halign': 'center', 'line-height': 1.55, 'overlay-opacity': 0 } },
  ...Object.entries(ASSET_META).map(([type, meta]) => ({ selector: `node.type-${type}`, style: { 'border-color': meta.color, 'background-color': `${meta.color}18` } })),
  { selector: 'node.status-scoped', style: { opacity: 0.58, 'border-style': 'dashed' } },
  { selector: 'node.status-discovered', style: { 'underlay-color': '#63d8ff', 'underlay-opacity': 0.08, 'underlay-padding': 5 } },
  { selector: 'node:selected', style: { 'border-width': 3, 'border-color': '#eaffff', 'underlay-color': '#62d9ff', 'underlay-opacity': 0.2, 'underlay-padding': 9 } },
  { selector: 'edge', style: { width: 1.5, 'line-color': '#4c6874', 'target-arrow-color': '#4c6874', 'target-arrow-shape': 'triangle', 'arrow-scale': 0.75, 'curve-style': 'bezier', label: 'data(label)', color: '#78909b', 'font-size': 8, 'text-background-color': '#090f13', 'text-background-opacity': 0.82, 'text-background-padding': 2, 'text-rotation': 'autorotate', 'overlay-opacity': 0 } },
  { selector: 'edge.edge-includes', style: { 'line-color': '#617cff', 'target-arrow-color': '#617cff' } },
  { selector: 'edge.edge-serves', style: { 'line-color': '#e6a54a', 'target-arrow-color': '#e6a54a' } },
  { selector: 'edge.edge-exposes', style: { 'line-color': '#ec6680', 'target-arrow-color': '#ec6680' } },
  { selector: 'edge:selected', style: { width: 3, color: '#efffff', 'line-color': '#62d9ff', 'target-arrow-color': '#62d9ff' } },
]

const CY_LIGHT_STYLE = [
  { selector: 'node', style: { 'background-color': '#ffffff', 'border-color': '#b8cbd8', color: '#284257', 'text-background-color': '#ffffff', 'text-background-opacity': 0.9 } },
  { selector: 'node.type-company', style: { 'background-color': '#f2f5f8', 'border-color': '#8fa3b6' } },
  { selector: 'node.type-domain', style: { 'background-color': '#eef2ff', 'border-color': '#6079e8' } },
  { selector: 'node.type-subdomain', style: { 'background-color': '#ebf9ff', 'border-color': '#42add5' } },
  { selector: 'node.type-ip', style: { 'background-color': '#f1f4f7', 'border-color': '#8394a7' } },
  { selector: 'node.type-service', style: { 'background-color': '#fff8e8', 'border-color': '#db9a32' } },
  { selector: 'node.type-app', style: { 'background-color': '#fff0fc', 'border-color': '#bc59d9' } },
  { selector: 'node.type-endpoint', style: { 'background-color': '#fff1f4', 'border-color': '#d95270' } },
  { selector: 'node.type-artifact', style: { 'background-color': '#effbf5', 'border-color': '#4cae7d' } },
  { selector: 'edge', style: { 'line-color': '#8ea6b5', 'target-arrow-color': '#8ea6b5', color: '#61798a', 'text-background-color': '#f8fbfd' } },
  { selector: 'edge.edge-includes', style: { 'line-color': '#6079e8', 'target-arrow-color': '#6079e8' } },
  { selector: 'edge.edge-serves', style: { 'line-color': '#db9a32', 'target-arrow-color': '#db9a32' } },
  { selector: 'edge.edge-exposes', style: { 'line-color': '#d95270', 'target-arrow-color': '#d95270' } },
  { selector: 'node:selected', style: { 'border-color': '#1677b8', 'underlay-color': '#56bde3' } },
]

function trimTarget(value) { return String(value || '').replace(/[),.;，。；）】\]}]+$/g, '') }
function strings(value, output = []) {
  if (value === null || value === undefined) return output
  if (typeof value === 'string' || typeof value === 'number') output.push(String(value))
  else if (Array.isArray(value)) value.forEach((item) => strings(item, output))
  else if (typeof value === 'object') Object.values(value).forEach((item) => strings(item, output))
  return output
}
function extractUrls(values) {
  const found = new Set()
  const pattern = /https?:\/\/[^\s"'<>]+/gi
  strings(values).forEach((value) => { for (const match of String(value).matchAll(pattern)) { const target = trimTarget(match[0]); try { if (new URL(target).hostname) found.add(target) } catch { /* incomplete model text */ } } })
  return [...found]
}
function rootDomain(host) { const labels = host.split('.').filter(Boolean); return labels.length > 2 ? labels.slice(-2).join('.') : host }
function isIp(host) { return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(host) }
function addNode(nodes, node) {
  const existing = nodes.get(node.id)
  if (!existing) nodes.set(node.id, { ...node, sources: [...new Set(node.sources || [])] })
  else { existing.sources = [...new Set([...(existing.sources || []), ...(node.sources || [])])]; existing.status = existing.status === 'discovered' || node.status === 'discovered' ? 'discovered' : existing.status; if (node.description && !existing.description) existing.description = node.description }
  return nodes.get(node.id)
}
function addEdge(edges, source, target, type, label) { const id = `${source}->${target}`; if (!edges.has(id)) edges.set(id, { id, source, target, type, label }) }

function addUrlGraph(nodes, edges, rawUrl, source, discovered = true) {
  let parsed
  try { parsed = new URL(rawUrl) } catch { return }
  const host = parsed.hostname.toLowerCase(); const root = rootDomain(host); const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80')
  const companyId = `company:${root}`; const hostId = `${isIp(host) ? 'ip' : host === root ? 'domain' : 'subdomain'}:${host}`; const serviceId = `service:${host}:${port}`
  const firstPath = parsed.pathname.split('/').filter(Boolean)[0]; const appId = firstPath ? `app:${host}:${firstPath}` : null; const path = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname : '/'; const endpointId = `endpoint:${parsed.protocol}//${host}:${port}${path}`
  addNode(nodes, { id: companyId, rawId: root, type: 'company', label: '授权目标', description: `授权范围根域名：${root}`, status: discovered ? 'discovered' : 'scoped', sources: [source] })
  addNode(nodes, { id: hostId, rawId: host, type: isIp(host) ? 'ip' : host === root ? 'domain' : 'subdomain', label: host, description: `主机 ${host}`, status: discovered ? 'discovered' : 'scoped', sources: [source] })
  addNode(nodes, { id: serviceId, rawId: port, type: 'service', label: `${parsed.protocol.replace(':', '').toUpperCase()} : ${port}`, description: `服务 ${parsed.protocol}//${host}:${port}`, status: discovered ? 'discovered' : 'scoped', sources: [source] })
  if (host === root || isIp(host)) addEdge(edges, companyId, hostId, 'includes', '包含')
  else { const domainId = `domain:${root}`; addNode(nodes, { id: domainId, rawId: root, type: 'domain', label: root, description: `根域名 ${root}`, status: discovered ? 'discovered' : 'scoped', sources: [source] }); addEdge(edges, companyId, domainId, 'includes', '包含'); addEdge(edges, domainId, hostId, 'includes', '解析到') }
  addEdge(edges, hostId, serviceId, 'serves', '提供')
  if (appId) { addNode(nodes, { id: appId, rawId: firstPath, type: 'app', label: `/${firstPath}`, description: `应用入口 /${firstPath}`, status: discovered ? 'discovered' : 'scoped', sources: [source] }); addEdge(edges, serviceId, appId, 'serves', '承载'); addEdge(edges, appId, endpointId, 'exposes', '暴露') } else addEdge(edges, serviceId, endpointId, 'exposes', '暴露')
  addNode(nodes, { id: endpointId, rawId: path, type: 'endpoint', label: path, description: rawUrl, status: discovered ? 'discovered' : 'scoped', sources: [source] })
}

function explicitCoverageRecords(coverage) {
  if (!coverage || typeof coverage !== 'object') return []
  const keys = ['assets', 'nodes', 'targets', 'services', 'endpoints', 'hosts', 'scanned_files', 'skipped_files']
  return keys.flatMap((key) => (Array.isArray(coverage[key]) ? coverage[key].map((item) => ({ item, key })) : []))
}
function deriveAssetGraph(run, events, experiences, remoteGraph) {
  const nodes = new Map(); const edges = new Map(); const sources = { tool: 0, ledger: 0, experience: 0, penetration: 0 }
  const completed = events.filter((event) => event.event_type === 'tool.completed')
  const coverages = completed.map((event) => event.payload?.coverage).filter(Boolean)
  sources.tool = coverages.length
  coverages.forEach((coverage) => explicitCoverageRecords(coverage).forEach(({ item, key }) => {
    const text = strings(item); const urls = extractUrls(text)
    urls.forEach((url) => addUrlGraph(nodes, edges, url, 'tool', true))
    if (!urls.length && (typeof item === 'string' || typeof item === 'number')) { const id = `artifact:${key}:${String(item)}`; addNode(nodes, { id, rawId: String(item), type: 'artifact', label: String(item), description: `工具回执中的 ${key}`, status: 'discovered', sources: ['tool'] }) }
    sources.tool += 1
  }))
  // Some tools expose a single target_url/host or nest assets under a
  // provider-specific key instead of the conventional arrays above.  Keep
  // those real coverage values in the graph as well.
  extractUrls(coverages).forEach((url) => addUrlGraph(nodes, edges, url, 'tool', true))
  // The event list is the ledger projection supplied by Workbench.  Include
  // every event (including tool.completed) so asset references emitted by a
  // completion record are not lost when coverage uses a provider-specific
  // shape.
  const ledgerValues = events.map((event) => event.payload || {})
  extractUrls(ledgerValues).forEach((url) => addUrlGraph(nodes, edges, url, 'ledger', true))
  if (ledgerValues.length) sources.ledger = ledgerValues.length
  ;(experiences || []).forEach((experience) => { const urls = extractUrls([experience.title, experience.summary, experience.tags, experience.steps, experience.tools]); urls.forEach((url) => addUrlGraph(nodes, edges, url, 'experience', false)); if (urls.length) sources.experience += 1 })
  ;(remoteGraph?.nodes || []).forEach((item) => { const type = ASSET_META[item.type] ? item.type : 'artifact'; addNode(nodes, { ...item, id: String(item.id), rawId: item.rawId || item.id, type, label: item.label || item.name || item.id, description: item.description || item.label, status: item.status === 'scoped' ? 'scoped' : 'discovered', sources: ['penetration'] }); sources.penetration += 1 })
  ;(remoteGraph?.edges || []).forEach((edge) => addEdge(edges, String(edge.source), String(edge.target), edge.type || 'includes', edge.label || '关联'))
  const stats = coverages.reduce((out, item) => { Object.entries(item || {}).forEach(([key, value]) => { if (/count$/.test(key) && Number.isFinite(Number(value))) out[key] = Math.max(out[key] || 0, Number(value)) }); return out }, {})
  return { nodes: [...nodes.values()], edges: [...edges.values()], stats, sources }
}
function displayLabel(node) { const meta = ASSET_META[node.type] || ASSET_META.artifact; const value = String(node.label || node.rawId || '').replace(/\s+/g, ' ').trim(); const shortened = value.length > 31 ? `${value.slice(0, 29)}…` : value; const heading = node.type === 'company' ? '授权目标' : node.type === 'service' ? 'Web 服务' : node.type === 'endpoint' ? '接口端点' : meta.label; const detail = node.type === 'company' ? node.rawId || '当前任务' : node.type === 'service' ? shortened.replace(' : ', ' · ') : node.type === 'endpoint' ? shortened === '/' ? '首页  /' : shortened : shortened; return `${meta.icon}  ${heading}\n${detail}` }

export function AssetCoverageGraph({ run, events = [], experiences = [] }) {
  const containerRef = useRef(null); const cyRef = useRef(null); const [remoteGraph, setRemoteGraph] = useState(null); const [selectedNode, setSelectedNode] = useState(null); const [direction, setDirection] = useState('LR'); const [refreshing, setRefreshing] = useState(false); const [error, setError] = useState(''); const [isLight, setIsLight] = useState(() => typeof document !== 'undefined' && document.body.classList.contains('light-theme')); const penetration = run?.module_route === 'penetration'
  const refresh = useCallback(async (quiet = false) => { if (!penetration || !run?.run_id) return; if (!quiet) setRefreshing(true); try { setRemoteGraph(await getPenetrationGraph(run.run_id)); setError('') } catch (reason) { setError(reason.message || '读取资产覆盖数据失败') } finally { if (!quiet) setRefreshing(false) } }, [penetration, run?.run_id])
  useEffect(() => { setRemoteGraph(null); setSelectedNode(null); setError(''); if (!penetration || !run?.run_id) return undefined; refresh(); const timer = window.setInterval(() => refresh(true), 5000); return () => window.clearInterval(timer) }, [penetration, run?.run_id, refresh])
  useEffect(() => { const observer = new MutationObserver(() => setIsLight(document.body.classList.contains('light-theme'))); observer.observe(document.body, { attributes: true, attributeFilter: ['class'] }); return () => observer.disconnect() }, [])
  const graph = useMemo(() => deriveAssetGraph(run, events, experiences, remoteGraph), [run, events, experiences, remoteGraph]); const counts = useMemo(() => graph.nodes.reduce((result, node) => { result[node.type] = (result[node.type] || 0) + 1; return result }, {}), [graph.nodes]); const discoveredCount = graph.nodes.filter((node) => node.status === 'discovered').length; const coverage = graph.stats.scanned_file_count !== undefined && graph.stats.input_file_count ? Math.round((graph.stats.scanned_file_count / graph.stats.input_file_count) * 100) : graph.nodes.length ? Math.round((discoveredCount / graph.nodes.length) * 100) : 0
  const layout = useCallback((fit = false) => { const cy = cyRef.current; if (!cy || cy.nodes().empty()) return; cy.layout({ name: 'dagre', rankDir: direction, nodeSep: 36, rankSep: 64, edgeSep: 18, padding: 86, animate: false, fit: false }).run(); if (fit) cy.fit(cy.elements(), 76) }, [direction])
  useEffect(() => { if (!containerRef.current || cyRef.current) return undefined; const cy = cytoscape({ container: containerRef.current, elements: [], style: CY_STYLE, minZoom: 0.2, maxZoom: 2.8, selectionType: 'single' }); cy.on('tap', 'node', (event) => setSelectedNode({ ...event.target.data() })); cy.on('tap', (event) => { if (event.target === cy) setSelectedNode(null) }); cyRef.current = cy; return () => { cy.destroy(); cyRef.current = null } }, [])
  useEffect(() => { cyRef.current?.style([...CY_STYLE, ...(isLight ? CY_LIGHT_STYLE : [])]) }, [isLight])
  useEffect(() => { const cy = cyRef.current; if (!cy) return; cy.batch(() => { cy.elements().remove(); cy.add([...graph.nodes.map((node) => ({ group: 'nodes', data: { ...node, displayLabel: displayLabel(node) }, classes: `type-${node.type} status-${node.status}` })), ...graph.edges.map((edge) => ({ group: 'edges', data: edge, classes: `edge-${edge.type}` }))]) }); layout(true); if (selectedNode) { const selected = cy.getElementById(selectedNode.id); if (selected.nonempty()) selected.select(); else setSelectedNode(null) } }, [graph, layout])
  useEffect(() => { layout(true) }, [direction, layout]); useEffect(() => { const frame = window.requestAnimationFrame(() => { cyRef.current?.resize(); if (cyRef.current?.elements().nonempty()) cyRef.current.fit(cyRef.current.elements(), 76) }); return () => window.cancelAnimationFrame(frame) }, [selectedNode])
  const zoom = (factor) => { const cy = cyRef.current; if (cy) cy.zoom({ level: Math.min(2.8, Math.max(0.2, cy.zoom() * factor)), renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } }) }
  if (!run) return <div className="blackboard-empty"><Empty description="选择任务后显示资产覆盖图" /></div>
  const meta = selectedNode ? (ASSET_META[selectedNode.type] || ASSET_META.artifact) : null
  return <div className="asset-coverage-view"><header className="asset-coverage-header"><div><span>ASSET COVERAGE MAP</span><b>资产覆盖图</b><small>数据来源：工具回执 {graph.sources.tool} · Ledger {graph.sources.ledger} · 经验库 {graph.sources.experience}{penetration ? ` · 渗透服务 ${graph.sources.penetration}` : ''}</small></div><div className="asset-coverage-state"><i className={error ? 'is-error' : 'is-live'} />{error ? '数据同步异常' : `实时投影 · ${run.run_id.slice(0, 8)}`}</div></header><div className="asset-coverage-legend"><div className="asset-coverage-legend-title"><SafetyCertificateOutlined /><span>资产 {graph.nodes.length} · 已测 {discoveredCount}</span><b>{coverage}%</b></div><div className="asset-coverage-legend-items">{Object.entries(ASSET_META).map(([type, item]) => <span key={type}><i style={{ background: item.color }} />{item.label}<b>{counts[type] || 0}</b></span>)}</div><small>滚轮缩放 · 拖拽平移 · 点击节点查看详情</small></div>{error && <Alert className="asset-coverage-error" type="warning" showIcon title="资产数据暂不可用" description={error} action={<Button size="small" onClick={() => refresh()}>重试</Button>} />}<div className={`asset-coverage-shell ${selectedNode ? 'has-selection' : ''}`}><div className="asset-coverage-toolbar"><Tooltip title="缩小"><Button aria-label="缩小资产图" icon={<MinusOutlined />} onClick={() => zoom(.82)} /></Tooltip><Tooltip title="放大"><Button aria-label="放大资产图" icon={<PlusOutlined />} onClick={() => zoom(1.22)} /></Tooltip><Tooltip title="适配窗口"><Button aria-label="适配资产图到窗口" icon={<ExpandOutlined />} onClick={() => cyRef.current?.fit(cyRef.current.elements(), 70)} /></Tooltip><Select aria-label="资产图布局方向" value={direction} onChange={setDirection} options={[{ value: 'LR', label: '从左到右' }, { value: 'TB', label: '从上到下' }]} />{penetration && <Tooltip title="立即同步"><Button aria-label="刷新资产图" loading={refreshing} icon={<ReloadOutlined />} onClick={() => refresh()} /></Tooltip>}</div><div className="asset-coverage-grid-lines" /><div ref={containerRef} className="asset-coverage-cytoscape" data-testid="asset-coverage-canvas" />{!selectedNode && <div className="asset-coverage-hint"><DeploymentUnitOutlined /> 点击任意节点查看详情</div>}{penetration && refreshing && !remoteGraph && <div className="asset-coverage-loading"><Spin /><span>正在读取授权资产…</span></div>}{graph.nodes.length === 0 && !refreshing && <div className="asset-coverage-loading"><SearchOutlined /><span>暂无真实资产证据（等待工具回执或经验数据）</span></div>}<aside className={`asset-coverage-detail ${selectedNode ? 'is-open' : ''}`}>{selectedNode ? <><div className="asset-detail-heading"><i style={{ color: meta.color }}>{meta.icon}</i><span><small>ASSET DETAIL</small><b>{meta.label}</b></span><Tag>{selectedNode.rawId}</Tag></div><p>{selectedNode.description || selectedNode.label}</p><dl><div><dt>覆盖状态</dt><dd>{selectedNode.status === 'discovered' ? '已测（有运行证据）' : '范围内（经验记录）'}</dd></div><div><dt>节点类型</dt><dd>{meta.label}</dd></div><div><dt>数据来源</dt><dd>{(selectedNode.sources || []).map((source) => ({ tool: '工具回执', ledger: 'Ledger', experience: '经验库', penetration: '渗透服务' }[source] || source)).join('、')}</dd></div></dl></> : <div className="asset-detail-empty"><DeploymentUnitOutlined /><b>选择一个资产节点</b><span>查看资产类型、覆盖状态与数据来源</span></div>}</aside></div><footer className="asset-coverage-footer"><span><b>{graph.nodes.length}</b> 资产</span><span><b>{graph.edges.length}</b> 关系</span><span><b>{discoveredCount}</b> 已测</span>{graph.stats.input_file_count !== undefined && <span><b>{graph.stats.scanned_file_count || 0}/{graph.stats.input_file_count}</b> 文件覆盖</span>}<em>仅展示已有工具、Ledger、经验或渗透服务证据，不会因打开此视图触发扫描。</em></footer></div>
}
