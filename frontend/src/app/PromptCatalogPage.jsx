import React, { useEffect, useState } from 'react'
import { CheckCircleOutlined, FileTextOutlined, LockOutlined, ReloadOutlined } from '@ant-design/icons'
import { App, Button, Empty, Skeleton, Statistic, Tag, Typography } from 'antd'
import { getPromptCatalog } from '../api.js'

const { Text, Title } = Typography

export function PromptCatalogPage() {
  const { message } = App.useApp()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const load = () => { setLoading(true); getPromptCatalog().then(setData).catch((error) => message.error(`读取 Prompt 目录失败：${error.message}`)).finally(() => setLoading(false)) }
  useEffect(() => { load() }, [])

  return <div className="catalog-page">
    <section className="page-intro catalog-hero"><div><Text className="panel-kicker">PROMPT CATALOG / ANQUAN2 IMPORT</Text><Title level={2}>Prompt 目录</Title><p>集中查看已迁移的角色 Prompt、来源与校验信息。目录只读，当前不接入 AI 思考流程。</p></div><div className="intro-tags"><Tag color="gold"><LockOutlined /> 运行时未注入</Tag><Button type="text" icon={<ReloadOutlined />} onClick={load}>刷新</Button></div></section>
    <section className="catalog-metrics"><div className="catalog-metric"><FileTextOutlined /><Statistic title="已登记模板" value={data?.count ?? 0} /></div><div className="catalog-metric"><CheckCircleOutlined /><Statistic title="来源" value="anquan2" /></div><div className="catalog-metric"><LockOutlined /><Statistic title="运行时注入" value="否" /></div></section>
    <section className="glass-panel catalog-library"><header className="panel-heading"><div><Text className="panel-kicker">BUNDLED ASSETS</Text><Title level={4}>角色与阶段</Title></div><Tag>{data?.schema_version || '1.0'}</Tag></header><div className="prompt-grid">{loading ? <Skeleton active paragraph={{ rows: 8 }} /> : data?.prompts?.length ? data.prompts.map((prompt) => <article className="prompt-card" key={prompt.key}><div className="prompt-card-icon"><FileTextOutlined /></div><div className="prompt-card-main"><header><div><b>{prompt.name}</b><small>{prompt.key} · v{prompt.version}</small></div><Tag color="default">{prompt.stage}</Tag></header><p>{prompt.purpose}</p><footer><span>{prompt.category}</span><code>SHA {String(prompt.checksum).slice(0, 12)}…</code></footer></div></article>) : <Empty description="暂无 Prompt 资产" />}</div></section>
  </div>
}
