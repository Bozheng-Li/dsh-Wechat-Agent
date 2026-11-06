import { BridgeError } from "@napcat-wechat/protocol";
import type { AiConfig } from "./config.js";
import { publicReply } from "./public-output.js";

export type ModelMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null | ContentPart[];
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  // Native conversation blocks are round-tripped only to their originating protocol.
  providerContent?: { kind: "gemini" | "responses"; blocks: Record<string, unknown>[] };
};
export type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
export type ModelReply = Omit<ModelMessage, 'role' | 'content'> & { role: 'assistant'; content: string | null };
export type ModelTool = { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } };
export type ModelOptions = { tools?: ModelTool[]; stream?: boolean; onText?: (delta: string) => Promise<void> | void };
export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};
export const READ_TOOLS: ModelTool[] = [
  {
    type: "function",
    function: {
      name: "wechat_status",
      description: "查询当前微信连接状态，只读。",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "recent_messages",
      description:
        "查询当前授权会话最近最多 10 条本地已观察消息。群聊仅返回 @ 本账号的消息和本账号发出的消息，不是微信全部历史。",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
];

export async function modelRequest(
  c: AiConfig, messages: ModelMessage[], signal: AbortSignal,
  tools = false, options: ModelOptions = {},
): Promise<ModelReply> {
  return publicReply(filtered => rawModelRequest(c, messages, signal, tools, filtered), options);
}

async function rawModelRequest(
  c: AiConfig,
  messages: ModelMessage[],
  signal: AbortSignal,
  tools = false,
  options: ModelOptions = {},
): Promise<ModelReply> {
  if (!c.model.trim()) throw new BridgeError("ERR_AI_MODEL", "请填写模型 ID");
  const timeout = AbortSignal.timeout(c.timeoutMs);
  try {
    const response = await fetch(
      c.baseUrl.endsWith("/chat/completions")
        ? c.baseUrl
        : c.baseUrl + "/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(c.apiKey ? { Authorization: `Bearer ${c.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: c.model,
          messages,
          temperature: c.temperature,
          max_tokens: c.maxTokens,
          stream: options.stream === true,
          ...((options.tools?.length || tools) ? { tools: options.tools ?? READ_TOOLS, tool_choice: "auto" } : {}),
        }),
        signal: AbortSignal.any([signal, timeout]),
        redirect: "error",
      },
    );
    if (!response.ok) {
      const reader = response.body?.getReader(),
        parts: Uint8Array[] = [];
      let size = 0;
      if (reader)
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 8192) {
            await reader.cancel();
            break;
          }
          parts.push(value);
        }
      let providerCode = "";
      try {
        const error = JSON.parse(Buffer.concat(parts).toString("utf8"))?.error;
        providerCode = String(error?.code ?? error?.type ?? "").slice(0, 128);
      } catch {
        /* HTML/plain HTTP errors have no standardized model error code. */
      }
      const code =
        response.status === 401 || response.status === 403
          ? "AUTH"
          : /^(model_not_found|invalid_model|unsupported_model)$/.test(
                providerCode,
              )
            ? "MODEL"
            : response.status === 404
              ? "ADDRESS_OR_MODEL"
              : response.status === 400
                ? "MODEL_OR_PARAMETERS"
                : response.status === 429
                  ? "RATE_LIMIT"
                  : "HTTP";
      throw new BridgeError(
        `ERR_AI_${code}`,
        `模型服务返回 HTTP ${response.status}（${{ AUTH: "鉴权失败", MODEL: "模型不存在或不受支持", ADDRESS_OR_MODEL: "地址或模型不存在，服务未提供可区分的错误码", MODEL_OR_PARAMETERS: "模型或调用参数不受支持", RATE_LIMIT: "额度或频率限制", HTTP: "服务异常" }[code]}）`,
        { httpStatus: response.status },
      );
    }
    if (options.stream) {
      if (!response.headers.get('content-type')?.includes('text/event-stream')) throw new BridgeError('ERR_AI_STREAM', '服务未返回 SSE 流，请关闭流式或核对模型能力');
      const reader = response.body?.getReader();
      if (!reader) throw new BridgeError('ERR_AI_RESPONSE', '模型响应没有内容');
      const decoder = new TextDecoder(); let buffer = '', content = '', size = 0, finished = false;
      const calls = new Map<number, ToolCall>();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          buffer += decoder.decode(value, { stream: !done });
          buffer = buffer.replace(/\r\n/g, '\n');
          let boundary: number;
          while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            const event = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
            const data = event.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
            if (!data) continue;
            if (data === '[DONE]') { finished = true; continue; }
            const chunk = JSON.parse(data);
            if (chunk.error) throw new BridgeError('ERR_AI_STREAM', '模型在流式生成中返回错误；已发送片段不会撤回');
            const choice = chunk.choices?.[0], delta = choice?.delta;
            if (choice?.finish_reason) finished = true;
            // Only public content. reasoning/reasoning_content/thinking are never relayed.
            if (typeof delta?.content === 'string') { content += delta.content; size += Buffer.byteLength(delta.content); if (size > 65536) throw new BridgeError('ERR_AI_RESPONSE_TOO_LARGE', '模型正文超过 65536 字节，已停止生成'); await options.onText?.(delta.content); }
            for (const t of delta?.tool_calls ?? []) {
              if (!Number.isInteger(t.index) || t.index < 0 || t.index >= 4) throw new BridgeError('ERR_AI_RESPONSE', '单轮最多允许四个工具调用');
              const call = calls.get(t.index) ?? { id: '', type: 'function' as const, function: { name: '', arguments: '' } };
              call.id += t.id ?? ''; call.function.name += t.function?.name ?? ''; call.function.arguments += t.function?.arguments ?? '';
              if (call.function.arguments.length > 4096 || call.id.length > 256) throw new BridgeError('ERR_AI_RESPONSE', '工具参数过长');
              calls.set(t.index, call);
            }
          }
          if (buffer.length > 1024 * 1024) throw new BridgeError('ERR_AI_RESPONSE', '流式事件过长');
          if (done) break;
        }
      } finally { await reader.cancel(); }
      if (!finished) throw new BridgeError('ERR_AI_STREAM_INTERRUPTED', '模型流意外中断；已发送片段不会重发');
      if (!content.trim() && !calls.size) throw new BridgeError('ERR_AI_EMPTY_RESPONSE', '模型未返回正文或工具调用');
      return { role: 'assistant', content: content.trim() || null, ...(calls.size ? { tool_calls: [...calls.values()] } : {}) };
    }
    const reader = response.body?.getReader();
    if (!reader) throw new BridgeError("ERR_AI_RESPONSE", "模型响应没有内容");
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 1024 * 1024) {
        await reader.cancel();
        throw new BridgeError("ERR_AI_RESPONSE", "模型响应超过 1 MiB");
      }
      chunks.push(value);
    }
    let data;
    try {
      data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new BridgeError(
        "ERR_AI_ADDRESS",
        "地址未返回 Chat Completions JSON，请检查服务地址",
      );
    }
    const m = data?.choices?.[0]?.message;
    if (
      !m ||
      (m.content !== null &&
        m.content !== undefined &&
        typeof m.content !== "string")
    )
      throw new BridgeError("ERR_AI_RESPONSE", "模型响应格式不受支持");
    if (
      m.tool_calls !== undefined &&
      (!Array.isArray(m.tool_calls) ||
        m.tool_calls.length > 4 ||
        !m.tool_calls.every(
          (t: ToolCall) =>
            typeof t.id === "string" &&
            t.id.length <= 256 &&
            t.type === "function" &&
            typeof t.function?.name === "string" &&
            typeof t.function?.arguments === "string" &&
            t.function.arguments.length <= 4096,
        ))
    )
      throw new BridgeError("ERR_AI_RESPONSE", "工具调用格式无效");
    const content = m.content?.trim() || null;
    const contentBytes = content ? Buffer.byteLength(content) : 0;
    const reason = data.choices[0].finish_reason;
    const finishReason = ["stop", "length", "content_filter", "tool_calls", "function_call"].includes(reason) ? reason : "unknown";
    if (!content && !m.tool_calls?.length)
      throw new BridgeError(
        "ERR_AI_EMPTY_RESPONSE",
        `模型返回空回复，且没有工具调用（结束原因：${finishReason}）；未发送微信消息，未自动重试`,
        { finishReason, contentBytes, toolCallCount: 0 },
      );
    if (contentBytes > 65536)
      throw new BridgeError(
        "ERR_AI_RESPONSE_TOO_LARGE",
        `模型正文为 ${contentBytes} 字节，超过 65536 字节上限；未发送微信消息，未自动重试`,
        { finishReason, contentBytes, limitBytes: 65536 },
      );
    return {
      role: "assistant",
      content,
      ...(m.tool_calls?.length ? { tool_calls: m.tool_calls } : {}),
    };
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    throw new BridgeError(
      signal.aborted
        ? "ERR_AI_CANCELLED"
        : timeout.aborted
          ? "ERR_AI_TIMEOUT"
          : "ERR_AI_NETWORK",
      signal.aborted
        ? "任务已取消"
        : timeout.aborted
          ? "模型请求超时，未自动重试"
          : "模型服务连接失败，请检查地址和网络",
    );
  }
}
