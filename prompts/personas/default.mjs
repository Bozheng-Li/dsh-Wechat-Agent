import background from './voice/background.mjs';
import personality from './voice/personality.mjs';
import style from './voice/style.mjs';
import examples from './voice/examples.mjs';

export const DEFAULT_PERSONA_ID = 'default-assistant';

export default {
  id: DEFAULT_PERSONA_ID,
  name: '微信助手',
  aliases: [],
  role: '默认助手（拟人）',
  summary: '在微信里待久了的那种人：话不多，接得住，看得清对方在说什么。',
  // 三段正文分别维护在 voice/ 下：来历、性格、表达。改动只动那三个文件。
  background: background.trim(),
  personality: personality.trim(),
  style: style.trim(),
  examples,
};
