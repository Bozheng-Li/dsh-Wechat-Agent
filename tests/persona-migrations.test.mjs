import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parse, stringify } from 'yaml';
import { StateStore } from '../lib/testing.js';
import { emptyPersona, personaText, validatePersona, validateConversationSettings } from '../shared/contracts.mjs';
import { migratePersonaTemplates } from '../backend/storage/persona-migrations.mjs';
import { CONFIG_FIELDS } from '../backend/config/repository.mjs';
import { info } from '../backend/storage/keys.mjs';

const legacy = JSON.parse(fs.readFileSync(new URL('./fixtures/persona-presets-preview8.json', import.meta.url), 'utf8')).personas;
const base = path.resolve(import.meta.dirname, '../storage/tmp');
const serialized = persona => validatePersona({ name: persona.name, aliases: [...persona.aliases], prompt: personaText(persona) });
const digest = bytes => createHash('sha256').update(bytes).digest('hex').slice(0, 16);
function directory(t) {
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'persona-migration-'));
  t.after(() => {
    assert.equal(path.dirname(root), base);
    assert(path.basename(root).startsWith('persona-migration-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test('all removed preset bodies and custom old bodies migrate to the single assistant in both saved formats', t => {
  const root = directory(t);
  for (const { id, persona } of [...legacy, { id: 'custom', persona: { name: '自定义', aliases: [], prompt: '我写的旧全局人设' } }]) {
    for (const input of [validatePersona(persona), serialized(persona)]) {
      const renamed = { ...input, name: '保留名字 ' + id, aliases: ['保留唤醒词'] };
      const store = { root, file: path.join(root, 'missing.json'), data: { personaTemplatesVersion: 2, persona: renamed,
        conversationConfigs: { room: { mode: 'nickname', persona: input } } },
      config: { file: path.join(root, 'missing.yaml'), data: { conversationDefaults: { persona: input } } } };
      assert.equal(migratePersonaTemplates(store), true);
      assert.deepEqual(store.data.persona, emptyPersona(renamed));
      assert.equal(store.data.conversationConfigs.room.persona, null);
      assert.equal(store.config.data.conversationDefaults.persona, null);
      assert.equal(store.data.personaTemplatesVersion, 3);
      assert.equal(migratePersonaTemplates(store), false);
    }
  }
});

function fixture(t, { yaml = false } = {}) {
  const root = directory(t), store = new StateStore(root);
  store.configure('owner', { enabled: true, groups: ['own-role@chatroom', 'follow-default@chatroom', 'edited@chatroom'], privatePeers: [], prompt: '账号要求原样保留' });
  store.configure('other-owner', { enabled: false, groups: ['other-room@chatroom'], privatePeers: [], prompt: '另一账号' });
  const defaultRole = serialized({ ...legacy[0].persona, name: '我的助手', aliases: ['小助'] });
  const roomRole = serialized(legacy.find(value => value.id === 'xingli').persona);
  const editedRole = { ...serialized(legacy.find(value => value.id === 'mobai').persona), prompt: '这是编辑过的会话正文，先备份再停用。' };
  store.setPersona(defaultRole);
  for (const peer of ['own-role@chatroom', 'follow-default@chatroom', 'edited@chatroom'])
    store.setConversationSettings('owner', 'group', peer, { ...store.conversationSettings('owner', 'group', peer), mode: 'nickname', memoryMode: 'on-demand' });
  const configurations = structuredClone(store.data.conversationConfigs);
  configurations[info('owner', 'group', 'own-role@chatroom').key].persona = roomRole;
  configurations[info('owner', 'group', 'edited@chatroom').key].persona = editedRole;
  const original = { ...JSON.parse(fs.readFileSync(store.file, 'utf8')),
    ...Object.fromEntries(CONFIG_FIELDS.filter(key => Object.hasOwn(store.data, key)).map(key => [key, structuredClone(store.data[key])])),
    personaTemplatesVersion: yaml ? 2 : 1, conversationConfigs: configurations };
  const configFile = path.join(root, 'config.yaml');
  let originalYaml;
  if (yaml) {
    const config = parse(fs.readFileSync(configFile, 'utf8'));
    config.personaTemplatesVersion = 2;
    config.conversationConfigs = configurations;
    config.conversationDefaults.persona = roomRole;
    originalYaml = Buffer.from(stringify(config));
    fs.writeFileSync(configFile, originalYaml);
  } else {
    delete original.configurationVersion;
    delete original.personaTemplatesVersion; // Old JSON predates the version marker and YAML.
    fs.writeFileSync(store.file, JSON.stringify(original));
    fs.unlinkSync(configFile);
  }
  const originalBytes = fs.readFileSync(store.file);
  const identityFile = path.join(root, 'AGENT.md'), memoryFile = path.join(root, 'memory-note.md');
  fs.writeFileSync(identityFile, '# 自定义身份\n原文不改');
  fs.writeFileSync(memoryFile, '# 已有资料\n约定原文');
  return { root, file: store.file, original, originalBytes, originalYaml, defaultRole, configurations, roomRole, editedRole,
    defaults: yaml ? { ...store.config.data.conversationDefaults, persona: roomRole } : store.config.data.conversationDefaults,
    identityFile, memoryFile };
}

for (const yaml of [false, true]) test(`${yaml ? 'active YAML' : 'legacy JSON'} startup backs up roles before unifying without changing permissions, memory or record indices`, t => {
  const f = fixture(t, { yaml }), store = new StateStore(f.root);
  assert.deepEqual(store.persona(), emptyPersona(f.defaultRole));
  for (const peer of ['own-role@chatroom', 'follow-default@chatroom', 'edited@chatroom']) {
    assert.deepEqual(store.conversationPersona('owner', 'group', peer), store.persona());
    assert.equal(store.conversationSettings('owner', 'group', peer).persona, null);
  }
  assert.equal(store.config.data.conversationDefaults.persona, null);
  assert.equal(store.data.personaTemplatesVersion, 3);
  for (const key of ['accounts', 'conversations', 'connectionWanted', 'storageSettings', 'storeId'])
    assert.deepEqual(store.data[key], f.original[key], key);
  for (const [key, before] of Object.entries(f.configurations)) {
    const { persona, ...rest } = before;
    assert.deepEqual(store.data.conversationConfigs[key], { ...rest, persona: null });
  }
  const folder = path.join(f.root, 'storage/backups');
  const snapshotName = fs.readdirSync(folder).find(name => /^personas\.before-single-[a-f0-9]+\.json$/.test(name));
  assert(snapshotName);
  const prefix = path.join(folder, snapshotName.slice(0, -5));
  const snapshot = JSON.parse(fs.readFileSync(prefix + '.json', 'utf8'));
  assert.deepEqual(snapshot.persona, f.defaultRole);
  assert.deepEqual(snapshot.conversationConfigs, f.configurations);
  assert.deepEqual(fs.readFileSync(prefix + '.state.json'), f.originalBytes);
  if (yaml) assert.deepEqual(fs.readFileSync(prefix + '.config.yaml'), f.originalYaml);
  assert.equal(fs.readFileSync(f.identityFile, 'utf8'), '# 自定义身份\n原文不改');
  assert.equal(fs.readFileSync(f.memoryFile, 'utf8'), '# 已有资料\n约定原文');
  const after = fs.readFileSync(f.file), afterConfig = fs.readFileSync(path.join(f.root, 'config.yaml'));
  new StateStore(f.root);
  assert.deepEqual(fs.readFileSync(f.file), after);
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'config.yaml')), afterConfig);
  const custom = { name: '全局自定义名字', aliases: ['自定义唤醒词'], prompt: '日常简短，解释保留必要细节。' };
  store.setPersona(custom);
  assert.deepEqual(new StateStore(f.root).persona(), custom, 'new global custom edits never migrate again');
  assert.equal(fs.readdirSync(folder).filter(name => /^personas\.before-single-[a-f0-9]+\.json$/.test(name)).length, 1);
});

test('a failed backup leaves all original persisted roles and authorizations untouched', t => {
  const f = fixture(t);
  const bytes = Buffer.from(JSON.stringify({ persona: f.defaultRole, conversationConfigs: f.configurations, conversationDefaults: f.defaults }, null, 2) + '\n');
  const folder = path.join(f.root, 'storage/backups'); fs.mkdirSync(folder, { recursive: true });
  fs.mkdirSync(path.join(folder, `personas.before-single-${digest(bytes)}.json`));
  assert.throws(() => new StateStore(f.root), error => error.code === 'STATE_WRITE_FAILED' && error.message.includes('人设备份失败'));
  assert.deepEqual(fs.readFileSync(f.file), f.originalBytes);
  assert.equal(fs.existsSync(path.join(f.root, 'config.yaml')), false);
});

test('new defaults and clearing the global custom body use the same assistant; YAML cannot restore room overrides', t => {
  const root = directory(t), store = new StateStore(root);
  assert.deepEqual(store.persona(), emptyPersona());
  store.setPersona({ name: '我的助手', aliases: ['小助'], prompt: '' });
  assert.deepEqual(store.persona(), emptyPersona({ name: '我的助手', aliases: ['小助'] }));
  const file = path.join(root, 'config.yaml'), config = parse(fs.readFileSync(file, 'utf8'));
  config.conversationDefaults = validateConversationSettings({ ...config.conversationDefaults, persona: { name: '偷偷恢复', aliases: [], prompt: '旧会话覆盖' } });
  fs.writeFileSync(file, stringify(config));
  assert.throws(() => new StateStore(root), error => error.code === 'PERSONA_GLOBAL_ONLY');
  assert(parse(fs.readFileSync(file, 'utf8')).conversationDefaults.persona, 'invalid external settings remain available for repair');
});
