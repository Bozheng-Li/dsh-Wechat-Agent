import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import { StateStore, AgentIdentity, ConversationMemory, ImageMemory, MediaLibrary, emptyPersona } from '../lib/testing.js';
import { ConfigurationRepository, CONFIG_FIELDS } from '../backend/config/repository.mjs';
import { commitConfigurationFiles, recoverConfigurationTransaction } from '../backend/config/transaction.mjs';

function temporary(t) {
  const parent = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, 'wechat-yaml-'));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(root)), parent);
    assert.match(path.basename(root), /^wechat-yaml-/);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}
const readConfig = root => parse(fs.readFileSync(path.join(root, 'config.yaml'), 'utf8'));
function editConfig(root, change) {
  const config = readConfig(root);
  change(config);
  fs.writeFileSync(path.join(root, 'config.yaml'), stringify(config));
}
const account = 'fixture-yaml-owner';
const authorized = { enabled: true, groups: ['fixture@chatroom'], privatePeers: ['alice'], prompt: 'Synthetic account instructions', publishScope: 'blocked-list', defaultBlockedUserIds: [], defaultBlockedLabelIds: [] };

test('legacy JSON preserves authorization in YAML and backs up the old custom body before switching to the global assistant', t => {
  const root = temporary(t), file = path.join(root, 'storage/state/channel.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const legacy = { version: 2, storeId: 'fixture-legacy', connectionWanted: true,
    accounts: { [account]: authorized }, seen: {}, sessions: {}, records: [],
    persona: { name: 'Fixture', aliases: ['F'], prompt: 'Custom unchanged persona.' } };
  const original = JSON.stringify(legacy, null, 2);
  fs.writeFileSync(file, original);
  const store = new StateStore(root), config = readConfig(root), state = JSON.parse(fs.readFileSync(file));
  assert.deepEqual(store.settings(account), authorized);
  assert.deepEqual(store.persona(), emptyPersona(legacy.persona));
  assert.equal(config.connectionWanted, true);
  assert.equal(config.ownerStoreId, legacy.storeId);
  assert.equal(config.accounts[account].prompt, undefined);
  assert.equal(fs.readFileSync(path.join(root, config.accounts[account].promptFile), 'utf8'), authorized.prompt);
  assert.equal(config.personaTemplatesVersion, 3);
  assert.equal(fs.readFileSync(path.join(root, config.persona.backgroundFile), 'utf8'), store.persona().background);
  const personaBackup = fs.readdirSync(path.join(root, 'storage/backups')).find(name => /^personas\.before-single-.+\.json$/.test(name));
  assert(personaBackup);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'storage/backups', personaBackup), 'utf8')).persona, legacy.persona);
  for (const field of CONFIG_FIELDS) assert(!Object.hasOwn(state, field), `Duplicated settings: ${field}`);
  assert.equal(state.configurationVersion, 1);
  const backup = fs.readdirSync(path.dirname(file)).find(name => /^channel\.before-yaml-.+\.backup\.json$/.test(name));
  assert.equal(fs.readFileSync(path.join(path.dirname(file), backup), 'utf8'), original);
  const reopened = new StateStore(root);
  assert.deepEqual(reopened.settings(account), authorized);
  assert.deepEqual(reopened.persona(), store.persona());
});

test('external YAML and referenced Markdown changes cannot be overwritten and are adopted on reload', t => {
  const root = temporary(t), store = new StateStore(root);
  store.configure(account, authorized);
  editConfig(root, config => { config.modelConfig.temperature = 0.7; });
  const edited = fs.readFileSync(path.join(root, 'config.yaml'));
  assert.throws(() => store.configure(account, { ...authorized, enabled: false }), { code: 'CONFIG_CHANGED' });
  assert.deepEqual(store.settings(account), authorized);
  assert.deepEqual(fs.readFileSync(path.join(root, 'config.yaml')), edited);
  const reopened = new StateStore(root);
  assert.equal(reopened.modelConfig().temperature, 0.7);
  const promptFile = path.join(root, readConfig(root).accounts[account].promptFile);
  fs.writeFileSync(promptFile, 'Edited externally.');
  assert.throws(() => reopened.configure(account, { ...authorized, enabled: false }), { code: 'CONFIG_CHANGED' });
  assert.equal(new StateStore(root).settings(account).prompt, 'Edited externally.');
});

test('invalid, duplicate-key, foreign-owner and missing active YAML stop loading without resetting state', t => {
  const root = temporary(t), store = new StateStore(root);
  store.configure(account, authorized);
  const file = path.join(root, 'config.yaml'), valid = fs.readFileSync(file), state = fs.readFileSync(store.file);
  const foreign = readConfig(root); foreign.ownerStoreId = 'another-store';
  for (const input of ['version: [', 'version: 1\nversion: 1\n', stringify(foreign)]) {
    fs.writeFileSync(file, input);
    assert.throws(() => new StateStore(root), { code: 'CONFIG_INVALID' });
    assert.deepEqual(fs.readFileSync(store.file), state);
  }
  fs.unlinkSync(file);
  assert.throws(() => new StateStore(root), { code: 'CONFIG_INVALID' });
  fs.writeFileSync(file, valid);
  assert.deepEqual(new StateStore(root).settings(account), authorized);
});

test('missing and escaping persona prompt paths fail clearly without replacing saved authorization', t => {
  const root = temporary(t), store = new StateStore(root);
  store.configure(account, authorized);
  const state = fs.readFileSync(store.file), valid = fs.readFileSync(path.join(root, 'config.yaml'));
  for (const prompt of ['prompts/missing.md', 'prompts/../../outside.md']) {
    fs.writeFileSync(path.join(root, 'config.yaml'), valid);
    editConfig(root, config => { config.accounts[account].promptFile = prompt; });
    assert.throws(() => new StateStore(root), { code: 'CONFIG_PROMPT_INVALID' });
    assert.deepEqual(fs.readFileSync(store.file), state);
  }
});

test('prompt publication failure reports a save error and preserves YAML and in-memory settings', t => {
  const root = temporary(t), store = new StateStore(root);
  const before = fs.readFileSync(path.join(root, 'config.yaml'));
  fs.writeFileSync(path.join(root, 'prompts/accounts'), 'blocked directory');
  assert.throws(() => store.configure(account, authorized), { code: 'STATE_WRITE_FAILED' });
  assert.deepEqual(fs.readFileSync(path.join(root, 'config.yaml')), before);
  assert.equal(store.settings(account).enabled, false);
});

test('multi-file publication failure rolls back the prior bytes and removes its journal', t => {
  const root = temporary(t), file = path.join(root, 'config.yaml'), blocked = path.join(root, 'blocked');
  fs.writeFileSync(file, 'original'); fs.mkdirSync(blocked);
  assert.throws(() => commitConfigurationFiles(root, [{ file, bytes: Buffer.from('changed') }, { file: blocked, bytes: Buffer.from('invalid target') }]));
  assert.equal(fs.readFileSync(file, 'utf8'), 'original');
  assert(!fs.existsSync(path.join(root, 'storage/state/config-transaction.json')));
});

test('startup rolls back prepared transactions and retains acknowledged committed bytes', t => {
  const root = temporary(t), journal = path.join(root, 'storage/state/config-transaction.json');
  fs.mkdirSync(path.dirname(journal), { recursive: true });
  const entry = { path: 'config.yaml', before: Buffer.from('old').toString('base64'), after: Buffer.from('new').toString('base64') };
  for (const phase of ['prepared', 'committed']) {
    fs.writeFileSync(path.join(root, entry.path), 'new');
    fs.writeFileSync(journal, JSON.stringify({ version: 1, phase, entries: [entry] }));
    recoverConfigurationTransaction(root);
    assert.equal(fs.readFileSync(path.join(root, entry.path), 'utf8'), phase === 'prepared' ? 'old' : 'new');
    assert(!fs.existsSync(journal));
  }
  fs.writeFileSync(journal, JSON.stringify({ version: 1, phase: 'committed', entries: [{ ...entry, after: Buffer.from('missing commit').toString('base64') }] }));
  assert.throws(() => recoverConfigurationTransaction(root), { code: 'CONFIG_RECOVERY_FAILED' });
  assert(fs.existsSync(journal));
  fs.writeFileSync(journal, JSON.stringify({ version: 1, phase: 'prepared', entries: [{ ...entry, path: '../outside.yaml' }] }));
  assert.throws(() => recoverConfigurationTransaction(root), { code: 'CONFIG_RECOVERY_FAILED' });
  assert.equal(fs.readFileSync(path.join(root, entry.path), 'utf8'), 'new');
  fs.writeFileSync(journal, JSON.stringify({ version: 1, phase: 'prepared', entries: [{ ...entry, before: 'invalid base64!' }] }));
  assert.throws(() => recoverConfigurationTransaction(root), { code: 'CONFIG_RECOVERY_FAILED' });
  assert.equal(fs.readFileSync(path.join(root, entry.path), 'utf8'), 'new');
  assert.throws(() => commitConfigurationFiles(root, [{ file: path.join(root, entry.path), bytes: Buffer.from('later') }]), { code: 'CONFIG_RECOVERY_FAILED' });
  assert.equal(fs.readFileSync(path.join(root, entry.path), 'utf8'), 'new');
});

test('identity copies custom legacy Markdown into prompts and preserves its original file', t => {
  const root = temporary(t), custom = '# Shared fixture identity\nKeep this exact text.\n';
  fs.writeFileSync(path.join(root, 'AGENT.md'), custom);
  const store = new StateStore(root), identity = new AgentIdentity(root, { config: store.config });
  assert.equal(identity.view().path, path.join(root, 'prompts/AGENT.md'));
  assert.equal(identity.view().markdown, custom);
  assert.equal(fs.readFileSync(path.join(root, 'AGENT.md'), 'utf8'), custom);
});

test('a minimal configuration adapter retains defaults while saving a feature section', t => {
  const root = temporary(t), repository = new ConfigurationRepository(root, 'minimal-fixture');
  repository.update('memory', { ...repository.section('memory'), windowChars: 5000 }, {});
  const reopened = new ConfigurationRepository(root, 'minimal-fixture', { configurationVersion: 1 });
  assert.equal(reopened.section('memory').windowChars, 5000);
  assert.equal(reopened.data.connectionWanted, false);
  assert.deepEqual(reopened.data.accounts, {});
});

test('feature defaults come from YAML and feature indices contain only runtime metadata', t => {
  const root = temporary(t);
  new StateStore(root);
  editConfig(root, config => {
    config.memory.retentionDays = 7;
    config.memory.windowChars = 5000;
    config.memory.windowCustomized = true;
    config.conversationDefaults.mode = 'nickname';
    config.imageMemoryDefaults = { enabled: false, retentionDays: 14 };
    config.mediaDefaults = { enabled: false, probability: 5, minGapMessages: 8 };
  });
  const store = new StateStore(root);
  store.configure(account, authorized);
  const scope = { accountId: account, chatType: 'group', peerId: authorized.groups[0] };
  assert.equal(store.conversationSettings(account, scope.chatType, scope.peerId).mode, 'nickname');
  const memory = new ConversationMemory(store);
  assert.equal(memory.index.windowChars, 5000);
  assert.equal(memory.expiry(1000), 1000 + 7 * 86400000);
  const index = JSON.parse(fs.readFileSync(memory.indexFile, 'utf8'));
  for (const field of ['windowChars', 'windowCustomized', 'windowDefaultVersion', 'retentionDays']) assert(!Object.hasOwn(index, field), field);
  const images = new ImageMemory(store), imageView = images.list(scope);
  assert.deepEqual(imageView.settings, { enabled: false, retentionDays: 14 });
  assert(!Object.hasOwn(JSON.parse(fs.readFileSync(path.join(imageView.path, 'index.json'), 'utf8')), 'settings'));
  const media = new MediaLibrary(store);
  t.after(() => media.close());
  assert.deepEqual(media.list(account).settings, { enabled: false, probability: 5, minGapMessages: 8, captureIncoming: true, preferNative: true, autoDescribe: true });
  media.configure(account, { enabled: true, probability: 9, minGapMessages: 2 });
  assert(!Object.hasOwn(JSON.parse(fs.readFileSync(media.indexFile, 'utf8')).accounts[account], 'settings'));
  assert.deepEqual(readConfig(root).media[account].settings, { enabled: true, probability: 9, minGapMessages: 2, captureIncoming: true, preferNative: true, autoDescribe: true });
  editConfig(root, config => { config.memory.retentionDays = 8; });
  assert.throws(() => images.configure(scope, { enabled: true, retentionDays: 20 }), { code: 'CONFIG_CHANGED' });
});
