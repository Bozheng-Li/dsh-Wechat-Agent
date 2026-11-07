import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { setImmediate as yieldNow } from 'node:timers/promises';
import { WorkbenchStore, atomicFeatureJson, digest, fail } from '../workbench/store.mjs';
import { KNOWLEDGE_LIMITS } from './request.mjs';

const require = createRequire(import.meta.url);
const VERSION = 1;
const stops = new Set([
  '一下',
  '什么',
  '怎么',
  '如何',
  '是否',
  '可以',
  '帮我',
  '我们',
  '你们',
  '请问',
  '这个',
  '那个',
  '哪些',
  '多少',
  '多久',
  '一下',
  'the',
  'a',
  'an',
  'and',
  'or',
  'for',
  'of',
  'to',
  'in',
  'is',
  'are',
  'what',
  'how',
  'please',
]);
export function knowledgeTerms(text, query = false) {
  const values = [];
  for (const match of String(text)
    .normalize('NFKC')
    .toLowerCase()
    .matchAll(/[\p{Script=Han}]+|(?:(?!\p{Script=Han})[\p{L}\p{N}])+(?:[._-](?:(?!\p{Script=Han})[\p{L}\p{N}])+)*/gu)) {
    const token = match[0];
    if (/^\p{Script=Han}+$/u.test(token)) {
      const chars = [...token];
      if (chars.length === 1) values.push(token);
      else for (let i = 0; i < chars.length - 1; i++) values.push(chars[i] + chars[i + 1]);
    } else if (token.length <= 120) values.push(token);
  }
  return query ? [...new Set(values.filter((value) => !stops.has(value)))].slice(0, 24) : values;
}
function sqlite() {
  try {
    return require('node:sqlite').DatabaseSync;
  } catch {
    fail(
      'KNOWLEDGE_INDEX_RUNTIME',
      '当前宿主缺少本地全文索引组件，请使用支持 Node 22.18 及以上的完整 DSH；原文仍可阅读'
    );
  }
}
function regular(file) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink())
    fail('WORKBENCH_STORAGE_INVALID', '知识索引含重定向或异常文件，已停止读取和写入');
}
const folded = (text) => text.normalize('NFKD').toLowerCase().replace(/\p{M}/gu, '');
function excerpt(text, query, matchedTokens) {
  if (text.length <= KNOWLEDGE_LIMITS.chunkChars) return { text, truncated: false };
  // FTS may match a stem (refund/refunds) or folded spelling. Use its actual
  // stored matches, then map normalized offsets back to the unchanged source.
  const offsets = [];
  let body = '',
    offset = 0;
  for (const character of text) {
    const normalized = folded(character);
    body += normalized;
    for (let i = 0; i < normalized.length; i++) offsets.push(offset);
    offset += character.length;
  }
  const terms = [...String(matchedTokens || '').matchAll(/\u0001([^\u0002]+)\u0002/gu)]
    .flatMap((match) => match[1].split(/\s+/u))
    .map(folded);
  let at = body.indexOf(folded(query));
  if (at < 0)
    at =
      [...new Set(terms)]
        .map((term) => body.indexOf(term))
        .filter((index) => index >= 0)
        .sort((a, b) => a - b)[0] ?? 0;
  let start = Math.max(0, Math.min(text.length - KNOWLEDGE_LIMITS.chunkChars, (offsets[at] || 0) - 160));
  if (/[\uDC00-\uDFFF]/u.test(text[start])) start--;
  let end = start + KNOWLEDGE_LIMITS.chunkChars;
  if (/[\uDC00-\uDFFF]/u.test(text[end])) end--;
  return { text: text.slice(start, end), truncated: true };
}

export class KnowledgeIndex {
  constructor(store, { now = Date.now } = {}) {
    this.store = store;
    this.disk = new WorkbenchStore(store, 'knowledge-index');
    this.now = now;
    this.builds = new Map();
    this.identities = new WeakMap();
  }
  identity(data) {
    if (this.identities.has(data)) return this.identities.get(data);
    const value = {
      version: VERSION,
      accountId: data.accountId,
      ownerStoreId: data.ownerStoreId,
      fingerprint: digest(data.documents.map((doc) => [doc.id, doc.libraryId, doc.sha256, doc.title, doc.chunks])),
    };
    if (Object.isFrozen(data)) this.identities.set(data, value);
    return value;
  }
  paths(accountId) {
    const file = this.disk.path(accountId).replace(/\.json$/, '.sqlite'),
      metadata = file + '.meta.json';
    for (const name of [file, metadata, file + '-journal', file + '-wal', file + '-shm']) regular(name);
    return { file, metadata };
  }
  invalidate(accountId) {
    const { file, metadata } = this.paths(accountId);
    for (const target of [metadata, file + '-journal', file + '-wal', file + '-shm', file]) {
      try {
        fs.unlinkSync(target);
      } catch (error) {
        if (error.code !== 'ENOENT')
          fail('KNOWLEDGE_INDEX_DELETE', '旧索引未能清理，原文尚未删除；请检查目录权限后重试');
      }
    }
  }
  status(data) {
    const expected = this.identity(data),
      { file, metadata } = this.paths(data.accountId);
    let saved;
    try {
      if (fs.existsSync(metadata) && fs.statSync(metadata).size < 8192)
        saved = JSON.parse(fs.readFileSync(metadata, 'utf8'));
    } catch {}
    const ready =
      fs.existsSync(file) &&
      saved?.version === VERSION &&
      saved?.accountId === data.accountId &&
      saved?.ownerStoreId === data.ownerStoreId &&
      saved?.fingerprint === expected.fingerprint;
    return {
      engine: 'SQLite FTS5 / BM25',
      embeddings: false,
      state: this.builds.has(data.accountId) ? 'building' : ready ? 'ready' : 'pending',
      documents: ready ? saved.documents : 0,
      chunks: ready ? saved.chunks : 0,
      builtAt: ready ? saved.builtAt : null,
    };
  }
  async ensure(data, signal, assertCurrent = () => {}, force = false) {
    signal?.throwIfAborted();
    assertCurrent();
    if (!force && this.status(data).state === 'ready') return this.identity(data);
    const previous = this.builds.get(data.accountId);
    const job = (async () => {
      if (previous) await previous.catch(() => {});
      signal?.throwIfAborted();
      assertCurrent();
      if (!force && this.status(data).builtAt) return this.identity(data);
      // SQLite's Windows VFS has a shorter filename budget than Node's fs.
      // Appending a UUID to the full account digest can exceed that budget even
      // when the published index fits. Keep the unique staging name short and
      // on the same filesystem so publication is still one atomic rename.
      const Database = sqlite(),
        target = this.paths(data.accountId),
        temporary = path.join(path.dirname(target.file), 'idx-' + randomUUID() + '.tmp');
      fs.closeSync(fs.openSync(temporary, 'wx', 0o600));
      const expected = this.identity(data);
      let db,
        count = 0;
      try {
        db = new Database(temporary);
        // This disposable index is built in an unpublished temporary file. The
        // durable originals remain authoritative; corrupt indexes are rebuilt.
        // Avoid disk fsync on every derived-table transaction in the chat loop.
        db.exec(
          "PRAGMA synchronous = OFF; PRAGMA journal_mode = MEMORY; PRAGMA max_page_count = 65536; CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT; CREATE VIRTUAL TABLE lookup USING fts5(title_tokens, body_tokens, document_id UNINDEXED, library_id UNINDEXED, chunk_id UNINDEXED, label UNINDEXED, title UNINDEXED, text UNINDEXED, tokenize='porter unicode61 remove_diacritics 2'); BEGIN IMMEDIATE;"
        );
        const insert = db.prepare(
          'INSERT INTO lookup(title_tokens, body_tokens, document_id, library_id, chunk_id, label, title, text) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        );
        for (const doc of data.documents)
          for (const chunk of doc.chunks) {
            signal?.throwIfAborted();
            insert.run(
              knowledgeTerms(doc.title + ' ' + chunk.label).join(' '),
              knowledgeTerms(chunk.text).join(' '),
              doc.id,
              doc.libraryId,
              chunk.id,
              chunk.label,
              doc.title,
              chunk.text
            );
            if (++count % 32 === 0) await yieldNow();
          }
        db.prepare('INSERT INTO metadata(key, value) VALUES (?, ?)').run('identity', JSON.stringify(expected));
        // FTS maintains its segments during insertion. A full synchronous
        // optimize here can block unrelated messages for seconds on large KBs.
        db.exec('COMMIT;');
        db.close();
        db = null;
        signal?.throwIfAborted();
        assertCurrent();
        this.paths(data.accountId);
        fs.renameSync(temporary, target.file);
        atomicFeatureJson(target.metadata, {
          ...expected,
          builtAt: this.now(),
          documents: data.documents.length,
          chunks: count,
        });
        return expected;
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        if (error?.code?.startsWith('KNOWLEDGE_') || error?.code?.startsWith('WORKBENCH_')) throw error;
        fail('KNOWLEDGE_INDEX_BUILD', '本地全文索引未建成，原文保留；请检查磁盘空间后重建索引');
      } finally {
        try {
          db?.close();
        } catch {}
        for (const file of [temporary, temporary + '-journal']) {
          try {
            regular(file);
            fs.unlinkSync(file);
          } catch {}
        }
      }
    })();
    this.builds.set(data.accountId, job);
    try {
      return await job;
    } finally {
      if (this.builds.get(data.accountId) === job) this.builds.delete(data.accountId);
    }
  }
  async search(data, { query, libraryIds, limit = KNOWLEDGE_LIMITS.maxChunks }, signal, assertCurrent) {
    const terms = knowledgeTerms(query, true);
    if (!terms.length) fail('KNOWLEDGE_QUERY_EMPTY', '请提供具体关键词，例如“退款期限”');
    if (!libraryIds.length) return [];
    await this.ensure(data, signal, assertCurrent);
    const run = () => {
      const Database = sqlite();
      let db;
      try {
        db = new Database(this.paths(data.accountId).file, { readOnly: true });
        const stored = JSON.parse(db.prepare("SELECT value FROM metadata WHERE key = 'identity'").get()?.value || '{}');
        if (JSON.stringify(stored) !== JSON.stringify(this.identity(data)))
          fail('KNOWLEDGE_INDEX_STALE', '本地索引已过期，需要重建');
        const match = terms.map((term) => '"' + term.replaceAll('"', '""') + '"').join(' OR ');
        return db
          .prepare(
            `SELECT document_id, library_id, chunk_id, label, title, text, highlight(lookup, 1, char(1), char(2)) AS matched_tokens FROM lookup WHERE lookup MATCH ? AND library_id IN (${libraryIds.map(() => '?').join(',')}) ORDER BY bm25(lookup, 4.0, 1.0), document_id, chunk_id LIMIT 24`
          )
          .all(match, ...libraryIds);
      } finally {
        db?.close();
      }
    };
    let rows;
    try {
      rows = run();
    } catch (error) {
      if (error?.code === 'WORKBENCH_STORAGE_INVALID' || error?.code === 'KNOWLEDGE_INDEX_RUNTIME') throw error;
      await this.ensure(data, signal, assertCurrent, true);
      try {
        rows = run();
      } catch {
        fail('KNOWLEDGE_INDEX_READ', '本地全文索引无法读取，请检查磁盘后重建；未返回不完整结果');
      }
    }
    signal?.throwIfAborted();
    assertCurrent?.();
    const results = [],
      seen = new Set();
    let chars = 0;
    for (const row of rows) {
      const value = excerpt(row.text, query, row.matched_tokens),
        key = digest(value.text);
      if (seen.has(key) || chars + value.text.length > KNOWLEDGE_LIMITS.maxChars) continue;
      seen.add(key);
      chars += value.text.length;
      results.push({
        documentId: row.document_id,
        libraryId: row.library_id,
        chunkId: row.chunk_id,
        title: row.title,
        label: row.label,
        citation: `${row.title} · ${row.label} · 段落 ${row.chunk_id}`,
        ...value,
      });
      if (results.length >= limit) break;
    }
    return results;
  }
}
