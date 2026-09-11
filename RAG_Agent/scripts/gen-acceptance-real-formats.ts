/**
 * 将验收语料改为真实用户常用格式（DOCX / PDF / XLSX），不依赖 MD 作为上传主路径。
 * 用法：npx tsx scripts/gen-acceptance-real-formats.ts
 * PDF 若本机无 PyMuPDF，则写出 .pdf.txt 旁路并由 docker mineru 补生成（见脚本尾部说明）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";
import * as XLSX from "xlsx";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const testdata = path.join(root, "data", "testdata");
const fixtures = path.join(root, "data", "fixtures");
const binaryDir = path.join(root, "scripts", "fixtures", "binary");

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function buildDocx(body: string): Buffer {
  const zip = new AdmZip();
  const paras = body
    .split(/\r?\n/)
    .map((line) => {
      const t = escapeXml(line.length ? line : " ");
      return `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
    })
    .join("");
  const docXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${paras}<w:sectPr/></w:body>
</w:document>`;
  zip.addFile("word/document.xml", Buffer.from(docXml, "utf8"));
  zip.addFile(
    "[Content_Types].xml",
    Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`),
  );
  zip.addFile(
    "_rels/.rels",
    Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`),
  );
  zip.addFile(
    "word/_rels/document.xml.rels",
    Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`),
  );
  return zip.toBuffer();
}

/** 轻量去 markdown 标记，保留条款正文供 Word/PDF */
function mdToPlain(md: string): string {
  return String(md || "")
    .replace(/\r\n/g, "\n")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\|.*\|$/gm, (row) =>
      row
        .split("|")
        .map((c) => c.trim())
        .filter(Boolean)
        .join(" | "),
    )
    .replace(/^\s*\|?\s*-+\s*\|.*$/gm, "")
    .replace(/^- /gm, "• ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function writePdfViaFitzPy(plainText: string, outPdf: string): string {
  const py = path.join(binaryDir, "_gen_acceptance_pdf.py");
  const txt = path.join(binaryDir, "_acceptance_pdf_src.txt");
  fs.mkdirSync(binaryDir, { recursive: true });
  fs.writeFileSync(txt, plainText, "utf8");
  fs.writeFileSync(
    py,
    `import sys
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
`,
    "utf8",
  );
  return `python ${JSON.stringify(py)} ${JSON.stringify(txt)} ${JSON.stringify(outPdf)}`;
}

function buildHrXlsx(): Buffer {
  const rows: string[][] = [
    ["章节", "条款", "标题", "正文"],
    ["组织与职责", "第1条", "人力资源部", "人力资源部是招聘、入职、劳动合同与人事档案的归口管理部门。办公地点：总部 A 座 3 楼。"],
    ["组织与职责", "第2条", "行政办公室", "行政办公室负责办公用品、门禁卡制卡与员工工位分配，不负责劳动合同签署。"],
    ["组织与职责", "第3条", "岗位：HRBP", "HRBP 岗位隶属于人力资源部，负责跟进入职流程各节点材料齐套情况，并向用人部门同步进度。"],
    ["组织与职责", "第4条", "岗位：招聘专员", "招聘专员岗位隶属于人力资源部，负责 Offer 发放前的背调发起；不负责门禁卡办理。"],
    ["组织与职责", "第5条", "岗位：行政专员", "行政专员岗位隶属于行政办公室，负责入职当日门禁卡与工位钥匙发放。"],
    ["入职流程", "第6条", "新员工入职流程", "新员工入职流程由人力资源部归口管理。完整办理须在入职日当日 17:00 前完成。"],
    ["入职流程", "第7条", "入职流程要求角色", "新员工入职流程必须由 HRBP 主导跟进；招聘专员仅在入职日前完成背调结果回传；行政专员仅在入职当日办理门禁与工位。"],
    ["入职流程", "第8条", "步骤：材料审核", "新员工须提交身份证原件、最高学历证明原件、离职证明复印件。材料审核由 HRBP 在入职日前 1 个工作日完成初审。"],
    ["入职流程", "第9条", "步骤：劳动合同签署", "材料审核通过后，由人力资源部指定经办人与员工签署劳动合同；行政办公室不得代签。"],
    ["入职流程", "第10条", "步骤：门禁与工位", "劳动合同签署完成后，行政专员凭人资开具的《入职完成单》发放门禁卡与工位钥匙。无《入职完成单》不得制卡。"],
    ["入职流程", "第11条", "条款互引", "第10条门禁发放以第9条劳动合同签署完成为前置条件；第9条又以第8条材料审核通过为前提。"],
    ["请假与审批", "第12条", "事假审批流程", "事假审批流程由行政办公室归口管理，用于 1 个工作日及以上的事假申请。"],
    ["请假与审批", "第13条", "事假流程要求角色", "事假审批流程要求直线经理初审，行政专员备案；连续请假超过 3 个工作日的，须追加人力资源部 HRBP 会签。"],
    ["请假与审批", "第14条", "步骤：提交申请", "员工在 OA「假勤」模块提交事假申请，写明事由与起止日期。"],
    ["请假与审批", "第15条", "步骤：直线经理审批", "直线经理须在 1 个工作日内完成同意或驳回；驳回须填写原因。"],
    ["请假与审批", "第16条", "步骤：行政备案", "审批通过后，行政专员在假勤台账登记；超过 3 日的须同步抄送 HRBP。"],
    ["请假与审批", "第17条", "与入职流程的边界", "事假审批流程与新员工入职流程相互独立：试用期员工亦可按本章申请事假，但不免除入职材料补交义务（参见第8条）。"],
    ["速查", "摘要", "流程归属", "新员工入职流程归属人力资源部，关键角色 HRBP、招聘专员、行政专员；事假审批流程归属行政办公室，关键角色直线经理、行政专员，超3日加 HRBP。"],
  ];
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, "人事制度");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

function main() {
  fs.mkdirSync(testdata, { recursive: true });
  fs.mkdirSync(fixtures, { recursive: true });
  fs.mkdirSync(binaryDir, { recursive: true });

  const v32Path = path.join(testdata, "养老机构服务规范-验收用-v3.2.md");
  if (!fs.existsSync(v32Path)) {
    throw new Error(`missing source md: ${v32Path}`);
  }
  const plain = mdToPlain(fs.readFileSync(v32Path, "utf8"));

  // 1) DOCX — 用户常用「养老机构服务规范.docx」
  const docxName = "养老机构服务规范.docx";
  const docxBuf = buildDocx(plain);
  const docxOut = path.join(testdata, docxName);
  fs.writeFileSync(docxOut, docxBuf);
  fs.writeFileSync(path.join(binaryDir, docxName), docxBuf);
  console.log(`DOCX ${docxOut} (${docxBuf.length} bytes)`);

  // 2) PDF 源文本 + 生成指令（由外层 docker/python 执行）
  const pdfName = "养老机构服务规范-验收用-v3.2.pdf";
  const pdfOut = path.join(testdata, pdfName);
  const pdfCmd = writePdfViaFitzPy(plain, pdfOut);
  fs.writeFileSync(path.join(binaryDir, "_gen_pdf_cmd.txt"), pdfCmd, "utf8");
  console.log(`PDF_CMD ${pdfCmd}`);

  // 3) XLSX — GraphRAG 人事制度
  const xlsxName = "graphrag-smoke-入职与请假制度.xlsx";
  const xlsxBuf = buildHrXlsx();
  fs.writeFileSync(path.join(fixtures, xlsxName), xlsxBuf);
  fs.writeFileSync(path.join(testdata, xlsxName), xlsxBuf);
  console.log(`XLSX ${path.join(fixtures, xlsxName)} (${xlsxBuf.length} bytes)`);

  // 保留 MD 语料：acceptance-v32 / GraphRAG 图门控契约依赖；二进制仍可并行生成
  console.log("gen-acceptance-real-formats: docx+xlsx ready; keep md for smoke; run PDF via mineru fitz next");
}

main();
