import React, { useCallback, useEffect, useState } from 'react'
import {
  ApiOutlined,
  CheckCircleOutlined,
  DatabaseOutlined,
  KeyOutlined,
  ReloadOutlined,
  RobotOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons'
import { Alert, App, Button, Empty, Form, Input, Popconfirm, Skeleton, Statistic, Tag, Typography } from 'antd'
import { getModelConfig, getModelUsage, modelUsageSocketUrl, testModelConfig, updateModelConfig } from '../api.js'

const { Text, Title } = Typography
const modelRules = [{ required: true, whitespace: true, message: '请输入模型 ID' }]

export function ModelUsagePage() {
  const { message } = App.useApp()
  const [form] = Form.useForm()
  const [config, setConfig] = useState(null)
  const [usage, setUsage] = useState(null)
  const [loading, setLoading] = useState(true)
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testResult, setTestResult] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [nextConfig, nextUsage] = await Promise.all([getModelConfig(), getModelUsage()])
      setConfig(nextConfig)
      setUsage(nextUsage)
      form.setFieldsValue({
        base_url: nextConfig.base_url,
        api_key: '',
        planner_model: nextConfig.planner_model,
        worker_model: nextConfig.worker_model,
        fallback_model: nextConfig.fallback_model,
      })
    } catch (error) {
      message.error(error.message)
    } finally {
      setLoading(false)
    }
  }, [form, message])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    let disposed = false
    let socket
    let reconnectTimer
    let refreshTimer
    const connect = () => {
      if (disposed) return
      socket = new WebSocket(modelUsageSocketUrl())
      socket.onmessage = () => {
        window.clearTimeout(refreshTimer)
        refreshTimer = window.setTimeout(load, 250)
      }
      socket.onclose = () => {
        if (!disposed) reconnectTimer = window.setTimeout(connect, 1500)
      }
    }
    connect()
    return () => {
      disposed = true
      window.clearTimeout(reconnectTimer)
      window.clearTimeout(refreshTimer)
      socket?.close()
    }
  }, [load])

  async function testConnection() {
    const values = await form.validateFields(['base_url', 'api_key', 'planner_model', 'worker_model', 'fallback_model'])
    setTesting(true)
    setTestResult(null)
    try {
      const result = await testModelConfig({
        base_url: values.base_url.trim(),
        api_key: values.api_key?.trim() || null,
        planner_model: values.planner_model.trim(),
        worker_model: values.worker_model.trim(),
        fallback_model: values.fallback_model.trim(),
      })
      setTestResult(result)
      message.success(`连接成功，延迟 ${result.latency_ms} ms`)
    } catch (error) {
      message.error(`连接失败：${error.message}`)
    } finally {
      setTesting(false)
    }
  }

  async function applyConfig() {
    const values = await form.validateFields()
    setSaving(true)
    try {
      await updateModelConfig({
        base_url: values.base_url.trim(),
        api_key: values.api_key?.trim() || null,
        planner_model: values.planner_model.trim(),
        worker_model: values.worker_model.trim(),
        fallback_model: values.fallback_model.trim(),
      })
      setTestResult(null)
      await load()
      message.success('连接与模型路由已应用')
    } catch (error) {
      message.error(`应用失败：${error.message}`)
    } finally {
      setSaving(false)
    }
  }

  async function clearKey() {
    const baseUrl = form.getFieldValue('base_url') || config.base_url
    setSaving(true)
    try {
      await updateModelConfig({ base_url: baseUrl.trim(), clear_api_key: true })
      setTestResult(null)
      await load()
      message.success('API Key 已清除，运行时已切换为 Demo 模式')
    } catch (error) {
      message.error(error.message)
    } finally {
      setSaving(false)
    }
  }

  if (loading && !config) return <div className="glass-panel loading-panel"><Skeleton active /></div>

  return <div className="models-page">
    <div className="page-intro">
      <div>
        <Text className="panel-kicker">MODEL RUNTIME</Text>
        <Title level={2}>模型配置与用量</Title>
        <p>配置 OpenAI 兼容服务与模型路由，并实时观察后端持久化的调用统计。</p>
      </div>
      <div className="intro-tags">
        <Tag color={config?.api_key_configured ? 'success' : 'default'}>{config?.api_key_configured ? '密钥已配置' : '密钥未配置'}</Tag>
        {config?.demo_mode && <Tag color="gold">DEMO MODE</Tag>}
        <Button type="text" icon={<ReloadOutlined />} onClick={load}>刷新</Button>
      </div>
    </div>

    <div className="model-grid">
      <section className="glass-panel model-config-card">
        <div className="panel-heading">
          <div><Text className="panel-kicker">MODEL CONFIGURATION</Text><Title level={4}>运行时连接</Title></div>
          <ApiOutlined className="heading-icon accent-gold" />
        </div>
        <Form form={form} layout="vertical" className="model-config-form" onValuesChange={() => setTestResult(null)}>
          <Form.Item
            name="base_url"
            label="Base URL"
            rules={[{ required: true, message: '请输入 Base URL' }, { type: 'url', message: '请输入有效的 HTTP/HTTPS URL' }]}
            extra="填写 OpenAI 兼容接口根地址，通常以 /v1 结尾。"
          >
            <Input prefix={<ApiOutlined />} placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1" autoComplete="url" />
          </Form.Item>
          <Form.Item
            name="api_key"
            label="API Key"
            rules={[{ min: 8, message: 'API Key 至少需要 8 个字符' }]}
            extra={config?.api_key_configured ? '已保存密钥；留空表示继续使用现有密钥。' : '密钥只会发送到本机后端，不写入浏览器存储。'}
          >
            <Input.Password prefix={<KeyOutlined />} placeholder={config?.api_key_configured ? '••••••••（留空保留）' : 'sk-...'} autoComplete="new-password" />
          </Form.Item>

          <div className="model-selector-heading">
            <span><RobotOutlined /> 模型路由</span>
            <small>输入服务商支持的准确模型 ID</small>
          </div>
          <div className="model-selector-grid">
            <Form.Item name="planner_model" label="规划模型" rules={modelRules}>
              <Input placeholder="例如 qwen-plus" autoComplete="off" />
            </Form.Item>
            <Form.Item name="worker_model" label="工作模型" rules={modelRules}>
              <Input placeholder="例如 qwen-turbo" autoComplete="off" />
            </Form.Item>
            <Form.Item name="fallback_model" label="回退模型" rules={modelRules}>
              <Input placeholder="例如 qwen-max" autoComplete="off" />
            </Form.Item>
          </div>
          <div className="runtime-hint"><span>请求超时</span><b>{config?.timeout_seconds} 秒</b></div>

          {testResult && <Alert className="connection-result" showIcon type="success" title="连接测试通过" description={`服务响应 ${testResult.latency_ms} ms，可见模型 ${testResult.model_count} 个。`} />}
          <div className="config-actions">
            <Button icon={<ApiOutlined />} loading={testing} onClick={testConnection}>测试连接</Button>
            <Button type="primary" icon={<CheckCircleOutlined />} loading={saving} onClick={applyConfig}>应用配置</Button>
            {config?.api_key_configured && <Popconfirm title="确认清除 API Key？" description="清除后将立即切换为 Demo 模式。" okText="清除" cancelText="取消" onConfirm={clearKey}><Button danger loading={saving}>清除密钥</Button></Popconfirm>}
          </div>
        </Form>
      </section>

      <section className="glass-panel usage-card">
        <div className="panel-heading"><div><Text className="panel-kicker">USAGE OBSERVATORY</Text><Title level={4}>模型用量</Title></div><DatabaseOutlined className="heading-icon" /></div>
        <div className="usage-stat-grid"><Statistic title="TOTAL TOKENS" value={usage?.total_tokens ?? 0} /><Statistic title="MODEL CALLS" value={usage?.model_call_count ?? 0} /><Statistic title="RUNS" value={usage?.run_count ?? 0} /><Statistic title="CACHE READ" value={usage?.cache_read_tokens ?? 0} /></div>
        <div className={`usage-disclosure ${usage?.token_usage_available ? 'is-available' : ''}`}><SafetyCertificateOutlined /><div><b>{usage?.token_usage_available ? 'Token 用量已实时接入' : '等待 Provider 用量数据'}</b><p>{usage?.token_usage_available ? '模型流式完成事件会立即持久化并推送 Token 与缓存读取统计。' : '尚无在线模型调用记录；首次在线调用后将自动更新。'}</p></div></div>
        <div className="model-decisions"><div className="subheading"><b>按模型决策记录</b><span>{usage?.models?.length || 0} 个模型</span></div>{usage?.models?.length ? usage.models.map((model) => <div className="model-decision-row" key={model.model}><span><CheckCircleOutlined /><b>{model.model}</b></span><span><small>决策</small>{model.decision_count}</span><span><small>流程</small>{model.run_count}</span></div>) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无模型决策记录" />}</div>
      </section>
    </div>
  </div>
}
