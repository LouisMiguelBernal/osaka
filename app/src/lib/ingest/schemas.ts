import { z } from "zod";

/**
 * Per-document-type field contracts. ONE declaration drives three things so they cannot drift: the
 * JSON schema Ollama decodes against, the validator the server re-applies to the model's output, and
 * the dashboard / Sheet columns.
 */

export const SCHEMA_VERSION = "1.0.0";

export const DOC_TYPES = ["intake", "tax_return", "financial_statement", "other"] as const;
export type DocType = (typeof DOC_TYPES)[number];
export type ExtractableDocType = Exclude<DocType, "other">;

/**
 * text   free text, kept verbatim (units/periods preserved: "$40k/month")
 * money  a single currency amount → number
 * number a count → number
 * date   ISO YYYY-MM-DD
 * year   four-digit year → number
 * taxId  SSN/EIN — encrypted at rest, masked everywhere outbound
 */
export type FieldKind = "text" | "money" | "number" | "date" | "year" | "taxId";

export type FieldSpec = {
  id: string;
  label: string;
  kind: FieldKind;
  required?: boolean;
  /** Extra guidance for the model (allowed values, what NOT to use). */
  hint?: string;
};

const INTAKE: FieldSpec[] = [
  { id: "contactName", label: "Contact name", kind: "text", required: true },
  { id: "email", label: "Email", kind: "text", required: true },
  { id: "phone", label: "Phone", kind: "text" },
  { id: "businessName", label: "Business name", kind: "text", required: true },
  { id: "entityType", label: "Entity type", kind: "text", hint: "As written, e.g. LLC, S-Corp, sole proprietor." },
  { id: "website", label: "Website", kind: "text" },
  { id: "industry", label: "Industry", kind: "text" },
  { id: "businessAddress", label: "Business address", kind: "text" },
  { id: "ownerCount", label: "Number of owners", kind: "text" },
  { id: "ownershipShare", label: "Contact's ownership share", kind: "text" },
  { id: "employeeCount", label: "Team size", kind: "text" },
  { id: "monthlyRevenue", label: "Monthly revenue", kind: "text", required: true, hint: "Keep the period, e.g. \"$40k/month\"." },
  { id: "recentRevenue", label: "Recent revenue (stated period)", kind: "text" },
  { id: "servicesOffered", label: "Products / services", kind: "text" },
  { id: "pricing", label: "Pricing", kind: "text", hint: "Keep each price's unit, e.g. \"$10 per kilo\"." },
  { id: "paymentTerms", label: "Payment terms", kind: "text" },
  { id: "hasCostOfGoods", label: "Has cost of goods", kind: "text" },
  { id: "acquisitionChannels", label: "Customer acquisition channels", kind: "text" },
  { id: "fulfilment", label: "Who delivers the work", kind: "text" },
];

const TAX_RETURN: FieldSpec[] = [
  { id: "returnType", label: "Return type", kind: "text", required: true, hint: "Form number only: 1040, 1120, 1120S, 1065, or as printed." },
  { id: "taxYear", label: "Tax year", kind: "year", required: true },
  { id: "taxpayerName", label: "Taxpayer / entity name", kind: "text", required: true },
  { id: "taxId", label: "SSN / EIN", kind: "taxId", hint: "Digits as printed. Null if masked or absent." },
  { id: "filingStatus", label: "Filing status", kind: "text" },
  { id: "grossIncome", label: "Total / gross income", kind: "money", required: true },
  { id: "totalDeductions", label: "Total deductions", kind: "money" },
  { id: "taxableIncome", label: "Taxable income", kind: "money", required: true },
  { id: "totalTax", label: "Total tax", kind: "money", required: true },
  { id: "totalPayments", label: "Total payments", kind: "money" },
  { id: "refundAmount", label: "Refund", kind: "money" },
  { id: "amountOwed", label: "Amount owed", kind: "money" },
  { id: "preparerName", label: "Paid preparer", kind: "text" },
];

const FINANCIAL_STATEMENT: FieldSpec[] = [
  { id: "statementType", label: "Statement type", kind: "text", required: true, hint: "One of: profit_and_loss, balance_sheet, cash_flow, bank_statement." },
  { id: "entityName", label: "Business name", kind: "text", required: true },
  { id: "periodStart", label: "Period start", kind: "date", required: true },
  { id: "periodEnd", label: "Period end", kind: "date", required: true },
  { id: "currency", label: "Currency", kind: "text", hint: "ISO code, e.g. USD, PHP." },
  { id: "revenue", label: "Total revenue / income", kind: "money" },
  { id: "cogs", label: "Cost of goods sold", kind: "money" },
  { id: "grossProfit", label: "Gross profit", kind: "money" },
  { id: "operatingExpenses", label: "Total operating expenses", kind: "money" },
  { id: "netIncome", label: "Net income", kind: "money" },
  { id: "totalAssets", label: "Total assets", kind: "money" },
  { id: "totalLiabilities", label: "Total liabilities", kind: "money" },
  { id: "totalEquity", label: "Total equity", kind: "money" },
  { id: "openingBalance", label: "Opening balance", kind: "money" },
  { id: "closingBalance", label: "Closing / ending cash", kind: "money" },
];

export const FIELD_SPECS: Record<ExtractableDocType, readonly FieldSpec[]> = {
  intake: INTAKE,
  tax_return: TAX_RETURN,
  financial_statement: FINANCIAL_STATEMENT,
};

export const DOC_TYPE_LABELS: Record<DocType, string> = {
  intake: "Client intake",
  tax_return: "Tax return",
  financial_statement: "Financial statement",
  other: "Other / unrecognised",
};

export const isDocType = (v: unknown): v is DocType =>
  typeof v === "string" && (DOC_TYPES as readonly string[]).includes(v);

export const isNumericKind = (k: FieldKind): boolean => k === "money" || k === "number" || k === "year";

export type FieldValue = string | number | null;
export type ExtractedFields = Record<string, FieldValue>;

/** JSON schema handed to Ollama's `format`. Every field is required-but-nullable so the model must decide each one. */
export function ollamaSchema(type: ExtractableDocType): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const f of FIELD_SPECS[type]) {
    properties[f.id] = {
      type: [isNumericKind(f.kind) ? "number" : "string", "null"],
      description: f.hint ? `${f.label}. ${f.hint}` : f.label,
    };
  }
  return { type: "object", properties, required: FIELD_SPECS[type].map((f) => f.id), additionalProperties: false };
}

export const CLASSIFY_SCHEMA = {
  type: "object",
  properties: {
    docType: { type: "string", enum: [...DOC_TYPES] },
    reason: { type: "string" },
  },
  required: ["docType", "reason"],
  additionalProperties: false,
} as const;

/** Parse "$1,234.50", "(1,234)", "1.2M", "40k" → number. Null when not a plain amount. */
export function parseAmount(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== "string") return null;
  let s = raw.trim();
  if (!s) return null;
  const negative = /^\(.*\)$/.test(s) || /^-/.test(s) || /-\s*$/.test(s);
  s = s.replace(/[()\s]/g, "").replace(/^[-+]/, "").replace(/-$/, "");
  s = s.replace(/^[A-Z]{3}/i, "").replace(/[$€£¥₱]/g, "").replace(/,/g, "");
  const m = /^(\d+(?:\.\d+)?)([kKmMbB])?$/.exec(s);
  if (!m) return null;
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] ?? "").toLowerCase() as "k" | "m" | "b"] ?? 1;
  const n = Number(m[1]) * mult;
  return negative ? -n : n;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Normalise common date spellings to YYYY-MM-DD; null if not a full date. */
export function parseDate(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  let y: number, mo: number, d: number;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  else if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s))) [mo, d, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  else if ((m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(s))) {
    mo = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1;
    [d, y] = [Number(m[2]), Number(m[3])];
  } else if ((m = /^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/.exec(s))) {
    mo = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()) + 1;
    [d, y] = [Number(m[1]), Number(m[3])];
  } else return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (mo < 1 || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Coerce one raw model value to its kind. Returns null for anything unusable. */
export function coerceField(spec: FieldSpec, raw: unknown): FieldValue {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string" && /^(n\/?a|null|none|unknown|-+)$/i.test(raw.trim())) return null;
  switch (spec.kind) {
    case "money":
    case "number":
      return parseAmount(raw);
    case "year": {
      const n = typeof raw === "number" ? raw : Number(String(raw).trim());
      return Number.isInteger(n) && n >= 1900 && n <= 2100 ? n : null;
    }
    case "date":
      return parseDate(raw);
    case "taxId": {
      const digits = String(raw).replace(/\D/g, "");
      return digits.length === 9 ? digits : null;
    }
    case "text": {
      const s = (typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw : "").trim();
      return s ? s.slice(0, 500) : null;
    }
  }
}

/** Server-side re-validation of model output: unknown keys dropped, every spec key present, values coerced. */
export function validateExtraction(type: ExtractableDocType, raw: unknown): ExtractedFields {
  const obj = z.record(z.string(), z.unknown()).safeParse(raw);
  const source = obj.success ? obj.data : {};
  const out: ExtractedFields = {};
  for (const spec of FIELD_SPECS[type]) out[spec.id] = coerceField(spec, source[spec.id]);
  return out;
}

export const missingRequired = (type: ExtractableDocType, fields: ExtractedFields): string[] =>
  FIELD_SPECS[type].filter((f) => f.required && fields[f.id] == null).map((f) => f.id);
