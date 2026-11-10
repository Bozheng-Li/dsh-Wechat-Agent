import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse, stringify } from 'yaml';
import { packageResources } from '../scripts/package-resources.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
function stage(t) {
  const parent = fs.realpathSync(os.tmpdir()), directory = fs.mkdtempSync(path.join(parent, 'wechat-resources-'));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(directory)), parent);
    assert.match(path.basename(directory), /^wechat-resources-/);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: manifest.name, type: 'module' }));
  for (const file of packageResources(root, manifest)) {
    fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    fs.copyFileSync(path.join(root, file), path.join(directory, file));
  }
  return directory;
}

test('a relocated bundle loads declared prompt resources and workspace YAML without its source tree', async t => {
  const directory = stage(t);
  fs.mkdirSync(path.join(directory, 'lib'));
  const file = path.join(directory, 'lib/testing.js');
  fs.copyFileSync(path.join(root, 'lib/testing.js'), file);
  const api = await import(pathToFileURL(file).href);
  const workspace = path.join(directory, 'fixture-workspace'), store = new api.StateStore(workspace);
  const identity = new api.AgentIdentity(workspace, { config: store.config });
  assert.equal(identity.view().markdown, fs.readFileSync(path.join(directory, 'prompts/identity/default.md'), 'utf8'));
  assert.equal(store.modelConfig().maxTokens, null);
  assert.match(api.memoryText({ summary: 'Fixture memory', entries: [] }), /Fixture memory/);
  assert.equal(store.data.configurationVersion, 1);
  assert(fs.existsSync(path.join(workspace, 'config.yaml')));
  assert(!fs.existsSync(path.join(directory, 'backend')));
  assert(!fs.existsSync(path.join(directory, 'modules')));
  const catalog = path.join(directory, 'prompts/conversation/templates.json');
  fs.writeFileSync(catalog, 'invalid JSON');
  assert.throws(() => api.memoryText({ summary: 'Fixture memory', entries: [{ text: 'Fixture image', attachments: [{ type: 'face' }] }] }), { code: 'PROMPT_INVALID' });
});

test('package resource validation rejects runtime authorization, credentials, machine paths and wildcard prompt inputs', t => {
  const directory = stage(t), file = path.join(directory, 'config.yaml'), original = fs.readFileSync(file, 'utf8');
  for (const change of [config => { config.ownerStoreId = 'runtime-owner'; },
    config => { config.accounts = { owner: { enabled: true } }; },
    config => { config.modelConfig.apiKey = 'fixture-secret'; },
    config => { config.storageSettings.workspacePath = 'C:\\fixture\\workspace'; },
    config => { config.remote.globalAdminIds = ['wxid_runtime_admin']; },
    config => { config.conversationDefaults.remoteEnabled = true; },
    config => { config.conversationDefaults.adminIds = ['wxid_runtime_admin']; }]) {
    const config = parse(original); change(config); fs.writeFileSync(file, stringify(config));
    assert.throws(() => packageResources(directory, manifest));
  }
  fs.writeFileSync(file, original);
  assert.throws(() => packageResources(directory, { ...manifest, files: [...manifest.files, 'prompts/**'] }));
  assert.deepEqual(packageResources(directory, manifest), manifest.files.filter(file => file === 'config.yaml' || file.startsWith('prompts/')));
});
