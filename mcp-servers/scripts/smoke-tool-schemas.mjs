/**
 * MCP tool schema 门禁（不调专家、不调 LLM）
 */
import { validateRagMcpTools, RAG_MCP_TOOLS } from '../rag-search/tools.mjs'
import { validateDbMcpTools, DB_MCP_TOOLS } from '../db-readonly/tools.mjs'
import {
  validateAdminOfficeMcpTools,
  ADMIN_OFFICE_MCP_TOOLS,
  buildAdminMailComposeDraft
} from '../admin-office/tools.mjs'

function assert(cond, msg) {
  if (!cond) throw new Error(`[mcp smoke:schema] ${msg}`)
}

validateRagMcpTools()
validateDbMcpTools()
validateAdminOfficeMcpTools()

assert(RAG_MCP_TOOLS.length >= 2, 'rag tools >= 2')
assert(DB_MCP_TOOLS.length >= 3, 'db tools >= 3')
assert(ADMIN_OFFICE_MCP_TOOLS.length >= 4, 'admin-office tools >= 4')

const names = new Set()
for (const t of [...RAG_MCP_TOOLS, ...DB_MCP_TOOLS, ...ADMIN_OFFICE_MCP_TOOLS]) {
  assert(!names.has(t.name), `duplicate tool name: ${t.name}`)
  names.add(t.name)
}

const draft = buildAdminMailComposeDraft({
  to: 'a@example.com',
  subject: 't',
  content: 'body'
})
assert(draft.ok && draft.mail_compose?.digest, 'create_draft local assemble')
assert(draft.warning === 'draft_only_no_smtp', 'draft warns no smtp')

console.log(
  `mcp smoke:schema OK — rag=${RAG_MCP_TOOLS.length} db=${DB_MCP_TOOLS.length} admin=${ADMIN_OFFICE_MCP_TOOLS.length} tools`
)
