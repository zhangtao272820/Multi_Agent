/**
 * W3：MinerU /health 探测（运维 / smoke:go-live:ops），不进默认 ci:gate。
 */
import { probeMineruHealth } from "../server/utils/heavy_parse_client";

async function main() {
  if (!process.env.RAG_HEAVY_PARSE) process.env.RAG_HEAVY_PARSE = "1";
  if (!process.env.MINERU_API_URL) {
    process.env.MINERU_API_URL = "http://127.0.0.1:8798";
  }
  const timeoutMs = Number(process.env.RAG_MINERU_PROBE_TIMEOUT_MS || 4000);
  const r = await probeMineruHealth({ timeoutMs });
  console.log(JSON.stringify(r));
  if (!r.ok) {
    console.error(
      "probe-mineru-health FAIL: MinerU unreachable. Configure MINERU_API_URL and start sidecar."
    );
    process.exit(1);
  }
  console.log("probe-mineru-health OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
