import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { parseDocument } from 'yaml';

/** Only declared defaults/templates enter a package; workspace prompts stay private. */
export function packageResources(root, manifest) {
  root = path.resolve(root);
  const files = manifest.files.filter(file => file === 'config.yaml' || file.startsWith('prompts/'));
  assert(files.includes('config.yaml') && files.includes('prompts/identity/default.md'), 'Missing configuration/prompt defaults');
  assert.equal(new Set(files).size, files.length, 'Duplicate package resource');
  for (const file of files) {
    assert(file === 'config.yaml' || /^prompts\/[a-z0-9][a-z0-9/_-]*\.(md|json)$/.test(file), `Invalid package resource: ${file}`);
    for (let current = path.join(root, file); current !== root; current = path.dirname(current))
      assert(!fs.lstatSync(current).isSymbolicLink(), `Linked package resource: ${file}`);
    const stat = fs.statSync(path.join(root, file));
    assert(stat.isFile() && stat.size <= 1024 * 1024, `Invalid package resource: ${file}`);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(path.join(root, file)));
    if (file.endsWith('.json')) {
      const catalog = JSON.parse(text);
      assert(catalog && !Array.isArray(catalog) && typeof catalog === 'object' && Object.values(catalog).every(value => typeof value === 'string'), `Invalid prompt catalog: ${file}`);
    }
  }
  const document = parseDocument(fs.readFileSync(path.join(root, 'config.yaml'), 'utf8'), { uniqueKeys: true });
  assert.equal(document.errors.length, 0, 'Invalid default YAML');
  const config = document.toJS({ maxAliasCount: 20 });
  assert(config.version === 1 && config.ownerStoreId === null && config.connectionWanted === false, 'Package must contain unowned, disconnected defaults');
  for (const key of ['accounts', 'conversationConfigs', 'imageMemory', 'media'])
    assert(config[key] && Object.keys(config[key]).length === 0, `Workspace configuration in package: ${key}`);
  assert.deepEqual(config.remote, { globalAdminIds: [] }, 'Package must not grant global administrator access');
  assert(config.conversationDefaults.remoteEnabled === false && Array.isArray(config.conversationDefaults.adminIds) && !config.conversationDefaults.adminIds.length,
    'Package must keep conversation remote access disabled');
  const privateKey = value => value && typeof value === 'object' && Object.entries(value).some(([key, item]) => /(?:api.?key|password|token|secret|credential)/i.test(key) && key !== 'maxTokens' || privateKey(item));
  assert(!privateKey(config), 'Credentials must not enter package defaults');
  for (const value of [config.storageSettings.workspacePath, config.storageSettings.recordsPath, config.prompts.identity])
    assert(typeof value === 'string' && value && !path.isAbsolute(value) && !path.win32.isAbsolute(value) && !value.split(/[\\/]/).includes('..'), 'Package defaults must use relative workspace paths');
  return files;
}
