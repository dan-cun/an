import React, { useEffect, useMemo, useState } from 'react'
import { AlertOutlined, AuditOutlined, DashboardOutlined, DatabaseOutlined, FileTextOutlined, MenuFoldOutlined, MenuUnfoldOutlined, RobotOutlined, ToolOutlined, TeamOutlined } from '@ant-design/icons'
import { Button, Layout, Menu, Tag } from 'antd'
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { health } from '../api.js'
import { AuditReplayPage } from './AuditReplayPage.jsx'
import { ControlStarfield } from './ControlStarfield.jsx'
import { ModelUsagePage } from './ModelUsagePage.jsx'
import { WorkbenchPage } from './WorkbenchPage.jsx'
import { DashboardPage } from './DashboardPage.jsx'
import { ExperienceLibraryPage } from './ExperienceLibraryPage.jsx'
import { PromptCatalogPage } from './PromptCatalogPage.jsx'
import { McpRegistryPage } from './McpRegistryPage.jsx'
import { IncidentResponsePage } from './IncidentResponsePage.jsx'

const { Header, Sider, Content } = Layout
const routes = { '/dashboard': ['安全态势总览', <DashboardOutlined />], '/workbench': ['任务编排', <TeamOutlined />], '/audit': ['审计与拦截', <AuditOutlined />], '/experiences': ['经验学习库', <DatabaseOutlined />], '/incident-response': ['应急响应', <AlertOutlined />], '/models': ['模型与用量', <RobotOutlined />], '/prompts': ['Prompt 目录', <FileTextOutlined />], '/mcp': ['MCP 工具清单', <ToolOutlined />] }

export function FeatureApp() {
  const navigate = useNavigate(); const location = useLocation(); const [collapsed, setCollapsed] = useState(false); const [backend, setBackend] = useState(null)
  const active = location.pathname.startsWith('/audit') ? '/audit' : location.pathname.startsWith('/experiences') ? '/experiences' : location.pathname.startsWith('/incident-response') ? '/incident-response' : location.pathname.startsWith('/models') ? '/models' : location.pathname.startsWith('/prompts') ? '/prompts' : location.pathname.startsWith('/mcp') ? '/mcp' : location.pathname.startsWith('/workbench') ? '/workbench' : '/dashboard'
  const [title, titleIcon] = routes[active]
  useEffect(() => { let live = true; const check = () => health().then((value) => live && setBackend(value)).catch(() => live && setBackend(null)); check(); const timer = setInterval(check, 10000); return () => { live = false; clearInterval(timer) } }, [])
  const items = useMemo(() => [
    { type: 'group', label: '安全运营', children: [
      { key: '/dashboard', icon: <DashboardOutlined />, label: '态势总览' },
      { key: '/workbench', icon: <TeamOutlined />, label: '任务编排' },
      { key: '/audit', icon: <AuditOutlined />, label: '审计与拦截' },
      { key: '/experiences', icon: <DatabaseOutlined />, label: '经验学习库' },
      { key: '/incident-response', icon: <AlertOutlined />, label: '应急响应' },
    ] },
    { type: 'group', label: '系统能力', children: [
      { key: '/models', icon: <RobotOutlined />, label: '模型与用量' },
      { key: '/prompts', icon: <FileTextOutlined />, label: 'Prompt 目录' },
      { key: '/mcp', icon: <ToolOutlined />, label: 'MCP 工具清单' },
    ] },
  ], [])

  return <Layout className={`feature-shell ${collapsed ? 'is-collapsed' : ''}`}>
    <ControlStarfield />
    <Sider className="feature-sidebar" width={236} collapsedWidth={72} collapsed={collapsed} trigger={null}>
      <button className="sidebar-title" type="button" onClick={() => navigate('/dashboard')}><span><b>安全任务平台</b><small>任务编排与审计</small></span></button>
      <Menu mode="inline" selectedKeys={[active]} items={items} onClick={({ key }) => navigate(key)} />
      <div className="sidebar-foot"><i className={backend ? 'is-online' : ''} /><span>{backend ? 'Runtime online' : 'Runtime offline'}</span></div>
    </Sider>
    <Layout className="feature-main">
      <Header className="feature-header"><div><Button type="text" icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />} onClick={() => setCollapsed((value) => !value)} /><span className="header-module">{titleIcon}<b>{title}</b></span></div><div className="header-status"><Tag color={backend ? 'success' : 'error'}>{backend ? '后端在线' : '后端离线'}</Tag>{backend?.demo_mode && <Tag color="gold">DEMO</Tag>}<span>{new Date().toLocaleDateString('zh-CN')}</span></div></Header>
      <Content className="feature-content"><Routes><Route path="/dashboard" element={<DashboardPage />} /><Route path="/workbench" element={<WorkbenchPage />} /><Route path="/audit" element={<AuditReplayPage />} /><Route path="/audit/:runId" element={<AuditReplayPage />} /><Route path="/experiences" element={<ExperienceLibraryPage />} /><Route path="/incident-response" element={<IncidentResponsePage />} /><Route path="/models" element={<ModelUsagePage />} /><Route path="/prompts" element={<PromptCatalogPage />} /><Route path="/mcp" element={<McpRegistryPage />} /><Route path="*" element={<Navigate to="/dashboard" replace />} /></Routes></Content>
    </Layout>
  </Layout>
}
