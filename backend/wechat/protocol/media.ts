import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { BridgeError, type Segment } from "@napcat-wechat/protocol";
import { bytes, fields, num, type Field } from "./wire.js";

export interface ImageDescriptor {
  messageId: string;
  kind?: 'image' | 'emoji';
  stickerMd5?: string;
  download?: { originalBytes?: number; fullBytes?: number };
  observedAt: number;
  inlineBytes: number;
  resources: {
    quality: "original" | "medium" | "thumbnail";
    reference: string;
    size?: number;
    aesKey?: string;
    md5?: string;
  }[];
  attributes: string[];
  contentEncoding?: "xml" | "escaped-xml" | "other";
  contentBytes?: number;
  inlineError?: "length-mismatch";
}

export function imageMime(b: Buffer) {
  if (b.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")))
    return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (/^GIF8[79]a$/.test(b.subarray(0, 6).toString())) return "image/gif";
  if (
    b.subarray(0, 4).toString() === "RIFF" &&
    b.subarray(8, 12).toString() === "WEBP"
  )
    return "image/webp";
  throw new BridgeError(
    "ERR_IMAGE_FORMAT",
    "图片内容不是受支持的 PNG/JPEG/GIF/WebP，不能交给模型冒充已解析",
  );
}
// AddMsg.ImgBuf (field 8) is a SKBuiltinBuffer_t (length=1, buffer=2).
// Only bytes in this very message are used. No client injection or media-directory scan.
export function observedImage(
  fs: Field[],
  content: string,
  dir: string,
  messageId: string,
): Segment {
  const id = createHash("sha256").update(messageId).digest("hex");
  mkdirSync(dir, { recursive: true });
  const attrs: Record<string, string> = {};
  let xml = content;
  for (let n = 0; n < 4; n++) {
    const previous = xml;
    xml = xml.replace(/&(?:amp|lt|gt|quot|apos|#\d{1,7}|#x[\da-f]{1,6});/gi, entity => {
      const known: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
      if (known[entity.toLowerCase()]) return known[entity.toLowerCase()];
      const value = entity.slice(2, -1), point = value[0].toLowerCase() === 'x' ? parseInt(value.slice(1), 16) : Number(value);
      return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : entity;
    });
    if (xml === previous) break;
  }
  const emoji = /<emoji\b/i.test(xml);
  const tag = /<(?:img|imgmsg|emoji)\b([^>]{0,32768})\/?\s*>/i.exec(xml)?.[1] ?? "";
  for (const m of tag.matchAll(
    /([\w]+)\s*=\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)')/g,
  ))
    attrs[m[1].toLowerCase()] = (m[2] ?? m[3])
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"');
  const descriptor: ImageDescriptor = {
    messageId,
    kind: emoji ? 'emoji' : 'image',
    ...(emoji && /^[a-f0-9]{32}$/i.test(attrs.md5 || '') ? { stickerMd5: attrs.md5.toLowerCase() } : {}),
    observedAt: Date.now(),
    inlineBytes: 0,
    attributes: Object.keys(attrs),
    resources: [],
    contentEncoding: /<(?:img|imgmsg)\b/i.test(xml)
      ? xml === content
        ? "xml"
        : "escaped-xml"
      : "other",
    contentBytes: Buffer.byteLength(content),
  };
  const fullBytes = Number(attrs.length), originalBytes = Number(attrs.hdlength);
  descriptor.download = { ...(Number.isSafeInteger(fullBytes) && fullBytes > 0 ? { fullBytes } : {}),
    ...(Number.isSafeInteger(originalBytes) && originalBytes > 0 ? { originalBytes } : {}) };
  for (const [quality, field, length] of [
    ["original", "cdnbigimgurl", attrs.hdlength ? "hdlength" : "length"],
    ["medium", "cdnmidimgurl", attrs.cdnmidimgsize ? "cdnmidimgsize" : "length"],
    ["thumbnail", "cdnthumburl", "cdnthumblength"],
  ] as const) {
    if (!attrs[field]) continue;
    const size = Number(attrs[length]);
    descriptor.resources.push({
      quality,
      reference: attrs[field],
      ...(Number.isSafeInteger(size) && size > 0 ? { size } : {}),
      ...(attrs.aeskey ? { aesKey: attrs.aeskey } : {}),
      ...(quality === "original" && /^[a-f0-9]{32}$/i.test(attrs.md5 ?? "")
        ? { md5: attrs.md5.toLowerCase() }
        : {}),
    });
  }
  if (emoji) for (const field of ['cdnurl', 'thumburl', 'externurl']) {
    if (attrs[field]) descriptor.resources.push({ quality: field === 'thumburl' ? 'thumbnail' : 'original', reference: attrs[field],
      ...(field === 'cdnurl' && /^[a-f0-9]{32}$/i.test(attrs.md5 || '') ? { md5: attrs.md5.toLowerCase() } : {}) });
  }
  const wrapped = bytes(fs, 8);
  if (wrapped.length) {
    let b: Buffer;
    try {
      const wrapper = fields(wrapped);
      b = bytes(wrapper, 2);
      const declared = num(wrapper, 1);
      if (declared !== undefined && declared !== BigInt(b.length)) {
        descriptor.inlineError = "length-mismatch";
        b = Buffer.alloc(0);
      }
    } catch {
      b = Buffer.alloc(0);
    }
    if (b.length && b.length <= 10 * 1024 * 1024) {
      try {
        imageMime(b);
        const file = path.join(dir, id + ".image");
        writeFileSync(file, b, { mode: 0o600 });
        descriptor.inlineBytes = b.length;
        writeFileSync(
          path.join(dir, id + ".json"),
          JSON.stringify(descriptor),
          { mode: 0o600 },
        );
        return { type: emoji ? 'face' : "image", data: { file, resourceId: id, ...(descriptor.stickerMd5 ? { stickerMd5: descriptor.stickerMd5 } : {}) } };
      } catch (e) {
        if (!(e instanceof BridgeError)) throw e;
      }
    }
  }
  writeFileSync(path.join(dir, id + ".json"), JSON.stringify(descriptor), {
    mode: 0o600,
  });
  return { type: emoji ? 'face' : "image", data: { file: "unavailable", resourceId: id, ...(descriptor.stickerMd5 ? { stickerMd5: descriptor.stickerMd5 } : {}) } };
}
