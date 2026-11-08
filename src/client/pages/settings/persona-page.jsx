import { PERSONA_CATEGORIES, PERSONA_PRESETS } from '../../../shared/persona-presets.mjs';
import { splitLines } from '../../shared/conversations.mjs';
import { Button } from '../../components/button.jsx';
import { PageHead, Notice, Back } from '../../components/page-ui.jsx';
import { Field, FormActions } from '../../components/form-ui.jsx';

export function PersonaSettings({
  draft,
  blocked,
  busy,
  dirty,
  notice,
  onChange,
  onSave,
  onReset,
  onBack,
  backLabel,
  onBrowsePresets,
  onSelectPreset,
  presetLoad,
  onUndoPreset,
}) {
  const aliases = splitLines(draft.aliases);
  const invalid =
    !draft.name.trim() ||
    aliases.length > 12 ||
    aliases.some((alias) => alias.length > 80) ||
    draft.prompt.length > 16000;
  return (
    <>
      <Back label={backLabel} onClick={onBack} />
      <PageHead title="默认人设" eyebrow="CHARACTER STUDIO" description="写下它的性格，也写下你想听到的那种回答。" />
      <Notice notice={notice} area="persona" />
      <div className="wa-persona-studio">
        <form
          className="wa-card wa-persona-manuscript"
          onSubmit={(event) => {
            event.preventDefault();
            onSave();
          }}
        >
          <div className="wa-between">
            <h2>你希望它怎样与你相处</h2>
            <Button data-testid="browse-persona-presets" disabled={blocked} onClick={onBrowsePresets}>
              浏览完整人设
            </Button>
          </div>
          <Field label="内置人设或自定义">
            <select
              className="wa-select"
              aria-label="选择人设模板"
              value={presetLoad?.id || ''}
              disabled={blocked}
              onChange={(event) => {
                if (event.target.value) onSelectPreset(event.target.value);
              }}
            >
              <option value="">自定义人设 · 直接编辑下方正文</option>
              {PERSONA_CATEGORIES.map((category) => (
                <optgroup key={category.id} label={category.name}>
                  {PERSONA_PRESETS.filter((preset) => preset.category === category.id).map((preset) => (
                    <option key={preset.id} value={preset.id}>
                      {preset.name} · {preset.role}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </Field>
          {presetLoad && (
            <div className="wa-alert wa-persona-load-note" role="status" data-testid="preset-loaded-notice">
              <div>
                已载入「{presetLoad.label}」
                <p className="wa-help">尚未保存，可以继续改写。当前名字和昵称按你的选择保留。</p>
              </div>
              <Button disabled={blocked} onClick={onUndoPreset}>
                撤销载入
              </Button>
            </div>
          )}
          <Field
            label="人设正文"
            id="wa-persona-prompt"
            count={draft.prompt.length + ' / 16000'}
            help="身份、性格、说话习惯和示例写在一起即可。保存后用于选择默认人设的会话。"
          >
            <textarea
              className="wa-textarea wa-persona-editor"
              id="wa-persona-prompt"
              rows={20}
              maxLength={16000}
              value={draft.prompt}
              disabled={blocked}
              onChange={(event) => onChange({ ...draft, prompt: event.target.value })}
              placeholder="例如：你叫小胖，是一个松弛、机灵又靠得住的聊天搭子。日常接梗，认真问题就说清楚……"
            />
          </Field>
          <div className="wa-note-box">
            <strong>自然回复与角色口吻</strong>
            <p className="wa-help">
              人设决定词汇、节奏、态度和互动方式，全局规则减少多余套话，完成请求后自然结束。普通闲聊默认简短；诗歌、故事、代码、步骤等按实际请求保留。不会把不同角色统一改成一种助手口吻，也不编造现实经历和关系。
            </p>
          </div>
          <details className="wa-subsection">
            <summary>名字与唤醒词 · {draft.name || '未设置'}</summary>
            <p className="wa-help">这是群聊识别呼叫的名字，与上面的人设正文分开保存。</p>
            <div className="wa-form-grid">
              <Field label="Agent 名字" id="wa-persona-name">
                <input
                  className="wa-input"
                  id="wa-persona-name"
                  maxLength={80}
                  value={draft.name}
                  disabled={blocked}
                  onChange={(event) => onChange({ ...draft, name: event.target.value })}
                />
              </Field>
              <Field label="其他昵称与别名" id="wa-persona-aliases" help="每行一个或用逗号分隔，最多 12 个。">
                <textarea
                  className="wa-textarea"
                  id="wa-persona-aliases"
                  rows={2}
                  value={draft.aliases}
                  maxLength={1000}
                  disabled={blocked}
                  onChange={(event) => onChange({ ...draft, aliases: event.target.value })}
                />
              </Field>
            </div>
          </details>
          <FormActions
            dirty={dirty}
            busy={busy === 'persona.save'}
            disabled={blocked}
            invalid={invalid}
            onReset={onReset}
            label="保存默认人设"
            hint="保存后用于跟随默认人设的会话；已有会话记忆继续保留。"
          />
        </form>
        <aside className="wa-persona-guide" aria-label="人设编写提示">
          <div className="wa-persona-guide-profile">
            <span className="wa-persona-ribbon-avatar" aria-hidden="true">{Array.from(draft.name || '角色')[0]}</span>
            <span>正在编辑</span>
            <h2>{draft.name || '还没有名字'}</h2>
            <p>默认人设用于未单独设置角色的会话。</p>
          </div>
          <div className="wa-persona-guide-note">
            <span className="wa-section-number">写得具体，比写得多更有用</span>
            <h3>先定性格，再给声音</h3>
            <p>写清楚它在意什么、如何相处，以及说话的节奏。比起“幽默亲切”，一两句口吻示例更直接。</p>
            <blockquote>“又熬到这个点？行，最后陪你捋一遍，弄完就休息。”</blockquote>
            <p>也可以说明不喜欢的表达，例如避免每次结尾都追问、避免固定的客套开场。</p>
          </div>
          <div className="wa-persona-guide-scope">
            <h3>保存后用于后续回复</h3>
            <p>会话里独立设置的人设继续生效。切换人设不会清空已有记忆。</p>
          </div>
        </aside>
      </div>
    </>
  );
}
