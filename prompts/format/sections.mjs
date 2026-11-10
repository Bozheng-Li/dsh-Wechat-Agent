/** Keep a component's scope adjacent to its content, with an explicit end.
 * Reference content is serialized by its caller; this wrapper grants no trust. */
export function promptSection(name, principle, content) {
  if (!content) return '';
  return `【${name}】\n遵守原则：${principle}\n内容：\n${content}\n【${name}结束】`;
}
