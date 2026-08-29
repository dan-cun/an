import React, { useEffect, useMemo, useState } from 'react'
import {
  BookOutlined,
  CheckCircleOutlined,
  DatabaseOutlined,
  DeleteOutlined,
  ExperimentOutlined,
  PlusOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  SyncOutlined,
  UserOutlined,
} from '@ant-design/icons'
import { App, Button, Empty, Form, Input, Modal, Popconfirm, Select, Tag, Typography } from 'antd'
import { useNavigate } from 'react-router-dom'
import { backfillExperiences, createExperience, deleteExperience, listExperiences } from '../api.js'
import { compactId } from './runtimeModel.js'

const { Text, Title } = Typography
const moduleLabels = { code_audit: '代码审计', reverse: '逆向分析', penetration: '渗透测试' }
const kindLabels = { success_pattern: '成功路径', failure_lesson: '失败经验', operator_note: '人工经验' }

export function ExperienceLibraryPage() {
  const { message } = App.useApp()
  const navigate = useNavigate()
  const [form] = Form.useForm()
  const [data, setData] = useState({ experiences: [], statistics: {} })
  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [open, setOpen] = useState(false)
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

  const syncRuns = async () => {
    setLoading(true)
    try {
      const result = await backfillExperiences()
      message.success(`历史运行同步完成：${result.stored} 条已写入或更新`)
      await refresh(true)
    } catch (error) {
      message.error(`同步失败：${error.message}`)
    } finally {
      setLoading(false)
    }
  }

  return <div className="experience-page">
    <section className="command-hero experience-hero">
      <div>
        <Text className="panel-kicker">VERIFIED EPISODIC MEMORY</Text>
        <Title level={2}>经验学习库</Title>
        <p>从真实解题账本提取成功路径与失败经验，经证据校验后供后续规划节点检索。</p>
      </div>
      <div className="command-actions">
        <Button icon={<SyncOutlined />} loading={loading} onClick={syncRuns}>同步历史运行</Button>
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
              <span><small>经验来源</small><b>{item.source_type === 'manual' ? '人工填入' : `具体题目：${item.source_title}`}</b></span>
              <span><small>置信度</small><b>{Math.round(item.confidence * 100)}%</b></span>
              <span><small>复用次数</small><b>{item.usage_count}</b></span>
            </div>
            {!!item.tags?.length && <div className="experience-tags">{item.tags.map((tag) => <Tag key={tag}>{tag}</Tag>)}</div>}
            {!!item.steps?.length && <details className="experience-steps"><summary>查看提取的解题步骤</summary><ol>{item.steps.map((step) => <li key={step}>{step}</li>)}</ol></details>}
          </div>
          <div className="experience-actions">
            {item.source_run_id && <Button size="small" onClick={() => navigate(`/workbench?run=${item.source_run_id}`)}>查看题目</Button>}
            <Popconfirm title="删除这条经验？" description="删除后不会影响原始运行账本。" okText="删除" cancelText="取消" onConfirm={() => remove(item.experience_id)}>
              <Button danger type="text" size="small" icon={<DeleteOutlined />} aria-label={`删除经验 ${item.title}`} />
            </Popconfirm>
          </div>
        </article>) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无符合条件的经验" />}
      </div>
    </section>

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
