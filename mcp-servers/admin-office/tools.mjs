/** Admin 办公 MCP：只读邮件 + draft 预览；禁止 SMTP 直发 */
import { createHash } from 'node:crypto'

export const ADMIN_OFFICE_MCP_TOOLS = [
  {
    name: 'admin_list_emails',
    description:
      '列出当前用户收件箱摘要（只读，代理 Admin /api/mail/inbox）。不发送邮件。',
    inputSchema: {
      type: 'object',
      properties: {
        user_id: { type: 'string', description: '绑定邮箱的用户 id' },
        session_id: { type: 'string', description: '会话 id，默认 default' },
        limit: { type: 'number', description: '条数，默认 10' },
        unread_only: { type: 'boolean', description: '仅未读，默认 true' }
      },
      required: ['user_id']
    }
  },
  {
    name: 'admin_search_emails',
    description:
      '按关键词搜索邮件（只读）。MCP 层不执行 SMTP；未配置 Admin 时返回 not_configured。',
    inputSchema: {
      type: 'object',
      properties: {
        user_id: { type: 'string' },
        session_id: { type: 'string' },
        query: { type: 'string', description: '搜索词' },
        limit: { type: 'number' }
      },
      required: ['user_id', 'query']
    }
  },
  {
    name: 'admin_create_draft',
    description:
      '创建本地邮件草稿结构 mail_compose（不发信、不写 SMTP）。返回 to/subject/content/digest 供产品 HITL Compose Card 确认。',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string' },
        subject: { type: 'string' },
        content: { type: 'string' },
        cc: { type: 'string' },
        from_address: { type: 'string' }
      },
      required: ['to', 'subject', 'content']
    }
  },
  {
    name: 'admin_get_pending_preview',
    description: '读取 Admin 会话待确认操作列表（含 mail_compose 预览）。不执行 confirm。',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: '会话 id' }
      },
      required: ['session_id']
    }
  },
  {
    name: 'admin_health',
    description: '探测 Admin 专家 /api/ready。',
    inputSchema: { type: 'object', properties: {} }
  }
]

export function validateAdminOfficeMcpTools() {
  for (const t of ADMIN_OFFICE_MCP_TOOLS) {
    if (!t.name || !t.description || !t.inputSchema) {
      throw new Error(`invalid admin-office mcp tool: ${t.name || '(unnamed)'}`)
    }
  }
  const sendLike = ADMIN_OFFICE_MCP_TOOLS.filter((t) =>
    /send_email|smtp|send_mail|send_draft/i.test(t.name)
  )
  if (sendLike.length) {
    throw new Error('admin-office MCP must not expose send/SMTP tools')
  }
}

/** 纯函数：装配 draft（供 MCP create_draft，无副作用） */
export function buildAdminMailComposeDraft(args = {}) {
  const to = String(args.to || '').trim()
  const subject = String(args.subject || '').trim()
  const content = String(args.content || '')
  const cc = String(args.cc || '').trim()
  const from_address = String(args.from_address || '').trim()
  if (!to || !subject) {
    return { ok: false, error: 'to_and_subject_required' }
  }
  const payload = JSON.stringify({
    tool: 'send_email',
    to,
    cc,
    bcc: '',
    subject,
    content,
    email_id: null,
    from_address
  })
  const digest = 'sha256:' + createHash('sha256').update(payload).digest('hex')
  return {
    ok: true,
    mail_compose: {
      tool: 'send_email',
      to,
      cc,
      bcc: '',
      subject,
      content,
      email_id: null,
      from_address,
      editable: true,
      digest
    },
    warning: 'draft_only_no_smtp'
  }
}
