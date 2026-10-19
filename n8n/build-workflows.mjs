// Generates the importable n8n workflow JSON from readable source.
//   node build-workflows.mjs   → workflows/osaka-email-pdf.json, workflows/osaka-error.json
// Edit THIS file, not the JSON. Credentials are referenced by name; pick them in n8n after import.
import fs from "node:fs";
import crypto from "node:crypto";

const id = (s) => crypto.createHash("md5").update(s).digest("hex").replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5");
const CRED = {
  gmailOAuth2: { gmailOAuth2: { id: "", name: "OSAKA Gmail" } },
  googleDriveOAuth2Api: { googleDriveOAuth2Api: { id: "", name: "OSAKA Google Drive" } },
  googleSheetsOAuth2Api: { googleSheetsOAuth2Api: { id: "", name: "OSAKA Google Sheets" } },
};
const RETRY = { retryOnFail: true, maxTries: 3, waitBetweenTries: 5000 };

function workflow(name) {
  const nodes = [];
  const connections = {};
  const node = (n) => {
    nodes.push({ id: id(name + n.name), typeVersion: 1, parameters: {}, ...n });
    return n.name;
  };
  const link = (from, to, output = 0, input = 0) => {
    connections[from] ??= { main: [] };
    while (connections[from].main.length <= output) connections[from].main.push([]);
    connections[from].main[output].push({ node: to, type: "main", index: input });
  };
  return { node, link, build: (settings = {}) => ({ id: crypto.createHash("md5").update(name).digest("base64url").slice(0, 16), name, nodes, connections, active: false, settings: { executionOrder: "v1", ...settings }, pinData: {} }) };
}

const code = (name, position, jsCode, mode = "runOnceForAllItems") => ({
  name,
  type: "n8n-nodes-base.code",
  typeVersion: 2,
  position,
  parameters: { mode, jsCode: jsCode.trim() },
});

/* Shared signing snippet (HMAC over canonical parts; see app/src/lib/ingest/hmac.ts). */
const SIGN = `
const crypto = require('crypto');
const sign = (parts) => {
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = crypto.createHmac('sha256', $env.OSAKA_INGEST_SECRET).update(['v1', ts, ...parts].join('\\n')).digest('hex');
  return { ts, signature: 'sha256=' + sig };
};`;

const ack = (w, target, refExpr, position, next) => {
  const signName = w.node(code(`Sign ack: ${target}`, position, `${SIGN}
const s = $('Route result').item.json;
const ref = ${refExpr};
return { json: { extractionId: s.extractionId, target: '${target}', ref, ...sign([s.extractionId, '${target}', String(ref)]) } };`, "runOnceForEachItem"));
  const httpName = w.node({
    name: `Ack: ${target}`,
    type: "n8n-nodes-base.httpRequest",
    typeVersion: 4.2,
    position: [position[0] + 220, position[1]],
    ...RETRY,
    parameters: {
      method: "POST",
      url: "={{ $env.OSAKA_BASE_URL }}/api/ingest/fanout-ack",
      sendHeaders: true,
      headerParameters: { parameters: [
        { name: "x-osaka-timestamp", value: "={{ $json.ts }}" },
        { name: "x-osaka-signature", value: "={{ $json.signature }}" },
      ] },
      sendBody: true,
      specifyBody: "json",
      jsonBody: "={{ JSON.stringify({ extractionId: $json.extractionId, target: $json.target, ref: $json.ref }) }}",
      options: {},
    },
  });
  w.link(signName, httpName);
  if (next) w.link(httpName, next);
  return signName;
};

/* ───────────────────────────── Main workflow ───────────────────────────── */
const w = workflow("OSAKA — Email PDF intake");

const trigger = w.node({
  name: "Gmail Trigger",
  type: "n8n-nodes-base.gmailTrigger",
  typeVersion: 1.2,
  position: [0, 300],
  credentials: CRED.gmailOAuth2,
  parameters: {
    pollTimes: { item: [{ mode: "everyMinute" }] },
    simple: false,
    filters: {
      q: "has:attachment label:inbox -label:osaka-processed -label:osaka-failed -label:osaka-quarantine -from:me",
      readStatus: "both",
    },
    options: { downloadAttachments: true, dataPropertyAttachmentsPrefixName: "attachment_" },
  },
});

const prepare = w.node(code("Prepare PDFs", [220, 300], `
// One output item per PDF attachment. Bot's own mail is dropped (no reply loops).
// senderAuth comes from Gmail's Authentication-Results header (SPF/DKIM/DMARC).
const bot = ($env.OSAKA_BOT_EMAIL || '').toLowerCase();
const items = $input.all();
const out = [];
for (let i = 0; i < items.length; i++) {
  const j = items[i].json;
  const from = j.from?.value?.[0] ?? {};
  const senderEmail = String(from.address || '').toLowerCase();
  if (!senderEmail || senderEmail === bot) continue;
  const headers = j.headers || {};
  const authHeader = String(headers['authentication-results'] || headers['Authentication-Results'] || '');
  const dmarcFail = /dmarc=fail/i.test(authHeader);
  const senderAuth = !dmarcFail && /(dmarc|dkim|spf)=pass/i.test(authHeader) ? 'pass' : /(dmarc|dkim|spf)=(fail|softfail)/i.test(authHeader) ? 'fail' : 'none';
  const base = { messageId: j.id, threadId: j.threadId, senderEmail, senderName: from.name || '', subject: j.subject || '', senderAuth };
  const binary = items[i].binary || {};
  const pdfKeys = Object.keys(binary).filter((k) => binary[k].mimeType === 'application/pdf' || /\\.pdf$/i.test(binary[k].fileName || ''));
  if (pdfKeys.length === 0) { out.push({ json: { ...base, noPdf: true } }); continue; }
  for (const k of pdfKeys) {
    out.push({ json: { ...base, noPdf: false, fileName: binary[k].fileName || 'attachment.pdf' }, binary: { file: binary[k] } });
  }
}
return out;`));
w.link(trigger, prepare);

const labels = w.node({
  name: "Get labels",
  type: "n8n-nodes-base.gmail",
  typeVersion: 2.1,
  position: [440, 300],
  executeOnce: true,
  alwaysOutputData: true,
  credentials: CRED.gmailOAuth2,
  parameters: { resource: "label", operation: "getAll", returnAll: true },
});
w.link(prepare, labels);

const restore = w.node(code("Label map + items", [660, 300], `
// Gmail's addLabels needs label IDs; resolve them once per run by name.
const byName = Object.fromEntries($('Get labels').all().map((l) => [l.json.name, l.json.id]));
const labelIds = { processed: byName['OSAKA/Processed'], failed: byName['OSAKA/Failed'], quarantine: byName['OSAKA/Quarantine'] };
const missing = Object.entries(labelIds).filter(([, v]) => !v).map(([k]) => k);
if (missing.length) throw new Error('Create these Gmail labels first: ' + missing.map((m) => 'OSAKA/' + m[0].toUpperCase() + m.slice(1)).join(', '));
return $('Prepare PDFs').all().map((it) => ({ json: { ...it.json, labelIds }, binary: it.binary }));`));
w.link(labels, restore);

const loop = w.node({ name: "One at a time", type: "n8n-nodes-base.splitInBatches", typeVersion: 3, position: [880, 300], parameters: { batchSize: 1, options: {} } });
w.link(restore, loop);

const hasPdf = w.node({
  name: "Has PDF?",
  type: "n8n-nodes-base.if",
  typeVersion: 2.2,
  position: [1100, 300],
  parameters: {
    conditions: {
      options: { caseSensitive: true, typeValidation: "loose", version: 2 },
      combinator: "and",
      conditions: [{ id: id("noPdf"), leftValue: "={{ $json.noPdf }}", rightValue: false, operator: { type: "boolean", operation: "false", singleValue: true } }],
    },
    options: {},
  },
});
w.link(loop, hasPdf, 1);

/* No PDF → polite reply + Failed label */
const noPdfReply = w.node({
  name: "Reply: no PDF",
  type: "n8n-nodes-base.gmail",
  typeVersion: 2.1,
  position: [1320, 560],
  credentials: CRED.gmailOAuth2,
  ...RETRY,
  parameters: {
    operation: "reply",
    messageId: "={{ $json.messageId }}",
    emailType: "html",
    message: "=<p>Hi{{ $json.senderName ? ' ' + $json.senderName.split(' ')[0] : '' }},</p><p>Thanks for your email. We couldn't find a PDF attached, so nothing was processed. Please reply with your document attached as a PDF.</p><p>— OSAKA</p>",
    options: { appendAttribution: false },
  },
});
const noPdfLabel = w.node({
  name: "Label: failed (no PDF)",
  type: "n8n-nodes-base.gmail",
  typeVersion: 2.1,
  position: [1540, 560],
  credentials: CRED.gmailOAuth2,
  ...RETRY,
  parameters: { operation: "addLabels", messageId: "={{ $('Has PDF?').item.json.messageId }}", labelIds: "={{ [$('Has PDF?').item.json.labelIds.failed] }}" },
});
w.link(hasPdf, noPdfReply, 1);
w.link(noPdfReply, noPdfLabel);
w.link(noPdfLabel, loop);

/* PDF → sign (fresh, per item) → OSAKA */
const sign = w.node(code("Sign request", [1320, 200], `${SIGN}
const j = $json;
const buf = await this.helpers.getBinaryDataBuffer(0, 'file');
const sha = crypto.createHash('sha256').update(buf).digest('hex');
return [{ json: { ...j, ...sign([j.messageId, sha, j.senderEmail, j.senderAuth]) }, binary: $input.first().binary }];`));
w.link(hasPdf, sign, 0);

const process_ = w.node({
  name: "OSAKA: process PDF",
  type: "n8n-nodes-base.httpRequest",
  typeVersion: 4.2,
  position: [1540, 200],
  parameters: {
    method: "POST",
    url: "={{ $env.OSAKA_BASE_URL }}/api/ingest/process",
    sendHeaders: true,
    headerParameters: { parameters: [
      { name: "x-osaka-timestamp", value: "={{ $json.ts }}" },
      { name: "x-osaka-signature", value: "={{ $json.signature }}" },
    ] },
    sendBody: true,
    contentType: "multipart-form-data",
    bodyParameters: { parameters: [
      { parameterType: "formBinaryData", name: "file", inputDataFieldName: "file" },
      { name: "messageId", value: "={{ $json.messageId }}" },
      { name: "threadId", value: "={{ $json.threadId }}" },
      { name: "senderEmail", value: "={{ $json.senderEmail }}" },
      { name: "senderName", value: "={{ $json.senderName }}" },
      { name: "senderAuth", value: "={{ $json.senderAuth }}" },
      { name: "subject", value: "={{ $json.subject }}" },
      { name: "fileName", value: "={{ $json.fileName }}" },
    ] },
    options: { timeout: 300000, response: { response: { fullResponse: true, neverError: true } } },
  },
});
w.link(sign, process_);

const route = w.node(code("Route result", [1760, 200], `
// Normalise the OSAKA response and decide which side effects are still owed.
// fanout flags come from the DB, so a retried execution never repeats a reply.
const req = $('Sign request').item;
const res = $json;
if (res.statusCode !== 200 || !res.body?.extractionId) {
  return [{ json: { route: 'transport_error', http: res.statusCode, error: res.body?.error || 'no response', email: req.json }, binary: req.binary }];
}
const s = res.body;
const done = s.fanout || {};
const route = s.status === 'needs_review' || s.status === 'approved' ? 'processed' : s.status === 'quarantined' ? 'quarantined' : 'failed';
return [{ json: { ...s, route, email: req.json, needDrive: !!s.drive && !done.drive, needSheet: !!s.sheet && !done.sheets, needReply: !done.reply }, binary: req.binary }];`, "runOnceForAllItems"));
w.link(process_, route);

const sw = w.node({
  name: "By outcome",
  type: "n8n-nodes-base.switch",
  typeVersion: 3.2,
  position: [1980, 200],
  parameters: {
    rules: { values: ["processed", "quarantined", "failed", "transport_error"].map((r) => ({
      conditions: {
        options: { caseSensitive: true, typeValidation: "strict", version: 2 },
        combinator: "and",
        conditions: [{ id: id("route" + r), leftValue: "={{ $json.route }}", rightValue: r, operator: { type: "string", operation: "equals" } }],
      },
      renameOutput: true,
      outputKey: r,
    })) },
    options: {},
  },
});
w.link(route, sw);

/* processed → Drive (client folder) → Sheet → reply → label */
const ifDrive = w.node({
  name: "Drive owed?",
  type: "n8n-nodes-base.if",
  typeVersion: 2.2,
  position: [2200, 0],
  parameters: { conditions: { options: { caseSensitive: true, typeValidation: "loose", version: 2 }, combinator: "and",
    conditions: [{ id: id("needDrive"), leftValue: "={{ $json.needDrive && !!$env.OSAKA_DRIVE_ROOT_FOLDER_ID }}", rightValue: true, operator: { type: "boolean", operation: "true", singleValue: true } }] }, options: {} },
});
w.link(sw, ifDrive, 0);

const findFolder = w.node({
  name: "Find client folder",
  type: "n8n-nodes-base.googleDrive",
  typeVersion: 3,
  position: [2420, -100],
  alwaysOutputData: true,
  credentials: CRED.googleDriveOAuth2Api,
  ...RETRY,
  parameters: {
    resource: "fileFolder",
    searchMethod: "query",
    queryString: "=mimeType = 'application/vnd.google-apps.folder' and name = '{{ $json.drive.folderPath[1].replace(/'/g, \"\\\\'\") }}' and '{{ $env.OSAKA_DRIVE_ROOT_FOLDER_ID }}' in parents and trashed = false",
    limit: 1,
    filter: {},
    options: {},
  },
});
w.link(ifDrive, findFolder, 0);

const pickFolder = w.node(code("Folder exists?", [2640, -100], `
const found = $input.first().json?.id;
const s = $('Route result').item;
return [{ json: { ...s.json, folderId: found || null }, binary: s.binary }];`));
w.link(findFolder, pickFolder);

const ifFolder = w.node({
  name: "Need folder?",
  type: "n8n-nodes-base.if",
  typeVersion: 2.2,
  position: [2860, -100],
  parameters: { conditions: { options: { caseSensitive: true, typeValidation: "loose", version: 2 }, combinator: "and",
    conditions: [{ id: id("folderId"), leftValue: "={{ $json.folderId }}", rightValue: "", operator: { type: "string", operation: "empty", singleValue: true } }] }, options: {} },
});
w.link(pickFolder, ifFolder);

const mkFolder = w.node({
  name: "Create client folder",
  type: "n8n-nodes-base.googleDrive",
  typeVersion: 3,
  position: [3080, -200],
  credentials: CRED.googleDriveOAuth2Api,
  ...RETRY,
  parameters: {
    resource: "folder",
    name: "={{ $json.drive.folderPath[1] }}",
    driveId: { __rl: true, mode: "list", value: "My Drive" },
    folderId: { __rl: true, mode: "id", value: "={{ $env.OSAKA_DRIVE_ROOT_FOLDER_ID }}" },
    options: {},
  },
});
w.link(ifFolder, mkFolder, 0);

const withFolder = w.node(code("Use new folder", [3300, -200], `
const s = $('Folder exists?').item;
return [{ json: { ...s.json, folderId: $json.id }, binary: s.binary }];`, "runOnceForEachItem"));
w.link(mkFolder, withFolder);

const upload = w.node({
  name: "Upload PDF to Drive",
  type: "n8n-nodes-base.googleDrive",
  typeVersion: 3,
  position: [3520, -100],
  credentials: CRED.googleDriveOAuth2Api,
  ...RETRY,
  parameters: {
    inputDataFieldName: "file",
    name: "={{ $json.drive.fileName }}",
    driveId: { __rl: true, mode: "list", value: "My Drive" },
    folderId: { __rl: true, mode: "id", value: "={{ $json.folderId }}" },
    options: {},
  },
});
w.link(withFolder, upload);
w.link(ifFolder, upload, 1);

const ifSheet = w.node({
  name: "Sheet owed?",
  type: "n8n-nodes-base.if",
  typeVersion: 2.2,
  position: [3960, 0],
  parameters: { conditions: { options: { caseSensitive: true, typeValidation: "loose", version: 2 }, combinator: "and",
    conditions: [{ id: id("needSheet"), leftValue: "={{ $('Route result').item.json.needSheet && !!$env.OSAKA_SHEET_ID }}", rightValue: true, operator: { type: "boolean", operation: "true", singleValue: true } }] }, options: {} },
});
ack(w, "drive", "$('Upload PDF to Drive').item.json.id", [3740, -100], ifSheet);
w.link(upload, "Sign ack: drive");
w.link(ifDrive, ifSheet, 1);

const sheetRow = w.node(code("Sheet row", [4180, -100], `
return [{ json: $('Route result').item.json.sheet.row }];`, "runOnceForEachItem"));
w.link(ifSheet, sheetRow, 0);

const append = w.node({
  name: "Append to Sheet",
  type: "n8n-nodes-base.googleSheets",
  typeVersion: 4.5,
  position: [4400, -100],
  credentials: CRED.googleSheetsOAuth2Api,
  ...RETRY,
  parameters: {
    operation: "append",
    documentId: { __rl: true, mode: "id", value: "={{ $env.OSAKA_SHEET_ID }}" },
    sheetName: { __rl: true, mode: "name", value: "={{ $('Route result').item.json.sheet.tab }}" },
    columns: { mappingMode: "autoMapInputData", value: {}, matchingColumns: [], schema: [] },
    options: { handlingExtraData: "insertInNewColumn" },
  },
});
w.link(sheetRow, append);

const ifReply = w.node({
  name: "Reply owed?",
  type: "n8n-nodes-base.if",
  typeVersion: 2.2,
  position: [5060, 0],
  parameters: { conditions: { options: { caseSensitive: true, typeValidation: "loose", version: 2 }, combinator: "and",
    conditions: [{ id: id("needReply"), leftValue: "={{ $('Route result').item.json.needReply }}", rightValue: true, operator: { type: "boolean", operation: "true", singleValue: true } }] }, options: {} },
});
ack(w, "sheets", "true", [4620, -100], ifReply);
w.link(append, "Sign ack: sheets");
w.link(ifSheet, ifReply, 1);

const replyBody = w.node(code("Compose reply", [5280, -100], `
// Masked summary for the sender. No dashboard link: localhost means nothing to a client.
const s = $('Route result').item.json;
const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const first = (s.sender?.name || '').split(' ')[0];
const rows = s.fields.filter((f) => f.value != null).map((f) => '<tr><td style="padding:4px 12px 4px 0;color:#475569">' + esc(f.label) + '</td><td style="padding:4px 0"><b>' + esc(f.value) + '</b></td></tr>').join('');
const missing = s.missingFields.length ? '<p>We could not find these in the document — reply with them when you can:</p><ul>' + s.missingFields.map((f) => '<li>' + esc(f.label) + '</li>').join('') + '</ul>' : '';
const body = s.docType === 'other'
  ? '<p>We received <b>' + esc(s.email.fileName) + '</b>. It doesn\\'t look like an intake form, tax return or financial statement, so a team member will review it by hand.</p>'
  : '<p>We received your <b>' + esc(s.docTypeLabel.toLowerCase()) + '</b> (' + esc(s.email.fileName) + ') and read the following:</p><table style="border-collapse:collapse;font-size:14px">' + rows + '</table>' + missing + '<p>A team member will review this before it is added to your file. Reply to this email if anything above is wrong.</p>';
return [{ json: { html: '<div style="font-family:Segoe UI,Arial,sans-serif;color:#022C22"><p>Hi' + (first ? ' ' + esc(first) : '') + ',</p>' + body + '<p>— OSAKA</p></div>' } }];`, "runOnceForEachItem"));
w.link(ifReply, replyBody, 0);

const reply = w.node({
  name: "Reply to sender",
  type: "n8n-nodes-base.gmail",
  typeVersion: 2.1,
  position: [5500, -100],
  credentials: CRED.gmailOAuth2,
  ...RETRY,
  parameters: {
    operation: "reply",
    messageId: "={{ $('Route result').item.json.email.messageId }}",
    emailType: "html",
    message: "={{ $json.html }}",
    options: { appendAttribution: false, replyToSenderOnly: true },
  },
});
w.link(replyBody, reply);

const labelDone = w.node({
  name: "Label: processed",
  type: "n8n-nodes-base.gmail",
  typeVersion: 2.1,
  position: [5940, 0],
  credentials: CRED.gmailOAuth2,
  ...RETRY,
  parameters: { operation: "addLabels", messageId: "={{ $('Route result').item.json.email.messageId }}", labelIds: "={{ [$('Route result').item.json.email.labelIds.processed] }}" },
});
ack(w, "reply", "$('Reply to sender').item.json.id", [5720, -100], labelDone);
w.link(reply, "Sign ack: reply");
w.link(ifReply, labelDone, 1);
w.link(labelDone, loop);

/* quarantined → label + operator alert (never reply to an unknown sender: no backscatter) */
const labelQ = w.node({
  name: "Label: quarantine",
  type: "n8n-nodes-base.gmail",
  typeVersion: 2.1,
  position: [2200, 300],
  credentials: CRED.gmailOAuth2,
  ...RETRY,
  parameters: { operation: "addLabels", messageId: "={{ $json.email.messageId }}", labelIds: "={{ [$json.email.labelIds.quarantine] }}" },
});
w.link(sw, labelQ, 1);

/* failed → tell the sender only when it's about their file; label */
const failedReply = w.node(code("Failure notice", [2200, 500], `
const s = $json;
const fileProblem = s.route === 'failed' && /PDF|attachment|password|pages/i.test(s.reason || '');
return [{ json: { ...s, fileProblem } }];`, "runOnceForEachItem"));
w.link(sw, failedReply, 2);
w.link(sw, failedReply, 3);

const ifFileProblem = w.node({
  name: "Sender can fix it?",
  type: "n8n-nodes-base.if",
  typeVersion: 2.2,
  position: [2420, 500],
  parameters: { conditions: { options: { caseSensitive: true, typeValidation: "loose", version: 2 }, combinator: "and",
    conditions: [{ id: id("fileProblem"), leftValue: "={{ $json.fileProblem }}", rightValue: true, operator: { type: "boolean", operation: "true", singleValue: true } }] }, options: {} },
});
w.link(failedReply, ifFileProblem);

const replyFail = w.node({
  name: "Reply: file problem",
  type: "n8n-nodes-base.gmail",
  typeVersion: 2.1,
  position: [2640, 400],
  credentials: CRED.gmailOAuth2,
  ...RETRY,
  parameters: {
    operation: "reply",
    messageId: "={{ $json.email.messageId }}",
    emailType: "html",
    message: "=<p>Hi,</p><p>We couldn't process <b>{{ $json.email.fileName }}</b>: {{ $json.reason }}</p><p>Please reply with a corrected copy.</p><p>— OSAKA</p>",
    options: { appendAttribution: false, replyToSenderOnly: true },
  },
});
w.link(ifFileProblem, replyFail, 0);

const labelF = w.node({
  name: "Label: failed",
  type: "n8n-nodes-base.gmail",
  typeVersion: 2.1,
  position: [2860, 500],
  credentials: CRED.gmailOAuth2,
  ...RETRY,
  parameters: { operation: "addLabels", messageId: "={{ $('Failure notice').item.json.email.messageId }}", labelIds: "={{ [$('Failure notice').item.json.email.labelIds.failed] }}" },
});
w.link(replyFail, labelF);
w.link(ifFileProblem, labelF, 1);

const alertBody = w.node(code("Operator alert", [3080, 400], `
const s = $('Route result').item.json;
const subject = 'OSAKA ' + (s.route === 'quarantined' ? 'quarantined' : 'failed') + ': ' + (s.email?.fileName || 'attachment') + ' from ' + (s.email?.senderEmail || '?');
const html = '<p><b>' + subject + '</b></p><p>Reason: ' + String(s.reason || s.error || 'unknown').replace(/</g, '&lt;') + '</p>' + (s.dashboardUrl ? '<p><a href="' + s.dashboardUrl.replace('host.docker.internal', 'localhost') + '">Open in OSAKA inbox</a></p>' : '');
return [{ json: { subject, html } }];`, "runOnceForEachItem"));
w.link(labelQ, alertBody);
w.link(labelF, alertBody);

const alert = w.node({
  name: "Email operator",
  type: "n8n-nodes-base.gmail",
  typeVersion: 2.1,
  position: [3300, 400],
  credentials: CRED.gmailOAuth2,
  ...RETRY,
  parameters: {
    operation: "send",
    sendTo: "={{ $env.OSAKA_OPERATOR_EMAIL }}",
    subject: "={{ $json.subject }}",
    emailType: "html",
    message: "={{ $json.html }}",
    options: { appendAttribution: false },
  },
});
w.link(alertBody, alert);
w.link(alert, loop);

fs.mkdirSync("workflows", { recursive: true });
// Every workflow reports failures to the error workflow (works whether or not it is active).
const wfId = (name) => crypto.createHash("md5").update(name).digest("base64url").slice(0, 16);
const ERROR_WF = "OSAKA — Error alert";
const ERROR_WF_ID = wfId(ERROR_WF);

fs.writeFileSync(
  "workflows/osaka-email-pdf.json",
  JSON.stringify(w.build({ errorWorkflow: ERROR_WF_ID }), null, 2),
);

/* ───────────────────────────── Error workflow ─────────────────────────────
 * Always writes a local error log (/inbox/results/_errors) so failures are visible with no
 * Google setup; additionally emails the operator once OSAKA_OPERATOR_EMAIL + Gmail are configured.
 */
const e = workflow(ERROR_WF);
const et = e.node({ name: "Error Trigger", type: "n8n-nodes-base.errorTrigger", typeVersion: 1, position: [0, 0] });

const errLog = e.node(code("Error record", [220, 0], `
const j = $json;
const at = new Date().toISOString();
const rec = {
  at,
  workflow: j.workflow?.name,
  node: j.execution?.lastNodeExecuted,
  error: j.execution?.error?.message || j.trigger?.error?.message || 'unknown',
  execution: String(j.execution?.url || '').replace('host.docker.internal', 'localhost'),
  recovery: 'Nothing is lost: the PDF stays in inbox and the sweeper retries it within 10 minutes; emails keep the OSAKA/Inbox label and are retried on the next poll.',
};
const name = at.replace(/[:.]/g, '-') + '.json';
return [{ json: rec, binary: { data: { data: Buffer.from(JSON.stringify(rec, null, 2)).toString('base64'), mimeType: 'application/json', fileName: name } } }];`));
e.link(et, errLog);

const errWrite = e.node({
  name: "Write error log",
  type: "n8n-nodes-base.readWriteFile",
  typeVersion: 1,
  position: [440, 0],
  parameters: { operation: "write", fileName: "=/inbox/results/_errors/{{ $binary.data.fileName }}", dataPropertyName: "data", options: {} },
});
e.link(errLog, errWrite);

const ifMail = e.node({
  name: "Email configured?",
  type: "n8n-nodes-base.if",
  typeVersion: 2.2,
  position: [660, 0],
  parameters: { conditions: { options: { caseSensitive: true, typeValidation: "loose", version: 2 }, combinator: "and",
    conditions: [{ id: id("opmail"), leftValue: "={{ $env.OSAKA_OPERATOR_EMAIL }}", rightValue: "", operator: { type: "string", operation: "notEmpty", singleValue: true } }] }, options: {} },
});
e.link(errLog, ifMail); // parallel to the log write, so the email gets the error record itself

// Email lives in its own workflow: n8n refuses to run ANY workflow containing a node with an unset
// credential, so a Gmail node here would also block the local log until Google is configured.
const ERROR_EMAIL_WF = "OSAKA — Error email";
const callMail = e.node({
  name: "Send error email",
  type: "n8n-nodes-base.executeWorkflow",
  typeVersion: 1.2,
  position: [880, -80],
  parameters: {
    source: "database",
    workflowId: { __rl: true, mode: "id", value: wfId(ERROR_EMAIL_WF) },
    options: { waitForSubWorkflow: false },
  },
});
e.link(ifMail, callMail, 0);

const m = workflow(ERROR_EMAIL_WF);
const mt = m.node({
  name: "Called by Error alert",
  type: "n8n-nodes-base.executeWorkflowTrigger",
  typeVersion: 1.1,
  position: [0, 0],
  parameters: { inputSource: "passthrough" },
});
const mm = m.node({
  name: "Email operator",
  type: "n8n-nodes-base.gmail",
  typeVersion: 2.1,
  position: [240, 0],
  credentials: CRED.gmailOAuth2,
  parameters: {
    operation: "send",
    sendTo: "={{ $env.OSAKA_OPERATOR_EMAIL }}",
    subject: "=OSAKA workflow error: {{ $json.workflow }}",
    emailType: "html",
    message: "=<p>The workflow <b>{{ $json.workflow }}</b> stopped at node <b>{{ $json.node }}</b>.</p><p>{{ $json.error }}</p><p><a href=\"{{ $json.execution }}\">Open the execution</a>. {{ $json.recovery }}</p>",
    options: { appendAttribution: false },
  },
});
m.link(mt, mm);
fs.writeFileSync("workflows/osaka-error-email.json", JSON.stringify(m.build(), null, 2));
fs.writeFileSync("workflows/osaka-error.json", JSON.stringify(e.build(), null, 2));

/* ──────────────────────── Local folder workflow (no Google) ────────────────────────
 * Drop a PDF into inbox/ (repo root) (mounted at /inbox). Results land in the
 * OSAKA dashboard and as <file>.json in inbox/results. Name a file
 * "<sender email>__<anything>.pdf" to attach it to that client; otherwise OSAKA_LOCAL_SENDER is used.
 *
 * Two entry points, one processing loop:
 *   - Watch: reacts to new files within seconds.
 *   - Sweeper (every 10 min): re-sends every PDF still in the folder. The app de-duplicates on the
 *     file hash, so finished files cost one DB lookup, while files that were missed (n8n was down)
 *     or failed (app/Ollama down) are processed again. This is the recovery path.
 */
const l = workflow("OSAKA — Local folder intake");

const SENDER_FROM_NAME = `
const senderOf = (fileName) => {
  const m = /^([^\\s_]+@[^\\s_]+\\.[a-z]{2,})__(.+)$/i.exec(fileName);
  return (m ? m[1] : ($env.OSAKA_LOCAL_SENDER || 'local-drop@osaka.local')).toLowerCase();
};`;

const watch = l.node({
  name: "Watch inbox",
  type: "n8n-nodes-base.localFileTrigger",
  typeVersion: 1,
  position: [0, 0],
  parameters: {
    triggerOn: "folder",
    path: "/inbox",
    events: ["add"],
    // Polling: Windows bind mounts don't deliver file-system events into Linux containers.
    options: { usePolling: true, awaitWriteFinish: true, depth: 0, ignored: "**/results/**" },
  },
});

const onlyPdf = l.node(code("Only PDFs", [220, 0], `${SENDER_FROM_NAME}
const out = [];
for (const it of $input.all()) {
  const p = String(it.json.path || '');
  const fileName = p.split('/').pop();
  if (!/\\.pdf$/i.test(fileName)) continue;
  out.push({ json: { path: p, fileName, senderEmail: senderOf(fileName), via: 'watch' } });
}
return out;`));
l.link(watch, onlyPdf);

const read = l.node({
  name: "Read PDF",
  type: "n8n-nodes-base.readWriteFile",
  typeVersion: 1,
  position: [440, 0],
  ...RETRY,
  parameters: { operation: "read", fileSelector: "={{ $json.path }}", options: { dataPropertyName: "file" } },
});
l.link(onlyPdf, read);

const attach = l.node(code("Attach file info", [660, 0], `
return $input.all().map((it, i) => ({ json: $('Only PDFs').all()[i].json, binary: it.binary }));`));
l.link(read, attach);

const sweep = l.node({
  name: "Sweeper (every 10 min)",
  type: "n8n-nodes-base.scheduleTrigger",
  typeVersion: 1.2,
  position: [0, 260],
  parameters: { rule: { interval: [{ field: "minutes", minutesInterval: 10 }] } },
});

const readAll = l.node({
  name: "Read all PDFs",
  type: "n8n-nodes-base.readWriteFile",
  typeVersion: 1,
  position: [220, 260],
  // An empty folder is not an error.
  onError: "continueRegularOutput",
  parameters: { operation: "read", fileSelector: "/inbox/*.pdf", options: { dataPropertyName: "file" } },
});
l.link(sweep, readAll);

const sweepInfo = l.node(code("Sweep file info", [440, 260], `${SENDER_FROM_NAME}
return $input.all()
  .filter((it) => it.binary?.file)
  .map((it) => {
    const fileName = it.binary.file.fileName || it.json.fileName;
    return { json: { path: '/inbox/' + fileName, fileName, senderEmail: senderOf(fileName), via: 'sweep' }, binary: it.binary };
  });`));
l.link(readAll, sweepInfo);

// Both entry points join here first: the loop node must have exactly one external parent,
// otherwise n8n never closes the loop and the execution stays "running" forever.
const queue = l.node({ name: "Queue", type: "n8n-nodes-base.noOp", typeVersion: 1, position: [880, 120] });
l.link(attach, queue);
l.link(sweepInfo, queue);

const lloop = l.node({ name: "One at a time", type: "n8n-nodes-base.splitInBatches", typeVersion: 3, position: [1100, 120], parameters: { batchSize: 1, options: {} } });
l.link(queue, lloop);
const finished = l.node({ name: "All done", type: "n8n-nodes-base.noOp", typeVersion: 1, position: [1320, -100] });
l.link(lloop, finished, 0);

const signLocal = l.node(code("Sign request (local)", [1320, 120], `${SIGN}
// Signed immediately before sending (±300 s window), one file at a time.
const src = $input.first().json;
const buf = await this.helpers.getBinaryDataBuffer(0, 'file');
const sha = crypto.createHash('sha256').update(buf).digest('hex');
const messageId = 'local:' + sha;
return [{ json: { ...src, messageId, senderAuth: 'pass', ...sign([messageId, sha, src.senderEmail, 'pass', 'local']) }, binary: $input.first().binary }];`));
l.link(lloop, signLocal, 1);

const procLocal = l.node({
  name: "OSAKA: process PDF",
  type: "n8n-nodes-base.httpRequest",
  typeVersion: 4.2,
  position: [1540, 120],
  // Connection failures (app restarting) retry; HTTP error codes come back as data (neverError).
  retryOnFail: true,
  maxTries: 3,
  waitBetweenTries: 5000,
  parameters: {
    method: "POST",
    url: "={{ $env.OSAKA_BASE_URL }}/api/ingest/process",
    sendHeaders: true,
    headerParameters: { parameters: [
      { name: "x-osaka-timestamp", value: "={{ $json.ts }}" },
      { name: "x-osaka-signature", value: "={{ $json.signature }}" },
    ] },
    sendBody: true,
    contentType: "multipart-form-data",
    bodyParameters: { parameters: [
      { parameterType: "formBinaryData", name: "file", inputDataFieldName: "file" },
      { name: "messageId", value: "={{ $json.messageId }}" },
      { name: "senderEmail", value: "={{ $json.senderEmail }}" },
      { name: "senderAuth", value: "pass" },
      { name: "source", value: "local" },
      { name: "subject", value: "=Local drop: {{ $json.fileName }}" },
      { name: "fileName", value: "={{ $json.fileName }}" },
    ] },
    options: { timeout: 300000, response: { response: { fullResponse: true, neverError: true } } },
  },
});
l.link(signLocal, procLocal);

const resultFile = l.node(code("Result file", [1760, 120], `
const src = $('Sign request (local)').first().json;
const res = $input.first().json;
const s = res.body || {};
const ok = res.statusCode === 200;
const result = ok
  ? { file: src.fileName, status: s.status, duplicate: s.duplicate, docType: s.docTypeLabel, confidence: s.confidence,
      fields: Object.fromEntries((s.fields || []).map((f) => [f.label, f.value])),
      missing: (s.missingFields || []).map((f) => f.label), warnings: s.warnings, reason: s.reason,
      dashboard: String(s.dashboardUrl || '').replace('host.docker.internal', 'localhost'),
      checkedAt: new Date().toISOString() }
  : { file: src.fileName, status: 'error', http: res.statusCode, error: s.error || 'OSAKA app unreachable — is npm run dev running on :3030?',
      retry: 'The sweeper retries this file within 10 minutes.', checkedAt: new Date().toISOString() };
// The sweeper re-checks finished files every 10 min; don't rewrite their result file each time.
const write = !(src.via === 'sweep' && ok && s.duplicate && s.status !== 'failed');
const name = src.fileName.replace(/\\.pdf$/i, '') + '.json';
return [{ json: { ...result, write }, binary: { data: { data: Buffer.from(JSON.stringify(result, null, 2)).toString('base64'), mimeType: 'application/json', fileName: name } } }];`));
l.link(procLocal, resultFile);

const ifWrite = l.node({
  name: "New result?",
  type: "n8n-nodes-base.if",
  typeVersion: 2.2,
  position: [1980, 120],
  parameters: { conditions: { options: { caseSensitive: true, typeValidation: "loose", version: 2 }, combinator: "and",
    conditions: [{ id: id("write"), leftValue: "={{ $json.write }}", rightValue: true, operator: { type: "boolean", operation: "true", singleValue: true } }] }, options: {} },
});
l.link(resultFile, ifWrite);

const writeResult = l.node({
  name: "Write result JSON",
  type: "n8n-nodes-base.readWriteFile",
  typeVersion: 1,
  position: [2200, 40],
  ...RETRY,
  parameters: { operation: "write", fileName: "=/inbox/results/{{ $binary.data.fileName }}", dataPropertyName: "data", options: {} },
});
l.link(ifWrite, writeResult, 0);
l.link(writeResult, lloop);
l.link(ifWrite, lloop, 1);

fs.writeFileSync("workflows/osaka-local-folder.json", JSON.stringify(l.build({ errorWorkflow: ERROR_WF_ID }), null, 2));
console.log(`Wrote workflows/osaka-email-pdf.json, osaka-error.json (${ERROR_WF_ID}), osaka-error-email.json, osaka-local-folder.json`);
