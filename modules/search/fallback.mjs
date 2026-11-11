import { ChannelError } from '../../shared/contracts.mjs';
import { searchFailure } from './errors.mjs';

const names = { dsh: 'DeepSeek 原生搜索', tavily: 'Tavily 搜索' };

async function attemptSearch(search, provider, request, signal, timeoutMs, requireCredential) {
  signal?.throwIfAborted();
  const deadline = new AbortController();
  const combined = AbortSignal.any([deadline.signal, ...(signal ? [signal] : [])]);
  const timer = setTimeout(() => deadline.abort(new ChannelError('WEB_SEARCH_TIMEOUT', `${names[provider]}超时，未取得本次结果。`)), timeoutMs);
  let abort;
  const cancelled = new Promise((_, reject) => {
    abort = () => reject(combined.reason);
    combined.addEventListener('abort', abort, { once: true });
  });
  try {
    const value = await Promise.race([search(provider, structuredClone(request), combined, { requireCredential }), cancelled]);
    combined.throwIfAborted();
    return value;
  } finally {
    clearTimeout(timer);
    combined.removeEventListener('abort', abort);
  }
}

/** A configured primary and its one alternate; never retry or change a query. */
export async function searchWithFallback({ primary, search, request, signal, timeoutMs = 45000, assertAllowed = () => {} }) {
  if (!Object.hasOwn(names, primary)) throw new ChannelError('INVALID_SEARCH_CONFIG', '请选择 DeepSeek 原生搜索或 Tavily。');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new TypeError('Search timeout must be positive');
  signal?.throwIfAborted();
  const providers = [primary, primary === 'dsh' ? 'tavily' : 'dsh'];
  const query = structuredClone(request), attempts = [], failures = [];
  let empty;
  const result = (value, provider) => ({ ...value, provider, primaryProvider: primary,
    fallbackUsed: provider !== primary, fallbackAttempted: attempts.length > 1, attempts: structuredClone(attempts) });
  for (const [index, provider] of providers.entries()) {
    signal?.throwIfAborted(); assertAllowed();
    try {
      const value = await attemptSearch(search, provider, query, signal, timeoutMs, index > 0);
      signal?.throwIfAborted(); assertAllowed();
      if (!value || !Array.isArray(value.sources))
        throw new ChannelError('WEB_SEARCH_INVALID_RESULT', '搜索接口没有返回有效的来源列表。');
      const usable = value.sources.length > 0 || request.includeImages && Array.isArray(value.images) && value.images.length > 0;
      attempts.push({ provider, state: usable ? 'succeeded' : 'empty', sourceCount: value.sources.length });
      if (usable) return result(value, provider);
      empty ??= { value, provider };
    } catch (error) {
      signal?.throwIfAborted(); assertAllowed();
      const failure = searchFailure(error);
      if (failure.code === 'WEB_ABORTED' || ['CANCELLED', 'AUTH_CHANGED', 'ACCOUNT_CHANGED', 'CONFIG_CHANGED', 'WORK_NOT_AUTHORIZED', 'REMOTE_NOT_AUTHORIZED'].includes(failure.code)) throw failure;
      attempts.push({ provider, state: 'failed', code: failure.code });
      failures.push({ provider, failure });
    }
  }
  signal?.throwIfAborted();
  // An empty, completed search is still distinct from both requests failing.
  if (empty) return result(empty.value, empty.provider);
  throw new ChannelError(failures[0].failure.code,
    failures.map(({ provider, failure }) => `${names[provider]}：${failure.message}`).join('；'),
    { search: { primaryProvider: primary, provider: null, fallbackUsed: false, fallbackAttempted: true, attempts } });
}
