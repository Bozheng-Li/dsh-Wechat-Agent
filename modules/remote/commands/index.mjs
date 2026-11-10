export function remoteCommand(text) {
  const matched = /^\/(pc|dsh)(?:\s+([\s\S]*))?$/i.exec(String(text).trim());
  if (!matched) return null;
  const kind = matched[1].toLowerCase(), body = (matched[2] ?? '').trim();
  if (kind === 'pc' && /^status$/i.test(body)) return { action: 'computer' };
  if (kind === 'dsh' && /^tasks$/i.test(body)) return { action: 'tasks' };
  const task = kind === 'dsh' && /^task\s+([a-z0-9_.-]{1,150})$/i.exec(body);
  return task ? { action: 'task', id: task[1] } : { action: 'help' };
}
