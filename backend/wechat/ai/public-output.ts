import { BridgeError } from "@napcat-wechat/protocol";
import type { ModelOptions, ModelReply } from "./types.js";

// Some compatible services put explicitly marked reasoning in content instead
// of their reasoning field. Keep a partial tag until its next stream fragment.
// Code examples stay literal; ordinary prose is never deleted by heuristics.
export class PublicTextFilter {
  private pending = "";
  private hidden: string[] = [];
  private code = 0;

  push(delta: string, final = false): string {
    this.pending += delta;
    let output = "", i = 0;
    while (i < this.pending.length) {
      const rest = this.pending.slice(i);
      if (!this.hidden.length && rest[0] === "`") {
        const count = /^`+/.exec(rest)![0].length;
        if (!final && count === rest.length) break;
        if (!this.code) this.code = count;
        else if (this.code === count) this.code = 0;
        output += rest.slice(0, count); i += count; continue;
      }
      if (!this.code && rest[0] === "<") {
        const end = rest.indexOf(">"), lower = rest.toLowerCase();
        if (end < 0 && rest.length <= 512 &&
          ["think", "thinking", "analysis", "reasoning"].some(name =>
            [`<${name}`, `</${name}`].some(tag => tag.startsWith(lower) || lower.startsWith(tag)))) {
          if (!final) break;
          // An unfinished private marker must not become visible on completion.
          i = this.pending.length; break;
        }
        const tag = end >= 0 ? /^<(\/?)(think|thinking|analysis|reasoning)(?:\s[^<>]{0,480})?>$/i.exec(rest.slice(0, end + 1)) : null;
        if (tag) {
          const name = tag[2].toLowerCase();
          if (!tag[1]) this.hidden.push(name);
          else {
            const level = this.hidden.lastIndexOf(name);
            if (level >= 0) this.hidden.length = level;
          }
          i += end + 1; continue;
        }
      }
      if (!this.hidden.length) output += this.pending[i];
      i++;
    }
    this.pending = this.pending.slice(i);
    return output;
  }
}

export function publicText(text: string) {
  return new PublicTextFilter().push(text, true).trim();
}

export async function publicReply(
  request: (options: ModelOptions) => Promise<ModelReply>, options: ModelOptions,
): Promise<ModelReply> {
  const filter = new PublicTextFilter();
  const reply = await request({ ...options, onText: async delta => {
    const value = filter.push(delta);
    if (value) await options.onText?.(value);
  } });
  const tail = filter.push("", true);
  if (tail) await options.onText?.(tail);
  const content = publicText(reply.content ?? "") || null;
  if (!content && !reply.tool_calls?.length)
    throw new BridgeError("ERR_AI_EMPTY_RESPONSE", "模型未返回可发送的最终正文，未发送微信消息");
  return { ...reply, content };
}

export { wechatReplyInstructions } from "../../../prompts/reply/delivery.mjs";
