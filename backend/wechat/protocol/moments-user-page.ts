import { BridgeError } from '@napcat-wechat/protocol';
import type { Moment, PageRequest } from './moments.js';

type Position = Pick<Moment, 'id' | 'createdAt'>;
interface Source { page: PageRequest; boundary?: Position; exhausted: boolean; pages: number; scanned: number }
export interface UserMomentsState {
  profile: Source; timeline: Source; pending: Moment[]; emittedIds: Set<string>; offset: number;
}
type Response = { items: Moment[]; firstPageMd5: string; session?: Buffer };
const MAX_REQUESTS = 4;
const invalid = (message: string): never => { throw new BridgeError('ERR_MOMENTS_PROTOCOL', message); };
const newestFirst = (a: Position, b: Position) => b.createdAt - a.createdAt || (a.id === b.id ? 0 : BigInt(a.id) > BigInt(b.id) ? -1 : 1);
const source = (page: PageRequest): Source => ({ page, exhausted: false, pages: 0, scanned: 0 });
const copySource = (value: Source): Source => ({ ...value, page: { ...value.page } });

/** PC user pages can omit posts still visible in the live timeline. Merge both
 * streams before assigning a recency position. Only return the prefix for which
 * both sources have been read far enough; a bounded partial scan must not promote
 * an old profile post into the missing newest position. */
export async function readUserMomentsPage(userId: string, limit: number, previous: UserMomentsState | undefined,
  request: (page: PageRequest) => Promise<Response>) {
  const state: UserMomentsState = previous ? { profile: copySource(previous.profile), timeline: copySource(previous.timeline),
    pending: [...previous.pending], emittedIds: new Set(previous.emittedIds), offset: previous.offset }
    : { profile: source({ action: 'user', userId }), timeline: source({ action: 'timeline' }), pending: [], emittedIds: new Set(), offset: 0 };
  const pending = new Map(state.pending.map(post => [post.id, post]));
  const sources = [state.profile, state.timeline]; let requests = 0;
  const fetchPage = async (stream: Source) => {
    const result = await request(stream.page); requests++;
    stream.pages++; stream.scanned += result.items.length;
    if (!result.items.length) { stream.exhausted = true; return; }
    if (stream.page.action === 'user' && result.items.some(post => post.author.userId !== userId))
      invalid('好友主页返回了其他作者的动态，未合并');
    const oldest = [...result.items].sort(newestFirst).at(-1)!;
    const maxId = result.items.reduce((id, post) => BigInt(post.id) < BigInt(id) ? post.id : id, result.items[0].id);
    if (stream.page.maxId && (BigInt(maxId) >= BigInt(stream.page.maxId) || result.items.some(post => BigInt(post.id) > BigInt(stream.page.maxId))) ||
        stream.boundary && result.items.some(post => newestFirst(post, stream.boundary!) < 0))
      invalid('朋友圈分页没有按发布时间向历史推进，未把旧动态当作最新');
    stream.boundary = { id: oldest.id, createdAt: oldest.createdAt };
    stream.page = { ...stream.page, maxId, firstPageMd5: result.firstPageMd5, session: result.session };
    for (const post of result.items) {
      if (post.author.userId !== userId || state.emittedIds.has(post.id)) continue;
      const earlier = pending.get(post.id);
      if (earlier && (earlier.author.userId !== post.author.userId || earlier.createdAt !== post.createdAt))
        invalid('同一动态在主页与动态流的作者或发布时间不一致，未选择');
      // Keep the most recently fetched interaction state for duplicates.
      pending.set(post.id, post);
    }
  };
  const isConfirmed = (post: Moment) => sources.every(stream => stream.exhausted || stream.boundary && newestFirst(post, stream.boundary) <= 0);
  const confirmed = () => [...pending.values()].filter(post => !post.deleted && isConfirmed(post)).sort(newestFirst);
  // A fresh user read must check both sources, even when the profile alone has
  // enough rows. Cursor reads continue their own frozen, requester-bound scan.
  for (const stream of sources) if (!stream.pages) await fetchPage(stream);
  while (requests < MAX_REQUESTS && confirmed().length < limit) {
    const active = sources.filter(stream => !stream.exhausted);
    if (!active.length) break;
    active.sort((a, b) => newestFirst(a.boundary!, b.boundary!));
    await fetchPage(active[0]);
  }
  const items = confirmed().slice(0, limit), offset = state.offset;
  for (const post of items) { pending.delete(post.id); state.emittedIds.add(post.id); }
  for (const [id, post] of pending) if (post.deleted && isConfirmed(post)) { pending.delete(id); state.emittedIds.add(id); }
  state.pending = [...pending.values()]; state.offset += items.length;
  const hasMore = state.pending.length > 0 || sources.some(stream => !stream.exhausted);
  return { items, state, hasMore, requests, selection: { basis: 'profile-and-timeline', order: 'createdAt-desc', offset,
    complete: items.length === limit || !hasMore, profilePages: state.profile.pages, timelinePages: state.timeline.pages,
    message: items.length < limit && hasMore
      ? '本页仅返回已核实时间顺序的动态；仍有未覆盖范围，请用 nextCursor 继续，不能用旧帖补作最新动态'
      : '已合并好友主页与当前账号可见动态流，按真实发布时间排序；仅代表微信实际返回的可见范围' } };
}
