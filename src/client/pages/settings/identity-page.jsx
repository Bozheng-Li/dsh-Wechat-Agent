import { useEffect, useRef, useState } from 'react';
import { call } from '../../shared/rpc.mjs';
import { Glyph } from '../../components/glyph.jsx';
import { Button } from '../../components/button.jsx';
import { PageHead, Back } from '../../components/page-ui.jsx';
import { Field, FormActions } from '../../components/form-ui.jsx';

export function IdentitySettings({ connection, blocked, onSave, onBack, backLabel }) {
  const [document, setDocument] = useState(null),
    [markdown, setMarkdown] = useState('');
  const [loading, setLoading] = useState(true),
    [saving, setSaving] = useState(false),
    [refresh, setRefresh] = useState(0);
  const [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const mounted = useRef(false),
    savingRef = useRef(false),
    draftRef = useRef({ document, markdown });
  draftRef.current = { document, markdown };
  const dirty = !!document && markdown !== document.markdown,
    busy = loading || saving;
  const invalid = !markdown.trim() || markdown.length > 32000 || markdown.includes('\0');
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    const draft = draftRef.current;
    if (draft.document && draft.markdown !== draft.document.markdown) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError('');
    void call(connection, 'identity.get', {}, AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]))
      .then((value) => {
        if (controller.signal.aborted) return;
        const current = draftRef.current;
        if (current.document && current.markdown !== current.document.markdown) return;
        if (typeof value?.markdown !== 'string' || !value.revision || !value.path)
          throw new Error('未能读取完整的全局身份文件，请重新读取。');
        setDocument(value);
        setMarkdown(value.markdown);
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setError(failure.message || '全局身份文件暂时无法读取，请重试。');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [connection, refresh]);
  const save = async () => {
    if (savingRef.current || busy || blocked || !dirty || invalid || !document?.revision) return;
    savingRef.current = true;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const result = await onSave({ markdown, revision: document.revision });
      if (!result || !mounted.current) return;
      setDocument({ ...document, markdown, revision: null });
      setNotice('全局身份已保存，将从下一轮回复开始生效。');
      setRefresh((value) => value + 1);
    } catch (failure) {
      if (mounted.current) setError(failure.message || '全局身份未能保存，草稿已保留。');
    } finally {
      savingRef.current = false;
      if (mounted.current) setSaving(false);
    }
  };
  return (
    <>
      <Back label={backLabel} onClick={onBack} />
      <PageHead
        title="全局身份"
        eyebrow="SHARED PRINCIPLES"
        description="在 AGENT.md 中定义所有会话共同遵循的身份与行为，再由各会话的人设决定名字、性格和表达方式。"
      />
      {error && (
        <div className="wa-alert is-error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="wa-alert is-success" role="status">
          {notice}
        </div>
      )}
      <form
        className="wa-card wa-content-narrow"
        data-testid="agent-identity-editor"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="wa-card-heading">
          <div>
            <h2>身份与行为正文</h2>
            <p className="wa-muted">直接编辑 Markdown，保存后下一轮读取。</p>
          </div>
          <div className="wa-card-icon">
            <Glyph name="shield" />
          </div>
        </div>
        <div className="wa-note-box">
          <p>每轮先读取全局身份，再应用当前会话的人设。</p>
          <p>共同规则负责行为边界，当前人设负责性格与表达。避免在这里给所有角色规定同一种口头禅或固定回复格式。</p>
          <p>近期对话用于接话；旧记忆按相关性读取，或在需要回忆往事、偏好、约定时查阅。</p>
        </div>
        <Field
          label="全局身份 Markdown"
          id="wa-identity-markdown"
          count={markdown.length + ' / 32000'}
          help="填写共同的身份、行为准则与回复习惯。每个会话的名字、别名和角色设定在会话设置中配置。"
        >
          <textarea
            className="wa-textarea wa-persona-editor"
            id="wa-identity-markdown"
            rows={20}
            maxLength={32000}
            value={markdown}
            disabled={busy || blocked || !document?.revision}
            onChange={(event) => {
              setMarkdown(event.target.value);
              setNotice('');
            }}
          />
        </Field>
        {invalid && document && <p className="wa-help">请填写 1–32000 字的 Markdown 正文。</p>}
        <div className="wa-subsection">
          <h3>文件位置</h3>
          <div className="wa-path-value" data-testid="agent-identity-path">
            {document?.path || (loading ? '正在读取文件位置…' : '暂未读取到文件位置')}
          </div>
          <p className="wa-help">可用外部编辑器修改 AGENT.md，下一轮会读取文件中的最新内容。本页不会自动刷新正文。</p>
          <Button
            icon="refresh"
            disabled={busy || blocked || dirty}
            onClick={() => {
              setNotice('');
              setRefresh((value) => value + 1);
            }}
          >
            {loading ? '正在读取…' : '重新读取文件'}
          </Button>
          {dirty && <p className="wa-help">有未保存的草稿，保存或取消更改后可重新读取文件。</p>}
        </div>
        <FormActions
          dirty={dirty}
          busy={saving}
          disabled={blocked || loading || !document?.revision}
          invalid={invalid}
          onReset={() => {
            setMarkdown(document?.markdown || '');
            setNotice('');
          }}
          label="保存全局身份"
          hint="修改会用于下一轮回复，已有会话记录与记忆继续保留。"
        />
      </form>
    </>
  );
}
