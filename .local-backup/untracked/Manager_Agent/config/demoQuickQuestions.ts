/**
 * 聊天页「快捷示例」——仅 UI 演示，不进编排 system prompt。
 *
 * 换真实客户时：改本文件或部署时覆盖 `DEMO_QUICK_QUESTIONS`，
 * 勿把客户专名写进 `orchestratorPromptProfiles.ts`。
 * SSOT：`doc/真实用户域解耦.md`
 */
export const DEMO_QUICK_QUESTIONS_DEFAULT: string[] = [
  '打开 https://httpbin.org/forms/post ，在 Customer name 字段填写 lobster_mgr_test，截图给我。',
  '打开 https://ant.design/components/form-cn ，在演示表单里填写姓名「张三」和邮箱 test@example.com，不要点提交，截图给我。',
  '打开百度搜索 Python 教程，点第一条结果，把标题和链接告诉我。',
  '在数据库中查询林婉清足底压力测试记录，汇总后生成报告（结论与注意事项）。',
  '先从数据库中取出林婉清足底压力测试记录，再从公开网站检索同年龄段足底压力参考区间或指南摘要，对照后生成报告。',
  '在知识库中检索个人月度财务情况，提炼要点并生成对比图表，并帮我创建明天上午 10 点的会议日程，标题为「项目周会」，并设置会议提醒。',
  '对上传图片做 OCR，提取可见文字并用一句话概括。',
  '生成 20 秒轻松钢琴纯音乐，用于演示开场。'
]

/** 解析部署覆盖：换行或 `|` 分隔；空则回落默认 */
export function resolveDemoQuickQuestions(envRaw?: string | null): string[] {
  const raw = String(envRaw ?? '').trim()
  if (!raw) return [...DEMO_QUICK_QUESTIONS_DEFAULT]
  const parts = raw.includes('|')
    ? raw.split('|')
    : raw.split(/\r?\n/)
  const list = parts.map((s) => s.trim()).filter(Boolean)
  return list.length ? list : [...DEMO_QUICK_QUESTIONS_DEFAULT]
}
