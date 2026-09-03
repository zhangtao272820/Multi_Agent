import {
  resolveBlastRadius,
  gateBlastRadiusExecution,
  type BlastRadius,
  type BlastRadiusGateResult,
} from "./blastRadius.ts";
import type { ManagerTaskEnvelope } from "./managerTaskEnvelope.ts";

/** 对 Envelope 执行 E1 闸门（专家入站 / 总管出站共用） */
export function gateManagerEnvelopeBlastRadius(
  envelope: Pick<ManagerTaskEnvelope, "blast_radius" | "confirm_token" | "target_agent" | "payload"> | null | undefined,
  opts?: { auto_confirm?: boolean; allow_t2_auto?: boolean; writeAllowed?: boolean }
): BlastRadiusGateResult {
  if (!envelope) return { ok: true }
  const kind = envelope.payload?.kind
  const data = envelope.payload?.data as { write_allowed?: boolean; read_only?: boolean } | undefined
  const writeAllowed =
    typeof opts?.writeAllowed === "boolean"
      ? opts.writeAllowed
      : Boolean(data?.write_allowed)
  const readOnly =
    Boolean(data?.read_only) ||
    (kind === "db" && !writeAllowed) ||
    kind === "rag" ||
    kind === "crawler"
  const blast =
    envelope.blast_radius ||
    resolveBlastRadius({
      agent: envelope.target_agent,
      writeAllowed,
      readOnly,
      actionKind:
        kind === "admin"
          ? readOnly
            ? "readonly"
            : "admin_write"
          : kind === "gui"
            ? "gui_write"
            : kind === "db" && writeAllowed
              ? "db_write"
              : kind === "code" && writeAllowed
                ? "code_edit"
                : "readonly",
    })
  return gateBlastRadiusExecution({
    blast_radius: blast,
    confirm_token: envelope.confirm_token,
    auto_confirm: opts?.auto_confirm,
    allow_t2_auto: opts?.allow_t2_auto,
  })
}

export type { BlastRadius, BlastRadiusGateResult };
