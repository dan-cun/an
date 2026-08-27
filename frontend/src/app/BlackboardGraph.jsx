import React, { useMemo } from 'react'
import { AimOutlined, BranchesOutlined, CheckCircleOutlined, ExperimentOutlined, FileSearchOutlined } from '@ant-design/icons'
import { Empty, Tag } from 'antd'

const stages = [
  { id: 'origin', label: 'Origin', detail: '输入起点', icon: <AimOutlined />, tone: 'cyan' },
  { id: 'intent', label: 'Intent', detail: '探索意图', icon: <BranchesOutlined />, tone: 'blue' },
  { id: 'execute', label: 'Execute', detail: 'Agent / Tool', icon: <ExperimentOutlined />, tone: 'purple' },
  { id: 'evidence', label: 'Evidence', detail: '事实与证据', icon: <FileSearchOutlined />, tone: 'gold' },
  { id: 'verify', label: 'Verify', detail: '验证与目标', icon: <CheckCircleOutlined />, tone: 'green' },
]

export function BlackboardGraph({ run, events = [] }) {
  const graph = useMemo(() => {
    if (!run) return []
    const has = (type) => events.some((event) => event.event_type === type)
    const toolEvents = events.filter((event) => event.event_type === 'tool.completed')
    const intentCount = events.find((event) => event.event_type === 'plan.created')?.payload?.steps?.length || run.total_steps || 0
    const evidenceCount = events.find((event) => event.event_type === 'analysis.completed')?.payload?.evidence_count || 0
    return stages.map((stage, index) => ({
      ...stage,
      state: index === 0 || has(['plan.created', 'tool.started', 'analysis.completed', 'report.generated'][index - 1]) ? 'done' :
        (index === 1 && has('input.ingested')) || (index === 2 && has('step.selected')) || (index === 3 && toolEvents.length) || (index === 4 && has('verification.completed')) ? 'active' : 'waiting',
      count: index === 0 ? 1 : index === 1 ? intentCount : index === 2 ? toolEvents.length : index === 3 ? evidenceCount : has('report.generated') ? 1 : 0,
    }))
  }, [run, events])

  if (!run) return <div className="blackboard-empty"><Empty description="选择任务后显示探索路径" /></div>
  return <div className="blackboard-view">
    <header className="blackboard-header">
      <div><span>FACT - INTENT GRAPH</span><b>黑板探索路径</b></div>
      <div className="blackboard-legend"><span><i className="is-done" />已确认</span><span><i className="is-active" />当前探索</span><span><i />等待</span></div>
    </header>
    <div className="blackboard-canvas">
      <div className="blackboard-grid-lines" />
      <div className="graph-route">{graph.map((node, index) => <React.Fragment key={node.id}>
        <article className={`graph-node is-${node.tone} is-${node.state}`}>
          <div className="graph-node-title"><i>{node.icon}</i><span><b>{node.label}</b><small>{node.detail}</small></span><Tag>{node.count}</Tag></div>
          <p>{node.id === 'origin' ? (run.name || '上传材料') : node.id === 'intent' ? `${run.routing?.primary_type || run.scenario} 分析路线` : node.id === 'execute' ? '受控模块适配器' : node.id === 'evidence' ? 'Finding / Evidence' : '独立校验与报告'}</p>
          <footer>{node.state === 'done' ? 'CONFIRMED' : node.state === 'active' ? 'EXPLORING' : 'PENDING'}</footer>
        </article>
        {index < graph.length - 1 && <div className={`graph-edge ${node.state !== 'waiting' ? 'is-live' : ''}`}><span>›</span></div>}
      </React.Fragment>)}</div>
      <div className="graph-insight"><span>调度策略</span><b>空闲 Agent 主动认领意图，事实写回黑板后触发下一轮规划。</b><small>自然语言输出不直接算状态，只有结构化 Evidence 与验证记录进入最终报告。</small></div>
    </div>
  </div>
}
