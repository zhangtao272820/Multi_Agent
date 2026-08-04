#!/usr/bin/env python3
"""Enumerate / generate outfit sprites from sprite_gen_manifest.

根因：纯文生图无法锁定现有立绘脸/发型/画风，且 appearance 里常带默认服装，
导致「换装」结果变成另一个路人。正确做法：以正式目录现有立绘为底图，
调用 Cursor GenerateImage（reference_image_paths）只改服装/生活状态。
详见 doc/立绘换装生成规范.md

Default dry-run → data/sprites/_staging/_tasks/
--generate 已废弃：禁止用于精修（易胸腿漂移）；请用 GenerateImage。
--promote 仅 staging→正式复制，永不覆盖已有情绪基图。

Usage:
  python scripts/build_sprite_gen_manifest.py
  python scripts/gen-sprites-from-manifest.py
  python scripts/gen-sprites-from-manifest.py --character xiaoyou --outfits casual,work,home
  python scripts/gen-sprites-from-manifest.py --promote --character xiaoyou
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import re
import shutil
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
MANIFEST_PATH = ROOT / "data" / "sprite_gen_manifest.json"
DRAFT_PATH = ROOT / "data" / "cast_pick_draft.json"
SOCIAL_PATH = ROOT / "data" / "social_graph.json"
SPRITES_ROOT = ROOT / "data" / "sprites"
CAST_DIRS = ("romance", "neutral", "npc")
CORE_PRIORITY = ["neutral", "happy", "shy"]

# scripts/ 下的共享身材库
import sys

_SCRIPTS = Path(__file__).resolve().parent
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS))
from body_catalog_lib import (  # noqa: E402
    ANATOMY_LOCK,
    body_lock_prompt,
    get_body_row,
    load_body_catalog,
)

# 强差异服装；姿态/表情由「同情绪底图」继承。必须与原图衣服明显不同（避免微调假换装）。
_OUTFIT_QUALITY = (
    "材质褶皱与光影要精细，纯黑背景高质量动漫视觉小说全身立绘。"
    "禁止只改色号、加腰带或微调花纹；禁止写成实照片。"
    "原图整套上衣/裙装/外套/鞋子必须全部替换，一件不留；新衣服轮廓、主色、花纹须与原图明显不同。"
)
OUTFIT_EDIT: dict[str, str] = {
    "school": (
        "把全身服装换成清晰可辨的日式学生校服（水手领或西装领+领结/丝带、百褶裙、皮鞋短袜），"
        "禁止保留原图奶油色绣花长裙或任何原礼服轮廓。" + _OUTFIT_QUALITY
    ),
    "casual": (
        "把全身服装换成与原图完全不同的日常便服：例如彩色卫衣或牛仔外套+短裙/长裤+运动鞋，"
        "禁止保留原图奶油色绣花连衣裙、泡泡袖与层叠裙摆。" + _OUTFIT_QUALITY
    ),
    "work": (
        "将衣服修改为通勤职业装：白色衬衫、深色西装外套、高腰深色半身裙或西装裤、正式皮鞋；"
        "剪影须是干练通勤而非大摆礼服；禁止奶油色绣花长裙、泡泡袖与花边裙摆。" + _OUTFIT_QUALITY
    ),
    "home": (
        "把全身服装换成居家服：宽松睡衣或家居套装+室内拖鞋，放松感，"
        "禁止保留原图外出礼服与绣花长裙。" + _OUTFIT_QUALITY
    ),
    "festival_spring": (
        "把全身服装换成新春节日装：红色或喜庆色系唐装/汉元素外套，可有细金饰，"
        "节日感一眼可辨；禁止保留原图奶油色绣花裙。" + _OUTFIT_QUALITY
    ),
    "festival_midautumn": (
        "把全身服装换成中秋节日装：月白或藕荷色汉元素长裙/旗袍改良，温润雅致；"
        "禁止保留原图奶油色西洋绣花裙。" + _OUTFIT_QUALITY
    ),
    "date": (
        "把全身服装换成约会装：精致连衣裙或漂亮裙装+小配饰，比日常更讲究，"
        "主色与剪裁须与原图奶油绣花裙明显不同（例如酒红/深蓝/墨绿）。" + _OUTFIT_QUALITY
    ),
    "rain": (
        "把全身服装换成雨天装：风衣或雨衣外套，可手持折叠伞，潮湿出门感；"
        "禁止只在原裙外罩一层透明雨衣。" + _OUTFIT_QUALITY
    ),
}

STATE_EDIT: dict[str, str] = {
    "sleepy": "在保持同一人物与当前服装的前提下，改为犯困状态：微眯眼、哈欠感、略疲惫站姿。",
    "sick": "在保持同一人物与当前服装的前提下，改为生病状态：脸色差、可有口罩或额温感、虚弱。",
    "party": "在保持同一人物脸型发型的前提下，改为派对氛围装扮（稍华丽配饰），表情更开朗。",
    "overtime": "在保持同一人物与通勤感服装的前提下，改为加班疲惫：黑眼圈、松垮领带/袖口、无力站姿。",
}

# 仅在「没有对应情绪底图」时才强制改表情；有底图时严禁改表情
EMO_FORCE: dict[str, str] = {
    "neutral": "表情改为平静、嘴唇自然闭合、眼神平视。",
    "happy": "表情改为明显开心微笑、眼睛弯起、嘴角上扬，与平静脸必须可区分。",
    "shy": "表情改为害羞：脸颊大红、眼神躲闪或斜视、嘴角小、手足无措感，与开心脸必须可区分。",
    "sad": "表情改为难过：眉眼下垂、嘴角向下。",
    "angry": "表情改为生气/不悦：皱眉、眼神锐利或轻轻鼓嘴，可带薄红但不是害羞笑。",
    "love": "表情改为温柔含情：柔和眼神与浅笑。",
    "surprised": "表情改为惊讶：眼睛睁大、嘴微张。",
    "sarcastic": "表情改为得意/轻嘲：单侧嘴角上扬。",
}

STYLE_LOCK = (
    "画风必须保持高质量动漫视觉小说全身立绘：精细上色与发丝高光、纯黑背景、"
    "清晰线稿，不要写成实照片、不要换构图为半身特写。"
)

_CLOTHING_NOISE = re.compile(
    r"(风衣|衬衫|软裙|连衣裙|外套|水手服|校服|西装|旗袍|睡衣|卫衣|夹克|战衣|披风|"
    r"舞台装|职业装|开衫|铅笔裙|裙子|穿搭|唐装|汉元素)[^，。；]*[，。；]?",
)


def load_json(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def load_dotenv_key() -> str:
    env_path = ROOT / ".env"
    if env_path.is_file():
        for line in env_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            if k.strip() == "DASHSCOPE_API_KEY" and v.strip():
                os.environ.setdefault("DASHSCOPE_API_KEY", v.strip().strip('"').strip("'"))
    return (os.environ.get("DASHSCOPE_API_KEY") or "").strip()


def romance_ids_from_draft() -> set[str] | None:
    draft = load_json(DRAFT_PATH)
    picks = draft.get("picks") or {}
    if not picks:
        return None
    return {
        cid
        for cid, row in picks.items()
        if (row or {}).get("kind") in {"romance", "main_candidate"}
    }


def cast_kind_for(cid: str, row_cast: str = "") -> str:
    """romance|neutral|npc：manifest → social_graph → 磁盘探测 → romance。"""
    kind = (row_cast or "").strip().lower()
    if kind in CAST_DIRS:
        return kind
    social = load_json(SOCIAL_PATH)
    chars = social.get("characters") or {}
    sk = str((chars.get(cid) or {}).get("cast_kind") or "").strip().lower()
    if sk in CAST_DIRS:
        return sk
    for k in CAST_DIRS:
        if (SPRITES_ROOT / k / cid).is_dir():
            return k
    return "romance"


def resolve_live_dir(cid: str, row_cast: str = "") -> Path:
    """正式立绘目录：data/sprites/{cast_kind}/{id}/；兼容旧顶层 {id}/。"""
    kind = cast_kind_for(cid, row_cast)
    preferred = SPRITES_ROOT / kind / cid
    if preferred.is_dir():
        return preferred
    for k in CAST_DIRS:
        alt = SPRITES_ROOT / k / cid
        if alt.is_dir():
            return alt
    legacy = SPRITES_ROOT / cid
    if legacy.is_dir():
        return legacy
    return preferred


def face_only_lock(appearance: str) -> str:
    """去掉服装描述，只留脸/发/气质，避免和换装指令打架。"""
    text = (appearance or "").strip()
    text = _CLOTHING_NOISE.sub("", text)
    text = re.sub(r"[，,、\s]{2,}", "，", text).strip("，,。 ")
    return text or "保持原角色五官与发型"


def resolve_ref_image(cid: str, emotion: str, row_cast: str = "") -> tuple[Path | None, bool]:
    """返回 (底图路径, 是否命中目标情绪文件)。优先用同情绪正式立绘，保证情绪分开。"""
    live = resolve_live_dir(cid, row_cast)
    exact = live / f"{emotion}.png"
    if exact.is_file():
        return exact, True
    for name in ("neutral.png", "happy.png"):
        p = live / name
        if p.is_file():
            return p, False
    return None, False


def build_edit_prompt(
    *,
    outfit: str,
    emotion: str,
    face_lock: str,
    state: str = "",
    ref_emotion_matched: bool = True,
    clothing_forbid: str = "",
    body_lock: str = "",
    outfit_hint: str = "",
) -> str:
    if outfit_hint.strip():
        outfit_bit = outfit_hint.strip()
        if not outfit_bit.endswith("。"):
            outfit_bit += "。"
        outfit_bit += _OUTFIT_QUALITY
    else:
        outfit_bit = OUTFIT_EDIT.get(outfit, f"只改服装为{outfit}。保持同一人物不变。")
    state_bit = STATE_EDIT.get(state, "") if state else ""
    if ref_emotion_matched:
        emo_bit = (
            f"原图已是「{emotion}」情绪：必须原样保留表情、眉眼与嘴型；"
            "手脚须解剖正确（可随新服装自然重摆姿势，但禁止畸形或多余指趾）；"
            "只允许改衣服鞋子配饰；换装后情绪仍要一眼可辨，禁止改成另一张平静脸。"
        )
    else:
        emo_bit = EMO_FORCE.get(emotion, "") + "（底图情绪不足时才改表情，仍保持同一张脸。）"
    forbid = ""
    if clothing_forbid:
        forbid = f"必须去掉并替换的原服装特征：{clothing_forbid}。"
    body_bit = body_lock or (
        "身材锁定：必须与底图躯干、四肢比例一致，禁止拉长腿或改变胸围腰围。"
        "胸部体积轮廓必须与底图完全一致。"
        + ANATOMY_LOCK
    )
    return (
        f"将她全身衣服鞋子修改为全新造型（禁止只微调原衣服，禁止保留原裙轮廓与花纹）："
        f"{forbid}{outfit_bit}"
        f"{emo_bit}{state_bit}"
        f"身份锁定：{face_lock}。{body_bit}{STYLE_LOCK}"
        "不要换脸；发型发色与原图一致；手中花束可保留。"
    )


def anatomy_fix_prompt() -> str:
    return (
        "不要改动脸型、发型发色、服装主色与剪裁。"
        "胸部大小与轮廓必须保持不变，禁止丰胸或缩胸。"
        "只修复手脚解剖学错误：双手各五指清晰、无融合手指；双脚脚掌着地、脚趾正常；"
        "保持与底图一致的身材比例与头身比。"
        "纯黑背景高质量动漫视觉小说全身立绘。"
    )


def build_tasks(
    manifest: dict[str, Any],
    *,
    mains_only: bool,
    character_filter: set[str] | None,
    outfit_filter: set[str] | None,
    emotions: list[str],
    force: bool,
) -> list[dict[str, Any]]:
    characters: dict[str, Any] = manifest.get("characters") or {}
    outfits = [o["id"] for o in (manifest.get("outfits") or [])]
    if outfit_filter:
        outfits = [o for o in outfits if o in outfit_filter]

    draft_mains = romance_ids_from_draft()
    body_catalog = load_body_catalog()
    default_forbid = str(body_catalog.get("default_anatomy_forbid") or "")
    tasks: list[dict[str, Any]] = []

    for cid, row in characters.items():
        if character_filter and cid not in character_filter:
            continue
        cast_kind = str(row.get("cast_kind") or "romance")
        if draft_mains is not None:
            is_main = cid in draft_mains
        else:
            is_main = cast_kind in {"romance", "main_candidate"}
        # Explicit --character always wins; otherwise mains-only skips neutral/npc.
        # (--all-cast sets mains_only=False so full cast is enumerated.)
        if not character_filter and mains_only and not is_main:
            continue

        existing = set(row.get("existing_files") or [])
        face = face_only_lock(str(row.get("appearance_lock") or ""))
        clothing_forbid = str(row.get("clothing_forbid") or "").strip()
        outfit_hints = row.get("outfit_hints") if isinstance(row.get("outfit_hints"), dict) else {}
        body_row = get_body_row(body_catalog, cid)
        body_lock = body_lock_prompt(body_row, default_forbid=default_forbid)
        name = row.get("name") or cid
        for outfit in outfits:
            for emo in emotions:
                filename = f"{outfit}_{emo}.png"
                dest_live = resolve_live_dir(cid, cast_kind) / filename
                dest_stage = SPRITES_ROOT / "_staging" / cid / filename
                ref, emo_matched = resolve_ref_image(cid, emo, cast_kind)
                skip_reason = ""
                if filename in existing or dest_live.is_file():
                    skip_reason = "already_exists_live"
                elif dest_stage.is_file() and not force:
                    skip_reason = "already_exists_staging"
                elif not ref:
                    skip_reason = "missing_ref_sprite"
                outfit_hint = str((outfit_hints or {}).get(outfit) or "").strip()
                tasks.append(
                    {
                        "character_id": cid,
                        "name": name,
                        "outfit": outfit,
                        "emotion": emo,
                        "filename": filename,
                        "ref_path": str(ref.relative_to(ROOT)).replace("\\", "/") if ref else "",
                        "ref_emotion_matched": emo_matched,
                        "staging_path": str(dest_stage.relative_to(ROOT)).replace("\\", "/"),
                        "live_path": str(dest_live.relative_to(ROOT)).replace("\\", "/"),
                        "skip": bool(skip_reason),
                        "skip_reason": skip_reason,
                        "prompt": build_edit_prompt(
                            outfit=outfit,
                            emotion=emo,
                            face_lock=face,
                            ref_emotion_matched=emo_matched,
                            clothing_forbid=clothing_forbid,
                            body_lock=body_lock,
                            outfit_hint=outfit_hint,
                        ),
                    }
                )
    return tasks


def write_task_list(tasks: list[dict[str, Any]], out_dir: Path) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    path = out_dir / f"tasks_{stamp}.json"
    pending = [t for t in tasks if not t.get("skip")]
    payload = {
        "generated_at": stamp,
        "total": len(tasks),
        "pending": len(pending),
        "skipped": len(tasks) - len(pending),
        "note": "edit mode: keep face from ref sprite; review _staging then --promote.",
        "tasks": tasks,
    }
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


def _http_json(method: str, url: str, *, headers: dict[str, str], body: dict | None = None) -> dict[str, Any]:
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {e.code}: {detail}") from e


def _poll_task(task_id: str, *, api_key: str) -> str:
    task_url = f"https://dashscope.aliyuncs.com/api/v1/tasks/{task_id}"
    poll_headers = {"Authorization": f"Bearer {api_key}"}
    for _ in range(90):
        time.sleep(2)
        polled = _http_json("GET", task_url, headers=poll_headers)
        output = polled.get("output") or {}
        status = str(output.get("task_status") or "")
        if status == "SUCCEEDED":
            results = output.get("results") or []
            if results and results[0].get("url"):
                return str(results[0]["url"])
            raise RuntimeError(f"succeeded but no url: {polled}")
        if status in {"FAILED", "CANCELED", "UNKNOWN"}:
            raise RuntimeError(f"task {status}: {polled}")
    raise RuntimeError(f"timeout waiting for task {task_id}")


def _download(url: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(url, method="GET")
    with urllib.request.urlopen(req, timeout=120) as resp:
        dest.write_bytes(resp.read())


def file_to_data_url(path: Path) -> str:
    raw = path.read_bytes()
    # 过大则压缩风险高；API 限 10MB。正式立绘一般足够小。
    if len(raw) > 9_500_000:
        raise RuntimeError(f"ref image too large: {path} ({len(raw)} bytes)")
    b64 = base64.b64encode(raw).decode("ascii")
    return f"data:image/png;base64,{b64}"


def build_outfit_mask(ref_path: Path, mask_path: Path, *, head_keep_ratio: float = 0.24) -> Path:
    """白=可改衣服区，黑=保留（头脸发+背景）。

    根因：
    1) 无 mask 的 description_edit 对复杂礼服几乎只微调；
    2) 若 mask 紧贴原裙剪影，局部重绘会锁死「大摆裙」轮廓，换不出工装。
    做法：头以下用矩形编辑框（可改剪影），不跟原裙外轮廓描边。
    """
    from PIL import Image
    import numpy as np

    img = Image.open(ref_path).convert("RGBA")
    arr = np.asarray(img)
    rgb = arr[:, :, :3].astype(np.int16)
    alpha = arr[:, :, 3] if arr.shape[2] == 4 else np.full(rgb.shape[:2], 255, dtype=np.uint8)
    lum = rgb.max(axis=2)
    fg = (lum > 18) & (alpha > 8)
    ys, xs = np.where(fg)
    if len(ys) == 0:
        raise RuntimeError(f"cannot build mask, empty foreground: {ref_path}")
    y0, y1 = int(ys.min()), int(ys.max())
    x0, x1 = int(xs.min()), int(xs.max())
    h = max(1, y1 - y0 + 1)
    w = max(1, x1 - x0 + 1)
    head_y = y0 + int(h * head_keep_ratio)
    # 左右略收，减少把披散长发侧面大面积涂进编辑区
    pad_x = int(w * 0.06)
    left, right = x0 + pad_x, x1 - pad_x

    mask = np.zeros((arr.shape[0], arr.shape[1]), dtype=np.uint8)
    mask[head_y : y1 + 1, left : right + 1] = 255

    Image.fromarray(mask, mode="L").save(mask_path)
    return mask_path


def dashscope_edit_png(
    prompt: str,
    *,
    api_key: str,
    model: str,
    ref_path: Path,
    dest: Path,
    strength: float,
    mask_path: Path | None = None,
) -> None:
    """以现有立绘为底换装。有 mask 时用 description_edit_with_mask（官方换装路径）。"""
    create_url = "https://dashscope.aliyuncs.com/api/v1/services/aigc/image2image/image-synthesis"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "X-DashScope-Async": "enable",
    }
    if mask_path is not None:
        body: dict[str, Any] = {
            "model": model,
            "input": {
                "function": "description_edit_with_mask",
                "prompt": prompt[:800],
                "base_image_url": file_to_data_url(ref_path),
                "mask_image_url": file_to_data_url(mask_path),
            },
            "parameters": {"n": 1},
        }
    else:
        body = {
            "model": model,
            "input": {
                "function": "description_edit",
                "prompt": prompt[:800],
                "base_image_url": file_to_data_url(ref_path),
            },
            "parameters": {"n": 1, "strength": float(strength)},
        }
    created = _http_json("POST", create_url, headers=headers, body=body)
    task_id = ((created.get("output") or {}).get("task_id")) or ""
    if not task_id:
        raise RuntimeError(f"no task_id: {created}")
    image_url = _poll_task(task_id, api_key=api_key)
    _download(image_url, dest)


def restore_emotion_prompt(emotion: str) -> str:
    bit = EMO_FORCE.get(emotion, "恢复清晰可辨的表情。")
    return (
        f"不要改动当前服装、发色与画风。{bit}"
        "保持纯黑背景高质量动漫视觉小说全身立绘。"
    )


def dashscope_t2i_png(prompt: str, *, api_key: str, model: str, dest: Path) -> None:
    """仅作兼容；默认不要用（无法锁定角色）。"""
    create_url = "https://dashscope.aliyuncs.com/api/v1/services/aigc/text2image/image-synthesis"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "X-DashScope-Async": "enable",
    }
    body = {
        "model": model,
        "input": {"prompt": prompt},
        "parameters": {"size": "1024*1024", "n": 1},
    }
    created = _http_json("POST", create_url, headers=headers, body=body)
    task_id = ((created.get("output") or {}).get("task_id")) or ""
    if not task_id:
        raise RuntimeError(f"no task_id: {created}")
    image_url = _poll_task(task_id, api_key=api_key)
    _download(image_url, dest)


def run_generate(
    tasks: list[dict[str, Any]],
    *,
    limit: int,
    mode: str,
    edit_model: str,
    t2i_model: str,
    strength: float,
    emotion_pass: bool,
    emotion_strength: float,
    use_mask: bool,
    anatomy_pass: bool,
    anatomy_strength: float,
) -> list[str]:
    api_key = load_dotenv_key()
    if not api_key:
        raise SystemExit("DASHSCOPE_API_KEY missing (.env or env)")

    pending = [t for t in tasks if not t.get("skip")]
    if limit > 0:
        pending = pending[:limit]
    done: list[str] = []
    for i, t in enumerate(pending, 1):
        dest = ROOT / t["staging_path"]
        dest.parent.mkdir(parents=True, exist_ok=True)
        print(f"[{i}/{len(pending)}] {t['character_id']} {t['filename']} ({mode}) …")
        try:
            if mode == "edit":
                ref = ROOT / t["ref_path"]
                if not ref.is_file():
                    raise RuntimeError(f"missing ref {ref}")
                mask_path: Path | None = None
                if use_mask:
                    mask_path = dest.parent / f".mask_{dest.stem}.png"
                    build_outfit_mask(ref, mask_path)
                    print(f"  mask → {mask_path.name}")
                # Pass1：大力换装（同情绪底图起步；默认 mask 局部重绘）
                dashscope_edit_png(
                    t["prompt"],
                    api_key=api_key,
                    model=edit_model,
                    ref_path=ref,
                    dest=dest,
                    strength=strength,
                    mask_path=mask_path,
                )
                # Pass2：弱编辑把表情/姿势拉回目标情绪，尽量不动衣服
                if emotion_pass:
                    print(f"  emotion-pass ({t['emotion']}) …")
                    dashscope_edit_png(
                        restore_emotion_prompt(str(t["emotion"])),
                        api_key=api_key,
                        model=edit_model,
                        ref_path=dest,
                        dest=dest,
                        strength=emotion_strength,
                        mask_path=None,
                    )
                # Pass3：弱编辑只修手脚畸形
                if anatomy_pass:
                    print("  anatomy-pass …")
                    dashscope_edit_png(
                        anatomy_fix_prompt(),
                        api_key=api_key,
                        model=edit_model,
                        ref_path=dest,
                        dest=dest,
                        strength=anatomy_strength,
                        mask_path=None,
                    )
            else:
                dashscope_t2i_png(
                    t["prompt"],
                    api_key=api_key,
                    model=t2i_model,
                    dest=dest,
                )
            done.append(str(dest.relative_to(ROOT)).replace("\\", "/"))
            print(f"  ok → {dest}")
        except Exception as ex:
            print(f"  FAIL: {ex}")
    return done


def run_promote(tasks: list[dict[str, Any]]) -> int:
    n = 0
    for t in tasks:
        staging = ROOT / t["staging_path"]
        live = ROOT / t["live_path"]
        if not staging.is_file():
            continue
        if live.is_file():
            continue
        live.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(staging, live)
        n += 1
        print(f"promoted {staging.name} → {live}")
    return n


def main() -> None:
    ap = argparse.ArgumentParser(description="Enumerate / generate outfit sprites from manifest")
    ap.add_argument("--mains-only", action="store_true", default=True)
    ap.add_argument("--all-cast", action="store_true")
    ap.add_argument("--character", type=str, default="")
    ap.add_argument("--outfits", type=str, default="")
    ap.add_argument("--emotions", type=str, default="neutral,happy,shy")
    ap.add_argument("--generate", action="store_true")
    ap.add_argument("--promote", action="store_true", help="Copy staging→live only if live missing")
    ap.add_argument("--limit", type=int, default=0, help="Max images to generate (0=all pending)")
    ap.add_argument("--force", action="store_true", help="Regenerate even if staging file exists")
    ap.add_argument(
        "--mode",
        choices=("edit", "t2i"),
        default="edit",
        help="edit=底图换装(默认); t2i=纯文生(不推荐)",
    )
    ap.add_argument(
        "--strength",
        type=float,
        default=0.82,
        help="换装 pass 修改幅度；过低几乎不换衣，过高易换脸",
    )
    ap.add_argument(
        "--emotion-pass",
        action=argparse.BooleanOptionalAction,
        default=False,
        help="换装后再做一轮弱编辑拉回情绪（默认关：易把衣服改回去）",
    )
    ap.add_argument(
        "--emotion-strength",
        type=float,
        default=0.42,
        help="情绪恢复 pass 幅度（宜低，避免又把衣服改回去）",
    )
    ap.add_argument(
        "--mask",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="换装用 description_edit_with_mask（默认开；官方推荐换装路径）",
    )
    ap.add_argument(
        "--anatomy-pass",
        action=argparse.BooleanOptionalAction,
        default=False,
        help="换装后再做一轮弱编辑只修手脚畸形（宜低 strength）",
    )
    ap.add_argument(
        "--anatomy-strength",
        type=float,
        default=0.35,
        help="手脚修复 pass 幅度（宜低，避免改脸改衣）",
    )
    ap.add_argument(
        "--edit-model",
        type=str,
        default=os.environ.get("COMPANION_IMAGE_EDIT_MODEL") or "wanx2.1-imageedit",
    )
    ap.add_argument(
        "--model",
        type=str,
        default=os.environ.get("COMPANION_IMAGE_MODEL") or "wanx2.1-t2i-turbo",
        help="仅 --mode t2i 使用",
    )
    args = ap.parse_args()

    manifest = load_json(MANIFEST_PATH)
    if not manifest:
        raise SystemExit(f"missing manifest: {MANIFEST_PATH}")

    char_filter = {x.strip() for x in args.character.split(",") if x.strip()} or None
    outfit_filter = {x.strip() for x in args.outfits.split(",") if x.strip()} or None
    emotions = [x.strip() for x in args.emotions.split(",") if x.strip()] or CORE_PRIORITY
    mains_only = not args.all_cast

    tasks = build_tasks(
        manifest,
        mains_only=mains_only,
        character_filter=char_filter,
        outfit_filter=outfit_filter,
        emotions=emotions,
        force=args.force,
    )
    staging_tasks = ROOT / "data" / "sprites" / "_staging" / "_tasks"
    out = write_task_list(tasks, staging_tasks)
    pending = sum(1 for t in tasks if not t.get("skip"))
    print(f"wrote {out}")
    print(f"tasks={len(tasks)} pending={pending} skipped={len(tasks) - pending} mode={args.mode}")

    if args.promote:
        n = run_promote(tasks)
        print(f"promoted {n} files")
        return

    if args.generate:
        if args.mode == "t2i":
            print("WARNING: t2i 无法锁定现有立绘，结果多半是路人脸。请优先 --mode edit。")
        done = run_generate(
            tasks,
            limit=args.limit,
            mode=args.mode,
            edit_model=args.edit_model,
            t2i_model=args.model,
            strength=args.strength,
            emotion_pass=bool(args.emotion_pass),
            emotion_strength=args.emotion_strength,
            use_mask=bool(args.mask),
            anatomy_pass=bool(args.anatomy_pass),
            anatomy_strength=args.anatomy_strength,
        )
        print(f"generated {len(done)} into _staging (review before --promote)")
        for p in done:
            print(f"  pending review: {p}")
        return

    print("dry-run complete (no images). Use --generate after reviewing task JSON.")


if __name__ == "__main__":
    main()
