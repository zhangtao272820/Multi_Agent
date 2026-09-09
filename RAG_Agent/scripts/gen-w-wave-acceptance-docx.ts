/**
 * 生成 W 波验收用测试 DOCX（制度条款 + 编号明细）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BODY = `养老机构服务规范（测试稿 · W波验收）

第一条 总则
本规范适用于本机构日常护理与行政管理。所有岗位须按本规范执行，不得擅自简化流程。

第二条 人员配比
护理人员与入住老年人配比不得低于 1:10。高峰时段应增加巡视频次。

第三条 口腔护理
口腔护理每日不少于 2 次，分别在晨起与晚间进行；意识不清者须记录完成情况。

第四条 感染防控
1. 进入护理区须洗手或使用速干手消毒剂
2. 感染性废物须放入黄色垃圾袋并当日清运
3. 发现疑似传染病立即报告护士长

第五条 给药管理
给药须核对床号、姓名、药品、剂量、时间；不得代服他人药品。

第六条 跌倒防范
卫生间、走廊须保持干燥；高风险老年人夜间陪同如厕。

第七条 膳食服务
三餐供应须保证营养均衡；特殊饮食（糖尿病、低盐）按医嘱执行。

第八条 应急处置
老年人突发胸痛、呼吸困难时，立即呼叫急救并通知家属，同时记录生命体征。

第九条 隐私保护
未经本人或监护人同意，不得对外提供健康信息与影像资料。

第十条 服务内容
为失能老年人提供下列服务：
1. 翻身护理（至少每 2 小时一次）
2. 更换尿不湿
3. 协助进食与饮水
4. 床单位整理与清洁

第十一条 护理记录
护理记录应包含：生命体征、出入量、皮肤情况、特殊事件及交接班要点。

第十二条 交接班
交接班须书面记录关键事项，口头补充紧急情况；禁止只口头交接而无书面留痕。

第十三条 补贴标准
护理员岗位补贴标准为每人每月 200 元，按出勤天数折算发放。

第十四条 探视制度
工作日下午 14:00-16:00 开放探视；传染病流行期间可暂停探视并提前公告。
`;

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function buildDocx(body: string): Buffer {
  const zip = new AdmZip();
  const paras = body
    .split("\n")
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
</Types>`)
  );
  zip.addFile(
    "_rels/.rels",
    Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`)
  );
  zip.addFile(
    "word/_rels/document.xml.rels",
    Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`)
  );
  return zip.toBuffer();
}

const outDir = path.join(__dirname, "fixtures", "binary");
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, "养老机构服务规范-W波验收.docx");
fs.writeFileSync(outPath, buildDocx(BODY));
console.log(`wrote ${outPath} (${fs.statSync(outPath).size} bytes)`);
