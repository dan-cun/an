import React, { useEffect, useState } from 'react'
import { CheckCircleOutlined, FileTextOutlined, ReloadOutlined } from '@ant-design/icons'
import { App, Button, Empty, Modal, Skeleton, Statistic, Tag, Typography } from 'antd'
import { getPrompt, getPromptCatalog } from '../api.js'

const { Text, Title } = Typography

export function PromptCatalogPage() {
  const { message } = App.useApp()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [detail, setDetail] = useState(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const load = () => { setLoading(true); getPromptCatalog().then(setData).catch((error) => message.error(`读取 Prompt 目录失败：${error.message}`)).finally(() => setLoading(false)) }
  useEffect(() => { load() }, [])

  async function openDetail(prompt) {
    setDetailLoading(true)
    try { setDetail(await getPrompt(prompt.key)) }
    catch (error) { message.error(`读取 Prompt 详情失败：${error.message}`) }
    finally { setDetailLoading(false) }
  }

  return <div className="catalog-page">
    <section className="page-intro catalog-hero"><div><Text className="panel-kicker">PROMPT CATALOG / LOCAL IMPORT</Text><Title level={2}>Prompt 目录</Title><p>集中查看已登记的角色 Prompt、来源与校验信息。</p></div><div className="intro-tags"><Button type="text" icon={<ReloadOutlined />} onClick={load}>刷新</Button></div></section>
    <section className="catalog-metrics"><div className="catalog-metric"><FileTextOutlined /><Statistic title="已登记模板" value={data?.count ?? 0} /></div><div className="catalog-metric"><CheckCircleOutlined /><Statistic title="来源" value="本地目录" /></div></section>
    <section className="glass-panel catalog-library"><header className="panel-heading"><div><Text className="panel-kicker">BUNDLED ASSETS</Text><Title level={4}>角色与阶段</Title></div><Tag>{data?.schema_version || '1.0'}</Tag></header><div className="prompt-grid">{loading ? <Skeleton active paragraph={{ rows: 8 }} /> : data?.prompts?.length ? data.prompts.map((prompt) => <article className="prompt-card prompt-card-action" role="button" tabIndex={0} key={prompt.key} onClick={() => openDetail(prompt)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') openDetail(prompt) }}><div className="prompt-card-icon"><FileTextOutlined /></div><div className="prompt-card-main"><header><div><b>{prompt.name}</b><small>{prompt.key} · v{prompt.version}</small></div><Tag color="default">{prompt.stage}</Tag></header><p>{prompt.purpose}</p><footer><span>{prompt.category}</span><code>SHA {String(prompt.checksum).slice(0, 12)}…</code></footer></div></article>) : <Empty description="暂无 Prompt 资产" />}</div></section>
    <Modal open={Boolean(detail) || detailLoading} title={detail?.name || 'Prompt 详情'} footer={<Button onClick={() => setDetail(null)}>关闭</Button>} width={780} onCancel={() => setDetail(null)} confirmLoading={detailLoading}><div className="prompt-detail">{detail ? <><div className="prompt-detail-meta"><Tag>{detail.key}</Tag><Tag>{detail.stage}</Tag><Tag>v{detail.version}</Tag><span>{detail.purpose}</span></div><dl><div><dt>来源</dt><dd>{detail.source}</dd></div><div><dt>校验和</dt><dd>{detail.checksum}</dd></div><div><dt>大小</dt><dd>{detail.size_bytes} bytes</dd></div></dl><pre>{detail.content}</pre></> : <Skeleton active paragraph={{ rows: 12 }} />}</div></Modal>
  </div>
}
