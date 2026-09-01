import React, { useEffect, useState } from 'react'
import {
  ApartmentOutlined, ApiOutlined, AuditOutlined, BarChartOutlined, BugOutlined, BulbOutlined,
  CodeOutlined, ConsoleSqlOutlined, DatabaseOutlined, DeleteOutlined, DeploymentUnitOutlined,
  EditOutlined, ExperimentOutlined, FileProtectOutlined, FileSearchOutlined, FilterOutlined,
  FontSizeOutlined, FundOutlined, GlobalOutlined, HistoryOutlined, KeyOutlined,
  MessageOutlined, PartitionOutlined, PlusOutlined, ReadOutlined, ReloadOutlined,
  SafetyCertificateOutlined, SafetyOutlined, ScanOutlined, SearchOutlined, SecurityScanOutlined,
  SettingOutlined, ToolOutlined, WifiOutlined,
} from '@ant-design/icons'
import { App, Button, Empty, Form, Input, Modal, Popconfirm, Select, Skeleton, Statistic, Tag, Typography } from 'antd'
import {
  createMcpServer, createMcpTool, deleteMcpServer, deleteMcpTool, getMcpCatalog,
  updateMcpServer, updateMcpTool,
} from '../api.js'

const { Text, Title } = Typography
const ICONS = {
  apartment: ApartmentOutlined, api: ApiOutlined, audit: AuditOutlined, 'bar-chart': BarChartOutlined,
  bug: BugOutlined, bulb: BulbOutlined, code: CodeOutlined, 'console-sql': ConsoleSqlOutlined,
  database: DatabaseOutlined, 'deployment-unit': DeploymentUnitOutlined, experiment: ExperimentOutlined,
  'file-protect': FileProtectOutlined, 'file-search': FileSearchOutlined, filter: FilterOutlined,
  'font-size': FontSizeOutlined, fund: FundOutlined, global: GlobalOutlined, history: HistoryOutlined,
  key: KeyOutlined, message: MessageOutlined, partition: PartitionOutlined, read: ReadOutlined,
  safety: SafetyOutlined, 'safety-certificate': SafetyCertificateOutlined, scan: ScanOutlined,
  search: SearchOutlined, 'security-scan': SecurityScanOutlined, setting: SettingOutlined,
  tool: ToolOutlined, wifi: WifiOutlined,
}
const SERVER_DEFAULTS = { server_id: '', name: '', purpose: '', category: 'security', transport: 'display_only', url: '', icon: 'safety' }
const TOOL_DEFAULTS = { name: '', display_name: '', purpose: '', input: '', returns: '', invocation_timing: '', risk_level: 'R1', icon: 'tool' }

function CatalogIcon({ name }) {
  const Icon = ICONS[name] || ToolOutlined
  return <Icon />
}

export function McpRegistryPage() {
  const { message } = App.useApp()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [serverDetail, setServerDetail] = useState(null)
  const [toolDetail, setToolDetail] = useState(null)
  const [serverModal, setServerModal] = useState(null)
  const [toolModal, setToolModal] = useState(null)
  const [serverForm] = Form.useForm()
  const [toolForm] = Form.useForm()

  const load = () => {
    setLoading(true)
    getMcpCatalog().then(setData).catch((error) => message.error(`读取 MCP 清单失败：${error.message}`)).finally(() => setLoading(false))
  }
  useEffect(() => { load() }, [])

  const openServerEditor = (server = null) => {
    serverForm.setFieldsValue(server ? { ...server } : SERVER_DEFAULTS)
    setServerModal({ server })
    setServerDetail(null)
  }
  const openToolEditor = (server, tool = null) => {
    toolForm.setFieldsValue(tool ? { ...tool, returns: tool.return } : TOOL_DEFAULTS)
    setToolModal({ server, tool })
    setToolDetail(null)
  }

  const saveServer = async () => {
    try {
      const values = await serverForm.validateFields()
      if (serverModal.server) await updateMcpServer(serverModal.server.server_id, values)
      else await createMcpServer(values)
      message.success(serverModal.server ? 'MCP Server 已更新' : 'MCP Server 已新增')
      setServerModal(null); load()
    } catch (error) { if (!error?.errorFields) message.error(`保存失败：${error.message}`) }
  }
  const saveTool = async () => {
    try {
      const values = await toolForm.validateFields()
      const { server, tool } = toolModal
      if (tool) await updateMcpTool(server.server_id, tool.name, values)
      else await createMcpTool(server.server_id, values)
      message.success(tool ? '工具已更新' : '工具已新增')
      setToolModal(null); load()
    } catch (error) { if (!error?.errorFields) message.error(`保存失败：${error.message}`) }
  }
  const removeServer = async (server) => {
    try { await deleteMcpServer(server.server_id); message.success('MCP Server 已删除'); setServerDetail(null); load() }
    catch (error) { message.error(`删除失败：${error.message}`) }
  }
  const removeTool = async (server, tool) => {
    try { await deleteMcpTool(server.server_id, tool.name); message.success('工具已删除'); setToolDetail(null); load() }
    catch (error) { message.error(`删除失败：${error.message}`) }
  }

  const servers = data?.servers || []
  const toolCount = servers.reduce((total, server) => total + (server.tools?.length || 0), 0)
  return <div className="catalog-page">
    <section className="page-intro catalog-hero"><div><Text className="panel-kicker">MCP REGISTRY / SAFE IMPORT</Text><Title level={2}>MCP 工具清单</Title><p>查看并维护展示型 MCP Server 与工具。所有内容只用于页面展示，不建立连接、不注册工具，也不会被模型调用。</p></div><div className="intro-tags"><Button type="primary" icon={<PlusOutlined />} onClick={() => openServerEditor()}>新增 Server</Button><Button type="text" icon={<ReloadOutlined />} onClick={load}>刷新</Button></div></section>
    <section className="catalog-metrics"><div className="catalog-metric"><CatalogIcon name="tool" /><Statistic title="安全 Server" value={servers.length} /></div><div className="catalog-metric is-green"><SafetyCertificateOutlined /><Statistic title="可展示工具" value={toolCount} /></div></section>
    <section className="glass-panel catalog-library"><header className="panel-heading"><div><Text className="panel-kicker">REGISTERED SERVERS</Text><Title level={4}>工具能力矩阵</Title></div></header><div className="mcp-grid">
      {loading ? <Skeleton active paragraph={{ rows: 12 }} /> : servers.length ? servers.map((server) => <article className={`mcp-card mcp-card-action ${server.candidate ? 'is-candidate' : ''}`} key={server.server_id} role="button" tabIndex={0} onClick={() => setServerDetail(server)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') setServerDetail(server) }}><header><div className="mcp-title"><CatalogIcon name={server.icon} /><span><b>{server.name}</b><small>{server.server_id} · {server.tools?.length || 0} 个展示工具</small></span></div><Tag color="green"><SafetyCertificateOutlined /> 安全 Server</Tag></header><p className="mcp-server-purpose">{server.purpose}</p><div className="mcp-server-actions" onClick={(event) => event.stopPropagation()}><Button size="small" icon={<PlusOutlined />} onClick={() => openToolEditor(server)}>新增工具</Button><Button size="small" icon={<EditOutlined />} onClick={() => openServerEditor(server)}>编辑</Button><Popconfirm title="删除这个 Server？" description="其中的展示工具也会一并删除。" okText="删除" cancelText="取消" onConfirm={() => removeServer(server)}><Button size="small" danger icon={<DeleteOutlined />}>删除</Button></Popconfirm></div><div className="mcp-tool-list">{(server.tools || []).map((tool) => <button className="mcp-tool-row" key={tool.tool_id} type="button" onClick={(event) => { event.stopPropagation(); setToolDetail({ server, tool }) }}><span><CatalogIcon name={tool.icon} /> {tool.display_name || tool.name}</span><small>{tool.name} · {tool.risk_level} · 运行时未暴露</small></button>)}</div>{!server.tools?.length && <small className="mcp-legacy-note">尚未添加展示工具。</small>}</article>) : <Empty description="暂无可展示的安全工具" />}
    </div></section>

    <Modal open={Boolean(serverDetail)} title={serverDetail?.name || 'MCP Server 详情'} width={760} onCancel={() => setServerDetail(null)} footer={<Button onClick={() => setServerDetail(null)}>关闭</Button>}>{serverDetail && <div className="mcp-detail"><div className="mcp-detail-tags"><Tag>{serverDetail.server_id}</Tag><Tag>{serverDetail.transport}</Tag><Tag color="gold">仅展示</Tag></div><p>{serverDetail.purpose}</p><dl><div><dt>分类</dt><dd>{serverDetail.category}</dd></div><div><dt>展示地址</dt><dd>{serverDetail.url || '未填写'}</dd></div><div><dt>工具数量</dt><dd>{serverDetail.tools?.length || 0}</dd></div></dl><div className="prompt-detail-actions"><Button icon={<PlusOutlined />} onClick={() => openToolEditor(serverDetail)}>新增工具</Button><Button icon={<EditOutlined />} onClick={() => openServerEditor(serverDetail)}>编辑 Server</Button><Popconfirm title="删除这个 Server？" okText="删除" cancelText="取消" onConfirm={() => removeServer(serverDetail)}><Button danger icon={<DeleteOutlined />}>删除</Button></Popconfirm></div></div>}</Modal>
    <Modal open={Boolean(toolDetail)} title={toolDetail?.tool?.display_name || '工具详情'} width={720} onCancel={() => setToolDetail(null)} footer={<Button onClick={() => setToolDetail(null)}>关闭</Button>}>{toolDetail && <div className="mcp-detail"><div className="mcp-detail-tags"><Tag>{toolDetail.tool.name}</Tag><Tag>{toolDetail.tool.risk_level}</Tag><Tag color="gold">运行时未暴露</Tag></div><dl><div><dt>作用</dt><dd>{toolDetail.tool.purpose}</dd></div><div><dt>输入</dt><dd>{toolDetail.tool.input}</dd></div><div><dt>返回</dt><dd>{toolDetail.tool.return}</dd></div><div><dt>调用时机</dt><dd>{toolDetail.tool.invocation_timing}</dd></div></dl><div className="prompt-detail-actions"><Button icon={<EditOutlined />} onClick={() => openToolEditor(toolDetail.server, toolDetail.tool)}>编辑</Button><Popconfirm title="删除这个展示工具？" okText="删除" cancelText="取消" onConfirm={() => removeTool(toolDetail.server, toolDetail.tool)}><Button danger icon={<DeleteOutlined />}>删除</Button></Popconfirm></div></div>}</Modal>
    <Modal open={Boolean(serverModal)} title={serverModal?.server ? '编辑 MCP Server' : '新增 MCP Server'} width={720} okText="保存" cancelText="取消" onOk={saveServer} onCancel={() => setServerModal(null)} destroyOnHidden><Form form={serverForm} layout="vertical"><div className="prompt-editor-grid"><Form.Item name="server_id" label="Server ID" rules={[{ required: true }, { pattern: /^[a-z0-9][a-z0-9_-]*$/, message: '仅支持小写字母、数字、下划线和连字符' }]}><Input disabled={Boolean(serverModal?.server)} placeholder="例如 local-demo-tools" /></Form.Item><Form.Item name="name" label="名称" rules={[{ required: true }]}><Input /></Form.Item><Form.Item name="category" label="分类" rules={[{ required: true }]}><Input /></Form.Item><Form.Item name="transport" label="展示传输方式" rules={[{ required: true }]}><Select options={['display_only', 'streamable_http', 'stdio', 'sse'].map((value) => ({ value, label: value }))} /></Form.Item><Form.Item name="icon" label="图标标识" rules={[{ required: true }]}><Input /></Form.Item><Form.Item name="url" label="展示地址"><Input placeholder="不会建立真实连接" /></Form.Item></div><Form.Item name="purpose" label="用途" rules={[{ required: true }]}><Input.TextArea rows={3} /></Form.Item></Form></Modal>
    <Modal open={Boolean(toolModal)} title={toolModal?.tool ? '编辑展示工具' : `为 ${toolModal?.server?.name || ''} 新增工具`} width={760} okText="保存" cancelText="取消" onOk={saveTool} onCancel={() => setToolModal(null)} destroyOnHidden><Form form={toolForm} layout="vertical"><div className="prompt-editor-grid"><Form.Item name="name" label="工具标识" rules={[{ required: true }, { pattern: /^[a-z0-9][a-z0-9_-]*$/, message: '仅支持小写字母、数字、下划线和连字符' }]}><Input disabled={Boolean(toolModal?.tool)} /></Form.Item><Form.Item name="display_name" label="展示名称" rules={[{ required: true }]}><Input /></Form.Item><Form.Item name="risk_level" label="风险等级" rules={[{ required: true }]}><Select options={['R0', 'R1', 'R2', 'R3'].map((value) => ({ value, label: value }))} /></Form.Item><Form.Item name="icon" label="图标标识" rules={[{ required: true }]}><Input /></Form.Item></div><Form.Item name="purpose" label="作用" rules={[{ required: true }]}><Input.TextArea rows={2} /></Form.Item><Form.Item name="input" label="输入说明" rules={[{ required: true }]}><Input.TextArea rows={2} /></Form.Item><Form.Item name="returns" label="返回说明" rules={[{ required: true }]}><Input.TextArea rows={2} /></Form.Item><Form.Item name="invocation_timing" label="调用时机（仅展示）" rules={[{ required: true }]}><Input.TextArea rows={2} /></Form.Item></Form></Modal>
  </div>
}
