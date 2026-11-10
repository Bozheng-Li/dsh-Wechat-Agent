const textLength = content => typeof content === 'string' ? content.length :
  Array.isArray(content) ? content.reduce((sum, block) => sum + (block.type === 'text' && typeof block.text === 'string' ? block.text.length : 0), 0) : 0;

/** Counts contain no conversation text, tool arguments, credentials or pixels.
 * Character counts are deliberately not labelled as tokenizer measurements. */
export function measureModelRequest(request) {
  const result = { systemChars: textLength(request.system), userChars: 0, assistantChars: 0, toolResultChars: 0,
    toolCallChars: 0, toolSchemaChars: 0, imageCount: 0, toolsCount: request.tools?.length ?? 0 };
  for (const message of request.messages ?? []) {
    const field = { system: 'systemChars', developer: 'systemChars', user: 'userChars', assistant: 'assistantChars', tool: 'toolResultChars' }[message.role];
    if (field) result[field] += textLength(message.content);
    if (Array.isArray(message.content)) for (const block of message.content) {
      if (block.type === 'image') result.imageCount++;
      if (block.type === 'tool-call') result.toolCallChars += JSON.stringify({ name: block.name, arguments: block.arguments }).length;
    }
  }
  result.toolSchemaChars = JSON.stringify((request.tools ?? []).map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters }))).length;
  result.totalTextChars = result.systemChars + result.userChars + result.assistantChars + result.toolResultChars + result.toolCallChars + result.toolSchemaChars;
  return result;
}

export function numericUsage(value) {
  if (!value || typeof value !== 'object') return undefined;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'number' && Number.isFinite(item) && item >= 0 && /token|input|output|cache|total|reasoning/i.test(key)) result[key] = item;
    else if (item && typeof item === 'object' && /token|input|output|cache|usage|detail/i.test(key)) {
      const nested = numericUsage(item); if (nested) result[key] = nested;
    }
  }
  return Object.keys(result).length ? result : undefined;
}

export function observeModelRequests(ctx, { strategy = 'legacy', mode, rows, onUpdate } = {}) {
  if (typeof ctx.on !== 'function') return;
  return ctx.on('llm/stream', (request, next) => {
    const row = { index: rows.length + 1, strategy, mode, ...measureModelRequest(request), state: 'running' };
    rows.push(row);
    const started = performance.now();
    const notify = () => { try { onUpdate?.(structuredClone(rows)); } catch { /* Diagnostics cannot prevent a reply. */ } };
    const stream = next();
    return (async function* () {
      try {
        for await (const chunk of stream) {
          const usage = numericUsage(chunk.usage ?? (chunk.type === 'usage' ? chunk : undefined));
          if (usage) row.usage = usage;
          yield chunk;
        }
        row.state = 'completed';
      } catch (error) { row.state = 'failed'; throw error; }
      finally { row.elapsedMs = Math.round(performance.now() - started); notify(); }
    })();
  }, { prepend: true });
}
