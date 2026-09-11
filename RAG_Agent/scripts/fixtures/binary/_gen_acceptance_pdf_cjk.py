from pathlib import Path
import pymupdf

src = Path("/tmp/_acceptance_pdf_src.txt").read_text(encoding="utf-8")
out = Path("/tmp/v32.pdf")
doc = pymupdf.open()
font = pymupdf.Font("cjk")
lines = src.splitlines()
idx = 0
while idx < len(lines):
    page = doc.new_page(width=595, height=842)
    tw = pymupdf.TextWriter(page.rect)
    y = 50.0
    while idx < len(lines) and y <= 790:
        line = lines[idx]
        # 过长行折行
        while line:
            piece = line[:88]
            line = line[88:]
            tw.append((48, y), piece, font=font, fontsize=10)
            y += 14
            if y > 790:
                if line:
                    lines[idx] = line
                else:
                    idx += 1
                break
        else:
            idx += 1
    tw.write_text(page)

doc.save(out)
text = "\n".join(p.get_text() for p in doc)
print(f"pages={doc.page_count} size={out.stat().st_size} chars={len(text)}")
print(text[:240])
doc.close()
