#!/usr/bin/env node
/**
 * ClawHive Admin Office MCP Server（stdio）
 * 只读邮件列表 / pending 预览 + 本地 draft 装配。禁止 SMTP 直发。
 *
 * 环境变量：
 *   ADMIN_AGENT_URL — 默认 http://127.0.0.1:13105
 *   AGENT_SERVICE_TOKEN / CLAWHIVE_INTERNAL_TOKEN
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { getJson } from '../lib/agentFetch.mjs'
import {
  ADMIN_OFFICE_MCP_TOOLS,
  buildAdminMailComposeDraft
} from './tools.mjs'

const ADMIN_BASE = String(process.env.ADMIN_AGENT_URL || 'http://127.0.0.1:13105').replace(
  /\/$/,
  ''
)

const server = new Server(
  { name: 'clawhive-admin-office', version: '0.1.0' },
  { capabilities: { tools: {} } }
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: ADMIN_OFFICE_MCP_TOOLS
}))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = String(req.params?.name || '')
  const args = req.params?.arguments ?? {}

  if (name === 'admin_health') {
    try {
      const res = await fetch(`${ADMIN_BASE}/api/ready`)
      const text = await res.text()
      let data
      try {
        data = JSON.parse(text)
      } catch {
        data = { ok: res.ok, raw: text.slice(0, 500) }
      }
      return {
        content: [{ type: 'text', text: JSON.stringify({ status: res.status, ...data }, null, 2) }]
      }
    } catch (e) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ ok: false, error: 'admin_unreachable', detail: String(e) })
          }
        ],
        isError: true
      }
    }
  }

  if (name === 'admin_create_draft') {
    const draft = buildAdminMailComposeDraft(args)
    return {
      content: [{ type: 'text', text: JSON.stringify(draft, null, 2) }],
      isError: !draft.ok
    }
  }

  if (name === 'admin_list_emails') {
    const userId = String(args.user_id || '').trim()
    if (!userId) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'user_id_required' }) }],
        isError: true
      }
    }
    const q = new URLSearchParams({
      user_id: userId,
      session_id: String(args.session_id || 'default'),
      limit: String(args.limit ?? 10),
      unread_only: String(args.unread_only !== false)
    })
    try {
      const data = await getJson(ADMIN_BASE, `/api/mail/inbox?${q.toString()}`)
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ ...data, warning: 'readonly_no_smtp' }, null, 2)
          }
        ]
      }
    } catch (e) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ ok: false, error: 'list_failed', detail: String(e) })
          }
        ],
        isError: true
      }
    }
  }

  if (name === 'admin_search_emails') {
    // 无独立 REST search 时：明确 not_implemented_via_rest，避免假成功发信
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ok: false,
            error: 'search_via_rest_not_exposed',
            hint: 'Use Admin chat tool search_emails; MCP will not send mail.',
            query: String(args.query || '')
          })
        }
      ],
      isError: true
    }
  }

  if (name === 'admin_get_pending_preview') {
    const sessionId = String(args.session_id || '').trim()
    if (!sessionId) {
      return {
        content: [
          { type: 'text', text: JSON.stringify({ ok: false, error: 'session_id_required' }) }
        ],
        isError: true
      }
    }
    try {
      const data = await getJson(
        ADMIN_BASE,
        `/api/pending?session_id=${encodeURIComponent(sessionId)}`
      )
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ ...data, warning: 'preview_only_no_commit' }, null, 2)
          }
        ]
      }
    } catch (e) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ ok: false, error: 'pending_failed', detail: String(e) })
          }
        ],
        isError: true
      }
    }
  }

  return {
    content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'unknown_tool', name }) }],
    isError: true
  }
})

const transport = new StdioServerTransport()
await server.connect(transport)
