import React, { useEffect, useState } from 'react'
import { LockOutlined, ReloadOutlined, SafetyCertificateOutlined, ToolOutlined } from '@ant-design/icons'
import { App, Button, Empty, Skeleton, Statistic, Tag, Typography } from 'antd'
import { getMcpCatalog } from '../api.js'

const { Text, Title } = Typography

export function McpRegistryPage() {
  const { message } = App.useApp()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const load = () => { setLoading(true); getMcpCatalog().then(setData).catch((error) => message.error(`读取 MCP 清单失败：${error.message}`)).finally(() => setLoading(false)) }
  useEffect(() => { load() }, [])

  return <div className="catalog-page">
    <section className="page-intro catalog-hero"><div><Text className="panel-kicker">MCP REGISTRY / SAFE IMPORT</Text><Title level={2}>MCP 工具清单</Title><p>按工具作用、输入、返回和调用时机整理可接入能力。当前只展示登记信息，不建立 MCP 连接。</p></div><div className="intro-tags"><Tag><LockOutlined /> 调用已禁用</Tag><Button type="text" icon={<ReloadOutlined />} onClick={load}>刷新</Button></div></section>
    <section className="catalog-metrics"><div className="catalog-metric"><ToolOutlined /><Statistic title="Server 数" value={data?.server_count ?? 0} /></div><div className="catalog-metric is-green"><SafetyCertificateOutlined /><Statistic title="低风险候选" value={data?.candidate_count ?? 0} /></div><div className="catalog-metric is-gold"><LockOutlined /><Statistic title="模型可调用" value="否" /></div></section>
    <section className="glass-panel catalog-library"><header className="panel-heading"><div><Text className="panel-kicker">REGISTERED SERVERS</Text><Title level={4}>工具能力矩阵</Title></div><Tag color="gold">runtime disabled</Tag></header><div className="mcp-grid">{loading ? <Skeleton active paragraph={{ rows: 12 }} /> : data?.servers?.length ? data.servers.map((server) => <article className={`mcp-card ${server.candidate ? 'is-candidate' : ''}`} key={server.server_id}><header><div className="mcp-title"><ToolOutlined /><span><b>{server.name}</b><small>{server.server_id} · {server.transport}</small></span></div><Tag color={server.candidate ? 'green' : 'default'}>{server.candidate ? `候选 ${server.risk_level}` : `禁用 ${server.risk_level}`}</Tag></header><dl><div><dt>作用</dt><dd>{server.purpose}</dd></div><div><dt>输入</dt><dd>{server.input}</dd></div><div><dt>返回</dt><dd>{server.return}</dd></div><div><dt>调用时机</dt><dd>{server.invocation_timing}</dd></div></dl></article>) : <Empty description="暂无 MCP Server" />}</div></section>
  </div>
}
