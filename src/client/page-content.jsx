import { PersonaLibrary } from './pages/settings/persona-library.jsx';
import { TasksPage } from './pages/tasks/page.jsx';
import { MediaLibraryPage } from './pages/media/library-page.jsx';
import { DiagnosticsPage } from './pages/diagnostics/page.jsx';
import { RecoveryPage } from './pages/recovery/page.jsx';
import { DigestsPage } from './pages/digests/page.jsx';
import { peerId, peerType, splitLines } from './shared/conversations.mjs';
import { same, personaDraft, modelDraft, storageDraft, configDraft, configPayload } from './shared/drafts.mjs';
import { call } from './shared/rpc.mjs';
import { PageHead } from './components/page-ui.jsx';
import { Overview } from './pages/overview/page.jsx';
import { Authorization } from './pages/conversations/authorization-page.jsx';
import { ConversationSettings } from './pages/conversations/settings-page.jsx';
import { SettingsIndex } from './pages/settings/page.jsx';
import { IdentitySettings } from './pages/settings/identity-page.jsx';
import { Changelog } from './pages/settings/changelog-page.jsx';
import { WorkspaceTabs } from './components/workspace-tabs.jsx';
import { MemoryWorkspace } from './pages/memory/workspace.jsx';
import { ModelSettings } from './pages/settings/model-page.jsx';
import { PersonaSettings } from './pages/settings/persona-page.jsx';
import { StorageSettings } from './pages/settings/storage-page.jsx';
import { Records } from './pages/records/page.jsx';

export function PanelContent({ connection, catalog, state }) {
  const {
    motion,
    status,
    page,
    setPage,
    memoryTab,
    setMemoryTab,
    error,
    busy,
    busyArea,
    notice,
    contacts,
    authQuery,
    setAuthQuery,
    authType,
    setAuthType,
    authTab,
    setAuthTab,
    drafts,
    personaLoad,
    setPersonaLoad,
    recordQuery,
    setRecordQuery,
    recordType,
    setRecordType,
    recordOffset,
    recordData,
    recordLoading,
    recordError,
    statusRef,
    draftsRef,
    workspaceRef,
    rows,
    detail,
    recordRows,
    recordSelected,
    setDraft,
    action,
    navigate,
    loadPersonaPreset,
    undoPersonaPreset,
    back,
    backLabel,
    openDetail,
    selectRecord,
    holdRecordPosition,
    changeRecordPage,
    refreshRecords,
    openRecords,
    saveSettings,
    grant,
    blocked,
    navPage,
    warning,
  } = state;
  let content;

  if (!status || !drafts.persona || !drafts.model || !drafts.storage)
    content = (
      <>
        <PageHead title="微信 Agent" description="正在读取你的工作台…" />
        <div className="wa-card wa-loading-block">
          <div className="wa-skeleton" style={{ width: '42%' }} />
          <div className="wa-skeleton" style={{ width: '78%' }} />
          <div className="wa-skeleton" />
        </div>
      </>
    );
  else if (page === 'overview')
    content = <Overview status={status} busy={busy} blocked={blocked} onAction={action} onNavigate={navigate} />;
  else if (['diagnostics', 'digests'].includes(page)) {
    const Page = { diagnostics: DiagnosticsPage, digests: DigestsPage }[page];
    content = (
      <Page
        key={page + ':' + (status.account?.id || 'offline')}
        rpc={(endpoint, payload, signal) => call(connection, endpoint, payload, signal || AbortSignal.timeout(300000))}
        status={status}
        onNavigate={navigate}
      />
    );
  } else if (page === 'authorization')
    content = (
      <Authorization
        key={status.account?.id || 'offline'}
        status={status}
        rows={rows}
        contacts={contacts}
        query={authQuery}
        setQuery={setAuthQuery}
        type={authType}
        setType={setAuthType}
        tab={authTab}
        setTab={setAuthTab}
        blocked={blocked}
        busy={busy}
        notice={notice}
        onAction={action}
        onGrant={grant}
        onDetail={openDetail}
        onToggle={(enabled) =>
          saveSettings(
            { ...statusRef.current.settings, enabled },
            {
              area: 'authorization',
              text: enabled ? '自动回复已开启，开始处理之后收到的新消息。' : '自动回复已暂停，授权与记录继续保留。',
            }
          )
        }
      />
    );
  else if (page === 'settings') content = <SettingsIndex status={status} onNavigate={navigate} />;
  else if (page === 'identity')
    content = (
      <IdentitySettings
        connection={connection}
        blocked={blocked}
        onSave={(payload) => action('identity.save', payload, { area: 'identity' })}
        onBack={back}
        backLabel={backLabel}
      />
    );
  else if (page === 'changelog') content = <Changelog connection={connection} onBack={() => setPage('settings')} />;
  else if (page === 'model')
    content = (
      <ModelSettings
        connection={connection}
        catalog={catalog}
        status={status}
        draft={drafts.model}
        prompt={drafts.prompt}
        blocked={blocked}
        busy={busyArea === 'model' ? busy : ''}
        notice={notice}
        modelDirty={!same(drafts.model, modelDraft(status.modelConfig))}
        promptDirty={drafts.prompt !== (status.settings?.prompt || '')}
        onModelChange={(value) => setDraft('model', value)}
        onModelSave={() =>
          action(
            'model.configure',
            {
              modelConfig: {
                vision: draftsRef.current.model.vision,
                visionModel: draftsRef.current.model.visionModel,
                webSearch: draftsRef.current.model.webSearch,
                searchProvider: draftsRef.current.model.searchProvider,
                tavilyBaseURL: draftsRef.current.model.tavilyBaseURL,
                maxTokens:
                  draftsRef.current.model.maxTokens.trim() === '' ? null : Number(draftsRef.current.model.maxTokens),
                temperature:
                  draftsRef.current.model.temperature.trim() === ''
                    ? null
                    : Number(draftsRef.current.model.temperature),
              },
            },
            { area: 'model', force: ['model'], text: '生成参数已保存，从下一个任务开始生效。' }
          )
        }
        onModelReset={() => setDraft('model', modelDraft(status.modelConfig))}
        onPromptChange={(value) => setDraft('prompt', value)}
        onPromptSave={() =>
          saveSettings(
            { ...statusRef.current.settings, prompt: draftsRef.current.prompt },
            { area: 'model', force: ['prompt'], text: '当前账号的补充回复要求已保存。' }
          )
        }
        onPromptReset={() => setDraft('prompt', status.settings?.prompt || '')}
        onSearchCredential={(provider, apiKey) =>
          action(
            'search.credentials',
            { provider, apiKey },
            { area: 'model', text: '搜索密钥已保存，之后的查询使用新凭据。' }
          )
        }
        onSelect={(selection) =>
          action(
            'model.select',
            { selection },
            {
              area: 'model',
              text: selection
                ? '回复模型与推理强度设置已保存，从下一个任务开始生效。'
                : '已跟随 DSH 默认模型，从下一个任务开始生效。',
            }
          )
        }
        onBack={back}
        backLabel={backLabel}
        onNavigate={navigate}
      />
    );
  else if (page === 'persona')
    content = (
      <PersonaSettings
        draft={drafts.persona}
        blocked={blocked}
        busy={busyArea === 'persona' ? busy : ''}
        dirty={!same(drafts.persona, personaDraft(status.persona))}
        notice={notice}
        onChange={(value) => setDraft('persona', value)}
        onSave={() =>
          action(
            'persona.save',
            {
              persona: {
                ...draftsRef.current.persona,
                name: draftsRef.current.persona.name.trim(),
                aliases: splitLines(draftsRef.current.persona.aliases),
              },
            },
            { area: 'persona', force: ['persona'], text: '人设已保存，将用于之后开始的回复任务。' }
          )
        }
        onReset={() => {
          setDraft('persona', personaDraft(status.persona));
          setPersonaLoad(null);
        }}
        onBack={back}
        backLabel={backLabel}
        onBrowsePresets={() => navigate('persona-library', 'persona')}
        onSelectPreset={(id) => loadPersonaPreset(id, true)}
        presetLoad={personaLoad}
        onUndoPreset={undoPersonaPreset}
      />
    );
  else if (page === 'persona-library')
    content = (
      <PersonaLibrary
        draft={drafts.persona}
        blocked={blocked}
        onBack={() => setPage('persona')}
        onLoad={loadPersonaPreset}
      />
    );
  else if (page === 'storage')
    content = (
      <StorageSettings
        status={status}
        draft={drafts.storage}
        blocked={blocked}
        busy={busyArea === 'storage' ? busy : ''}
        dirty={!same(drafts.storage, storageDraft(status.storage))}
        notice={notice}
        onChange={(value) => setDraft('storage', value)}
        onSave={() =>
          action(
            'storage.save',
            { storage: { basePath: draftsRef.current.storage.basePath.trim() } },
            {
              area: 'storage',
              force: ['storage'],
              text: '全局工作目录已应用，插件数据已整理到新位置；旧目录继续保留。',
            }
          )
        }
        onReset={() => setDraft('storage', storageDraft(status.storage))}
        onBack={back}
        backLabel={backLabel}
      />
    );
  else if (page === 'conversation')
    content = (
      <ConversationSettings
        peer={detail}
        draft={drafts.conversation}
        status={status}
        blocked={blocked}
        busy={busyArea === 'conversation' ? busy : ''}
        notice={notice}
        dirty={!same(drafts.conversation, configDraft(detail?.config, status.persona))}
        onChange={(value) => setDraft('conversation', value)}
        onSave={() =>
          action(
            'conversation.configure',
            {
              accountId: status.account.id,
              chatType: peerType(detail),
              peerId: peerId(detail),
              config: configPayload(draftsRef.current.conversation),
            },
            { area: 'conversation', force: ['conversation'], text: '此会话的设置已保存，之后的回复使用新设置。' }
          )
        }
        onReset={() => setDraft('conversation', configDraft(detail?.config, status.persona))}
        onBack={() => setPage('authorization')}
        onNavigate={navigate}
        onRecords={openRecords}
        onRevoke={(peer) => grant(peer, false)}
        onResumeNatural={(blockedKey) =>
          action(
            'natural.resume',
            {
              accountId: status.account.id,
              chatType: peerType(detail),
              peerId: peerId(detail),
              blockedKey,
              confirmReviewed: true,
            },
            { area: 'conversation', text: '已恢复主动参与，将按当前间隔安排新机会；此前消息不会自动重发。' }
          )
        }
      />
    );
  else if (page === 'memory')
    content = (
      <MemoryWorkspace
        key={status.account?.id || 'offline'}
        tab={memoryTab}
        setTab={setMemoryTab}
        rpc={(endpoint, payload, signal) =>
          call(
            connection,
            endpoint,
            payload,
            signal ||
              AbortSignal.timeout(
                ['memory.compress', 'memory.retryImages', 'memory.global.extract', 'memory.images.import'].includes(
                  endpoint
                )
                  ? 300000
                  : 30000
              )
          )
        }
        status={status}
        rows={recordRows}
        initialPeer={detail}
      />
    );
  else if (page === 'assets')
    content = (
      <MediaLibraryPage
        key={status.account?.id || 'offline'}
        rpc={(endpoint, payload, signal) =>
          call(
            connection,
            endpoint,
            payload,
            signal || AbortSignal.timeout(endpoint === 'assets.describe' ? 300000 : 30000)
          )
        }
        status={status}
      />
    );
  else if (page === 'tasks')
    content = (
      <TasksPage
        key={status.account?.id || 'offline'}
        rpc={(endpoint, payload, signal) => call(connection, endpoint, payload, signal || AbortSignal.timeout(30000))}
        status={status}
        rows={rows}
        initialPeer={detail}
      />
    );
  else if (page === 'records')
    content = (
      <Records
        rows={recordRows}
        selected={recordSelected}
        onSelect={selectRecord}
        query={recordQuery}
        setQuery={setRecordQuery}
        type={recordType}
        setType={setRecordType}
        data={recordData}
        loading={recordLoading}
        error={recordError}
        offset={recordOffset}
        onOffset={changeRecordPage}
        onRefresh={refreshRecords}
        onInspect={holdRecordPosition}
        blocked={blocked}
        processing={status.processing}
        notice={notice}
        onCancelAll={() => action('cancel', {}, { area: 'records', text: '已取消全部会话的当前任务和等待任务。' })}
        onCancel={() =>
          recordSelected &&
          action(
            'cancel',
            { accountId: status.account.id, chatType: peerType(recordSelected), peerId: peerId(recordSelected) },
            { area: 'records', text: '已取消此会话的当前任务和等待任务，其他会话继续处理。' }
          )
        }
      />
    );
  else if (page === 'recovery')
    content = (
      <RecoveryPage
        key={status.account?.id || 'offline'}
        rpc={(endpoint, payload, signal) => call(connection, endpoint, payload, signal || AbortSignal.timeout(300000))}
        status={status}
      />
    );
  if (status && ['records', 'recovery'].includes(page)) {
    const active = page === 'recovery' ? 'recovery' : 'history';
    content = (
      <>
        <WorkspaceTabs
          name="records"
          label="处理记录分类"
          className="wa-records-tabs"
          tabs={[
            ['history', '处理记录', '查看消息、任务与发送结果'],
            ['recovery', '发送恢复', '核对回执与整理恢复项'],
          ]}
          active={active}
          onChange={(id) => navigate(id === 'recovery' ? 'recovery' : 'records')}
        />
        <div
          id="wa-records-panel-history"
          role="tabpanel"
          aria-labelledby="wa-records-tab-history"
          hidden={active !== 'history'}
        >
          {active === 'history' && content}
        </div>
        <div
          id="wa-records-panel-recovery"
          role="tabpanel"
          aria-labelledby="wa-records-tab-recovery"
          hidden={active !== 'recovery'}
        >
          {active === 'recovery' && content}
        </div>
      </>
    );
  }

  return content;
}
