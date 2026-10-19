import { createIsomorphicCanvasFactory, extractText, getDocumentProxy, renderPageAsImage } from "unpdf";

/** Under Next.js the CJS module can arrive wrapped as { default }; unpdf needs the bare exports. */
const loadCanvas = async () => {
  const m = await import("@napi-rs/canvas");
  return ((m as unknown as { default?: typeof m }).default ?? m) as typeof m;
};

/**
 * PDF intake: reject what cannot be processed, return per-page text, and render
 * pages for the vision path when the PDF has no usable text layer (scans,
 * phone photos saved as PDF).
 */

export const MAX_PAGES = 60;
export const MAX_VISION_PAGES = 10;
/** Below this many text characters per page on average, treat the PDF as scanned. */
export const SCANNED_CHARS_PER_PAGE = 50;

export class PdfRejected extends Error {
  constructor(readonly code: "not_pdf" | "encrypted" | "corrupt" | "empty" | "too_many_pages", message: string) {
    super(message);
    this.name = "PdfRejected";
  }
}

export type PdfText = { pageCount: number; pages: string[]; scanned: boolean };

export interface PdfReader {
  read(data: Uint8Array): Promise<PdfText>;
  renderPages(data: Uint8Array, count: number): Promise<string[]>;
}

export const hasPdfMagic = (data: Uint8Array): boolean => {
  // "%PDF-" may be preceded by junk bytes; the spec allows it within the first 1 KB.
  const head = Buffer.from(data.subarray(0, 1024)).toString("latin1");
  return head.includes("%PDF-");
};

export const isScanned = (pages: readonly string[]): boolean => {
  if (pages.length === 0) return true;
  const chars = pages.reduce((n, p) => n + p.replace(/\s/g, "").length, 0);
  return chars / pages.length < SCANNED_CHARS_PER_PAGE;
};

const copy = (data: Uint8Array): Uint8Array => new Uint8Array(data); // pdf.js detaches the buffer it is given

export const unpdfReader: PdfReader = {
  async read(data) {
    if (data.byteLength === 0) throw new PdfRejected("empty", "The attachment is empty.");
    if (!hasPdfMagic(data)) throw new PdfRejected("not_pdf", "The attachment is not a PDF.");

    let doc;
    try {
      doc = await getDocumentProxy(copy(data));
    } catch (err) {
      const name = (err as { name?: string })?.name;
      if (name === "PasswordException") {
        throw new PdfRejected("encrypted", "The PDF is password-protected. Please send an unlocked copy.");
      }
      throw new PdfRejected("corrupt", "The PDF could not be opened (damaged or incomplete file).");
    }
    if (doc.numPages > MAX_PAGES) {
      throw new PdfRejected("too_many_pages", `The PDF has ${doc.numPages} pages; the limit is ${MAX_PAGES}.`);
    }
    const { text } = await extractText(doc, { mergePages: false });
    const pages = text.map((t) => t.replace(/[ \t]+\n/g, "\n").trim());
    return { pageCount: doc.numPages, pages, scanned: isScanned(pages) };
  },

  async renderPages(data, count) {
    // The document must be opened WITH a real canvas factory: unpdf's serverless pdf.js
    // build otherwise wires in a stub that throws "@napi-rs/canvas is not available".
    const doc = await getDocumentProxy(copy(data), {
      CanvasFactory: await createIsomorphicCanvasFactory(loadCanvas),
    } as Parameters<typeof getDocumentProxy>[1]);
    const n = Math.min(count, doc.numPages, MAX_VISION_PAGES);
    const out: string[] = [];
    for (let p = 1; p <= n; p++) {
      const png = await renderPageAsImage(doc, p, {
        canvasImport: loadCanvas,
        width: 1400, // legible for an 8B vision model without exploding the context
      });
      out.push(Buffer.from(png).toString("base64"));
    }
    return out;
  },
};
