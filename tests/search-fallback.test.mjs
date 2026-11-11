import test from 'node:test';
import assert from 'node:assert/strict';
import { SearchService, SEARCH_CREDENTIALS, DshAgentRunner, ChannelError, webSearchTool, searchWithFallback } from '../lib/testing.js';

const source = provider => ({ sources: [{ title: provider, url: `https://example.org/${provider}`, snippet: 'Public evidence' }] });
const signal = () => new AbortController().signal;
const input = { query: 'public research comparison', maxResults: 5 };

test('a successful primary runs once with an immutable query and accurate provenance', async () => {
  const calls = [], request = structuredClone(input);
  const result = await searchWithFallback({ primary: 'tavily', request, search: async (provider, query, abort, options) => {
    calls.push({ provider, query: structuredClone(query), options }); query.query = 'changed inside provider';
    assert(!abort.aborted); return source(provider);
  } });
  assert.deepEqual(request, input); assert.equal(calls.length, 1);
  assert.equal(calls[0].options.requireCredential, false);
  assert.deepEqual(result.attempts, [{ provider: 'tavily', state: 'succeeded', sourceCount: 1 }]);
  assert.equal(result.provider, 'tavily'); assert.equal(result.fallbackUsed, false); assert.equal(result.fallbackAttempted, false);
});

test('either configured provider falls back exactly once for actionable service failures', async t => {
  for (const primary of ['dsh', 'tavily']) for (const [message, code] of [
    ['HTTP 401 private-token', 'WEB_SEARCH_AUTH_FAILED'], ['HTTP 429', 'WEB_SEARCH_RATE_LIMITED'],
    ['HTTP 503', 'WEB_SEARCH_SERVICE_FAILED'], ['no web_search_tool_result blocks', 'WEB_SEARCH_UNSUPPORTED'],
    ['connection lost', 'WEB_SEARCH_FAILED'],
  ]) await t.test(`${primary}: ${code}`, async () => {
    const calls = [], alternate = primary === 'dsh' ? 'tavily' : 'dsh';
    const result = await searchWithFallback({ primary, request: input, search: async (provider, query, _signal, options) => {
      calls.push(provider); assert.deepEqual(query, input);
      if (provider === primary) { query.query = 'provider tried to change the query'; throw new Error(message); }
      assert.equal(options.requireCredential, true); return source(provider);
    } });
    assert.deepEqual(calls, [primary, alternate]); assert.equal(result.provider, alternate);
    assert.equal(result.primaryProvider, primary); assert.equal(result.fallbackUsed, true);
    assert.equal(result.fallbackAttempted, true); assert.equal(result.attempts[0].code, code);
    assert(!JSON.stringify(result).includes('private-token'));
  });
});

test('empty primary results try the alternate but completed empty requests remain different from failures', async () => {
  const result = await searchWithFallback({ primary: 'tavily', request: input,
    search: async provider => provider === 'tavily' ? { sources: [] } : source(provider) });
  assert.equal(result.provider, 'dsh'); assert.equal(result.attempts[0].state, 'empty');
  for (const empty of ['tavily', 'dsh']) {
    const value = await searchWithFallback({ primary: 'tavily', request: input, search: async provider => {
      if (provider === empty) return { sources: [] }; throw Error('HTTP 503');
    } });
    assert.equal(value.provider, empty); assert.equal(value.sources.length, 0); assert.equal(value.attempts.length, 2);
  }
  const empty = await searchWithFallback({ primary: 'tavily', request: input, search: async () => ({ sources: [] }) });
  assert.equal(empty.provider, 'tavily'); assert.equal(empty.fallbackAttempted, true);
  let calls = 0;
  const images = await searchWithFallback({ primary: 'tavily', request: { ...input, includeImages: true }, search: async () => {
    calls++; return { sources: [], images: [{ url: 'https://example.org/image.png' }] };
  } });
  assert.equal(calls, 1); assert.equal(images.images.length, 1);
});

test('two failed requests expose safe attempts without looping or fabricated sources', async () => {
  let calls = 0;
  await assert.rejects(searchWithFallback({ primary: 'dsh', request: input, search: async () => { calls++; throw Error('HTTP 401 https://private.example/secret-key'); } }), error => {
    assert.equal(error.code, 'WEB_SEARCH_AUTH_FAILED'); assert(!error.message.includes('secret-key'));
    assert.equal(error.details.search.provider, null); assert.equal(error.details.search.fallbackAttempted, true);
    assert.deepEqual(error.details.search.attempts.map(row => row.provider), ['dsh', 'tavily']); return true;
  });
  assert.equal(calls, 2);
});

test('a provider ignoring its timeout signal cannot prevent the bounded alternate attempt', async () => {
  const calls = [], aborted = [];
  const result = await searchWithFallback({ primary: 'tavily', request: input, timeoutMs: 15,
    search: (provider, _query, abort) => {
      calls.push(provider);
      if (provider === 'dsh') return source(provider);
      abort.addEventListener('abort', () => aborted.push(abort.reason.code), { once: true });
      return new Promise(() => {});
    } });
  assert.deepEqual(calls, ['tavily', 'dsh']); assert.deepEqual(aborted, ['WEB_SEARCH_TIMEOUT']);
  assert.equal(result.attempts[0].code, 'WEB_SEARCH_TIMEOUT');
});

test('cancellation or revoked authorization stops search without contacting the alternate', async () => {
  const controller = new AbortController(), reason = new Error('caller stopped'), calls = [];
  await assert.rejects(searchWithFallback({ primary: 'tavily', request: input, signal: controller.signal,
    search: async provider => { calls.push(provider); controller.abort(reason); return source(provider); } }), error => error === reason);
  assert.deepEqual(calls, ['tavily']);
  let allowed = true, count = 0;
  await assert.rejects(searchWithFallback({ primary: 'dsh', request: input,
    assertAllowed: () => { if (!allowed) throw new ChannelError('AUTH_CHANGED', 'revoked'); },
    search: async () => { count++; allowed = false; throw new Error('HTTP 503'); } }), error => error.code === 'AUTH_CHANGED');
  assert.equal(count, 1);
  count = 0;
  await assert.rejects(searchWithFallback({ primary: 'dsh', request: input,
    search: async () => { count++; throw Object.assign(Error('cancelled'), { code: 'WEB_ABORTED' }); } }), error => error.code === 'WEB_ABORTED');
  assert.equal(count, 1);
});

function serviceFixture(primary, { response, nativeResult, missingAlternate = false } = {}) {
  const reads = [], requests = [], native = [], hostCalls = [];
  const values = { [SEARCH_CREDENTIALS.tavily]: 'fixture-tavily-only', [SEARCH_CREDENTIALS.dsh]: 'fixture-dsh-only', DEEPSEEK_API_KEY: 'fixture-chat-secret' };
  if (missingAlternate) delete values[SEARCH_CREDENTIALS[primary === 'dsh' ? 'tavily' : 'dsh']];
  class Provider {
    constructor(resolveOptions) { this.resolveOptions = resolveOptions; }
    async search(query, abort) { native.push({ query, options: this.resolveOptions(), abort }); return nativeResult ? nativeResult() : source('dsh'); }
  }
  const original = new Provider(() => ({ apiKey: 'fixture-host-secret' }));
  const service = new SearchService({ credentials: { resolve: async ref => { reads.push(ref); return values[ref] ? { value: values[ref] } : undefined; } },
    web: { searchProviders: new Map([['deepseek-official', original]]), search: async () => { hostCalls.push(true); return source('host-third'); } } },
    { fetchImpl: async (url, options) => { requests.push({ url, body: JSON.parse(options.body) }); return response ? response() : Response.json({ results: source('tavily').sources }); } });
  return { service, reads, requests, native, hostCalls, original };
}

test('both real adapters use only their own credentials across fallback, with frozen settings', async () => {
  for (const primary of ['tavily', 'dsh']) {
    const f = serviceFixture(primary, primary === 'tavily' ? { response: () => new Response('', { status: 429 }) } : { nativeResult: () => { throw Error('HTTP 503'); } });
    const config = { searchProvider: primary, tavilyBaseURL: 'https://search.example/api' }, access = f.service.forConfig(config);
    config.searchProvider = 'other'; config.tavilyBaseURL = 'https://untrusted.example';
    const result = await access.search(input, signal());
    assert.equal(result.provider, primary === 'tavily' ? 'dsh' : 'tavily');
    assert.deepEqual(f.reads, [SEARCH_CREDENTIALS[primary], SEARCH_CREDENTIALS[result.provider]]);
    assert.equal(f.requests[0].url, 'https://search.example/api/search');
    assert.equal(f.requests[0].body.api_key, 'fixture-tavily-only');
    assert.equal(f.native[0].options.apiKey, 'fixture-dsh-only');
    assert.equal(f.original.resolveOptions().apiKey, 'fixture-host-secret'); assert.equal(f.hostCalls.length, 0);
    assert(!JSON.stringify(result).includes('fixture-chat-secret'));
  }
});

test('invalid JSON, empty lists and HTTP errors fall back through the actual Tavily adapter', async t => {
  for (const [name, response] of [
    ['invalid-json', () => new Response('{')], ['missing-results', () => Response.json({ answer: 'uncited' })],
    ['empty', () => Response.json({ results: [] })], ['auth', () => new Response('', { status: 401 })],
    ['service', () => new Response('', { status: 500 })],
  ]) await t.test(name, async () => {
    const f = serviceFixture('tavily', { response });
    const result = await f.service.forConfig({ searchProvider: 'tavily' }).search(input, signal());
    assert.equal(result.provider, 'dsh'); assert.equal(f.native.length, 1); assert.equal(f.requests.length, 1);
  });
});

test('a missing alternate credential never borrows the host route or chat key', async () => {
  const f = serviceFixture('tavily', { missingAlternate: true, response: () => { throw new Error('network'); } });
  await assert.rejects(f.service.forConfig({ searchProvider: 'tavily' }).search(input, signal()), error => {
    assert.equal(error.details.search.attempts[1].code, 'WEB_PROVIDER_CREDENTIAL_MISSING'); return true;
  });
  assert.equal(f.hostCalls.length, 0); assert.equal(f.native.length, 0);
});

test('the public tool and runner report the actual alternate, not the saved default', async () => {
  const f = serviceFixture('tavily', { response: () => new Response('', { status: 429 }) });
  const runner = new DshAgentRunner({}); runner.search = f.service;
  const config = { searchProvider: 'tavily' }, tool = runner.searchTool(config); config.searchProvider = 'dsh';
  const value = JSON.parse(await tool.execute({ query: input.query }, { signal: signal() }));
  assert.equal(value.ok, true); assert.equal(value.provider, 'dsh'); assert.equal(value.fallbackUsed, true);
  assert.equal(runner.searchStatus().provider, 'dsh'); assert.equal(runner.searchStatus().primaryProvider, 'tavily');
  assert(!Object.hasOwn(runner.searchStatus(), 'query'));
  const events = [], revoked = new ChannelError('AUTH_CHANGED', 'revoked'); let checks = 0;
  const blocked = webSearchTool(() => ({ search: async () => source('dsh') }), event => events.push(event),
    { assertAllowed: () => { if (++checks > 1) throw revoked; } });
  const result = JSON.parse(await blocked.execute({ query: input.query }, { signal: signal() }));
  assert.equal(result.code, 'AUTH_CHANGED'); assert.equal(events.length, 0);
});
