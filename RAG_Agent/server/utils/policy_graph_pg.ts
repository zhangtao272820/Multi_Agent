/**
 * M1：制度图 Postgres 边表（与 pgvector 同库可选镜像；失败不阻断文件主路径）。
 */
import pg from "pg";

const NODES_TABLE = "rag_policy_nodes";
const EDGES_TABLE = "rag_policy_edges";

function wantPgMirror(): boolean {
  const explicit = String(process.env.RAG_POLICY_GRAPH_BACKEND ?? "").trim().toLowerCase();
  if (explicit === "pg" || explicit === "postgres") return true;
  if (explicit === "file" || explicit === "json") return false;
  const backend = String(process.env.RAG_VECTOR_BACKEND ?? "memory").trim().toLowerCase();
  return backend === "pgvector" && Boolean(String(process.env.RAG_PG_CONNECTION_STRING ?? "").trim());
}

let pool: pg.Pool | null = null;
let schemaReady = false;

async function getPool(): Promise<pg.Pool | null> {
  if (!wantPgMirror()) return null;
  const connectionString = String(process.env.RAG_PG_CONNECTION_STRING ?? "").trim();
  if (!connectionString) return null;
  if (!pool) {
    pool = new pg.Pool({ connectionString, max: 4 });
  }
  return pool;
}

export async function ensurePolicyGraphPgSchema(): Promise<boolean> {
  const p = await getPool();
  if (!p) return false;
  if (schemaReady) return true;
  try {
    await p.query(`
    CREATE TABLE IF NOT EXISTS ${NODES_TABLE} (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      source TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      chunk_id TEXT,
      text TEXT,
      meta JSONB
    );
    CREATE TABLE IF NOT EXISTS ${EDGES_TABLE} (
      id TEXT PRIMARY KEY,
      from_id TEXT NOT NULL,
      to_id TEXT NOT NULL,
      rel TEXT NOT NULL,
      source TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      meta JSONB
    );
    CREATE INDEX IF NOT EXISTS rag_policy_nodes_source_idx ON ${NODES_TABLE}(source);
    CREATE INDEX IF NOT EXISTS rag_policy_edges_source_idx ON ${EDGES_TABLE}(source);
  `);
  } catch (e: unknown) {
    // 并发建表时可能撞 pg_type 唯一约束；表已存在则视为就绪
    const code = (e as { code?: string })?.code;
    if (code !== "23505") throw e;
  }
  schemaReady = true;
  return true;
}

export async function purgePolicyGraphPgBySource(source: string): Promise<void> {
  const p = await getPool();
  if (!p) return;
  await ensurePolicyGraphPgSchema();
  const s = String(source || "").trim();
  if (!s) return;
  await p.query(`DELETE FROM ${EDGES_TABLE} WHERE source = $1`, [s]);
  await p.query(`DELETE FROM ${NODES_TABLE} WHERE source = $1`, [s]);
}

export async function mirrorPolicyGraphToPg(data: {
  source: string;
  content_hash: string;
  nodes: Array<{
    id: string;
    type: string;
    name: string;
    chunk_id?: string;
    text?: string;
    meta?: Record<string, unknown>;
  }>;
  edges: Array<{
    id: string;
    from_id: string;
    to_id: string;
    rel: string;
    meta?: Record<string, unknown>;
  }>;
}): Promise<void> {
  const p = await getPool();
  if (!p) return;
  await ensurePolicyGraphPgSchema();
  const source = String(data.source || "").trim();
  const content_hash = String(data.content_hash || "").trim();
  if (!source) return;
  const client = await p.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM ${EDGES_TABLE} WHERE source = $1`, [source]);
    await client.query(`DELETE FROM ${NODES_TABLE} WHERE source = $1`, [source]);
    for (const n of data.nodes) {
      await client.query(
        `INSERT INTO ${NODES_TABLE} (id, type, name, source, content_hash, chunk_id, text, meta)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (id) DO UPDATE SET
           type=EXCLUDED.type, name=EXCLUDED.name, source=EXCLUDED.source,
           content_hash=EXCLUDED.content_hash, chunk_id=EXCLUDED.chunk_id,
           text=EXCLUDED.text, meta=EXCLUDED.meta`,
        [
          n.id,
          n.type,
          n.name,
          source,
          content_hash,
          n.chunk_id ?? null,
          n.text ?? null,
          n.meta ? JSON.stringify(n.meta) : null,
        ]
      );
    }
    for (const e of data.edges) {
      await client.query(
        `INSERT INTO ${EDGES_TABLE} (id, from_id, to_id, rel, source, content_hash, meta)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (id) DO UPDATE SET
           from_id=EXCLUDED.from_id, to_id=EXCLUDED.to_id, rel=EXCLUDED.rel,
           source=EXCLUDED.source, content_hash=EXCLUDED.content_hash, meta=EXCLUDED.meta`,
        [
          e.id,
          e.from_id,
          e.to_id,
          e.rel,
          source,
          content_hash,
          e.meta ? JSON.stringify(e.meta) : null,
        ]
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw e;
  } finally {
    client.release();
  }
}

/** 从 PG 灌入内存结构（文件空且 pgvector 时可由调用方合并） */
export async function loadPolicyGraphFromPg(): Promise<{
  nodes: Array<Record<string, unknown>>;
  edges: Array<Record<string, unknown>>;
} | null> {
  const p = await getPool();
  if (!p) return null;
  await ensurePolicyGraphPgSchema();
  const nodes = (await p.query(`SELECT * FROM ${NODES_TABLE}`)).rows ?? [];
  const edges = (await p.query(`SELECT * FROM ${EDGES_TABLE}`)).rows ?? [];
  return { nodes, edges };
}
