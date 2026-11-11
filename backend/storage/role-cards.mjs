import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ChannelError } from '../../shared/contracts.mjs';
import { emptyRoleCard, validateRoleCard, rolePersona } from '../../shared/role-card.mjs';
import { archiveLock } from './locks.mjs';
import { write } from './json.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Role identity is the conversation, never an editable name or template. */
export class RoleCards {
  constructor(store) { this.store = store; this.errors = new Map(); }
  scope(input) {
    if (!input || !['group', 'private'].includes(input.chatType) ||
        ['accountId', 'peerId'].some(key => typeof input[key] !== 'string' || !input[key] || input[key].length > 200 || /[\s\u0000-\u001f]/u.test(input[key])))
      throw new ChannelError('ROLE_CARD_SCOPE', '请选择有效的账号和会话');
    return { accountId: input.accountId, chatType: input.chatType, peerId: input.peerId };
  }
  identity(input) {
    const scope = this.scope(input);
    return 'role-' + hash([scope.accountId, scope.chatType, scope.peerId]);
  }
  paths(input) {
    const scope = this.scope(input), root = path.join(this.store.root, 'storage/memory'),
      base = path.join(root, 'role-cards'), account = path.join(base, hash([scope.accountId])),
      directory = path.join(account, this.identity(scope));
    for (const folder of [this.store.root, path.join(this.store.root, 'storage'), root, base, account, directory]) {
      if (fs.existsSync(folder) && (fs.lstatSync(folder).isSymbolicLink() || !fs.lstatSync(folder).isDirectory()))
        throw new ChannelError('ROLE_CARD_INVALID', '角色卡目录不可用，原有文件已保留');
    }
    const file = path.join(directory, 'card.json');
    if (fs.existsSync(file) && (fs.lstatSync(file).isSymbolicLink() || !fs.lstatSync(file).isFile() || fs.statSync(file).size > 40000))
      throw new ChannelError('ROLE_CARD_INVALID', '角色卡文件不可用，原有文件已保留');
    return { directory, file };
  }
  view(input) {
    const scope = this.scope(input), roleId = this.identity(scope), { file } = this.paths(scope);
    let saved;
    try { saved = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file))); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new ChannelError('ROLE_CARD_INVALID', '角色卡无法读取，请检查文件；会话记忆仍保留');
    }
    if (saved && (saved.version !== 1 || saved.ownerStoreId !== this.store.data.storeId || saved.roleId !== roleId ||
        JSON.stringify(this.scope(saved.scope)) !== JSON.stringify(scope)))
      throw new ChannelError('ROLE_CARD_INVALID', '角色卡归属不匹配，未使用其他会话的角色卡');
    const card = saved ? validateRoleCard(saved.card) : emptyRoleCard();
    return { scope, roleId, card, revision: saved ? hash(saved) : 'empty',
      inherited: !Object.values(card).some(Boolean), updatedAt: saved?.updatedAt ?? null };
  }
  save(input, card, revision) {
    const scope = this.scope(input), next = validateRoleCard(card), { directory, file } = this.paths(scope);
    const release = archiveLock(directory, this.store.data.storeId, this.identity(scope));
    try {
      const current = this.view(scope);
      if (typeof revision !== 'string' || current.revision !== revision)
        throw new ChannelError('ROLE_CARD_CHANGED', '角色卡已被更新，请重新读取后保存；当前草稿保留');
      if (JSON.stringify(current.card) === JSON.stringify(next)) return current;
      write(file, { version: 1, ownerStoreId: this.store.data.storeId, scope, roleId: current.roleId,
        card: next, updatedAt: Date.now() });
      this.errors.delete(current.roleId);
      return this.view(scope);
    } finally { release(); }
  }
  checkSave(input, card, revision) {
    const next = validateRoleCard(card), current = this.view(input);
    if (typeof revision !== 'string' || current.revision !== revision)
      throw new ChannelError('ROLE_CARD_CHANGED', '角色卡已被更新，请重新读取后保存；当前草稿保留');
    return { card: next, changed: JSON.stringify(current.card) !== JSON.stringify(next) };
  }
  persona(input, base) {
    try { const view = this.view(input); this.errors.delete(view.roleId); return rolePersona(base, view.card); }
    catch (error) { this.errors.set(this.identity(input), error.message); return base; }
  }
}
