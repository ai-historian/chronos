// Import pipeline tests. The PDF path renders through the real worker scripts
// emitted by esbuild into out/ — `npm test` runs `npm run build` first (pretest).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, statSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { PDFDocument, rgb } from "pdf-lib";
import { importFiles, findIncompleteImports, resumeIncompleteImports, renderPdfFile, type ProgressSink } from "../src/main/import/import";
import { writeImportMarker } from "../src/main/import/import-status";

const OUT = join(__dirname, "..", "out");
const workers = { pdf: join(OUT, "pdf-worker.js"), split: join(OUT, "pdf-split-worker.js") };
const TIMEOUT = { timeout: 30_000 };

async function makePdf(path: string, pages: number): Promise<void> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([200, 300]);
    page.drawRectangle({ x: 20, y: 20, width: 100 + i * 20, height: 120, color: rgb(0.6, 0.3, 0.1) });
  }
  writeFileSync(path, await doc.save());
}

function withTmp(fn: (dir: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "chronos-import-"));
    try {
      await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test("importFiles renders a 2-page pdf to page_0001/0002.png", TIMEOUT, withTmp(async (dir) => {
  const pdf = join(dir, "Letters.pdf");
  await makePdf(pdf, 2);
  const sourcesDir = join(dir, "sources");
  mkdirSync(sourcesDir);
  const res = await importFiles([pdf], sourcesDir, workers, () => {});
  assert.deepEqual(res, { imported: 1, skipped: [], errors: [] });
  const src = join(sourcesDir, "Letters");
  for (const p of ["page_0001.png", "page_0002.png"]) {
    const f = join(src, "png", p);
    assert.ok(existsSync(f), p);
    assert.ok(statSync(f).size > 0, `${p} non-empty`);
  }
  assert.ok(!existsSync(join(src, ".png.partial")), "no .png.partial left");
  assert.ok(!existsSync(join(src, ".importing.json")), "no marker left");
}));

test("findIncompleteImports surfaces partial", TIMEOUT, withTmp(async (dir) => {
  const src = join(dir, "X");
  mkdirSync(join(src, ".png.partial"), { recursive: true });
  writeFileSync(join(src, ".png.partial", "page_0001.png"), "png");
  writeImportMarker(src, { source: "X", sourceFile: join(dir, "X.pdf"), dpi: 200, startedAt: new Date().toISOString(), expectedPages: 3 });
  const found = findIncompleteImports(dir);
  assert.equal(found.length, 1);
  assert.equal(found[0].name, "X");
  assert.equal(found[0].renderedPages, 1);
  assert.equal(found[0].marker.expectedPages, 3);
}));

test("progress sink receives done==total at end", TIMEOUT, withTmp(async (dir) => {
  const pdf = join(dir, "Ledger.pdf");
  await makePdf(pdf, 3);
  const sourcesDir = join(dir, "sources");
  mkdirSync(sourcesDir);
  const events: Parameters<ProgressSink>[0][] = [];
  const res = await importFiles([pdf], sourcesDir, workers, (p) => events.push(p));
  assert.equal(res.imported, 1);
  assert.ok(events.length > 0);
  const ids = new Set(events.map((e) => e.id));
  assert.equal(ids.size, 1, "one progress id per run");
  assert.match([...ids][0], /^import-\d+/);
  const last = events[events.length - 1];
  assert.equal(last.finished, true);
  assert.ok(last.total !== undefined);
  assert.equal(last.done, last.total);
  assert.equal(events.filter((e) => e.finished).length, 1, "finished sent once");
}));

test("importFiles skips unsupported and reports errors", TIMEOUT, withTmp(async (dir) => {
  const docx = join(dir, "notes.docx");
  writeFileSync(docx, "not supported");
  const bad = join(dir, "Broken.pdf");
  writeFileSync(bad, randomBytes(4096));
  const sourcesDir = join(dir, "sources");
  mkdirSync(sourcesDir);
  const res = await importFiles([docx, bad], sourcesDir, workers, () => {});
  assert.equal(res.imported, 0);
  assert.deepEqual(res.skipped, ["notes.docx"]);
  assert.equal(res.errors.length, 1);
  assert.match(res.errors[0], /Broken/);
  const src = join(sourcesDir, "Broken");
  assert.ok(!existsSync(join(src, ".png.partial")), "no partial dir left");
  // The docx never creates a source dir.
  assert.ok(!readdirSync(sourcesDir).includes("notes"));
}));

test("resumeIncompleteImports finishes a partial import and renames .png.partial to png", TIMEOUT, withTmp(async (dir) => {
  const pdf = join(dir, "Diary.pdf");
  await makePdf(pdf, 2);
  const sourcesDir = join(dir, "sources");
  const src = join(sourcesDir, "Diary");
  mkdirSync(join(src, ".png.partial"), { recursive: true });
  // A page already rendered before the "crash" is kept (the worker skips existing PNGs).
  writeFileSync(join(src, ".png.partial", "page_0001.png"), "kept");
  writeImportMarker(src, { source: "Diary", sourceFile: pdf, dpi: 200, startedAt: new Date().toISOString(), expectedPages: 2 });
  const incompletes = findIncompleteImports(sourcesDir);
  assert.equal(incompletes.length, 1);
  const res = await resumeIncompleteImports(incompletes, sourcesDir, workers, () => {});
  assert.deepEqual(res, { imported: 1, skipped: [], errors: [] });
  assert.deepEqual(readdirSync(join(src, "png")).sort(), ["page_0001.png", "page_0002.png"]);
  assert.equal(statSync(join(src, "png", "page_0001.png")).size, 4, "pre-rendered page not re-rendered");
  assert.ok(!existsSync(join(src, ".png.partial")));
  assert.ok(!existsSync(join(src, ".importing.json")));
  assert.deepEqual(findIncompleteImports(sourcesDir), []);
}));

// Fake pdf worker: the batch starting at page 0 fails fast; every other batch keeps
// posting progress for ~1 s. Exercises the pool's failure path without a real render.
const FAKE_WORKER = `
const { workerData, parentPort } = require("node:worker_threads");
const { startPage, endPage } = workerData;
if (startPage === 0) {
  setTimeout(() => { parentPort.postMessage({ type: "error", message: "injected failure" }); process.exit(1); }, 50);
} else {
  let i = startPage;
  const t = setInterval(() => {
    parentPort.postMessage({ type: "progress", page: i + 1 });
    if (++i >= endPage) { clearInterval(t); parentPort.postMessage({ type: "done" }); }
  }, 20);
}
`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("renderPdfFile terminates sibling workers on first failure", TIMEOUT, withTmp(async (dir) => {
  const fake = join(dir, "fake-worker.js");
  writeFileSync(fake, FAKE_WORKER);
  let calls = 0;
  await assert.rejects(renderPdfFile(fake, join(dir, "x.pdf"), dir, 200, 0, () => void calls++), /injected failure/);
  const atReject = calls;
  await sleep(500);
  assert.equal(calls, atReject, "no progress from orphaned workers after rejection");
}));

test("no progress event arrives after finished (failing multi-batch import)", TIMEOUT, withTmp(async (dir) => {
  const fake = join(dir, "fake-worker.js");
  writeFileSync(fake, FAKE_WORKER);
  const pdf = join(dir, "Big.pdf");
  await makePdf(pdf, 200); // 4 batches -> 4 concurrent workers
  const sourcesDir = join(dir, "sources");
  const events: Parameters<ProgressSink>[0][] = [];
  const res = await importFiles([pdf], sourcesDir, { pdf: fake, split: workers.split }, (p) => events.push(p));
  assert.equal(res.errors.length, 1);
  await sleep(500);
  assert.equal(events.filter((e) => e.finished).length, 1);
  assert.equal(events[events.length - 1].finished, true, "finished is the last event");
}));

test("corrupt pdf: finished is the last progress event", TIMEOUT, withTmp(async (dir) => {
  const bad = join(dir, "Broken.pdf");
  writeFileSync(bad, randomBytes(4096));
  const events: Parameters<ProgressSink>[0][] = [];
  const res = await importFiles([bad], join(dir, "sources"), workers, (p) => events.push(p));
  assert.equal(res.errors.length, 1);
  await sleep(500);
  assert.equal(events[events.length - 1].finished, true);
  assert.equal(events.filter((e) => e.finished).length, 1);
}));
