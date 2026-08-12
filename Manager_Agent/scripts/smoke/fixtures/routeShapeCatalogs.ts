/**
 * Wave7：合成运行时目录 stub（两套域）。
 * 仅 smoke/eval 使用；禁止写入生产 System Prompt。
 */

export type SyntheticProbe = {
  db: {
    matched: boolean
    tables: string[]
    tableInventory: string[]
    schemaSummary?: string
  }
  rag: {
    hits: number
    hasDocs: boolean
    docInventory: string[]
    sources: string[]
    snippets?: string[]
  }
}

/** 域 A：订单 / 退款政策（合成） */
export const CATALOG_ORDERS: SyntheticProbe = {
  db: {
    matched: true,
    tables: ['orders', 'customers'],
    tableInventory: ['orders', 'customers', 'order_items', 'payments'],
    schemaSummary: 'orders(id, customer_id, amount, created_at); customers(id, name)'
  },
  rag: {
    hits: 1,
    hasDocs: true,
    docInventory: ['refund_policy.md', 'shipping_sla.md'],
    sources: ['refund_policy.md'],
    snippets: ['冷静期 7 天内可无理由退款']
  }
}

/** 域 B：课程 / 学员手册（合成；与养老/p2026 无关） */
export const CATALOG_COURSES: SyntheticProbe = {
  db: {
    matched: true,
    tables: ['courses', 'enrollments'],
    tableInventory: ['courses', 'enrollments', 'instructors', 'sessions'],
    schemaSummary: 'courses(id, title); enrollments(course_id, student_id, status)'
  },
  rag: {
    hits: 1,
    hasDocs: true,
    docInventory: ['student_handbook.md', 'grading_policy.md'],
    sources: ['student_handbook.md'],
    snippets: ['缺勤累计三次取消学分']
  }
}

export type ShapeCase = {
  id: string
  /** 形态标签（断言用，非用户原话正则） */
  taskIntent: 'structured_query' | 'document_retrieval' | 'hybrid' | 'ops_admin'
  userTask: string
  draft: Array<{ agent: string; scopedUserLanguage: string }>
  meta: Record<string, unknown>
  expectCap: string[]
  /** 选用哪套合成 catalog（换域烟雾会两套都跑） */
  catalogKey: 'orders' | 'courses' | 'either'
}

/**
 * 抽象形态黄金集：问句故意用中性业务词，不写养老/p2026 专名。
 * 同一套 shape 应对 orders / courses 两套 catalog 都成立（换域零改 Manager）。
 */
export const ROUTE_SHAPE_CASES: ShapeCase[] = [
  {
    id: 'S1_structured',
    taskIntent: 'structured_query',
    userTask: '统计本月成交笔数按客户汇总',
    draft: [{ agent: 'db', scopedUserLanguage: '统计本月成交笔数按客户汇总' }],
    meta: {
      dataPlaneTaskIntent: 'structured_query',
      dataPlanePrimaryPlane: 'db',
      dataPlaneClarifyRisk: 'low',
      dataPlaneConfidence: 0.85
    },
    expectCap: ['db'],
    catalogKey: 'either'
  },
  {
    id: 'S2_document',
    taskIntent: 'document_retrieval',
    userTask: '手册里关于冷静期或缺勤规则原文怎么写的',
    draft: [{ agent: 'rag', scopedUserLanguage: '手册冷静期或缺勤规则原文' }],
    meta: {
      dataPlaneTaskIntent: 'document_retrieval',
      dataPlanePrimaryPlane: 'rag',
      dataPlaneClarifyRisk: 'low',
      dataPlaneConfidence: 0.84
    },
    expectCap: ['rag'],
    catalogKey: 'either'
  },
  {
    id: 'S3_hybrid',
    taskIntent: 'hybrid',
    userTask: '知识库查政策要点，数据库查本周记录条数，对比说明',
    draft: [
      { agent: 'rag', scopedUserLanguage: '政策要点' },
      { agent: 'db', scopedUserLanguage: '本周记录条数' }
    ],
    meta: {
      requiresAgentPipelineHint: true,
      taskShape: 'multi_source_parallel',
      dataPlaneTaskIntent: 'hybrid'
    },
    expectCap: ['rag', 'db'],
    catalogKey: 'either'
  },
  {
    id: 'S4_admin',
    taskIntent: 'ops_admin',
    userTask: '查明天本地天气并提醒我带伞',
    draft: [{ agent: 'admin', scopedUserLanguage: '明天天气并提醒带伞' }],
    meta: { taskShape: 'action_only', wantsAdminHint: true },
    expectCap: ['admin'],
    catalogKey: 'either'
  }
]

export function probeForCatalog(key: 'orders' | 'courses'): SyntheticProbe {
  return key === 'orders' ? CATALOG_ORDERS : CATALOG_COURSES
}
