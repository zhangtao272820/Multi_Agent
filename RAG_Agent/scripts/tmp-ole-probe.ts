import fs from "node:fs";
import WordExtractor from "word-extractor";

const path = process.argv[2] || "f:/下载/养老机构服务规范.docx";
const buf = fs.readFileSync(path);
const magic = buf.slice(0, 4).toString("hex");
const e = await new WordExtractor().extract(buf);
const t = String(e.getBody() || "");
console.log(JSON.stringify({ magic, chars: t.length, preview: t.slice(0, 160) }, null, 2));
