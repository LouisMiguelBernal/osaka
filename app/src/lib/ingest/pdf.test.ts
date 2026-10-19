import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { hasPdfMagic, isScanned, PdfRejected, unpdfReader } from "./pdf";

async function makePdf(pages: string[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const text of pages) {
    const page = doc.addPage([612, 792]);
    text.split("\n").forEach((line, i) => line && page.drawText(line, { x: 50, y: 740 - i * 18, size: 12, font }));
  }
  return doc.save();
}

const rejectCode = async (data: Uint8Array) => {
  try {
    await unpdfReader.read(data);
    return "ok";
  } catch (e) {
    return e instanceof PdfRejected ? e.code : "other";
  }
};

describe("unpdfReader", () => {
  it("returns per-page text from a real PDF", async () => {
    const data = await makePdf(["ACME Trading LLC Profit and Loss statement for Q1 2026", "Total Revenue 120,500.00 and Net Income 30,000.00 for the period"]);
    const r = await unpdfReader.read(data);
    expect(r.pageCount).toBe(2);
    expect(r.pages[1]).toContain("120,500.00");
    expect(r.scanned).toBe(false);
  });

  it("flags a PDF without a text layer as scanned and can render it", async () => {
    const data = await makePdf(["", ""]);
    const r = await unpdfReader.read(data);
    expect(r.scanned).toBe(true);
    const imgs = await unpdfReader.renderPages(data, 5);
    expect(imgs).toHaveLength(2);
    expect(Buffer.from(imgs[0], "base64").subarray(1, 4).toString()).toBe("PNG");
  });

  it("rejects empty, non-PDF and damaged files", async () => {
    expect(await rejectCode(new Uint8Array())).toBe("empty");
    expect(await rejectCode(new TextEncoder().encode("PK\u0003\u0004 zip file"))).toBe("not_pdf");
    const good = await makePdf(["hello"]);
    expect(await rejectCode(good.subarray(0, 40))).toBe("corrupt");
  });
});

describe("helpers", () => {
  it("finds the PDF header even after leading junk", () => {
    expect(hasPdfMagic(new TextEncoder().encode("\n\n%PDF-1.7"))).toBe(true);
    expect(hasPdfMagic(new TextEncoder().encode("GIF89a"))).toBe(false);
  });

  it("scanned heuristic", () => {
    expect(isScanned([])).toBe(true);
    expect(isScanned(["   ", "12"])).toBe(true);
    expect(isScanned(["x".repeat(200)])).toBe(false);
  });
});
