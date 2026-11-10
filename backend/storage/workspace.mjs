import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ChannelError, AGENT_WORKSPACE_NAME } from "../../shared/contracts.mjs";
import { absoluteDirectory, sameDirectory, withinDirectory, writableDirectory } from "./paths.mjs";
import { ConfigurationRepository } from '../config/repository.mjs';
import { recoverConfigurationTransaction } from '../config/transaction.mjs';

const LOCATION = 'location.json';
const MIGRATION_LOCK = '.workspace-migration.lock';
const STATE = path.join('storage', 'state', 'channel.json');
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const keyOf = (value) => (process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value));
const failure = (code, message) => new ChannelError(code, message);

function statIfPresent(file) {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

// Check ancestors too: a plain-looking leaf below a junction still redirects.
function plainPath(file, { directory = false, missing = false } = {}) {
  const absolute = path.resolve(file);
  let current = absolute,
    leaf;
  while (true) {
    const stat = statIfPresent(current);
    if (current === absolute) leaf = stat;
    if (stat?.isSymbolicLink())
      throw failure('WORKSPACE_PATH_LINK', '工作区或源数据目录包含重定向链接，未迁移；请选择普通文件夹');
    if (stat && current !== absolute && !stat.isDirectory())
      throw failure('INVALID_STORAGE_PATH', '工作区路径的上级位置不是文件夹');
    if (path.dirname(current) === current) break;
    current = path.dirname(current);
  }
  if (!leaf && !missing) throw failure('WORKSPACE_SOURCE_MISSING', '原数据目录或文件已不存在，未迁移；请先恢复原位置');
  if (leaf && !(directory ? leaf.isDirectory() : leaf.isFile()))
    throw failure('INVALID_STORAGE_PATH', directory ? '工作区位置不是普通文件夹' : '源数据不是普通文件，未迁移');
  return leaf;
}

function optionalBytes(file) {
  if (!plainPath(file, { missing: true })) return null;
  return fs.readFileSync(file);
}

function parseJson(bytes, code, message) {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw failure(code, message);
  }
}

function derived(root) {
  return {
    basePath: root,
    workspacePath: path.join(root, 'workspace'),
    recordsPath: path.join(root, 'storage/conversations'),
    memoryPath: path.join(root, 'storage/memory'),
    assetsPath: path.join(root, 'storage/assets'),
    tasksPath: path.join(root, 'storage/tasks'),
    loginPath: path.join(root, 'storage/private'),
    cachePath: path.join(root, 'storage/cache'),
  };
}

/** A missing pointer means first use; a broken pointer must never create an empty account. */
export function readWorkspaceLocation(bootstrap) {
  const base = absoluteDirectory(bootstrap, '工作区引导目录');
  try {
    plainPath(base, { directory: true, missing: true });
    const bytes = optionalBytes(path.join(base, LOCATION));
    if (!bytes) return base;
    const location = parseJson(
      bytes,
      'WORKSPACE_LOCATION_INVALID',
      '工作区位置记录损坏，未创建空数据；请保留 location.json 并恢复原工作区'
    );
    if (
      !object(location) ||
      location.version !== 1 ||
      typeof location.root !== 'string' ||
      (location.storeId !== undefined && (typeof location.storeId !== 'string' || !location.storeId))
    )
      throw failure('WORKSPACE_LOCATION_INVALID', '工作区位置记录格式不正确，未创建空数据；请检查 location.json');
    const root = absoluteDirectory(location.root, '工作区目录');
    plainPath(root, { directory: true });
    recoverConfigurationTransaction(root);
    const state = parseJson(
      optionalBytes(path.join(root, STATE)) || Buffer.alloc(0),
      'WORKSPACE_LOCATION_INVALID',
      '已设置的工作区状态文件无法读取，未切换到空数据；请恢复原目录'
    );
    if (
      !object(state) ||
      ![1, 2].includes(state.version) ||
      (state.configurationVersion !== 1 && !object(state.accounts)) ||
      (location.storeId !== undefined && state.storeId !== location.storeId)
    )
      throw failure('WORKSPACE_LOCATION_INVALID', '工作区状态与位置记录不匹配，未载入其他账号的数据');
    if (state.configurationVersion === 1) new ConfigurationRepository(root, state.storeId, state);
    return fs.realpathSync(root);
  } catch (error) {
    if (error instanceof ChannelError || (error?.name === 'ChannelError' && typeof error.code === 'string'))
      throw error;
    throw failure('WORKSPACE_LOCATION_INVALID', '工作区位置无法读取，未创建空数据；请检查原目录、磁盘和权限');
  }
}

/** Report the effective legacy locations until their data has actually moved. */
export function describeWorkspace(root, store) {
  const paths = derived(absoluteDirectory(root, '工作区目录')),
    settings = store?.storageSettings?.();
  const legacyPaths = new Map();
  const remember = (value, expected) => {
    if (typeof value === 'string' && value && !sameDirectory(value, expected))
      legacyPaths.set(keyOf(value), path.resolve(value));
  };
  remember(settings?.workspacePath, paths.workspacePath);
  remember(settings?.recordsPath, paths.recordsPath);
  for (const config of Object.values(store?.data?.conversationConfigs || {}))
    remember(config.recordsPath, paths.recordsPath);
  for (const metadata of Object.values(store?.data?.conversations || {})) {
    if (
      typeof metadata.directory === 'string' &&
      !withinDirectory(paths.recordsPath, metadata.directory) &&
      ![...legacyPaths.values()].some((directory) => withinDirectory(directory, metadata.directory))
    )
      legacyPaths.set(keyOf(metadata.directory), path.resolve(metadata.directory));
  }
  return {
    ...paths,
    workspacePath: settings?.workspacePath || paths.workspacePath,
    agentWorkspacePath: path.join(settings?.workspacePath || paths.workspacePath, AGENT_WORKSPACE_NAME),
    recordsPath: settings?.recordsPath || paths.recordsPath,
    legacyPaths: [...legacyPaths.values()],
  };
}

function syncDirectory(directory) {
  if (process.platform === 'win32') return;
  let descriptor;
  try {
    descriptor = fs.openSync(directory, 'r');
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EISDIR'].includes(error.code)) throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function atomicBytes(file, bytes) {
  plainPath(file, { missing: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(temporary, file);
        break;
      } catch (error) {
        if (process.platform !== 'win32' || attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code))
          throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * 2 ** attempt);
      }
    }
    syncDirectory(path.dirname(file));
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try {
      fs.unlinkSync(temporary);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

function sameBytes(left, right) {
  return left === null ? right === null : right !== null && left.equals(right);
}

function migrationLock(bootstrap, storeId) {
  const file = path.join(bootstrap, MIGRATION_LOCK),
    token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    let descriptor;
    try {
      plainPath(file, { missing: true });
      descriptor = fs.openSync(file, 'wx', 0o600);
      fs.writeFileSync(descriptor, JSON.stringify({ storeId, pid: process.pid, token }));
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      return () => {
        const bytes = optionalBytes(file);
        if (!bytes) return;
        const current = parseJson(bytes, 'WORKSPACE_MIGRATION_BUSY', '工作区迁移锁无法读取，请重新启用插件后检查目录');
        if (current.token === token) fs.unlinkSync(file);
      };
    } catch (error) {
      if (descriptor !== undefined) {
        try {
          fs.closeSync(descriptor);
        } catch {}
        try {
          fs.unlinkSync(file);
        } catch {}
      }
      if (error.code !== 'EEXIST') throw error;
      const owner = parseJson(
        optionalBytes(file) || Buffer.alloc(0),
        'WORKSPACE_MIGRATION_BUSY',
        '工作区迁移锁无法读取，请保留文件并重新启用插件'
      );
      if (!object(owner)) throw failure('WORKSPACE_MIGRATION_BUSY', '工作区迁移锁格式不正确，请保留文件并重新启用插件');
      let alive = true;
      if (Number.isInteger(owner.pid) && owner.pid > 0) {
        try {
          process.kill(owner.pid, 0);
        } catch (error) {
          alive = error.code !== 'ESRCH';
        }
      }
      if (owner.storeId !== storeId || alive)
        throw failure('WORKSPACE_MIGRATION_BUSY', '另一个工作区迁移尚未结束，请稍后重试');
      fs.unlinkSync(file);
    }
  }
  throw failure('WORKSPACE_MIGRATION_BUSY', '工作区迁移正在进行，请稍后重试');
}

function fingerprint(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
}

function fileDigest(file) {
  const hash = createHash('sha256'),
    buffer = Buffer.allocUnsafe(1024 * 1024);
  const descriptor = fs.openSync(file, 'r');
  try {
    let count;
    while ((count = fs.readSync(descriptor, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, count));
    return hash.digest('hex');
  } finally {
    fs.closeSync(descriptor);
  }
}

// Every copied source is checked again before publication, including directory
// listings. A concurrently changed workspace cannot become a mixed snapshot.
function copier(stage, excluded, backupRoot) {
  const sources = new Map();
  let conflict = 0;
  const names = (directory) =>
    fs
      .readdirSync(directory)
      .filter((name) => !excluded.has(keyOf(path.join(directory, name))))
      .sort();
  const retain = (target) => {
    const relative = path.relative(stage, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
      throw new Error('Invalid migration backup path');
    const backup = path.join(backupRoot, 'conflicts', String(++conflict), relative);
    fs.mkdirSync(path.dirname(backup), { recursive: true, mode: 0o700 });
    fs.renameSync(target, backup);
  };
  const copy = (source, target) => {
    const stat = statIfPresent(source),
      key = keyOf(source);
    if (!stat) throw failure('WORKSPACE_SOURCE_MISSING', '原工作区的数据文件已不存在，未切换位置');
    if (stat.isSymbolicLink())
      throw failure('WORKSPACE_PATH_LINK', '源数据中包含重定向链接，未迁移；请先将链接改为普通文件或文件夹');
    if (!stat.isDirectory() && !stat.isFile()) throw failure('INVALID_STORAGE_PATH', '源数据包含非常规文件，未迁移');
    const existing = statIfPresent(target);
    if (existing?.isSymbolicLink()) throw failure('WORKSPACE_PATH_LINK', '目标目录出现重定向链接，未切换工作区');
    if (stat.isDirectory()) {
      if (existing && !existing.isDirectory()) retain(target);
      fs.mkdirSync(target, { recursive: true, mode: 0o700 });
      const entries = names(source),
        previous = sources.get(key);
      if (previous && previous.entries?.join('\0') !== entries.join('\0'))
        throw failure('STORAGE_SOURCE_CHANGED', '源工作区文件在迁移期间发生变化，未切换位置；请稍后重试');
      sources.set(key, { file: source, entries });
      for (const name of entries) copy(path.join(source, name), path.join(target, name));
      return;
    }
    const before = fingerprint(stat),
      digest = fileDigest(source),
      previous = sources.get(key);
    if (previous && (previous.fingerprint !== before || previous.digest !== digest))
      throw failure('STORAGE_SOURCE_CHANGED', '源工作区文件在迁移期间发生变化，未切换位置；请稍后重试');
    sources.set(key, { file: source, fingerprint: before, digest });
    if (existing?.isFile() && existing.size === stat.size && fileDigest(target) === digest) return;
    if (existing) retain(target);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    let input, output;
    try {
      input = fs.openSync(source, 'r');
      if (fingerprint(fs.fstatSync(input)) !== before)
        throw failure('STORAGE_SOURCE_CHANGED', '源文件在复制前已变化，未切换工作区');
      output = fs.openSync(target, 'wx', stat.mode & 0o777);
      const buffer = Buffer.allocUnsafe(1024 * 1024),
        copied = createHash('sha256');
      let count;
      while ((count = fs.readSync(input, buffer, 0, buffer.length, null))) {
        copied.update(buffer.subarray(0, count));
        let offset = 0;
        while (offset < count) {
          const written = fs.writeSync(output, buffer, offset, count - offset, null);
          if (!written) throw new Error('Incomplete workspace write');
          offset += written;
        }
      }
      fs.fsyncSync(output);
      if (copied.digest('hex') !== digest || fingerprint(fs.fstatSync(input)) !== before)
        throw failure('STORAGE_SOURCE_CHANGED', '源工作区文件在复制期间发生变化，未切换位置；请稍后重试');
    } finally {
      if (input !== undefined) fs.closeSync(input);
      if (output !== undefined) fs.closeSync(output);
    }
    if (fileDigest(target) !== digest) throw failure('WORKSPACE_COPY_FAILED', '新工作区文件校验失败，原工作区仍保留');
    fs.utimesSync(target, stat.atime, stat.mtime);
  };
  return {
    copy,
    retain,
    verify() {
      for (const entry of sources.values()) {
        const stat = statIfPresent(entry.file);
        const changed =
          !stat ||
          stat.isSymbolicLink() ||
          (entry.entries
            ? !stat.isDirectory() || names(entry.file).join('\0') !== entry.entries.join('\0')
            : !stat.isFile() || fingerprint(stat) !== entry.fingerprint || fileDigest(entry.file) !== entry.digest);
        if (changed)
          throw failure('STORAGE_SOURCE_CHANGED', '源工作区在迁移期间发生变化，未切换位置；请停止其他写入后重试');
      }
    },
  };
}

function rewritePaths(value, mappings, field = '') {
  if (Array.isArray(value)) return value.map((item) => rewritePaths(item, mappings, field));
  if (object(value))
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewritePaths(item, mappings, key)]));
  if (
    typeof value !== 'string' ||
    !path.isAbsolute(value) ||
    !/^(?:file|path|directory|folder)$|(?:Path|Directory)$/.test(field)
  )
    return value;
  for (const mapping of mappings)
    if (withinDirectory(mapping.from, value)) return path.join(mapping.to, path.relative(mapping.from, value));
  return value;
}

function writeJson(file, value) {
  atomicBytes(file, Buffer.from(JSON.stringify(value, null, 2) + '\n'));
}

function removeStage(stage, parent, expected) {
  // Only this invocation's exclusively created sibling staging directory can
  // be removed. Completed targets and source directories are never deleted.
  if (!stage || !sameDirectory(path.dirname(stage), parent) || !path.basename(stage).includes('.wechat-agent-')) return;
  const current = statIfPresent(stage);
  if (
    !current ||
    current.isSymbolicLink() ||
    !current.isDirectory() ||
    current.dev !== expected.dev ||
    current.ino !== expected.ino
  )
    return;
  fs.rmSync(stage, { recursive: true, force: true });
}

/**
 * The caller drains scheduler/channel/worker before this synchronous copy, and
 * validates a new runtime before commit(). rollback() restores only the pointer;
 * both complete directories remain available. Never mutate the supplied store.
 */
export function migrateWorkspaceRoot({ bootstrap, store, targetRoot }) {
  if (!store?.root || !store.data?.storeId || typeof store._withSourceLocks !== 'function')
    throw failure('WORKSPACE_SOURCE_INVALID', '当前工作区尚未正常载入，不能迁移数据');
  const base = absoluteDirectory(bootstrap, '工作区引导目录'),
    source = absoluteDirectory(store.root, '原工作区目录');
  let target = absoluteDirectory(targetRoot, '工作区目录');
  plainPath(base, { directory: true });
  plainPath(source, { directory: true });
  plainPath(target, { directory: true, missing: true });
  if (!sameDirectory(readWorkspaceLocation(base), source))
    throw failure('WORKSPACE_LOCATION_CHANGED', '工作区位置已由其他实例修改，请重新启用插件后再迁移');
  const description = describeWorkspace(source, store);
  if (sameDirectory(source, target)) {
    if (description.legacyPaths.length)
      throw failure(
        'WORKSPACE_LEGACY_PATHS',
        '当前工作区仍有旧的独立保存位置；请选择新的空文件夹归并数据，原目录将保留'
      );
    return { root: source, commit: () => source, rollback: () => source };
  }
  const destination = derived(target),
    settings = store.storageSettings();
  const recordRoots = [
    ...new Map(
      [settings.recordsPath, ...Object.values(store.data.conversationConfigs).map((config) => config.recordsPath)]
        .filter(Boolean)
        .map((value) => [keyOf(value), path.resolve(value)])
    ).values(),
  ];
  const allSources = [
    source,
    settings.workspacePath,
    ...recordRoots,
    ...Object.values(store.data.conversations).map((metadata) => metadata.directory),
  ];
  for (const directory of allSources) {
    absoluteDirectory(directory, '源数据目录');
    plainPath(directory, { directory: true, missing: true });
    if (withinDirectory(directory, target) || withinDirectory(target, directory))
      throw failure(
        'WORKSPACE_PATH_OVERLAP',
        '新工作区不能位于原数据目录内部，也不能包含原数据目录；请选择独立的空文件夹'
      );
  }
  if (withinDirectory(target, base) || withinDirectory(base, target))
    throw failure('WORKSPACE_PATH_OVERLAP', '新工作区与引导目录不能互相包含；请选择独立的空文件夹');
  const assertEmpty = () => {
    const stat = plainPath(target, { directory: true, missing: true });
    if (stat && fs.readdirSync(target).length)
      throw failure('WORKSPACE_TARGET_NOT_EMPTY', '新工作区不是空文件夹，未覆盖已有内容；请选择新的空文件夹');
    return stat;
  };
  assertEmpty();
  const pointerFile = path.join(base, LOCATION),
    previousPointer = optionalBytes(pointerFile);
  const release = migrationLock(base, store.data.storeId);
  let stage,
    stageStat,
    nextPointer,
    retainedLock = false;
  const parent = path.dirname(target);
  try {
    target = writableDirectory(target, '工作区目录');
    if (!sameDirectory(target, destination.basePath))
      throw failure('WORKSPACE_PATH_LINK', '工作区位置在检查后发生变化，未迁移');
    const emptyStat = assertEmpty();
    stage = path.join(parent, `.${path.basename(target)}.wechat-agent-${randomUUID()}.tmp`);
    fs.mkdirSync(stage, { mode: 0o700 });
    stageStat = fs.lstatSync(stage);
    const result = store._withSourceLocks(store.views.values(), () => {
      const currentState = optionalBytes(store.file),
        snapshot = store._rootSnapshot();
      store.config.assertCurrent();
      if (
        !currentState ||
        JSON.stringify(parseJson(currentState, 'WORKSPACE_SOURCE_INVALID', '原工作区状态无法读取，未迁移')) !==
          store.rootWritten ||
        JSON.stringify(snapshot) !== store.rootWritten
      )
        throw failure('STORAGE_SOURCE_CHANGED', '原工作区配置已变化或仍有未保存状态，未迁移；请重新启用插件后重试');
      const excluded = new Set(
        [
          path.join(source, 'owner.lock'),
          path.join(base, 'owner.lock'),
          pointerFile,
          path.join(base, MIGRATION_LOCK),
          ...Object.values(store.data.conversations).map((metadata) =>
            path.join(metadata.directory, '.wechat-agent-write.lock')
          ),
        ].map(keyOf)
      );
      const backupRoot = path.join(stage, 'storage/backups/workspace-migration', randomUUID());
      const transfer = copier(stage, excluded, backupRoot);
      transfer.copy(source, stage);
      if (!sameDirectory(settings.workspacePath, path.join(source, 'workspace'))) {
        if (statIfPresent(path.join(stage, 'workspace'))) transfer.retain(path.join(stage, 'workspace'));
        transfer.copy(settings.workspacePath, path.join(stage, 'workspace'));
      }
      for (const directory of recordRoots)
        if (!sameDirectory(directory, path.join(source, 'storage/conversations')))
          transfer.copy(directory, path.join(stage, 'storage/conversations'));
      const mappings = [
        { from: source, to: target },
        { from: settings.workspacePath, to: destination.workspacePath },
        ...recordRoots.map((from) => ({ from, to: destination.recordsPath })),
      ];
      const directories = new Map(),
        targets = new Set();
      for (const [key, metadata] of Object.entries(snapshot.conversations)) {
        const directory = store._directory(metadata, destination, { recordsPath: '' });
        if (!withinDirectory(destination.recordsPath, directory) || targets.has(keyOf(directory)))
          throw failure('WORKSPACE_SOURCE_INVALID', '会话目录索引冲突，未合并不同会话的数据');
        targets.add(keyOf(directory));
        directories.set(key, directory);
        mappings.unshift({ from: metadata.directory, to: directory });
        transfer.copy(metadata.directory, path.join(stage, path.relative(target, directory)));
      }
      mappings.sort((left, right) => right.from.length - left.from.length);
      const rewritten = rewritePaths(snapshot, mappings);
      const rewrittenConfig = rewritePaths(store.config.snapshot(store.data), mappings);
      rewrittenConfig.storageSettings = { workspacePath: destination.workspacePath, recordsPath: destination.recordsPath };
      for (const config of Object.values(rewrittenConfig.conversationConfigs)) config.recordsPath = '';
      const targetConfig = new ConfigurationRepository(stage, store.data.storeId, { configurationVersion: 1 });
      targetConfig.commit(rewrittenConfig);
      for (const [key, directory] of directories) {
        rewritten.conversations[key].directory = directory;
        const file = path.join(stage, path.relative(target, directory), 'conversation.json');
        const original = optionalBytes(file),
          view = parseJson(original || Buffer.alloc(0), 'WORKSPACE_SOURCE_INVALID', '会话记录无法读取，未切换工作区');
        if (view.key !== key || view.ownerStoreId !== store.data.storeId)
          throw failure('WORKSPACE_SOURCE_INVALID', '会话记录归属不正确，未合并其他账号数据');
        const next = rewritePaths(view, mappings);
        if (JSON.stringify(view) !== JSON.stringify(next)) writeJson(file, next);
      }
      writeJson(path.join(stage, STATE), rewritten);
      const memoryFile = path.join(stage, 'storage/memory/index.json'),
        memoryBytes = optionalBytes(memoryFile);
      if (memoryBytes) {
        const memory = parseJson(memoryBytes, 'MEMORY_INVALID', '记忆索引无法读取，未切换工作区');
        if (!object(memory) || memory.ownerStoreId !== store.data.storeId || !object(memory.conversations))
          throw failure('MEMORY_INVALID', '记忆索引归属不正确，未切换工作区');
        let changed = false;
        const oldMemoryRoot = path.join(source, 'storage/memory');
        for (const entry of Object.values(memory.conversations)) {
          if (
            !object(entry) ||
            typeof entry.folder !== 'string' ||
            !entry.folder ||
            !withinDirectory(oldMemoryRoot, path.resolve(oldMemoryRoot, entry.folder))
          )
            throw failure('MEMORY_INVALID', '记忆索引的文件夹超出原记忆目录，未迁移');
          if (path.isAbsolute(entry.folder)) {
            entry.folder = path.relative(oldMemoryRoot, entry.folder);
            changed = true;
          }
        }
        if (changed) writeJson(memoryFile, memory);
      }
      for (const directory of Object.values(destination))
        if (directory !== target) {
          const local = path.join(stage, path.relative(target, directory));
          plainPath(local, { directory: true, missing: true });
          fs.mkdirSync(local, { recursive: true, mode: 0o700 });
        }
      // Copied ACL markers describe the old filesystem. Preserve that receipt
      // as a backup so protectStorage applies permissions to the new location.
      const acl = path.join(stage, 'storage/state/private-acl-v1.json');
      if (statIfPresent(acl)) transfer.retain(acl);
      transfer.verify();
      if (!sameBytes(optionalBytes(pointerFile), previousPointer))
        throw failure('WORKSPACE_LOCATION_CHANGED', '工作区位置已发生变化，未覆盖其他实例的设置');
      const currentEmpty = assertEmpty();
      if (!currentEmpty || currentEmpty.dev !== emptyStat.dev || currentEmpty.ino !== emptyStat.ino)
        throw failure('WORKSPACE_TARGET_CHANGED', '目标文件夹在迁移期间被替换，未切换工作区');
      fs.rmdirSync(target); // Checked, empty target only; never recursive.
      try {
        fs.renameSync(stage, target);
        stage = undefined;
      } catch (error) {
        if (!statIfPresent(target)) fs.mkdirSync(target, { mode: 0o700 });
        throw error;
      }
      syncDirectory(parent);
      nextPointer = Buffer.from(
        JSON.stringify({ version: 1, root: target, storeId: store.data.storeId }, null, 2) + '\n'
      );
      atomicBytes(pointerFile, nextPointer);
      let finished,
        reverted = false;
      const checkPointer = () => {
        if (!sameBytes(optionalBytes(pointerFile), nextPointer))
          throw failure(
            'WORKSPACE_LOCATION_CHANGED',
            '工作区位置已被其他操作修改，未覆盖新设置；请重新启用插件核对当前位置'
          );
      };
      const finish = (rollback) => {
        const expected = rollback ? 'rollback' : 'commit';
        if (finished) {
          if (finished !== expected)
            throw failure('WORKSPACE_MIGRATION_FINISHED', '这次工作区迁移已经结束，不能再次切换');
          return rollback ? source : target;
        }
        try {
          if (!reverted) checkPointer();
          else if (!rollback) throw failure('WORKSPACE_MIGRATION_FINISHED', '这次工作区迁移已经回退，不能再次提交');
          if (rollback && !reverted) {
            if (previousPointer) atomicBytes(pointerFile, previousPointer);
            else {
              fs.unlinkSync(pointerFile);
              syncDirectory(base);
            }
            reverted = true;
          }
        } finally {
          release();
        }
        finished = expected;
        return rollback ? source : target;
      };
      return { root: target, commit: () => finish(false), rollback: () => finish(true) };
    });
    retainedLock = true;
    return result;
  } catch (error) {
    // A lock-release failure after publication is exceptional, but still must
    // not leave a switched pointer when the caller never received a transaction.
    if (nextPointer) {
      try {
        const current = optionalBytes(pointerFile);
        if (sameBytes(current, nextPointer)) {
          if (previousPointer) atomicBytes(pointerFile, previousPointer);
          else fs.unlinkSync(pointerFile);
        } else if (!sameBytes(current, previousPointer)) throw new Error('Workspace pointer changed');
      } catch {
        throw failure(
          'WORKSPACE_ROLLBACK_FAILED',
          '新数据副本已保存，但位置记录回退失败；请重新启用插件核对当前目录，两份数据均保留'
        );
      }
    }
    if (error instanceof ChannelError || (error?.name === 'ChannelError' && typeof error.code === 'string'))
      throw error;
    throw failure(
      'WORKSPACE_MIGRATION_FAILED',
      '工作区迁移未完成，原数据保留；请检查可用磁盘空间、目录权限及文件占用后重试'
    );
  } finally {
    try {
      if (stage && stageStat) removeStage(stage, parent, stageStat);
    } finally {
      if (!retainedLock) release();
    }
  }
}
