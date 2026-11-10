import { promptText } from '../loader.mjs';

export const needsClearerImage = (image) =>
  image.type === 'image' && !!image.description && !['original', 'full'].includes(image.quality);
export function memoryText(doc) {
  const rows = doc.entries.map((entry) =>
    JSON.stringify({
      time: entry.time,
      speaker: entry.senderName || entry.senderId,
      senderId: entry.senderId,
      direction: entry.direction,
      text: entry.text,
      ...(entry.attachments?.length
        ? {
            images: entry.attachments.map((image) => ({
              type: image.type,
              description:
                image.type === 'face'
                  ? promptText("conversation/templates.json", "conversation-store-description-1")
                  : image.description || image.error || promptText("conversation/templates.json", "conversation-store-description-2"),
              ...(image.quality ? { quality: image.quality } : {}),
              ...(image.quality === 'thumbnail'
                ? { sourceNote: promptText("conversation/templates.json", "conversation-store-sourceNote-3") }
                : needsClearerImage(image)
                  ? { sourceNote: promptText("conversation/templates.json", "conversation-store-sourceNote-4") }
                  : {}),
            })),
          }
        : {}),
    })
  );
  return [
    doc.summary && `已保存的会话记忆（压缩摘要，可能有信息损耗）：\n${doc.summary}`,
    rows.length && `最近的会话原文（按接收顺序）：\n${rows.join('\n')}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}
