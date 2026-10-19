import type { Llm } from "./ollama";
import { LlmError } from "./ollama";
import type { PdfReader } from "./pdf";
import { PdfRejected } from "./pdf";
import type { CheckResult } from "./checks";
import { runChecks, scoreConfidence } from "./checks";
import { groundFields } from "./ground";
import type { DocType, ExtractableDocType, ExtractedFields } from "./schemas";
import { CLASSIFY_SCHEMA, FIELD_SPECS, isDocType, missingRequired, ollamaSchema, validateExtraction } from "./schemas";
import { CLASSIFY_SYSTEM, documentTurn, extractSystem, visionTurn } from "./prompts";
import type { FailureStage } from "./state";

/**
 * classify → extract (per chunk) → merge → validate → ground → check → score.
 *
 * Pure orchestration over injected `Llm` and `PdfReader`, so every branch is
 * unit-testable without Ollama or a real PDF. The route owns persistence.
 */

export const CHUNK_CHARS = 20_000;
export const CLASSIFY_CHARS = 8_000;
export const VISION_BATCH = 3;

export class PipelineError extends Error {
  constructor(readonly stage: FailureStage, message: string, readonly retryable: boolean) {
    super(message);
    this.name = "PipelineError";
  }
}

export type PipelineResult = {
  docType: DocType;
  classifyReason: string;
  fields: ExtractedFields; // plaintext — caller encrypts before storage
  ungrounded: string[];
  missingFields: string[];
  checks: CheckResult[];
  confidence: number;
  pageCount: number;
  usedVision: boolean;
  warnings: string[];
};

/** Greedy page packing so a long statement is read in full, never truncated. */
export function chunkPages(pages: readonly string[], maxChars = CHUNK_CHARS): { text: string; from: number; to: number }[] {
  const chunks: { text: string; from: number; to: number }[] = [];
  let buf: string[] = [];
  let from = 1;
  let size = 0;
  pages.forEach((page, i) => {
    const block = `--- page ${i + 1} ---\n${page.length > maxChars ? page.slice(0, maxChars) : page}`;
    if (buf.length && size + block.length > maxChars) {
      chunks.push({ text: buf.join("\n\n"), from, to: i });
      buf = [];
      size = 0;
      from = i + 1;
    }
    buf.push(block);
    size += block.length;
  });
  if (buf.length) chunks.push({ text: buf.join("\n\n"), from, to: pages.length });
  return chunks;
}

/** First non-null wins; disagreements are reported, not silently resolved. */
export function mergeChunks(type: ExtractableDocType, parts: ExtractedFields[]): { fields: ExtractedFields; conflicts: string[] } {
  const fields: ExtractedFields = {};
  const conflicts: string[] = [];
  for (const spec of FIELD_SPECS[type]) {
    const values = parts.map((p) => p[spec.id]).filter((v) => v != null);
    fields[spec.id] = values[0] ?? null;
    if (new Set(values.map(String)).size > 1) conflicts.push(spec.id);
  }
  return { fields, conflicts };
}

const llmStage = async <T>(stage: FailureStage, fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof LlmError) throw new PipelineError(stage, err.message, err.retryable);
    throw new PipelineError(stage, err instanceof Error ? err.message : "Unknown model error", true);
  }
};

export async function runPipeline(pdf: Uint8Array, deps: { llm: Llm; reader: PdfReader }): Promise<PipelineResult> {
  const warnings: string[] = [];

  // 1. Open the file.
  let text;
  try {
    text = await deps.reader.read(pdf);
  } catch (err) {
    if (err instanceof PdfRejected) throw new PipelineError("validate_file", err.message, false);
    throw new PipelineError("validate_file", "The PDF could not be read.", false);
  }

  // 2. Vision fallback for scans.
  let images: string[] = [];
  if (text.scanned) {
    images = await llmStage("validate_file", () => deps.reader.renderPages(pdf, text.pageCount));
    if (text.pageCount > images.length) {
      warnings.push(`Scanned PDF: only the first ${images.length} of ${text.pageCount} pages were read.`);
    }
  }
  const usedVision = images.length > 0;
  const fullText = text.pages.join("\n\n");

  // 3. Classify.
  const cls = await llmStage("classify", () =>
    deps.llm.chatJson({
      system: CLASSIFY_SYSTEM,
      schema: CLASSIFY_SCHEMA as unknown as Record<string, unknown>,
      ...(usedVision
        ? { user: visionTurn("Classify this document."), images: images.slice(0, 2) }
        : { user: documentTurn(fullText.slice(0, CLASSIFY_CHARS)) }),
    }),
  );
  const docType: DocType = isDocType((cls as { docType?: unknown })?.docType) ? (cls as { docType: DocType }).docType : "other";
  const classifyReason = String((cls as { reason?: unknown })?.reason ?? "").slice(0, 300);

  const base = { docType, classifyReason, pageCount: text.pageCount, usedVision, warnings };
  if (docType === "other") {
    return { ...base, fields: {}, ungrounded: [], missingFields: [], checks: [], confidence: 0 };
  }

  // 4. Extract, chunk by chunk.
  const schema = ollamaSchema(docType);
  const system = extractSystem(docType);
  const parts: ExtractedFields[] = [];
  if (usedVision) {
    for (let i = 0; i < images.length; i += VISION_BATCH) {
      const batch = images.slice(i, i + VISION_BATCH);
      const raw = await llmStage("extract", () =>
        deps.llm.chatJson({ system, schema, user: visionTurn(`Pages ${i + 1}–${i + batch.length} of ${images.length}.`), images: batch }),
      );
      parts.push(validateExtraction(docType, raw));
    }
  } else {
    const chunks = chunkPages(text.pages);
    for (const c of chunks) {
      const note = chunks.length > 1 ? `Pages ${c.from}–${c.to} of ${text.pageCount}. Return null for fields not on these pages.` : undefined;
      const raw = await llmStage("extract", () => deps.llm.chatJson({ system, schema, user: documentTurn(c.text, note) }));
      parts.push(validateExtraction(docType, raw));
    }
  }
  const merged = mergeChunks(docType, parts);
  if (merged.conflicts.length) warnings.push(`Different values across pages for: ${merged.conflicts.join(", ")}.`);

  // 5. Ground (text layer only).
  let fields = merged.fields;
  let ungrounded: string[] = [];
  if (usedVision) {
    warnings.push("Read from page images — values could not be verified against a text layer.");
  } else {
    ({ fields, ungrounded } = groundFields(FIELD_SPECS[docType], fields, fullText));
  }

  // 6. Checks + score.
  const checks = runChecks(docType, fields);
  const confidence = scoreConfidence({ type: docType, fields, ungrounded, checks, usedVision });
  return { ...base, fields, ungrounded, missingFields: missingRequired(docType, fields), checks, confidence };
}
