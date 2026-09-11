import sys
from pathlib import Path
import fitz
src = Path(sys.argv[1]).read_text(encoding="utf-8")
out = Path(sys.argv[2])
doc = fitz.open()
# 分页写入，避免单页过长
chunk = 1800
i = 0
while i < len(src):
    page = doc.new_page(width=595, height=842)
    rect = fitz.Rect(48, 48, 547, 794)
    page.insert_textbox(rect, src[i:i+chunk], fontname="china-s", fontsize=10, align=0)
    i += chunk
doc.save(out)
doc.close()
print(f"wrote {out} bytes={out.stat().st_size}")
