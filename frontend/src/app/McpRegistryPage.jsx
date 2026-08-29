import React, { useEffect, useState } from 'react'
import {
  ApartmentOutlined,
  ApiOutlined,
  AuditOutlined,
  BarChartOutlined,
  BugOutlined,
  BulbOutlined,
  CodeOutlined,
  ConsoleSqlOutlined,
  DatabaseOutlined,
  DeploymentUnitOutlined,
  ExperimentOutlined,
  FileProtectOutlined,
  FileSearchOutlined,
  FilterOutlined,
  FontSizeOutlined,
  FundOutlined,
  GlobalOutlined,
  HistoryOutlined,
  KeyOutlined,
  LockOutlined,
  MessageOutlined,
  PartitionOutlined,
  ReadOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  SafetyOutlined,
  ScanOutlined,
  SearchOutlined,
  SecurityScanOutlined,
  SettingOutlined,
  ToolOutlined,
  WifiOutlined,
} from '@ant-design/icons'
import { App, Button, Empty, Skeleton, Statistic, Tag, Typography } from 'antd'
import { getMcpCatalog } from '../api.js'

const { Text, Title } = Typography

const SAFE_SERVER_IDS = new Set([
  'local-semgrep',
  'local-cyberchef',
  'local-wiremcp',
  'local-web-security',
  'local-security-extended',
])

const ICONS = {
  apartment: ApartmentOutlined,
  api: ApiOutlined,
  audit: AuditOutlined,
  'bar-chart': BarChartOutlined,
  bug: BugOutlined,
  bulb: BulbOutlined,
  code: CodeOutlined,
  'console-sql': ConsoleSqlOutlined,
  database: DatabaseOutlined,
  'deployment-unit': DeploymentUnitOutlined,
  experiment: ExperimentOutlined,
  'file-protect': FileProtectOutlined,
  'file-search': FileSearchOutlined,
  filter: FilterOutlined,
  'font-size': FontSizeOutlined,
  fund: FundOutlined,
  global: GlobalOutlined,
  history: HistoryOutlined,
  key: KeyOutlined,
  message: MessageOutlined,
  partition: PartitionOutlined,
  read: ReadOutlined,
  safety: SafetyOutlined,
  'safety-certificate': SafetyCertificateOutlined,
  scan: ScanOutlined,
  search: SearchOutlined,
  'security-scan': SecurityScanOutlined,
  setting: SettingOutlined,
  tool: ToolOutlined,
  wifi: WifiOutlined,
}

function CatalogIcon({ name }) {
  const Icon = ICONS[name] || ToolOutlined
  return <Icon />
}

export function McpRegistryPage() {
  const { message } = App.useApp()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const load = () => { setLoading(true); getMcpCatalog().then(setData).catch((error) => message.error(`读取 MCP 清单失败：${error.message}`)).finally(() => setLoading(false)) }
  useEffect(() => { load() }, [])

  // Keep the UI safe even while an older backend process is still serving the
  // pre-filter catalog. Runtime registration remains disabled on the backend.
  const displayServers = (data?.servers || []).filter((server) => SAFE_SERVER_IDS.has(server.server_id))
  const displayToolCount = typeof data?.safe_tool_count === 'number'
    ? data.safe_tool_count
    : displayServers.reduce((total, server) => total + (server.tools?.length || 0), 0)

  return <div className="catalog-page">
    <section className="page-intro catalog-hero"><div><Text className="panel-kicker">MCP REGISTRY / SAFE IMPORT</Text><Title level={2}>MCP 工具清单</Title><p>按工具作用、输入、返回和调用时机整理可接入能力。当前只展示登记信息，不建立 MCP 连接。</p></div><div className="intro-tags"><Tag><LockOutlined /> 调用已禁用</Tag><Button type="text" icon={<ReloadOutlined />} onClick={load}>刷新</Button></div></section>
    <section className="catalog-metrics"><div className="catalog-metric"><CatalogIcon name="tool" /><Statistic title="安全 Server" value={data ? displayServers.length : 0} /></div><div className="catalog-metric is-green"><SafetyCertificateOutlined /><Statistic title="可展示工具" value={displayToolCount} /></div><div className="catalog-metric is-gold"><LockOutlined /><Statistic title="模型状态" value="正在调用" /></div></section>
    <section className="glass-panel catalog-library"><header className="panel-heading"><div><Text className="panel-kicker">REGISTERED SERVERS</Text><Title level={4}>工具能力矩阵</Title></div><Tag color="gold">runtime disabled</Tag></header><div className="mcp-grid">{loading ? <Skeleton active paragraph={{ rows: 12 }} /> : displayServers.length ? displayServers.map((server) => <article className={`mcp-card ${server.candidate ? 'is-candidate' : ''}`} key={server.server_id}><header><div className="mcp-title"><CatalogIcon name={server.icon} /><span><b>{server.name}</b><small>{server.server_id} · {server.tool_count ?? server.tools?.length ?? 0} 个安全工具</small></span></div><Tag color="green"><SafetyCertificateOutlined /> 安全 Server</Tag></header><p className="mcp-server-purpose">{server.purpose}</p><div className="mcp-tool-list">{(server.tools || []).map((tool) => <details className="mcp-tool" key={tool.tool_id}><summary><span><CatalogIcon name={tool.icon} /> {tool.display_name || tool.name}</span><small>{tool.name} · {tool.risk_level} · 运行时未暴露</small></summary><dl><div><dt>作用</dt><dd>{tool.purpose}</dd></div><div><dt>输入</dt><dd>{tool.input}</dd></div><div><dt>返回</dt><dd>{tool.return}</dd></div><div><dt>调用时机</dt><dd>{tool.invocation_timing}</dd></div></dl></details>)}</div>{!server.tools?.length && <small className="mcp-legacy-note">后端尚未重启到工具清单版本，暂不展示该 Server 的安全工具明细。</small>}</article>) : <Empty description="暂无可展示的安全工具" />}</div></section>
  </div>
}
