/** DB MCP Server 工具定义 */
export const DB_MCP_TOOLS = [
  {
    name: 'db_probe',
    description: '探测 NL2SQL 可达性：schema 匹配与 DB ping（只读，不执行用户 SQL）。',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '自然语言问题，用于 schema 检索' }
      },
      required: ['question']
    }
  },
  {
    name: 'db_ask_readonly',
    description:
      '经 DB 专家 NL2SQL 只读链路问答（内部 guardPipeline 强制 SELECT+LIMIT）。会产生 LLM 调用；仅用于受信 Host。',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '问数问题' },
        db_id: { type: 'string', description: '可选数据源 id' }
      },
      required: ['question']
    }
  },
  {
    name: 'db_health',
    description: '探测 DB 专家 /api/ready。',
    inputSchema: { type: 'object', properties: {} }
  }
]

export function validateDbMcpTools() {
  for (const t of DB_MCP_TOOLS) {
    if (!t.name || !t.description || !t.inputSchema) {
      throw new Error(`invalid db mcp tool: ${t.name || '(unnamed)'}`)
    }
  }
}
