import { XMLParser, XMLValidator } from "fast-xml-parser";
import { z } from "zod";
import type { Segment } from "@napcat-wechat/protocol";

const parser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false, // WeChat server IDs exceed Number.MAX_SAFE_INTEGER.
  trimValues: false,
  processEntities: false,
});
const quoteSchema = z.object({
  type: z.literal("57"),
  title: z.string(),
  refermsg: z.object({
    type: z.string(),
    svrid: z.string().optional(),
    fromusr: z.string().optional(),
    chatusr: z.string().optional(),
    displayname: z.string().optional(),
    content: z.string().optional(),
  }).optional(),
});
function xmlText(text: string) {
  return text.replace(/&(?:lt|gt|amp|quot|apos|#\d+|#x[\da-f]+);/gi, (entity) => {
    const named: Record<string, string> = {
      "&lt;": "<", "&gt;": ">", "&amp;": "&", "&quot;": '"', "&apos;": "'",
    };
    if (named[entity]) return named[entity];
    const code = entity[2].toLowerCase() === "x"
      ? parseInt(entity.slice(3, -1), 16)
      : Number(entity.slice(2, -1));
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
      ? String.fromCodePoint(code) : entity;
  });
}

// Preserve the existing reply envelope and current text without looking up or
// downloading its referenced content. A quote cannot manufacture an @ mention.
export function quotedMessage(content: string, peerId: string): Segment[] | undefined {
  if (Buffer.byteLength(content) > 65536) return;
  let xml = content.trim();
  for (let n = 0; n < 2 && xml.startsWith("&lt;"); n++) xml = xmlText(xml);
  if (/<!\s*(DOCTYPE|ENTITY)\b/i.test(xml) || XMLValidator.validate(xml) !== true) return;
  let parsed;
  try { parsed = parser.parse(xml); } catch { return; }
  const result = quoteSchema.safeParse(parsed?.msg?.appmsg ?? parsed?.appmsg);
  if (!result.success) return;
  const app = result.data, ref = app.refermsg, message: Segment[] = [];
  const type = Number(ref?.type);
  const quotedText = type === 1 ? xmlText(ref?.content ?? "").slice(0, 6000) : undefined;
  const senderId = ref?.chatusr || ref?.fromusr;
  message.push({
      type: "reply",
      data: {
        ...(ref?.svrid && /^[1-9]\d{0,19}$/.test(ref.svrid) ? { id: `wx:${peerId}:${ref.svrid}` } : {}),
        ...(Number.isInteger(type) ? { messageType: type } : {}),
        ...(senderId && /^[\w@.:-]{1,256}$/.test(senderId) ? { senderId } : {}),
        ...(ref?.displayname ? { senderName: xmlText(ref.displayname).slice(0, 256) } : {}),
        ...(quotedText ? { content: quotedText } : {}),
      },
  });
  message.push({ type: "text", data: { text: xmlText(app.title).slice(0, 8000) } });
  return message;
}
