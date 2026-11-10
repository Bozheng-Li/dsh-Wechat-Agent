export type ModelMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null | ContentPart[];
  tool_calls?: ToolCall[];
  tool_call_id?: string;
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
