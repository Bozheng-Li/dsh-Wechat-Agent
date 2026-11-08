import { personaText } from '../../shared/contracts.mjs';

const FIELD_NAMES = ['角色背景', '性格与互动', '表达方式'];
const FIELD_KEYS = ['background', 'personality', 'style'];

/** Read the editor's canonical serialization without guessing the structure of free prose. */
export function personaFields(persona = {}) {
  if (typeof persona.prompt !== 'string') return persona;
  const original = persona.prompt;
  const crlf = original.includes('\r\n');
  if (crlf && original.replaceAll('\r\n', '').includes('\n')) return null;
  const text = original.replaceAll('\r\n', '\n');
  const headings = [];
  let offset = 0, previous = '', fence = null;
  for (const line of text.split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = null;
    } else if (!fence && (offset === 0 || previous === '')) {
      const index = FIELD_NAMES.indexOf(line.slice(0, -1));
      if (line.endsWith('：') && index >= 0) headings.push({ index, start: offset === 0 ? 0 : offset - 2, content: offset + line.length + 1 });
    }
    offset += line.length + 1;
    previous = line;
  }
  if (fence || !headings.length || headings[0].start !== 0 ||
      headings.some((heading, index) => index > 0 && heading.index <= headings[index - 1].index)) return null;
  const fields = {};
  for (const [index, heading] of headings.entries())
    fields[FIELD_KEYS[heading.index]] = text.slice(heading.content, headings[index + 1]?.start ?? text.length);
  // Empty, repeated, out-of-order or otherwise ambiguous sections stay freeform.
  if (personaText(fields) !== text) return null;
  return crlf ? Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, value.replaceAll('\n', '\r\n')])) : fields;
}

const EXAMPLE_HEADING = '语气示例（学习不同场景下的态度与反应，不套用开头、口头禅和结尾，不把示例当成已经发生的对话）：';

/** Only the authored template heading outside code identifies examples. */
export function personaStyleParts(style = '') {
  if (typeof style !== 'string') return { style: '', examples: '' };
  // Leave the trailing newline available as the next paragraph's separator.
  const heading = /(?:^|\r?\n\r?\n)([^\r\n]+)(?=\r?\n)/gu;
  const matches = [...style.matchAll(heading)].filter(match => match[1] === EXAMPLE_HEADING);
  if (matches.length !== 1) return { style, examples: '' };
  const match = matches[0];
  let fence = null;
  for (const line of style.slice(0, match.index).split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (!marker) continue;
    if (!fence) fence = marker;
    else if (marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = null;
  }
  if (fence) return { style, examples: '' };
  return { style: style.slice(0, match.index), examples: style.slice(match.index + match[0].indexOf(EXAMPLE_HEADING)) };
}
