import { memoryText } from "../memory/conversation/store.mjs";
import { relevantMemoryReference } from "../memory/query/tool.mjs";

// Storage retention and the conversation supplied to a model are different
// budgets. Older detail stays available through the scoped memory tool.
export function recentReplyHistory(history, { maxChars = 10000, maxEntries = 20 } = {}) {
  const entries = [];
  let remaining = maxChars;
  for (const entry of history.slice(-maxEntries).reverse()) {
    if (!entry || remaining < 200) continue;
    const rawText = typeof entry.text === 'string' ? entry.text : '';
    const text = rawText.slice(0, Math.max(0, remaining - 200));
    let used = text.length + 200, omitted = text !== rawText;
    const originalImages = Array.isArray(entry.attachments) ? entry.attachments : [];
    const attachments = [];
    for (const image of originalImages.slice(0, 6)) {
      // Reserve the image label, quality/source note and unknown-image text
      // before allocating its description. A second image-heavy message must
      // not overdraw the remainder left by the first one.
      const available = remaining - used - 200;
      if (available < 0) break;
      const originalNote = image.description || image.error || '';
      const note = originalNote.slice(0, Math.min(1000, available));
      const clipped = note !== originalNote;
      attachments.push({
        ...image,
        ...(image.description ? { description: note } : image.error ? { error: note } : {}),
        ...(clipped ? { descriptionTruncated: true } : {}),
      });
      used += note.length + 200;
      omitted ||= clipped;
    }
    omitted ||= attachments.length !== originalImages.length;
    if (!text && !attachments?.length) continue;
    entries.push({ ...entry, text, ...(entry.attachments ? { attachments } : {}), ...(omitted ? { contextOmitted: true } : {}) });
    remaining -= used;
  }
  return entries.reverse();
}

export function replyMemoryContext({ snapshot, text, longTerm = '', onDemand = false, ambient = false, persona, promptStrategy = 'legacy' }) {
  // The saved window is also the deletion/expiry boundary. Chat archives may
  // retain records after a memory clear; they must not silently restore them.
  // Snapshot also includes confirmed replies to earlier queued requests and
  // directly saved image notes, which the observed-message log may not contain.
  const recent = recentReplyHistory(snapshot.entries.filter((entry) => entry.key !== snapshot.triggerKey),
    promptStrategy === 'progressive-v1' ? { maxChars: 6000, maxEntries: 12 } : undefined);
  if (onDemand) return { history: recent, memory: undefined, mode: 'on-demand', referenceChars: 0 };
  const included = new Map(recent.map((entry) => [entry.key, entry]));
  const old = {
    ...snapshot,
    // Do not repeat the current message or complete recent messages as memory.
    entries: snapshot.entries.filter((entry) =>
      entry.key !== snapshot.triggerKey && (!included.has(entry.key) || included.get(entry.key).contextOmitted)),
  };
  const query = ambient
    ? recent.filter((entry) => entry.direction === 'incoming').slice(-3).map((entry) => entry.text).join(' ')
    : text;
  const reference = relevantMemoryReference([longTerm, memoryText(old)].filter(Boolean).join('\n\n'), query, {
    maxChars: promptStrategy === 'progressive-v1' ? 3000 : 6000,
    names: [persona?.name, ...(persona?.aliases || [])].filter(Boolean),
  });
  return {
    history: recent,
    memory: reference.text || undefined,
    mode: 'relevant',
    referenceChars: reference.text.length,
    matchedTerms: reference.matchedTerms,
    omitted: reference.omitted,
  };
}
