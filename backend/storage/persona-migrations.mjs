import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ChannelError, emptyPersona } from '../../shared/contracts.mjs';

export const PERSONA_TEMPLATES_VERSION = 3;
const hash = bytes => createHash('sha256').update(bytes).digest('hex').slice(0, 16);

function backup(file, bytes) {
  try { fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST' || !fs.lstatSync(file).isFile() || !fs.readFileSync(file).equals(bytes)) throw error;
  }
}

/** Reset old roles once; subsequent global custom edits stay saved. */
export function migratePersonaTemplates(store) {
  if ((store.data.personaTemplatesVersion ?? 1) >= PERSONA_TEMPLATES_VERSION) return false;
  const original = Buffer.from(JSON.stringify({
    persona: store.data.persona,
    conversationConfigs: store.data.conversationConfigs,
    conversationDefaults: store.config.data.conversationDefaults,
  }, null, 2) + '\n');
  if (fs.existsSync(store.file) || fs.existsSync(store.config.file)) {
    try {
      store.config.assertCurrent();
      const folder = path.join(store.root, 'storage/backups');
      fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
      const prefix = path.join(folder, `personas.before-single-${hash(original)}`);
      // Expanded bodies retain custom text even when YAML points at separate Markdown.
      backup(prefix + '.json', original);
      if (fs.existsSync(store.file)) backup(prefix + '.state.json', fs.readFileSync(store.file));
      if (fs.existsSync(store.config.file)) backup(prefix + '.config.yaml', fs.readFileSync(store.config.file));
    } catch {
      throw new ChannelError('STATE_WRITE_FAILED', '旧人设备份失败，未切换默认助手；请检查存储目录权限');
    }
  }
  store.data.persona = emptyPersona(store.data.persona);
  for (const settings of Object.values(store.data.conversationConfigs)) settings.persona = null;
  store.config.data.conversationDefaults.persona = null;
  store.data.personaTemplatesVersion = PERSONA_TEMPLATES_VERSION;
  return true;
}
