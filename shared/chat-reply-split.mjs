/** Explicit business-level bubble splitting. The transport may still split long
 * individual text bubbles at its protocol byte limit. */
export const SPLIT_MARK = '<SPLIT>';

const FENCE = /^\s*(`{3,}|~{3,})/u;

/** Only the marker splits; line breaks and code examples remain literal. */
export function splitChatReply(text) {
  const value = typeof text === 'string' ? text.replace(/\r\n/g, '\n').trim() : '';
  if (!value) return [];
  const messages = [];
  let current = [], fence;
  for (const line of value.split('\n')) {
    if (fence) {
      current.push(line);
      const closing = FENCE.exec(line)?.[1];
      if (closing?.[0] === fence[0] && closing.length >= fence.length && line.trim() === closing) fence = undefined;
      continue;
    }
    let rest = line;
    while (true) {
      const opening = FENCE.exec(rest)?.[1];
      if (opening) { fence = opening; current.push(rest); break; }
      const mark = /<split>/iu.exec(rest);
      if (!mark) { current.push(rest); break; }
      if (mark.index) current.push(rest.slice(0, mark.index));
      messages.push(current.join('\n')); current = [];
      rest = rest.slice(mark.index + mark[0].length);
    }
  }
  messages.push(current.join('\n'));
  return messages.map(part => part.trim()).filter(Boolean);
}

/** Keep @ mentions on the first bubble and media in its original order. */
export function replySegments(message) {
  const mentions = message.filter(part => part.type === 'at');
  const body = message.filter(part => part.type !== 'at');
  if (!body.length) return [message];
  return body.map((part, index) => [...(index === 0 ? mentions : []), part]);
}
