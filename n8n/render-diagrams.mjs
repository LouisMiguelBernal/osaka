// Renders each workflow JSON in workflows/ as an n8n-style SVG canvas in ../docs/images/.
//   node render-diagrams.mjs
// Positions and connections come straight from the workflow files, so diagrams never drift from the code.
import fs from "node:fs";
import path from "node:path";

const SIZE = 64;
const PAD = 70;
const KIND = [
  [/Trigger|localFileTrigger|scheduleTrigger/i, "#ff6d5a", "▶"],
  [/\.code$/, "#f5a623", "{ }"],
  [/httpRequest/, "#7b61ff", "⇄"],
  [/gmail/, "#ea4335", "✉"],
  [/googleDrive/, "#1fa463", "▲"],
  [/googleSheets/, "#0f9d58", "▦"],
  [/readWriteFile/, "#2db67c", "⎘"],
  [/\.if$|\.switch$/, "#00a3a3", "◇"],
  [/splitInBatches/, "#3b82f6", "↻"],
  [/executeWorkflow/, "#a855f7", "⤷"],
  [/noOp/, "#64748b", "○"],
];
const style = (type) => KIND.find(([re]) => re.test(type)) ?? [null, "#94a3b8", "•"];
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function wrap(label, max = 18) {
  const words = label.split(" ");
  const lines = [""];
  for (const w of words) {
    const cur = lines[lines.length - 1];
    if ((cur + " " + w).trim().length > max && cur) lines.push(w);
    else lines[lines.length - 1] = (cur + " " + w).trim();
  }
  return lines.slice(0, 3);
}

function render(wf) {
  const nodes = wf.nodes;
  const xs = nodes.map((n) => n.position[0]);
  const ys = nodes.map((n) => n.position[1]);
  const minX = Math.min(...xs) - PAD, minY = Math.min(...ys) - PAD;
  const width = Math.max(...xs) - minX + SIZE + PAD;
  const height = Math.max(...ys) - minY + SIZE + PAD + 40;
  const at = Object.fromEntries(nodes.map((n) => [n.name, { x: n.position[0] - minX, y: n.position[1] - minY }]));

  const edges = [];
  for (const [from, c] of Object.entries(wf.connections)) {
    c.main.forEach((targets, outIdx) => {
      const outs = c.main.length;
      for (const t of targets) {
        const a = at[from], b = at[t.node];
        const x1 = a.x + SIZE, y1 = a.y + SIZE / 2 + (outs > 1 ? (outIdx - (outs - 1) / 2) * 14 : 0);
        const x2 = b.x, y2 = b.y + SIZE / 2;
        const back = x2 <= x1; // loop-back edge: route below the nodes
        const d = back
          ? `M${x1},${y1} C${x1 + 60},${y1} ${x1 + 60},${Math.max(y1, y2) + 110} ${(x1 + x2) / 2},${Math.max(y1, y2) + 110} S${x2 - 60},${y2} ${x2},${y2}`
          : `M${x1},${y1} C${x1 + (x2 - x1) / 2},${y1} ${x2 - (x2 - x1) / 2},${y2} ${x2},${y2}`;
        edges.push(`<path d="${d}" fill="none" stroke="#5b6574" stroke-width="2"${back ? ' stroke-dasharray="6 5"' : ""} marker-end="url(#arrow)"/>`);
      }
    });
  }

  const boxes = nodes.map((n) => {
    const { x, y } = at[n.name];
    const [, color, glyph] = style(n.type);
    const trig = /Trigger/i.test(n.type);
    const label = wrap(n.name).map((l, i) => `<text x="${x + SIZE / 2}" y="${y + SIZE + 18 + i * 14}" text-anchor="middle" class="lbl">${esc(l)}</text>`).join("");
    return `<g>
  <rect x="${x}" y="${y}" width="${SIZE}" height="${SIZE}" rx="${trig ? 26 : 10}" fill="#2a2f38" stroke="${color}" stroke-width="2"/>
  <text x="${x + SIZE / 2}" y="${y + SIZE / 2 + 7}" text-anchor="middle" class="ico" fill="${color}">${esc(glyph)}</text>
  ${label}
</g>`;
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${esc(wf.name)}">
<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#5b6574"/></marker>
<pattern id="dots" width="20" height="20" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill="#2c313a"/></pattern></defs>
<style>.lbl{font:600 11px 'Segoe UI',Inter,Arial,sans-serif;fill:#e5e7eb}.ico{font:700 22px 'Segoe UI Symbol','Segoe UI',Arial,sans-serif}.ttl{font:700 16px 'Segoe UI',Inter,Arial,sans-serif;fill:#f3f4f6}.sub{font:12px 'Segoe UI',Inter,Arial,sans-serif;fill:#9ca3af}</style>
<rect width="100%" height="100%" fill="#1f2228"/><rect width="100%" height="100%" fill="url(#dots)"/>
<text x="20" y="28" class="ttl">${esc(wf.name)}</text><text x="20" y="46" class="sub">${nodes.length} nodes · generated from n8n/workflows</text>
${edges.join("\n")}
${boxes.join("\n")}
</svg>
`;
}

const outDir = path.resolve(import.meta.dirname, "..", "docs", "images");
fs.mkdirSync(outDir, { recursive: true });
for (const f of fs.readdirSync(path.join(import.meta.dirname, "workflows")).filter((f) => f.endsWith(".json"))) {
  const wf = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "workflows", f), "utf8"));
  const out = path.join(outDir, `workflow-${f.replace(/^osaka-/, "").replace(/\.json$/, "")}.svg`);
  fs.writeFileSync(out, render(wf));
  console.log(`${path.basename(out)}  (${wf.nodes.length} nodes)`);
}
