import type { Extraction } from "@/lib/schema";
import type { CheckResult } from "./checks";
import { assertNoTaxIds, outboundFields } from "./mask";
import type { DocType, ExtractedFields, FieldSpec } from "./schemas";
import { DOC_TYPE_LABELS, FIELD_SPECS, isDocType } from "./schemas";

/**
 * The ONLY shape that leaves the app for n8n (and from there Sheets, Drive and
 * the reply email). Built from the stored row, masked, then passed through the
 * tax-ID gate — so nothing downstream can receive a full SSN/EIN even by mistake.
 */

export type OutboundField = { id: string; label: string; value: string | null };

export type IngestSummary = {
  extractionId: string;
  status: string;
  duplicate: boolean;
  docType: DocType | null;
  docTypeLabel: string;
  confidence: number | null;
  reason: string | null;
  fields: OutboundField[];
  missingFields: OutboundField[];
  ungrounded: string[];
  warnings: string[];
  checks: CheckResult[];
  sender: { email: string; name: string | null };
  client: { id: string; name: string | null } | null;
  fanout: Record<string, unknown>;
  dashboardUrl: string;
  drive: { folderPath: string[]; fileName: string } | null;
  sheet: { tab: string; row: Record<string, string | number | null> } | null;
};

const money = new Intl.NumberFormat("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });

export function formatValue(spec: FieldSpec, v: ExtractedFields[string]): string | null {
  if (v == null) return null;
  if (typeof v === "number" && spec.kind === "money") return money.format(v);
  return String(v);
}

/** Folder/file names safe for Drive: no PII beyond the client name, no slashes. */
export const safeName = (s: string): string => s.replace(/[\\/:*?"<>|#%\n\r\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "unknown";

export function buildSummary(input: {
  row: Extraction;
  clientName: string | null;
  senderName: string | null;
  duplicate: boolean;
  baseUrl: string;
}): IngestSummary {
  const { row } = input;
  const type = isDocType(row.docType) ? row.docType : null;
  const specs = type && type !== "other" ? FIELD_SPECS[type] : [];
  const stored = (row.fields ?? {}) as ExtractedFields;
  const shown = type && type !== "other" ? outboundFields(type, stored) : {};

  const fields = specs.map((s) => ({ id: s.id, label: s.label, value: formatValue(s, shown[s.id] ?? null) }));
  const labelOf = new Map(specs.map((s) => [s.id, s.label]));
  const date = row.createdAt.toISOString().slice(0, 10);
  const who = safeName(input.clientName || row.senderEmail);
  const processed = row.status === "needs_review" || row.status === "approved";

  const summary: IngestSummary = {
    extractionId: row.id,
    status: row.status,
    duplicate: input.duplicate,
    docType: type,
    docTypeLabel: type ? DOC_TYPE_LABELS[type] : "Not classified",
    confidence: row.confidence == null ? null : Number(row.confidence),
    reason: row.failedReason,
    fields,
    missingFields: row.missingFields.map((id) => ({ id, label: labelOf.get(id) ?? id, value: null })),
    ungrounded: row.ungrounded,
    warnings: row.warnings,
    checks: (row.checks ?? []) as CheckResult[],
    sender: { email: row.senderEmail, name: input.senderName },
    client: row.clientId ? { id: row.clientId, name: input.clientName } : null,
    fanout: (row.fanout ?? {}) as Record<string, unknown>,
    dashboardUrl: `${input.baseUrl.replace(/\/$/, "")}/inbox/${row.id}`,
    drive:
      processed && type
        ? { folderPath: ["OSAKA", who, DOC_TYPE_LABELS[type]], fileName: `${date}_${type}_${safeName(row.fileName.replace(/\.pdf$/i, ""))}.pdf` }
        : null,
    sheet:
      processed && type && type !== "other"
        ? {
            tab: type,
            row: {
              received: date,
              extraction_id: row.id,
              sender: row.senderEmail,
              file: row.fileName,
              confidence: row.confidence == null ? null : Number(row.confidence),
              missing: row.missingFields.join(", "),
              status: row.status,
              ...Object.fromEntries(specs.map((s) => [s.id, (shown[s.id] ?? null) as string | number | null])),
            },
          }
        : null,
  };
  assertNoTaxIds(summary);
  return summary;
}
