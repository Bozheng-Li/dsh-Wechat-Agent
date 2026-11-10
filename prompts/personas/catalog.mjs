import assistant from './default.mjs';
export { DEFAULT_PERSONA_ID } from './default.mjs';

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

export const PERSONA_PRESETS = freeze([assistant]);

export function getPersonaPreset(id) {
  return PERSONA_PRESETS.find((preset) => preset.id === id);
}

export function personaFromPreset(id = assistant.id, identity) {
  const preset = getPersonaPreset(id);
  if (!preset) throw new Error('仅保留默认助手，请在全局助手设置中自定义');
  const examples = preset.examples
    .map((example) => `场景：${example.scene}\n对方：${example.message}\n回应：${example.reply}`)
    .join('\n\n');
  return {
    name: identity?.name ?? preset.name,
    aliases: [...(identity?.aliases ?? preset.aliases)],
    background: preset.background,
    personality: preset.personality,
    style: `${preset.style}\n\n语气示例（学习不同场景下的态度与反应，不套用开头、口头禅和结尾，不把示例当成已经发生的对话）：\n${examples}`,
  };
}

