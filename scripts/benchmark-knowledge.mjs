// Explicit, local capacity check. Uses generated documents and no providers,
// credentials, production state, models, or WeChat transport.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { StateStore } from '../lib/testing.js';
import { KnowledgeLibrary, documentChunks } from '../src/features/knowledge/library.mjs';
import { digest, scopeKey } from '../src/features/workbench/store.mjs';

const repo = path.resolve(import.meta.dirname, '..'), base = path.join(repo, 'storage/tmp');
fs.mkdirSync(base, { recursive: true });
const root = fs.mkdtempSync(path.join(base, 'knowledge-capacity-'));
const reportPath = process.argv[2] ? path.resolve(process.argv[2]) : path.join(repo, 'storage/logs/knowledge-capacity.json');
const report = { at: new Date().toISOString(), node: process.version, platform: process.platform, documents: 150, sourceChars: 8000000, modelCalls: 0, networkCalls: 0 };
const rounded = value => Math.round(value * 100) / 100;
const elapsed = start => rounded(performance.now() - start);
let sample, loop;
try {
  const store = new StateStore(root), accountId = 'capacity-fixture', scope = { accountId, chatType: 'group', peerId: 'capacity@chatroom' };
  store.configure(accountId, { enabled: true, groups: [scope.peerId, 'other@chatroom'], privatePeers: [], prompt: '' });
  const kb = new KnowledgeLibrary(store);
  const lib = kb.configure(accountId, { title: '容量验证', description: '', scopes: [scopeKey(scope)], enabled: true, revision: 0 }).libraries[0];
  const data = kb.disk.load(accountId); data.settings = { enabled: true, mode: 'explicit' };
  for (let i = 0, remaining = report.sourceChars; i < report.documents; i++) {
    const chars = Math.ceil(remaining / (report.documents - i)); remaining -= chars;
    const anchor = ` BENCH${String(i).padStart(4, '0')}：合成产品退款期限为七天，详情见本段原文。 `;
    const background = Array.from({ length: 36 }, (_, j) => `第${j}节 产品${i}功能说明与使用步骤，订单服务记录 ITEM${i}V${j}。`).join('\n');
    const text = (background.repeat(Math.ceil(chars / background.length)).slice(0, 25000) + anchor + background.repeat(Math.ceil(chars / background.length))).slice(0, chars);
    data.documents.push({ id: `fixture-document-${i}`, libraryId: lib.id, title: `合成文档${i}.md`, sha256: digest(text), bytes: Buffer.byteLength(text), chars, importedAt: Date.now(), chunks: documentChunks([{ label: '正文', text }]) });
  }
  kb.disk.save(data);
  report.chunks = data.documents.reduce((sum, doc) => sum + doc.chunks.length, 0);
  const original = fs.readFileSync(kb.disk.path(accountId));
  report.sourceBytes = original.length;
  report.rssBeforeMiB = rounded(process.memoryUsage().rss / 1048576);
  let peak = process.memoryUsage().rss;
  sample = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 10);
  loop = monitorEventLoopDelay({ resolution: 10 }); loop.enable(); await delay(25);
  const query = () => kb.search(accountId, { query: 'BENCH0149', scope }, new AbortController().signal);
  let start = performance.now(); const cold = await query(); report.coldQueryMs = elapsed(start);
  assert(cold.found && cold.results.some(row => row.title === '合成文档149.md' && row.text.includes('BENCH0149')));
  report.warmQueryMs = [];
  for (let i = 0; i < 12; i++) {
    start = performance.now(); const found = await query(); report.warmQueryMs.push(elapsed(start));
    assert(found.found && found.results.length <= 4 && found.chars <= 3000 && found.results.every(row => row.text.length <= 750));
    await delay(5);
  }
  const sorted = [...report.warmQueryMs].sort((a, b) => a - b);
  report.warmMedianMs = sorted[Math.floor(sorted.length / 2)]; report.warmP95Ms = sorted[Math.ceil(sorted.length * 0.95) - 1];
  const denied = await kb.search(accountId, { query: 'BENCH0149', scope: { ...scope, peerId: 'other@chatroom' } }, new AbortController().signal);
  assert.equal(denied.found, false);
  report.indexBytes = fs.statSync(kb.index.paths(accountId).file).size;
  const controller = new AbortController(); start = performance.now(); let requestedAt;
  const timer = setTimeout(() => { requestedAt = performance.now(); controller.abort(new Error('capacity-cancel')); }, 25);
  try { await assert.rejects(kb.rebuild(accountId, controller.signal), /capacity-cancel/u); }
  finally { clearTimeout(timer); }
  report.cancelTimerDelayMs = rounded(requestedAt - start);
  report.cancelSettlementMs = rounded(performance.now() - requestedAt);
  assert.deepEqual(fs.readFileSync(kb.disk.path(accountId)), original);
  assert.equal(kb.list(accountId).index.state, 'ready');
  assert(fs.readdirSync(path.dirname(kb.index.paths(accountId).file)).every(name => !name.includes('.tmp')));
  await delay(25);
  report.eventLoopMaxMs = rounded(loop.max / 1e6); report.eventLoopP95Ms = rounded(loop.percentile(95) / 1e6);
  report.peakRssMiB = rounded(Math.max(peak, process.memoryUsage().rss) / 1048576);
  report.passed = true;
} catch (error) {
  report.passed = false; report.error = error.stack; process.exitCode = 1;
} finally {
  clearInterval(sample); loop?.disable();
  fs.mkdirSync(path.dirname(reportPath), { recursive: true }); fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  const resolved = fs.realpathSync(root), parent = fs.realpathSync(base);
  assert.equal(path.dirname(resolved), parent); assert(path.basename(resolved).startsWith('knowledge-capacity-'));
  fs.rmSync(resolved, { recursive: true });
}
