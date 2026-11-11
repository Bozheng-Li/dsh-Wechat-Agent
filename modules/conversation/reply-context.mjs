import { memoryText } from "../memory/conversation/store.mjs";
import { relevantMemoryReference } from "../memory/query/tool.mjs";

const PROGRESSIVE_IMAGE_SUMMARY_CHARS = 80;

function completePrefix(text, maximum) {
  let end = Math.min(text.length, maximum);
  if (end > 0 && end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1]) && /[\uDC00-\uDFFF]/u.test(text[end])) end--;
  return text.slice(0, end);
}

function imageSummary(note, maximum, available = Infinity) {
  let result = '', count = 0;
  for (const character of note) {
    if (count >= maximum || result.length + character.length > available) break;
    result += character; count++;
  }
  return result;
}

function referenceImageSummary(image) {
  const note = image.description || image.error || '';
  let summary = imageSummary(note, PROGRESSIVE_IMAGE_SUMMARY_CHARS);
  if (summary === note) return image;
  // memoryText does not serialize descriptionTruncated. Keep an explicit
  // omission label inside this read-only projection, within the same budget.
  const suffix = '…（图片笔记有省略）';
  summary = imageSummary(note, PROGRESSIVE_IMAGE_SUMMARY_CHARS - Array.from(suffix).length) + suffix;
  return { ...image,
    ...(image.description ? { description: summary } : image.error ? { error: summary } : {}),
    descriptionTruncated: true };
}

// Storage retention and the conversation supplied to a model are different
// budgets. Older detail stays available through the scoped memory tool.
export function recentReplyHistory(history, { maxChars = 10000, maxEntries = 20, imageSummaryChars } = {}) {
  const entries = [];
  let remaining = maxChars;
  for (const entry of history.slice(-maxEntries).reverse()) {
    if (!entry || remaining < 200) continue;
    const rawText = typeof entry.text === 'string' ? entry.text : '';
    const textBudget = Math.max(0, remaining - 200);
    const text = imageSummaryChars === undefined ? rawText.slice(0, textBudget) : completePrefix(rawText, textBudget);
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
      const note = imageSummaryChars === undefined ? originalNote.slice(0, Math.min(1000, available))
        : imageSummary(originalNote, imageSummaryChars, available);
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
    entries.push({ ...entry, text, ...(entry.attachments ? { attachments } : {}), ...(omitted ? { contextOmitted: true } : {}),
      ...(imageSummaryChars === undefined ? {} : { contextTextOmitted: text !== rawText }) });
    remaining -= used;
  }
  return entries.reverse();
}

export function replyMemoryContext({ snapshot, text, longTerm = '', role, onDemand = false, ambient = false, persona, promptStrategy = 'legacy' }) {
  // The saved window is also the deletion/expiry boundary. Chat archives may
  // retain records after a memory clear; they must not silently restore them.
  // Snapshot also includes confirmed replies to earlier queued requests and
  // directly saved image notes, which the observed-message log may not contain.
  const progressive = promptStrategy === 'progressive-v1';
  const recent = recentReplyHistory(snapshot.entries.filter((entry) => entry.key !== snapshot.triggerKey),
    progressive ? { maxChars: 6000, maxEntries: 12, imageSummaryChars: PROGRESSIVE_IMAGE_SUMMARY_CHARS } : undefined);
  if (onDemand) return { history: recent, memory: undefined, mode: 'on-demand', referenceChars: 0 };
  const included = new Map(recent.map((entry) => [entry.key, entry]));
  const old = {
    ...snapshot,
    // Do not repeat the current message or complete recent messages as memory.
    entries: snapshot.entries.filter((entry) =>
      entry.key !== snapshot.triggerKey && (!included.has(entry.key) ||
        (progressive ? included.get(entry.key).contextTextOmitted : included.get(entry.key).contextOmitted)))
      // Image-only clipping must not reinsert full notes through automatic
      // memory. Preserve all message text; explicit tools retain the original
      // snapshot and can expand notes, including details outside this index.
      .map(entry => progressive && entry.attachments?.length
        ? { ...entry, attachments: entry.attachments.map(referenceImageSummary) } : entry),
  };
  const query = ambient
    ? recent.filter((entry) => entry.direction === 'incoming').slice(-3).map((entry) => entry.text).join(' ')
    : text;
  const roleText = role?.memory || '';
  const reference = relevantMemoryReference([role ? role.legacyMemory : longTerm, memoryText(old)].filter(Boolean).join('\n\n'), query, {
    maxChars: role ? Math.max(0, 3000 - roleText.length - 2) : progressive ? 3000 : 6000,
    names: [persona?.name, ...(persona?.aliases || [])].filter(Boolean),
  });
  const memory = [roleText, reference.text].filter(Boolean).join('\n\n');
  return {
    history: recent,
    memory: memory || undefined,
    mode: 'relevant',
    referenceChars: memory.length,
    matchedTerms: reference.matchedTerms,
    omitted: reference.omitted,
  };
}
