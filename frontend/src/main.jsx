import React from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { App as AntApp, ConfigProvider, theme } from 'antd'
import 'antd/dist/reset.css'
import { FeatureApp } from './app/FeatureApp.jsx'
import './styles.css'
import './material-inputs.css'

const appTheme = {
  algorithm: theme.darkAlgorithm,
  token: {
    colorPrimary: '#62d9ff',
    colorInfo: '#62d9ff',
    colorSuccess: '#65d49d',
    colorWarning: '#f1b45b',
    colorError: '#ff7373',
    colorBgBase: '#080b0e',
    colorBgContainer: '#11161a',
    colorBgElevated: '#171d22',
    colorBorder: '#2b343b',
    colorBorderSecondary: '#222a30',
    borderRadius: 7,
    borderRadiusLG: 9,
    fontFamily: "Inter, 'Microsoft YaHei', ui-sans-serif, system-ui, sans-serif",
  },
  components: {
    Layout: { bodyBg: '#080b0e', headerBg: '#101519', siderBg: '#0e1317' },
    Menu: { darkItemBg: '#0e1317', darkItemSelectedBg: '#1c3039', darkItemSelectedColor: '#8ce8ff' },
  },
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ConfigProvider theme={appTheme}>
      <AntApp>
        <BrowserRouter><FeatureApp /></BrowserRouter>
      </AntApp>
    </ConfigProvider>
  </React.StrictMode>,
)
