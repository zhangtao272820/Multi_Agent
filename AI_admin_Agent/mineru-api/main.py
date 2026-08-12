"""
MinerU 兼容重解析 API（RAG / Admin 共用）。

引擎（MINERU_ENGINE）：
  - auto（默认）：full → enhanced → lite
  - full：真 MinerU / magic_pdf（需额外安装）
  - enhanced：PyMuPDF 版面文本 + pdfplumber 表 + 空页 RapidOCR
  - lite：pypdf（兼容旧行为）

契约：
  - POST /parse JSON：{ file_path?, url?, filename? }（Admin 兼容）
  - POST /parse multipart：file + filename（RAG 上传缓冲）
"""
from __future__ import annotations

import io
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel

app = FastAPI(title="clawhive-mineru-api", version="2.0.0")

_UA = "Mozilla/5.0 (compatible; ClawHive-MinerU-API/2.0)"
_MAX_TEXT = int(os.getenv("MINERU_MAX_TEXT_CHARS") or "500000")
_ENGINE = (os.getenv("MINERU_ENGINE") or "auto").strip().lower()


class ParseRequest(BaseModel):
    file_path: str = ""
    url: str = ""
    filename: str = ""


def _engine_mode() -> str:
    return _ENGINE if _ENGINE in {"auto", "full", "enhanced", "lite"} else "auto"


def _strip_html(html: str) -> str:
    text = re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", " ", html)
    text = re.sub(r"(?is)<[^>]+>", " ", text)
    return re.sub(r"\s{2,}", " ", text).strip()


def _clip(text: str) -> str:
    t = str(text or "").strip()
    if len(t) <= _MAX_TEXT:
        return t
    return t[:_MAX_TEXT]


def _blocks_from_markdown(md: str) -> list[dict[str, Any]]:
    blocks: list[dict[str, Any]] = []
    buf: list[str] = []
    kind = "text"

    def flush() -> None:
        nonlocal buf, kind
        body = "\n".join(buf).strip()
        if body:
            blocks.append({"type": kind, "text": body})
        buf = []
        kind = "text"

    for line in str(md or "").splitlines():
        if line.startswith("|") and "|" in line[1:]:
            if kind != "table" and buf:
                flush()
            kind = "table"
            buf.append(line)
        elif line.startswith("#"):
            if buf:
                flush()
            kind = "heading"
            buf.append(line)
            flush()
        else:
            if kind == "table" and buf and not line.startswith("|"):
                flush()
            if line.strip() == "" and buf and kind == "text":
                flush()
            else:
                if line.strip():
                    buf.append(line)
    flush()
    return blocks


# ── lite ──────────────────────────────────────────────────────────────────────

def _read_pdf_lite(data: bytes) -> str:
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(data))
    parts: list[str] = []
    for page in reader.pages[:80]:
        parts.append(page.extract_text() or "")
    return "\n\n".join(p for p in parts if p.strip())


def _read_bytes_lite(data: bytes, filename: str) -> str:
    lower = filename.lower()
    if lower.endswith(".pdf"):
        return _read_pdf_lite(data)
    if lower.endswith((".html", ".htm")):
        return _strip_html(data.decode("utf-8", errors="ignore"))
    return data.decode("utf-8", errors="ignore")


# ── enhanced ──────────────────────────────────────────────────────────────────

def _ocr_pixmap_png(png_bytes: bytes) -> str:
    try:
        from rapidocr_onnxruntime import RapidOCR
    except ImportError:
        return ""
    try:
        engine = RapidOCR()
        result, _ = engine(png_bytes)
        if not result:
            return ""
        return "\n".join(str(row[1]) for row in result if row and len(row) > 1)
    except Exception:
        return ""


def _parse_pdf_enhanced(data: bytes) -> str:
    import fitz  # PyMuPDF

    doc = fitz.open(stream=data, filetype="pdf")
    parts: list[str] = []
    try:
        for i, page in enumerate(doc):
            if i >= 80:
                break
            text = (page.get_text("text") or "").strip()
            if len(text) >= 40:
                parts.append(f"## Page {i + 1}\n\n{text}")
                continue
            # 空/弱文本页：尝试 OCR
            try:
                pix = page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False)
                ocr = _ocr_pixmap_png(pix.tobytes("png"))
                if ocr.strip():
                    parts.append(f"## Page {i + 1}\n\n{ocr.strip()}")
                elif text:
                    parts.append(f"## Page {i + 1}\n\n{text}")
            except Exception:
                if text:
                    parts.append(f"## Page {i + 1}\n\n{text}")
    finally:
        doc.close()

    # 表格补充（pdfplumber）
    try:
        import pdfplumber

        with pdfplumber.open(io.BytesIO(data)) as pdf:
            for i, page in enumerate(pdf.pages[:40]):
                tables = page.extract_tables() or []
                for ti, table in enumerate(tables):
                    rows = []
                    for row in table:
                        cells = [str(c or "").replace("\n", " ").strip() for c in row]
                        if any(cells):
                            rows.append("| " + " | ".join(cells) + " |")
                    if rows:
                        header_sep = "| " + " | ".join(["---"] * max(1, rows[0].count("|") - 1)) + " |"
                        md = "\n".join([rows[0], header_sep, *rows[1:]])
                        parts.append(f"## Page {i + 1} Table {ti + 1}\n\n{md}")
    except Exception:
        pass

    return "\n\n".join(parts)


def _parse_office_enhanced(data: bytes, filename: str) -> str:
    """DOCX/PPTX：优先 zip 内 XML 文本；失败再 lite 解码。"""
    lower = filename.lower()
    try:
        import zipfile
        from xml.etree import ElementTree as ET

        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            texts: list[str] = []
            if lower.endswith(".docx"):
                names = [n for n in zf.namelist() if n.startswith("word/") and n.endswith(".xml")]
            elif lower.endswith(".pptx"):
                names = [n for n in zf.namelist() if n.startswith("ppt/slides/slide") and n.endswith(".xml")]
            else:
                return ""
            for name in sorted(names)[:80]:
                raw = zf.read(name)
                try:
                    root = ET.fromstring(raw)
                except ET.ParseError:
                    continue
                chunks = [el.text for el in root.iter() if el.text and el.text.strip()]
                body = "\n".join(chunks).strip()
                if body:
                    texts.append(body)
            return "\n\n".join(texts)
    except Exception:
        return ""


def _read_bytes_enhanced(data: bytes, filename: str) -> str:
    lower = filename.lower()
    if lower.endswith(".pdf"):
        return _parse_pdf_enhanced(data)
    if lower.endswith((".docx", ".pptx")):
        office = _parse_office_enhanced(data, filename)
        if office.strip():
            return office
    if lower.endswith((".png", ".jpg", ".jpeg", ".bmp", ".tiff", ".webp")):
        return _ocr_pixmap_png(data)
    return _read_bytes_lite(data, filename)


# ── full MinerU ───────────────────────────────────────────────────────────────

def _parse_with_mineru_cli(data: bytes, filename: str) -> str:
    """调用系统 mineru CLI（pip install 'mineru[core]' 后可用）。"""
    if not shutil.which("mineru"):
        raise RuntimeError("mineru CLI 未安装")
    suffix = Path(filename).suffix or ".pdf"
    with tempfile.TemporaryDirectory(prefix="mineru_") as tmp:
        tmp_path = Path(tmp)
        inp = tmp_path / f"input{suffix}"
        out_dir = tmp_path / "out"
        out_dir.mkdir(parents=True, exist_ok=True)
        inp.write_bytes(data)
        cmd = ["mineru", "-p", str(inp), "-o", str(out_dir)]
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
        if proc.returncode != 0:
            raise RuntimeError(proc.stderr.strip() or proc.stdout.strip() or "mineru failed")
        md_files = sorted(out_dir.rglob("*.md"))
        if not md_files:
            raise RuntimeError("mineru 未产出 markdown")
        return "\n\n".join(p.read_text(encoding="utf-8", errors="ignore") for p in md_files)


def _parse_with_magic_pdf(data: bytes, filename: str) -> str:
    """兼容旧 magic_pdf 管线。"""
    from magic_pdf.data.data_reader_writer import FileBasedDataWriter
    from magic_pdf.data.dataset import PymuDocDataset
    from magic_pdf.model.doc_analyze_by_custom_model import doc_analyze
    from magic_pdf.config.enums import SupportedPdfParseMethod

    if not filename.lower().endswith(".pdf"):
        raise RuntimeError("magic_pdf 仅支持 PDF")

    with tempfile.TemporaryDirectory(prefix="magic_pdf_") as tmp:
        tmp_path = Path(tmp)
        image_writer = FileBasedDataWriter(str(tmp_path / "images"))
        md_writer = FileBasedDataWriter(str(tmp_path))
        ds = PymuDocDataset(data)
        if ds.classify() == SupportedPdfParseMethod.OCR:
            infer = ds.apply(doc_analyze, ocr=True)
            pipe = infer.pipe_ocr_mode(image_writer)
        else:
            infer = ds.apply(doc_analyze, ocr=False)
            pipe = infer.pipe_txt_mode(image_writer)
        pipe.dump_md(md_writer, "result.md", "images")
        md_path = tmp_path / "result.md"
        if not md_path.is_file():
            raise RuntimeError("magic_pdf 未产出 markdown")
        return md_path.read_text(encoding="utf-8", errors="ignore")


def _read_bytes_full(data: bytes, filename: str) -> str:
    errors: list[str] = []
    for fn in (_parse_with_mineru_cli, _parse_with_magic_pdf):
        try:
            text = fn(data, filename)
            if str(text or "").strip():
                return text
        except Exception as exc:
            errors.append(f"{fn.__name__}: {exc}")
    raise RuntimeError("; ".join(errors) or "full engine unavailable")


# ── dispatch ─────────────────────────────────────────────────────────────────

def _parse_bytes(data: bytes, filename: str) -> tuple[str, str]:
    mode = _engine_mode()
    order: list[str]
    if mode == "auto":
        order = ["full", "enhanced", "lite"]
    else:
        order = [mode]

    last_err: Exception | None = None
    for eng in order:
        try:
            if eng == "full":
                text = _read_bytes_full(data, filename)
            elif eng == "enhanced":
                text = _read_bytes_enhanced(data, filename)
            else:
                text = _read_bytes_lite(data, filename)
            text = _clip(text)
            if not text:
                raise RuntimeError(f"{eng} produced empty text")
            provider = {
                "full": "mineru_full",
                "enhanced": "mineru_enhanced",
                "lite": "mineru_api_lite",
            }[eng]
            return text, provider
        except Exception as exc:
            last_err = exc
            continue
    raise RuntimeError(str(last_err) if last_err else "parse failed")


def _fetch_url(url: str) -> tuple[bytes, str]:
    with httpx.Client(timeout=60.0, follow_redirects=True, headers={"User-Agent": _UA}) as client:
        resp = client.get(url)
        resp.raise_for_status()
        ctype = str(resp.headers.get("content-type") or "")
        name = url.rsplit("/", 1)[-1].split("?", 1)[0] or "download.bin"
        if "pdf" in ctype and not name.lower().endswith(".pdf"):
            name = f"{name}.pdf"
        return resp.content, name


def _load_local(fpath: str) -> tuple[bytes, str]:
    workspace = str(os.getenv("MINERU_WORKSPACE_DIR") or "/data/workspace").strip()
    safe = os.path.basename(fpath)
    full = fpath if os.path.isabs(fpath) else os.path.join(workspace, safe)
    if not os.path.isfile(full):
        raise FileNotFoundError(safe)
    return Path(full).read_bytes(), safe


def _ok_payload(source: str, text: str, provider: str) -> dict[str, Any]:
    md = _clip(text)
    return {
        "ok": True,
        "source": source,
        "text": md,
        "markdown": md,
        "blocks": _blocks_from_markdown(md)[:200],
        "provider": provider,
        "engine": _engine_mode(),
        "chars": len(md),
    }


@app.get("/health")
async def health():
    return {
        "ok": True,
        "service": "mineru_api",
        "mode": _engine_mode(),
        "version": "2.0.0",
        "has_mineru_cli": bool(shutil.which("mineru")),
    }


@app.post("/parse")
async def parse_document(request: Request):
    """
    同时支持：
    - application/json：{ file_path?, url?, filename? }（Admin 兼容）
    - multipart/form-data：file + 可选 filename / file_path / url（RAG 上传）
    """
    try:
        data: bytes | None = None
        source = ""
        ctype = (request.headers.get("content-type") or "").lower()

        if "multipart/form-data" in ctype:
            form = await request.form()
            upload = form.get("file")
            fname_hint = str(form.get("filename") or "").strip()
            u = str(form.get("url") or "").strip()
            fp = str(form.get("file_path") or "").strip()
            if upload is not None and hasattr(upload, "read"):
                data = await upload.read()  # type: ignore[misc]
                source = fname_hint or str(getattr(upload, "filename", "") or "upload.bin")
            elif u:
                data, source = _fetch_url(u)
                if fname_hint:
                    source = fname_hint
            elif fp:
                data, source = _load_local(fp)
            else:
                raise HTTPException(status_code=400, detail="需要 file、file_path 或 url")
        else:
            raw = await request.body()
            if not raw:
                raise HTTPException(status_code=400, detail="需要 file_path 或 url")
            try:
                req = ParseRequest.model_validate_json(raw)
            except Exception as exc:
                raise HTTPException(status_code=400, detail=f"无效 JSON: {exc}") from exc
            u = str(req.url or "").strip()
            fp = str(req.file_path or "").strip()
            fname_hint = str(req.filename or "").strip()
            if u:
                data, source = _fetch_url(u)
                if fname_hint:
                    source = fname_hint
            elif fp:
                data, source = _load_local(fp)
            else:
                raise HTTPException(status_code=400, detail="需要 file_path 或 url")

        if not data:
            raise HTTPException(status_code=400, detail="空文件")

        text, provider = _parse_bytes(data, source)
        return _ok_payload(source, text, provider)
    except HTTPException:
        raise
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"文件不存在: {exc}") from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
