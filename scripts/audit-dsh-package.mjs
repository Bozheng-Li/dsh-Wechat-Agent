import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const tar = require('tar');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const file = process.argv[2] ? path.resolve(root, process.argv[2]) : path.join(root, `release/dsh-plugin-wechat-agent-${version}.tgz`);
const reportFile = process.argv[3] ? path.resolve(root, process.argv[3]) : path.join(root, 'storage/logs/dsh-plugin-package-audit.json');
const files = [];
const stickerManifest = JSON.parse(fs.readFileSync(path.join(root, 'assets/stickers/manifest.json'), 'utf8'));
const stickerFiles = new Map(stickerManifest.packs.flatMap(pack => pack.items.map(item => ['package/assets/stickers/' + item.file, item.id])));
const stickerMetadata = new Set(['package/assets/stickers/manifest.json', 'package/assets/stickers/' + stickerManifest.source.licenseFile]);
let packageManifest;
const reviewFiles = new Map([
  ['package/runtime/make_image_memory_thumbnail.py', fs.readFileSync(path.join(root, 'runtime/make_image_memory_thumbnail.py'))],
  ...['lib/index.js', 'lib/client.js', 'lib/worker.cjs', 'CHANGELOG.md'].map(name => ['package/' + name, fs.readFileSync(path.join(root, name))])
]);
await tar.t({ file, onentry(entry) {
  const name = entry.path;
  assert(name.startsWith('package/') && !name.includes('..') && !name.includes('\\'), `unsafe archive path: ${name}`);
  assert(!['SymbolicLink', 'Link'].includes(entry.type), 'tarball must be self-contained');
  assert(!/(^|\/)(?:storage|config|node_modules|__pycache__|\.git|\.venv)(\/|$)|\.(?:pyc|log|pem|key)$|SKILL\.md|testing\.js/.test(name), `unexpected private/development file: ${name}`);
  assert(!/^package\/runtime\/(?:read_knowledge_document\.py$|python\/Lib\/site-packages\/pypdf(?:[\/.-]|$))/i.test(name), `removed document parser/dependency is still bundled: ${name}`);
  assert(stickerFiles.has(name) || stickerMetadata.has(name) || /^package\/(?:runtime\/|licenses\/|lib\/(?:index\.js|client\.js|worker\.cjs)$|package\.json$|cordis\.patch\.yml$|README\.md$|LICENSE$|THIRD_PARTY_NOTICES\.md$|CHANGELOG\.md$)/.test(name), `undeclared release input: ${name}`);
  files.push(name);
  if (reviewFiles.has(name)) {
    const chunks = []; entry.on('data', chunk => chunks.push(chunk));
    entry.on('end', () => assert.equal(createHash('sha256').update(Buffer.concat(chunks)).digest('hex'), createHash('sha256').update(reviewFiles.get(name)).digest('hex'), `local review source mismatch: ${name}`));
  }
  if (stickerFiles.has(name) || stickerMetadata.has(name)) {
    const chunks = [];
    entry.on('data', chunk => chunks.push(chunk));
    entry.on('end', () => {
      const expected = stickerFiles.get(name) || createHash('sha256').update(fs.readFileSync(path.join(root, name.slice('package/'.length)))).digest('hex');
      assert.equal(createHash('sha256').update(Buffer.concat(chunks)).digest('hex'), expected, `built-in sticker mismatch: ${name}`);
    });
  }
  if (name === 'package/package.json') {
    const chunks = [];
    entry.on('data', chunk => chunks.push(chunk));
    entry.on('end', () => { packageManifest = JSON.parse(Buffer.concat(chunks).toString('utf8')); });
  }
} });
assert.equal(packageManifest?.name, 'dsh-plugin-wechat-agent');
assert.equal(packageManifest.version, version);
assert(!packageManifest.private && !packageManifest.scripts && !packageManifest.devDependencies, 'publish only the prepared standalone package');
assert.equal(packageManifest.publishConfig?.access, 'public');
assert.equal(packageManifest.publishConfig?.registry, 'https://registry.npmjs.org/');
assert(packageManifest.keywords?.includes('dsh-plugin'));
assert.equal(packageManifest.dsh?.bundle?.patch, './cordis.patch.yml');
for (const item of ['lib/index.js', 'lib/client.js', 'lib/worker.cjs', 'cordis.patch.yml', 'CHANGELOG.md', 'licenses/fast-xml-parser/LICENSE', 'licenses/zod/LICENSE', 'runtime/native_login_worker.py', 'runtime/prepare_reply_image.py', 'runtime/python/python.exe', 'runtime/wechat39-engine/WeChatWin.dll']) assert(files.includes(`package/${item}`), `missing: ${item}`);
for (const item of [...stickerFiles.keys(), ...stickerMetadata]) assert(files.includes(item), `missing built-in sticker: ${item}`);
for (const item of reviewFiles.keys()) assert(files.includes(item), `missing local reviewed source: ${item}`);
const digest = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
assert.equal(fs.readFileSync(file + '.sha256', 'utf8').split(' ')[0], digest);
const report = { ok: true, version, file, files: files.length, bytes: fs.statSync(file).size, sha256: digest, assertions: ['explicit release inputs only', 'no user data or credentials', 'no bytecode or test entry', 'standalone authentication runtime', 'public npm manifest with DSH bundle metadata', 'all built-in sticker bytes, provenance and license match', 'local bundles, image-memory helper and changelog match', 'removed document parser and PDF dependency absent', 'SHA-256 sidecar matches'], at: new Date().toISOString() };
fs.mkdirSync(path.dirname(reportFile), { recursive: true });
fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
