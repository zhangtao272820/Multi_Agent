from __future__ import annotations

from dataclasses import dataclass, replace


@dataclass(frozen=True)
class Scene:
    id: str
    title: str
    allow_sys_schema: bool = False
    force_checkpoint: bool = True
    force_audit_sql: bool = False
    strict_secrets: bool = False
    allow_chart: bool = False
    allow_group_by: bool = True
    stub: bool = False
    stub_message: str = ""
    prompt_extra: str = ""
    depth_later: str = ""
    # 智能档：交付物由 Understand 判定，不绑死图表策略
    auto_deliverables: bool = False


_STUB_EMBED = (
    "本场景能力建设中：嵌入 SaaS 将按商户注入行级 WHERE。"
    "路由、只读权限与审计留痕已接通，暂不执行业务 SQL。"
)
_STUB_ETL = (
    "本场景能力建设中：ETL / 数据质量将提供空值、重复检查模板。"
    "路由、只读权限与审计留痕已接通，暂不执行质检 SQL。"
)

SCENES: dict[str, Scene] = {
    "auto": Scene(
        id="auto",
        title="智能问数",
        allow_chart=True,
        auto_deliverables=True,
        prompt_extra=(
            "统一问数入口：名单/计数/聚合/趋势均可。"
            "用户问「分别是什么」时必须选出名称列，不要只 COUNT。"
            "适合可视化时给出分类列与数值列；需要解读时再归纳，勿编造数字。"
        ),
        depth_later="Understand 交付物 need_chart / need_interpret / sys_meta",
    ),
    "assistant": Scene(
        id="assistant",
        title="后台助手",
        prompt_extra="偏业务名单与计数。用户问「分别是什么」时必须选出名称列，不要只 COUNT。",
        depth_later="写入类 HITL",
    ),
    "analyst": Scene(
        id="analyst",
        title="分析师自助",
        allow_chart=True,
        prompt_extra="允许聚合、GROUP BY、分布统计。结果适合做图时给出分类列与数值列。",
        depth_later="自动看板、下钻对话",
    ),
    "exec": Scene(
        id="exec",
        title="决策分析",
        allow_chart=True,
        prompt_extra=(
            "允许 GROUP BY、同比/环比（用日期列自比上一周期）。"
            "不要编造不存在的漏斗表。"
        ),
        depth_later="漏斗模板包",
    ),
    "dba": Scene(
        id="dba",
        title="DBA 助手",
        allow_sys_schema=True,
        force_checkpoint=True,
        prompt_extra=(
            "只读元数据：information_schema / performance_schema。"
            "查表清单、列、索引、状态。不要编造慢日志；无权限时说明原因。"
            "禁止写操作与 SLEEP。"
        ),
        depth_later="慢日志、锁等待接实例监控",
    ),
    "audit": Scene(
        id="audit",
        title="合规审计",
        force_checkpoint=True,
        force_audit_sql=True,
        strict_secrets=True,
        prompt_extra="必须留下完整可复制 SQL。禁止密码、证件号等敏感列。不要改数。",
        depth_later="监管口径模板",
    ),
    "embed": Scene(
        id="embed",
        title="嵌入 SaaS",
        stub=True,
        stub_message=_STUB_EMBED,
        force_checkpoint=True,
        depth_later="按商户注入 WHERE",
    ),
    "etl": Scene(
        id="etl",
        title="ETL / 质检",
        stub=True,
        stub_message=_STUB_ETL,
        force_checkpoint=True,
        depth_later="空值/重复检查模板",
    ),
}

DEFAULT_SCENE = "auto"


def get_scene(scene_id: str | None) -> Scene:
    key = str(scene_id or DEFAULT_SCENE).strip().lower()
    if key in {"", "default", "smart"}:
        key = "auto"
    if key in {"saas", "embedded"}:
        key = "embed"
    if key in {"dq", "quality"}:
        key = "etl"
    return SCENES.get(key) or SCENES[DEFAULT_SCENE]


def scene_with_sys_meta(scene: Scene, *, sys_meta: bool) -> Scene:
    """本 turn 临时允许 sys schema（不切换整页高级场景）。"""
    if not sys_meta or scene.allow_sys_schema:
        return scene
    return replace(scene, allow_sys_schema=True)


def scene_public() -> list[dict]:
    return [
        {
            "id": s.id,
            "title": s.title,
            "stub": s.stub,
            "force_checkpoint": s.force_checkpoint,
            "allow_chart": s.allow_chart,
            "allow_sys_schema": s.allow_sys_schema,
            "strict_secrets": s.strict_secrets,
            "auto_deliverables": s.auto_deliverables,
            "depth_later": s.depth_later,
        }
        for s in SCENES.values()
    ]
