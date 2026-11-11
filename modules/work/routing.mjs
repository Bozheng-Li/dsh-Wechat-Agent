import { ChannelError, publicError } from '../../shared/contracts.mjs';
import { readPrompt } from '../../prompts/loader.mjs';
import { workRoutingContext, guardWorkFollowup } from './routing-context.mjs';

const actions = new Set(['chat', 'new', 'continue', 'status', 'cancel']);
const intents = new Set(['execute', 'continue', 'status', 'cancel', 'chat', 'unclear']);
const targets = new Set(['none', 'unique', 'ambiguous']);

/** Validate short decision evidence, never a free-form reasoning transcript. */
export function parseWorkRoute(raw, message, tasks) {
  const invalid = () => { throw new ChannelError('WORK_ROUTE_INVALID', '模型未返回一致的工作判断与复核'); };
  let value;
  try { value = JSON.parse(String(raw).trim().replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { invalid(); }
  if (!value || Array.isArray(value) || typeof value !== 'object' ||
      Object.keys(value).some(key => !['action', 'taskId', 'review'].includes(key)) ||
      !Object.hasOwn(value, 'taskId') || !actions.has(value.action)) invalid();
  const review = value.review;
  if (!review || Array.isArray(review) || typeof review !== 'object' ||
      Object.keys(review).some(key => !['intent', 'evidence', 'target'].includes(key)) ||
      !intents.has(review.intent) || !targets.has(review.target) ||
      typeof review.evidence !== 'string' || Array.from(review.evidence).length > 240 ||
      review.evidence && !String(message).includes(review.evidence)) invalid();
  const id = value.taskId;
  if (id !== null && (typeof id !== 'string' || !tasks.some(task => task.id === id))) invalid();
  if (value.action === 'chat') {
    if (id !== null || !['chat', 'unclear'].includes(review.intent) || review.target === 'unique') invalid();
  } else {
    if (!review.evidence.trim()) invalid();
    const expectedIntent = value.action === 'new' ? 'execute' : value.action;
    if (review.intent !== expectedIntent) invalid();
    if (value.action === 'new') {
      if (id !== null || review.target !== 'none') invalid();
    } else if (value.action === 'status') {
      if (review.target !== (id === null ? 'none' : 'unique')) invalid();
    } else if (!id || review.target !== 'unique') invalid();
  }
  return { action: value.action, ...(id !== null ? { taskId: id } : {}),
    review: { intent: review.intent, evidence: review.evidence, target: review.target } };
}

/** A tool-free decision grants no authority; execution checks the live scope again. */
export async function routeWorkMessage(channel, item, signal) {
  channel.assertAllowed(item);
  channel.work.assertAllowed(item.record, signal);
  const context = workRoutingContext(channel, item);
  item.workRoutingContext = context;
  try {
    const result = await channel.runner.run({ mode: 'work-routing', tools: [],
      systemOverride: readPrompt('work/routing.md'),
      text: JSON.stringify(context),
      signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]) });
    signal.throwIfAborted();
    channel.assertAllowed(item);
    channel.work.assertAllowed(item.record, signal);
    const decision = guardWorkFollowup(parseWorkRoute(result.text, item.text, context.tasks), item.text, context);
    if (decision.taskId) channel.work.owned(decision.taskId, item.record);
    return decision;
  } catch (error) {
    signal.throwIfAborted();
    channel.assertAllowed(item);
    channel.work.assertAllowed(item.record, signal);
    if (['STATE_WRITE_FAILED', 'CONFIG_CHANGED'].includes(error?.code)) throw error;
    return { action: 'chat', fallback: publicError(error, '工作判断暂时不可用').code };
  }
}
