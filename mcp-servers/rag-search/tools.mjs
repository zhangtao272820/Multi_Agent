/** RAG MCP Server 工具定义（schema smoke 与 index 共用） */
export const RAG_MCP_TOOLS = [
  {
    name: 'kb_search',
    description:
      'Hybrid 检索私有知识库（Retrieve-first）。返回 evidence 片段与 docKey；无命中时 hits 为空，不编造答案。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索问句' },
        top_k: { type: 'integer', minimum: 1, maximum: 20, description: '返回片段上限（默认 5）' }
      },
      required: ['query']
    }
  },
  {
    name: 'kb_health',
    description: '探测 RAG 专家 /api/ready 是否可用（不检索、不生成）。',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  }
]

export function validateRagMcpTools() {
  for (const t of RAG_MCP_TOOLS) {
    if (!t.name || !t.description || !t.inputSchema) {
      throw new Error(`invalid rag mcp tool: ${t.name || '(unnamed)'}`)
    }
    if (t.name === 'kb_search' && !Array.isArray(t.inputSchema.required)) {
      throw new Error('kb_search must require query')
    }
  }
}
