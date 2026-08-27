import React, { useEffect, useMemo, useState } from 'react'
import { AppstoreOutlined, AuditOutlined, DashboardOutlined, HomeOutlined, MenuFoldOutlined, MenuUnfoldOutlined, RobotOutlined, TeamOutlined } from '@ant-design/icons'
import { Button, Layout, Menu, Tag } from 'antd'
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { health } from '../api.js'
import { AuditReplayPage } from './AuditReplayPage.jsx'
import { ControlStarfield } from './ControlStarfield.jsx'
import { ModelUsagePage } from './ModelUsagePage.jsx'
import { WorkbenchPage } from './WorkbenchPage.jsx'
import { DashboardPage } from './DashboardPage.jsx'

const { Header, Sider, Content } = Layout
const routes = { '/dashboard': ['安全态势总览', <DashboardOutlined />], '/workbench': ['任务编排', <TeamOutlined />], '/audit': ['审计与拦截', <AuditOutlined />], '/models': ['模型与用量', <RobotOutlined />] }

export function FeatureApp() {
  const navigate = useNavigate(); const location = useLocation(); const [collapsed, setCollapsed] = useState(false); const [backend, setBackend] = useState(null)
  const active = location.pathname.startsWith('/audit') ? '/audit' : location.pathname.startsWith('/models') ? '/models' : location.pathname.startsWith('/workbench') ? '/workbench' : '/dashboard'
  const [title, titleIcon] = routes[active]
  useEffect(() => { let live = true; const check = () => health().then((value) => live && setBackend(value)).catch(() => live && setBackend(null)); check(); const timer = setInterval(check, 10000); return () => { live = false; clearInterval(timer) } }, [])
  const items = useMemo(() => [
    { type: 'group', label: '安全运营', children: [
      { key: '/dashboard', icon: <DashboardOutlined />, label: '态势总览' },
      { key: '/workbench', icon: <TeamOutlined />, label: '任务编排' },
      { key: '/audit', icon: <AuditOutlined />, label: '审计与拦截' },
    ] },
    { type: 'group', label: '系统能力', children: [
      { key: '/models', icon: <RobotOutlined />, label: '模型与用量' },
      { key: 'visual', icon: <AppstoreOutlined />, label: '视觉入口' },
    ] },
  ], [])

  return <Layout className={`feature-shell ${collapsed ? 'is-collapsed' : ''}`}>
    <ControlStarfield />
    <Sider className="feature-sidebar" width={236} collapsedWidth={72} collapsed={collapsed} trigger={null}>
      <button className="feature-brand" type="button" onClick={() => window.location.assign('/')}><img src="/model/logo.svg" alt="" /><span><b>SECMIND</b><small>AGENT RUNTIME</small></span></button>
      <Menu mode="inline" selectedKeys={[active]} items={items} onClick={({ key }) => key === 'visual' ? window.location.assign('/') : navigate(key)} />
      <div className="sidebar-foot"><i className={backend ? 'is-online' : ''} /><span>{backend ? 'Runtime online' : 'Runtime offline'}</span></div>
    </Sider>
    <Layout className="feature-main">
      <Header className="feature-header"><div><Button type="text" icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />} onClick={() => setCollapsed((value) => !value)} /><span className="header-module">{titleIcon}<b>{title}</b></span></div><div className="header-status"><Tag color={backend ? 'success' : 'error'}>{backend ? '后端在线' : '后端离线'}</Tag>{backend?.demo_mode && <Tag color="gold">DEMO</Tag>}<span>{new Date().toLocaleDateString('zh-CN')}</span></div></Header>
      <Content className="feature-content"><Routes><Route path="/dashboard" element={<DashboardPage />} /><Route path="/workbench" element={<WorkbenchPage />} /><Route path="/audit" element={<AuditReplayPage />} /><Route path="/audit/:runId" element={<AuditReplayPage />} /><Route path="/models" element={<ModelUsagePage />} /><Route path="*" element={<Navigate to="/dashboard" replace />} /></Routes></Content>
    </Layout>
  </Layout>
}
