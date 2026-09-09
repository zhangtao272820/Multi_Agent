const AGENT_LABELS: Record<string, string> = {
  db: '查数据库',
  rag: '检索知识库',
  crawler: '采集网页',
  code: '计算数据',
  clean: '清洗数据',
  visualize: '生成图表',
  report: '撰写报告',
  admin: '处理日程事务',
  gui: '浏览器操作',
  multimodal: '理解附件',
  music: '生成音乐',
  video: '生成视频',
  multi: '多步执行'
}

/** 将内部 phase 转为用户可读状态文案（U3-4） */
export function userPhaseLabel(phase: string): string {
  const p = String(phase || '').trim()
  if (!p) return '准备中…'
  if (p === 'route' || p === 'orchestrate' || p === 'turn_scope') return '理解你的问题…'
  if (p === 'planner' || p === 'plan_lint') return '制定执行计划…'
  if (p === 'prefetch') return '预取背景资料…'
  if (p === 'plan_preview') return '等待你确认计划…'
  if (p === 'multi' || p === 'scheduler') return '调度专才…'
  if (p === 'local_replan') return '规划下一步…'
  if (p === 'synth' || p === 'synth_stream') return '整理回答…'
  if (p === 'evaluator' || p === 'critic' || p === 'optimizer' || p === 'verifier') return '核对结果…'
  if (p === 'finalize') return '完成'
  if (p === 'clarify') return '需要补充信息…'
  if (p.startsWith('execute:')) {
    const agent = p.slice('execute:'.length)
    const label = AGENT_LABELS[agent] || agent
    return `正在${label}…`
  }
  return p
}

export function planAgentLabel(agent: string): string {
  return AGENT_LABELS[String(agent || '').toLowerCase()] || agent || '步骤'
}
