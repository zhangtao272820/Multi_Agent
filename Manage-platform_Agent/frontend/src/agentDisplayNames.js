/**
 * 对外展示名（紫微斗数星曜）。仅影响控制台 / 文档展示，不改 docker 服务名与 API。
 * 技术名（DB_Agent 等）仍作内部键与运维标识。
 */

const BY_KEY = {
  platform: { cn: "紫微", en: "Ziwei", role: "控制面" },
  clawhive: { cn: "紫微", en: "Ziwei", role: "控制面" },
  "manage-platform": { cn: "紫微", en: "Ziwei", role: "控制面" },
  manager: { cn: "天机", en: "Tianji", role: "总管" },
  db: { cn: "禄存", en: "Lucun", role: "数据库" },
  rag: { cn: "文曲", en: "Wenqu", role: "知识" },
  code: { cn: "武曲", en: "Wuqu", role: "代码" },
  crawler: { cn: "巨门", en: "Jumen", role: "爬虫" },
  extractor: { cn: "巨门", en: "Jumen", role: "爬虫" },
  admin: { cn: "天梁", en: "Tianliang", role: "办公" },
  multimodal: { cn: "廉贞", en: "Lianzhen", role: "多模态" },
  music: { cn: "贪狼", en: "Tanlang", role: "音乐" },
  video: { cn: "破军", en: "Pojun", role: "视频" },
  gui: { cn: "七杀", en: "Qisha", role: "GUI" },
  lobster: { cn: "七杀", en: "Qisha", role: "GUI" },
  ai: { cn: "太阴", en: "Taiyin", role: "数字人" },
  tavern: { cn: "天府", en: "Tianfu", role: "酒馆" },
};

/** 托管登记名 / 目录名 → 展示键 */
const ALIAS_TO_KEY = {
  Manage_platform_Agent: "platform",
  "Manage-platform_Agent": "platform",
  ClawHive: "platform",
  Manager_Agent: "manager",
  DB_Agent: "db",
  RAG_Agent: "rag",
  code_assistent_Agent: "code",
  Extractor_Agent: "extractor",
  AI_admin_Agent: "admin",
  Multimodal_Agent: "multimodal",
  Music_Agent: "music",
  Video_Agent: "video",
  Lobster_Agent: "lobster",
  AI_Agent: "ai",
  Tavern_Agent: "tavern",
};

function normalize(raw) {
  return String(raw || "").trim();
}

function resolveKey(raw) {
  const name = normalize(raw);
  if (!name) return "";
  if (BY_KEY[name]) return name;
  if (ALIAS_TO_KEY[name]) return ALIAS_TO_KEY[name];
  const lower = name.toLowerCase();
  if (BY_KEY[lower]) return lower;
  const stripped = name.replace(/_Agent$/i, "").replace(/-Agent$/i, "");
  const strippedLower = stripped.toLowerCase();
  if (BY_KEY[strippedLower]) return strippedLower;
  if (ALIAS_TO_KEY[stripped]) return ALIAS_TO_KEY[stripped];
  // code_assistent / db_agent 等
  const compact = strippedLower.replace(/_/g, "");
  if (compact.includes("code")) return "code";
  if (compact.includes("manage") || compact.includes("clawhive") || compact.includes("platform")) {
    return "platform";
  }
  return strippedLower;
}

/** @returns {{ cn: string, en: string, role: string } | null} */
export function getAgentDisplay(nameOrKey) {
  const key = resolveKey(nameOrKey);
  return BY_KEY[key] || null;
}

/** 主标题：禄存；无映射则回退技术名 */
export function agentTitle(nameOrKey) {
  const d = getAgentDisplay(nameOrKey);
  if (!d) return normalize(nameOrKey) || "—";
  return d.cn;
}

/** 副标题：禄存 · 数据库 · DB_Agent */
export function agentSubtitle(nameOrKey) {
  const tech = normalize(nameOrKey);
  const d = getAgentDisplay(nameOrKey);
  if (!d) return tech;
  return `${d.cn} · ${d.role}${tech ? ` · ${tech}` : ""}`;
}

/** 列表行：禄存（数据库） */
export function agentListLabel(nameOrKey) {
  const d = getAgentDisplay(nameOrKey);
  if (!d) return normalize(nameOrKey) || "—";
  return `${d.cn}（${d.role}）`;
}

export const PLATFORM_DISPLAY = BY_KEY.platform;

export default BY_KEY;
