import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { WorkbenchStore } from "../modules/workbench/store.mjs";

function fixture(t) {
  const base = path.resolve('storage/tmp');
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'workbench-schema-'));
  const store = { root, data: { storeId: 'synthetic-schema-store' } };
  const disk = new WorkbenchStore(store, 'workbench');
  const accountId = 'synthetic-schema-owner';
  t.after(() => {
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved), fs.realpathSync(base));
    assert(path.basename(resolved).startsWith('workbench-schema-'));
    fs.rmSync(resolved, { recursive: true });
  });
  return { disk, accountId };
}

test('loading and updating a former workbench schema preserves all retired fields', t => {
  const { disk, accountId } = fixture(t);
  const legacy = {
    ...disk.load(accountId),
    revision: 7,
    libraries: [{ id: 'legacy-library', name: 'Archived local material', config: { enabled: true } }],
    documents: [{ id: 'legacy-document', libraryId: 'legacy-library', source: 'original.pdf', chunks: [{ text: 'Retain this original content.', page: 2 }] }],
    previousMetadata: { indexRevision: 3, nested: ['preserve', { checksum: 'old-checksum' }] },
  };
  const file = disk.path(accountId);
  const original = Buffer.from(JSON.stringify(legacy, null, 4));
  fs.writeFileSync(file, original);

  assert.deepEqual(disk.load(accountId), legacy);
  assert.deepEqual(disk.snapshot(accountId), legacy);
  assert.deepEqual(fs.readFileSync(file), original, 'read operations must not rewrite old data');

  const update = disk.load(accountId);
  update.diagnostics = { checks: [{ id: 'model', state: 'passed' }], at: 123 };
  const saved = disk.save(update);
  assert.equal(saved.revision, 8);
  const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const key of ['libraries', 'documents', 'previousMetadata']) {
    assert.deepEqual(persisted[key], legacy[key], key);
  }
  assert.deepEqual(persisted.diagnostics, update.diagnostics);
});

test('a current workbench file loads and saves without retired schema fields', t => {
  const { disk, accountId } = fixture(t);
  const initial = disk.load(accountId);
  assert.equal(Object.hasOwn(initial, 'libraries'), false);
  assert.equal(Object.hasOwn(initial, 'documents'), false);
  initial.summaries.push({ id: 'synthetic-summary', title: 'Current summary', todos: [] });
  disk.save(initial);

  const loaded = disk.load(accountId);
  assert.equal(loaded.summaries[0].title, 'Current summary');
  assert.equal(Object.hasOwn(loaded, 'libraries'), false);
  assert.equal(Object.hasOwn(loaded, 'documents'), false);
  loaded.recovery.push({ id: 'synthetic-draft', state: 'prepared', text: 'Current recovery draft' });
  disk.save(loaded);
  assert.equal(disk.load(accountId).recovery[0].state, 'prepared');
});

test('a stale current write cannot overwrite retained legacy data', t => {
  const { disk, accountId } = fixture(t);
  const initial = { ...disk.load(accountId), libraries: [{ id: 'legacy-library' }], documents: [{ id: 'legacy-document' }] };
  disk.save(initial);
  const stale = disk.load(accountId);
  const current = disk.load(accountId);
  current.documents[0].originalChecksum = 'preserved-concurrent-value';
  disk.save(current);
  const before = fs.readFileSync(disk.path(accountId));

  stale.diagnostics = { checks: [] };
  assert.throws(() => disk.save(stale), { code: 'WORKBENCH_CHANGED' });
  assert.deepEqual(fs.readFileSync(disk.path(accountId)), before);
});
