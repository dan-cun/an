import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  BookOutlined,
  CheckCircleOutlined,
  DatabaseOutlined,
  DeleteOutlined,
  EyeOutlined,
  ExperimentOutlined,
  PlusOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  SyncOutlined,
  UserOutlined,
} from '@ant-design/icons'
import { App, Button, Empty, Form, Input, Modal, Popconfirm, Select, Tag, Typography } from 'antd'
import { useNavigate } from 'react-router-dom'
import { backfillExperiences, createExperience, deleteExperience, getLedger, getPenetrationGraph, getRun, listExperiences } from '../api.js'
import { compactId } from './runtimeModel.js'

const { Text, Title } = Typography
const moduleLabels = { code_audit: '代码审计', reverse: '逆向分析', penetration: '渗透测试' }
const kindLabels = { success_pattern: '成功路径', failure_lesson: '失败经验', operator_note: '人工经验' }
const agentLabels = { interpreter: '理解任务', planner: '规划路径', analyst: '分析结果', verifier: '验证证据', reporter: '形成报告' }

function cleanDetailText(value, maxLength = 240) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text
}

function uniqueItems(items, limit = 16) {
  return [...new Set(items.map((item) => cleanDetailText(item)).filter(Boolean))].slice(0, limit)
}

function enrichExperience(experience, context) {
  if (!experience) return null
  const events = context?.events || []
  const graphNodes = context?.graph?.nodes || []
  if (!events.length && !graphNodes.length) return experience
  const blackboardSteps = events.flatMap((event) => {
    const payload = event.payload || {}
    const node = agentLabels[payload.agent_id] || payload.node
    if (event.event_type === 'agent.instruction' && payload.content) return [`${node || '编排节点'}：${payload.content}`]
    if (event.event_type === 'agent.thought' && payload.summary) return [`${node || '分析节点'}：${payload.summary}`]
    if (event.event_type === 'tool.completed' && payload.tool) return [`工具 ${payload.tool} 执行${payload.status === 'success' ? '成功' : payload.status || '已完成'}${payload.evidence_ids?.length ? `，产出 ${payload.evidence_ids.length} 条证据` : ''}`]
    if (event.event_type === 'observation.recorded' && payload.summary) return [`记录工具观测：${payload.summary}`]
    if (event.event_type === 'analysis.completed') return [`分析完成：形成 ${payload.finding_count || 0} 个发现、${payload.evidence_count || 0} 条证据`]
    if (event.event_type === 'verification.completed') return [`证据验证完成：${payload.route === 'report' ? '进入报告阶段' : '继续执行任务'}`]
    if (event.event_type === 'report.generated') return ['报告已根据黑板中的可验证事实生成']
    return []
  })
  const graphSteps = graphNodes.filter((node) => node.type !== 'origin' && node.type !== 'goal').map((node) => `黑板节点 ${node.raw_id || node.id}：${node.label || node.description}`)
  const steps = uniqueItems([...blackboardSteps, ...graphSteps, ...(experience.steps || [])], 12)
  const tools = uniqueItems([...events.filter((event) => event.event_type === 'tool.started' && event.payload?.tool).map((event) => event.payload.tool), ...(experience.tools || [])], 20)
  const eventEvidence = events.flatMap((event) => Array.isArray(event.payload?.evidence_ids) ? event.payload.evidence_ids.map((id) => `证据 ${id}`) : [])
  const graphEvidence = graphNodes.filter((node) => ['fact', 'vulnerability', 'hypothesis'].includes(node.type)).map((node) => `黑板 ${node.raw_id || node.id}：${node.label || node.description}`)
  const summaryEvidence = events.filter((event) => ['analysis.completed', 'verification.completed', 'report.generated'].includes(event.event_type)).map((event) => event.event_type === 'analysis.completed' ? `黑板分析记录 ${event.payload?.finding_count || 0} 个发现、${event.payload?.evidence_count || 0} 条证据` : event.event_type === 'verification.completed' ? '黑板已完成证据校验' : '黑板已生成报告')
  return { ...experience, steps, tools, evidence_refs: uniqueItems([...(experience.evidence_refs || []), ...eventEvidence, ...graphEvidence, ...summaryEvidence], 12), summary: context.run && experience.source_type === 'run' ? `${experience.summary} 本次经验已结合任务黑板中的执行节点、工具观测与验证记录整理。` : experience.summary }
}

export function ExperienceLibraryPage() {
  const { message } = App.useApp()
  const navigate = useNavigate()
  const [form] = Form.useForm()
  const [data, setData] = useState({ experiences: [], statistics: {} })
  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [open, setOpen] = useState(false)
  const [selectedExperience, setSelectedExperience] = useState(null)
  const [experienceContext, setExperienceContext] = useState(null)
  const detailRequestRef = useRef(0)
  const [filters, setFilters] = useState({ module_route: '', source_type: '' })

  const refresh = async (quiet = false) => {
    setLoading(true)
    try {
      setData(await listExperiences(filters))
    } catch (error) {
      if (!quiet) message.error(`读取经验库失败：${error.message}`)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { refresh(true) }, [filters.module_route, filters.source_type])

  const metrics = useMemo(() => {
    const stats = data.statistics || {}
    return [
      ['经验总量', stats.total || 0, <DatabaseOutlined />, 'cyan'],
      ['已验证', stats.verified || 0, <SafetyCertificateOutlined />, 'green'],
      ['题目提取', stats.run_sourced || 0, <ExperimentOutlined />, 'blue'],
      ['人工填入', stats.manual || 0, <UserOutlined />, 'gold'],
    ]
  }, [data.statistics])

  const create = async () => {
    const values = await form.validateFields()
    setCreating(true)
    try {
      await createExperience({
        ...values,
        tags: values.tags ? values.tags.split(/[,，\s]+/).filter(Boolean) : [],
      })
      message.success('人工经验已写入数据库')
      setOpen(false)
      form.resetFields()
      await refresh(true)
    } catch (error) {
      message.error(`新增经验失败：${error.message}`)
    } finally {
      setCreating(false)
    }
  }

  const remove = async (experienceId) => {
    try {
      await deleteExperience(experienceId)
      message.success('经验已删除')
      await refresh(true)
    } catch (error) {
      message.error(`删除失败：${error.message}`)
    }
  }

  const syncRuns = async (mode = 'sync') => {
    setLoading(true)
    try {
      const result = await backfillExperiences()
      message.success(mode === 'ai' ? `AI 经验生成完成：${result.stored} 条已写入或更新` : `历史运行同步完成：${result.stored} 条已写入或更新`)
      await refresh(true)
    } catch (error) {
      message.error(`同步失败：${error.message}`)
    } finally {
      setLoading(false)
    }
  }

  const generateFromRuns = async () => {
    await syncRuns('ai')
  }

  const openExperience = async (item) => {
    const requestId = detailRequestRef.current + 1
    detailRequestRef.current = requestId
    setSelectedExperience(item)
    setExperienceContext(null)
    if (!item.source_run_id) return
    setExperienceContext({ loading: true })
    try {
      const [run, ledger] = await Promise.all([getRun(item.source_run_id), getLedger(item.source_run_id)])
      if (detailRequestRef.current !== requestId) return

      // Show the ledger-derived details immediately. The penetration service is
      // an optional external dependency and must not hold the modal open while
      // it is offline or still working.
      setExperienceContext({ run, events: ledger.events || [], graph: null, loading: run?.module_route === 'penetration' })

      if (run?.module_route === 'penetration') {
        try {
          const graph = await Promise.race([
            getPenetrationGraph(item.source_run_id),
            new Promise((_, reject) => setTimeout(() => reject(new Error('penetration graph timeout')), 5000)),
          ])
          if (detailRequestRef.current !== requestId) return
          setExperienceContext((current) => ({ ...(current || {}), run, events: ledger.events || [], graph, loading: false }))
        } catch {
          if (detailRequestRef.current !== requestId) return
          setExperienceContext((current) => ({ ...(current || {}), run, events: ledger.events || [], graph: null, loading: false }))
        }
      } else {
        setExperienceContext({ run, events: ledger.events || [], graph: null, loading: false })
      }
    } catch {
      if (detailRequestRef.current === requestId) setExperienceContext({ loading: false, error: '任务账本暂时不可用，以下显示已保存的经验摘要。' })
    }
  }

  const closeExperience = () => {
    detailRequestRef.current += 1
    setSelectedExperience(null)
    setExperienceContext(null)
  }

  const experienceDetail = useMemo(() => enrichExperience(selectedExperience, experienceContext), [selectedExperience, experienceContext])

  return <div className="experience-page">
    <section className="command-hero experience-hero">
      <div>
        <Text className="panel-kicker">VERIFIED EPISODIC MEMORY</Text>
        <Title level={2}>经验学习库</Title>
        <p>从真实解题账本提取成功路径与失败经验，经证据校验后供后续规划节点检索。</p>
      </div>
      <div className="command-actions">
        <Button icon={<SyncOutlined />} loading={loading} onClick={syncRuns}>同步历史运行</Button>
        <Button icon={<ExperimentOutlined />} loading={loading} onClick={generateFromRuns}>AI 生成经验</Button>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>新增人工经验</Button>
      </div>
    </section>

    <section className="experience-metrics">
      {metrics.map(([label, value, icon, tone]) => <article key={label} className={`experience-metric is-${tone}`}>
        <i>{icon}</i><span><small>{label}</small><b>{value}</b></span>
      </article>)}
    </section>

    <section className="glass-panel experience-library">
      <header className="panel-heading compact-heading experience-toolbar">
        <div><Text className="panel-kicker">KNOWLEDGE RECORDS</Text><Title level={4}>可检索经验</Title></div>
        <div>
          <Select value={filters.module_route} onChange={(value) => setFilters((current) => ({ ...current, module_route: value }))} options={[
            { value: '', label: '全部模块' },
            ...Object.entries(moduleLabels).map(([value, label]) => ({ value, label })),
          ]} />
          <Select value={filters.source_type} onChange={(value) => setFilters((current) => ({ ...current, source_type: value }))} options={[
            { value: '', label: '全部来源' }, { value: 'run', label: '具体题目' }, { value: 'manual', label: '人工填入' },
          ]} />
          <Button type="text" icon={<ReloadOutlined />} loading={loading} onClick={() => refresh()}>刷新</Button>
        </div>
      </header>
      <div className="experience-list">
        {data.experiences?.length ? data.experiences.map((item) => <article className={`experience-card is-${item.experience_kind}`} key={item.experience_id}>
          <div className="experience-card-icon">{item.experience_kind === 'failure_lesson' ? <ExperimentOutlined /> : <BookOutlined />}</div>
          <div className="experience-card-main">
            <header>
              <div><b>{item.title}</b><small>{compactId(item.experience_id)} · {new Date(item.updated_at).toLocaleString('zh-CN')}</small></div>
              <span>
                <Tag color={item.experience_kind === 'failure_lesson' ? 'warning' : item.source_type === 'manual' ? 'gold' : 'success'}>{kindLabels[item.experience_kind] || item.experience_kind}</Tag>
                {item.verified && <Tag color="success" icon={<CheckCircleOutlined />}>已验证</Tag>}
              </span>
            </header>
            <p>{item.summary}</p>
            <div className="experience-meta">
              <span><small>所属模块</small><b>{moduleLabels[item.module_route] || item.module_route}</b></span>
              <span><small>经验来源</small><b>{item.source_type === 'manual' ? '人工填入' : item.source_type === 'ai_generated' ? '经验库' : `具体题目：${item.source_title}`}</b></span>
              <span><small>置信度</small><b>{Math.round(item.confidence * 100)}%</b></span>
              <span><small>复用次数</small><b>{item.usage_count}</b></span>
            </div>
            {!!item.tags?.length && <div className="experience-tags">{item.tags.map((tag) => <Tag key={tag}>{tag}</Tag>)}</div>}
            {!!item.steps?.length && <details className="experience-steps"><summary>查看提取的解题步骤</summary><ol>{item.steps.map((step) => <li key={step}>{step}</li>)}</ol></details>}
          </div>
          <div className="experience-actions">
            <div>
              {item.source_run_id && <Button size="small" onClick={() => navigate(`/workbench?run=${item.source_run_id}`)}>查看题目</Button>}
              <Popconfirm title="删除这条经验？" description="删除后不会影响原始运行账本。" okText="删除" cancelText="取消" onConfirm={() => remove(item.experience_id)}>
                <Button danger type="text" size="small" icon={<DeleteOutlined />} aria-label={`删除经验 ${item.title}`} />
              </Popconfirm>
            </div>
            <Button className="experience-view-button" size="small" icon={<EyeOutlined />} onClick={() => openExperience(item)}>查看经验</Button>
          </div>
        </article>) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无符合条件的经验" />}
      </div>
    </section>

    <Modal
      className="experience-detail-modal"
      title="本次任务的经验"
      open={!!selectedExperience}
      width={720}
      footer={<Button type="primary" onClick={closeExperience}>关闭</Button>}
      onCancel={closeExperience}
      destroyOnHidden
    >
      {experienceDetail && <div className="experience-detail">
        <header>
          <div><Text className="panel-kicker">TASK EXPERIENCE</Text><Title level={4}>{experienceDetail.title}</Title></div>
          <span>
            <Tag color={experienceDetail.experience_kind === 'failure_lesson' ? 'warning' : experienceDetail.source_type === 'manual' ? 'gold' : 'success'}>{kindLabels[experienceDetail.experience_kind] || experienceDetail.experience_kind}</Tag>
            {experienceDetail.verified && <Tag color="success" icon={<CheckCircleOutlined />}>已验证</Tag>}
          </span>
        </header>
        <section className="experience-detail-summary">
          <small>经验总结</small><p>{experienceDetail.summary}</p>
          {experienceContext?.loading && <small className="experience-blackboard-loading">正在同步任务黑板…</small>}
          {experienceContext?.events?.length > 0 && <small className="experience-blackboard-source">已根据本任务黑板 {experienceContext.events.length} 条记录整理</small>}
          {experienceContext?.error && <small className="experience-blackboard-error">{experienceContext.error}</small>}
        </section>
        <section className="experience-detail-facts">
          <span><small>任务来源</small><b>{experienceDetail.source_type === 'manual' ? '人工填入' : experienceDetail.source_type === 'ai_generated' ? '经验库' : experienceDetail.source_title}</b></span>
          <span><small>所属模块</small><b>{moduleLabels[experienceDetail.module_route] || experienceDetail.module_route}</b></span>
          <span><small>问题类型</small><b>{experienceDetail.vulnerability_type || '未标注'}</b></span>
          <span><small>置信度</small><b>{Math.round((experienceDetail.confidence || 0) * 100)}%</b></span>
          <span><small>发现数量</small><b>{experienceDetail.finding_count || 0}</b></span>
          <span><small>复用次数</small><b>{experienceDetail.usage_count || 0}</b></span>
        </section>
        <section className="experience-detail-block"><b>解题步骤</b>{experienceDetail.steps?.length ? <ol>{experienceDetail.steps.map((step, index) => <li key={`${index}-${step}`}>{step}</li>)}</ol> : <p className="experience-detail-empty">本条经验未记录解题步骤。</p>}</section>
        <section className="experience-detail-grid">
          <div className="experience-detail-block"><b>使用工具</b>{experienceDetail.tools?.length ? <div className="experience-detail-tags">{experienceDetail.tools.map((tool) => <Tag key={tool}>{tool}</Tag>)}</div> : <p className="experience-detail-empty">未记录工具。</p>}</div>
          <div className="experience-detail-block"><b>证据引用</b>{experienceDetail.evidence_refs?.length ? <ul>{experienceDetail.evidence_refs.map((reference, index) => <li key={`${index}-${reference}`}>{reference}</li>)}</ul> : <p className="experience-detail-empty">未记录证据引用。</p>}</div>
        </section>
      </div>}
    </Modal>

    <Modal title="新增人工经验" open={open} onCancel={() => setOpen(false)} onOk={create} confirmLoading={creating} okText="写入经验库" cancelText="取消">
      <Form form={form} layout="vertical" initialValues={{ module_route: 'code_audit', experience_kind: 'operator_note' }}>
        <Form.Item name="title" label="经验标题" rules={[{ required: true, min: 2 }]}><Input placeholder="例如：压缩包审计前先校验源码覆盖率" /></Form.Item>
        <Form.Item name="summary" label="经验内容" rules={[{ required: true, min: 3 }]}><Input.TextArea rows={5} maxLength={4000} showCount placeholder="描述适用条件、建议步骤和需要避免的问题" /></Form.Item>
        <div className="form-grid">
          <Form.Item name="module_route" label="所属模块"><Select options={Object.entries(moduleLabels).map(([value, label]) => ({ value, label }))} /></Form.Item>
          <Form.Item name="experience_kind" label="经验类型"><Select options={Object.entries(kindLabels).map(([value, label]) => ({ value, label }))} /></Form.Item>
        </div>
        <Form.Item name="vulnerability_type" label="漏洞或问题类型"><Input placeholder="例如 command_injection；可留空" /></Form.Item>
        <Form.Item name="tags" label="标签"><Input placeholder="使用逗号或空格分隔" /></Form.Item>
      </Form>
    </Modal>
  </div>
}
