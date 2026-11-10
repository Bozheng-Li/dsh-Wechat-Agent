import { useEffect, useRef, useState } from 'react';
import { call } from "../../shared/rpc.mjs";
import { Button } from "../../components/button.jsx";
import { PageHead, Back } from "../../components/page-ui.jsx";
import { Field, FormActions } from "../../components/form-ui.jsx";

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
        description="所有授权会话共同遵循的身份与行为规则。"
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
        className="wa-card wa-content-narrow wa-identity-manuscript"
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
        </div>
        <Field
          label="全局身份 Markdown"
          id="wa-identity-markdown"
          count={markdown.length + ' / 32000'}
          help="先应用全局身份，再应用默认助手的表达偏好；名字与唤醒词在默认助手中设置。"
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
        {invalid && document && <div className="wa-alert is-error" role="alert">请填写 1–32000 字的 Markdown 正文。</div>}
        <details className="wa-subsection wa-identity-file">
          <summary>文件位置与重新读取</summary>
          <div className="wa-path-value" data-testid="agent-identity-path">
            {document?.path || (loading ? '正在读取文件位置…' : '暂未读取到文件位置')}
          </div>
          <p className="wa-help">外部编辑器的更改在下一轮生效；重新读取可同步到本页。</p>
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
        </details>
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
