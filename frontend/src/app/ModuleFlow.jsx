import React from 'react'
import { Tag } from 'antd'

const labels = { code_audit: '代码审计', reverse_triage: '逆向分析', penetration_test: '渗透测试', unknown: '待识别' }

export function ModuleFlow({ run, events = [] }) {
  const route = run?.scenario || 'unknown'
  const penetration = route === 'penetration_test'
  const nodes = penetration
    ? ['Origin', 'Intent', 'Worker', 'Fact', 'Goal']
    : ['输入材料', '题型识别', '任务规划', '工具分析', '证据归一化', '结论验证', '报告生成']
  const completed = new Set(events.map((event) => event.event_type))
  return <div className="module-flow">
    <div className="module-flow-head"><span>模块流程</span><Tag color={route === 'unknown' ? 'default' : 'cyan'}>{labels[route] || route}</Tag>{run?.routing?.confidence && <small>置信度 {(run.routing.confidence * 100).toFixed(0)}%</small>}</div>
    <div className="module-flow-track">{nodes.map((node, index) => <React.Fragment key={node}><div className={`module-flow-node ${index === 0 || completed.size > index ? 'is-active' : ''}`}><b>{node}</b><small>{penetration ? ['黑板起点', '意图', '执行器', '事实', '目标'][index] : ['上传', '规则+正则', '有界计划', '模块适配器', 'Finding/Evidence', '校验', '统一报告'][index]}</small></div>{index < nodes.length - 1 && <span className="module-flow-arrow">→</span>}</React.Fragment>)}</div>
  </div>
}
