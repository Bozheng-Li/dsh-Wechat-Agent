import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const registry = 'https://registry.npmjs.org/';
const deadline = Date.now() + (process.argv.includes('--wait') ? 600000 : 0);
let metadata, published;
do {
  const response = await fetch(registry + encodeURIComponent(manifest.name), {
    headers: { 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(30000),
  });
  assert(response.ok || response.status === 404, `npm registry returned HTTP ${response.status}`);
  metadata = await response.json(); published = metadata.versions?.[manifest.version];
  if (published || Date.now() >= deadline) break;
  await new Promise(resolve => setTimeout(resolve, 5000));
} while (true);
assert(published, `Version ${manifest.version} has not been published`);
assert.equal(published.name, manifest.name);
assert.equal(published.version, manifest.version);
assert.equal(published.dsh?.bundle?.patch, manifest.dsh.bundle.patch);
assert.deepEqual(published.engines, manifest.engines);
assert(!published.private && !published.devDependencies && !published.scripts);
const file = path.join(root, `release/${manifest.name}-${manifest.version}.tgz`);
const bytes = fs.readFileSync(file);
const integrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64');
assert.equal(published.dist?.integrity, integrity, 'The npm tarball does not match the audited local package');
const publishedAt = metadata.time?.[manifest.version];
assert(Number.isFinite(Date.parse(publishedAt)), 'Registry publication time is missing');
const report = { ok: true, name: manifest.name, version: manifest.version, publishedAt, latest: metadata['dist-tags']?.latest,
  registry, tarball: published.dist.tarball, integrity, bytes: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'), verifiedAt: new Date().toISOString() };
if (process.argv.includes('--write-index')) {
  const indexFile = path.join(root, 'market/index.json');
  const index = fs.existsSync(indexFile) ? JSON.parse(fs.readFileSync(indexFile, 'utf8'))
    : { format: 1, title: { en: 'WeChat Agent', zh: '微信 Agent 插件源' }, plugins: [] };
  assert.equal(index.format, 1); assert(Array.isArray(index.plugins));
  let plugin = index.plugins.find(item => item.name === manifest.name);
  if (!plugin) {
    plugin = { name: manifest.name, title: { en: 'WeChat Agent', zh: '微信 Agent' },
      description: { en: 'Personas, conversation and long-term memory, images and scheduled tasks for WeChat on Windows x64.',
        zh: 'Windows x64 微信插件：丰富人设、会话与长期记忆、图片理解、表情素材回复和定时任务。' },
      metadata: { keywords: ['wechat', '微信', '小胖', 'agent', 'memory', '定时任务'] }, versions: [] };
    index.plugins.push(plugin);
  }
  const entry = { version: manifest.version, publishTimestamp: Math.floor(Date.parse(publishedAt) / 1000),
    engines: { dsh: manifest.engines.dsh }, source: { type: 'npm', registry } };
  plugin.versions = [entry, ...plugin.versions.filter(item => item.version !== manifest.version)];
  fs.mkdirSync(path.dirname(indexFile), { recursive: true });
  fs.writeFileSync(indexFile, JSON.stringify(index, null, 2) + '\n');
  report.index = 'market/index.json';
}
fs.mkdirSync(path.join(root, 'storage/logs'), { recursive: true });
fs.writeFileSync(path.join(root, 'storage/logs/npm-release.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
