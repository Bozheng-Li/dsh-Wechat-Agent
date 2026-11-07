import { useEffect, useMemo, useRef, useState } from 'react';
import {
  PERSONA_CATEGORIES,
  PERSONA_PRESETS,
  getPersonaPreset,
  searchPersonaPresets,
} from '../../../shared/persona-presets.mjs';

function Copy({ text }) {
  return text
    .split('\n')
    .filter(Boolean)
    .map((paragraph, index) => <p key={index}>{paragraph}</p>);
}
function Back({ children, onClick }) {
  return (
    <button type="button" className="wa-back" onClick={onClick}>
      <span aria-hidden="true">←</span>
      {children}
    </button>
  );
}
function Emblem({ preset }) {
  const category = PERSONA_CATEGORIES.find((item) => item.id === preset.category);
  return (
    <span className="wa-persona-emblem" style={{ '--persona-color': category.color }} aria-hidden="true">
      {preset.name.slice(-1)}
    </span>
  );
}

export function PersonaLibrary({ draft, blocked, onBack, onLoad }) {
  const [query, setQuery] = useState(''),
    [category, setCategory] = useState('all'),
    [selectedId, setSelectedId] = useState(null);
  const [keepIdentity, setKeepIdentity] = useState(() => !!draft.name.trim() && draft.name !== '微信助手');
  const root = useRef(null),
    selected = getPersonaPreset(selectedId);
  const filtered = useMemo(() => searchPersonaPresets(query, category), [query, category]);
  useEffect(() => {
    root.current?.closest('.wa-workspace')?.scrollTo({ top: 0, left: 0 });
  }, [selectedId]);

  if (selected) {
    const group = PERSONA_CATEGORIES.find((item) => item.id === selected.category);
    return (
      <div ref={root} className="wa-persona-library" data-testid="persona-preset-preview" data-preset-id={selected.id}>
        <Back onClick={() => setSelectedId(null)}>返回人设库</Back>
        <header className="wa-page-head wa-persona-preview-head">
          <Emblem preset={selected} />
          <div>
            <p className="wa-eyebrow">{group.name} · 内置人设</p>
            <h1>
              {selected.name}
              <span>{selected.role}</span>
            </h1>
            <p className="wa-muted">{selected.summary}</p>
          </div>
        </header>
        <div className="wa-persona-preview-layout">
          <div className="wa-persona-copy">
            <section className="wa-card">
              <h2>角色背景</h2>
              <Copy text={selected.background} />
            </section>
            <section className="wa-card">
              <h2>性格与互动方式</h2>
              <Copy text={selected.personality} />
            </section>
            <section className="wa-card">
              <h2>语言与表达风格</h2>
              <Copy text={selected.style} />
            </section>
            <section className="wa-card wa-persona-examples">
              <h2>语气示例</h2>
              <p className="wa-help">示例用于说明说话方式，实际回复会结合当前对话。</p>
              {selected.examples.map((example) => (
                <article className="wa-persona-example" key={example.scene}>
                  <h3>{example.scene}</h3>
                  <p className="wa-persona-example-question">
                    <span>对方</span>
                    {example.message}
                  </p>
                  <p className="wa-persona-example-reply">
                    <span>示例回应</span>
                    {example.reply}
                  </p>
                </article>
              ))}
            </section>
          </div>
          <aside className="wa-card wa-persona-apply" aria-label="载入这套人设">
            <p className="wa-eyebrow">这一次，换种相处方式</p>
            <h2>把它变成你的 Agent</h2>
            <div className="wa-persona-tags">
              {selected.tags.map((tag) => (
                <span key={tag}>{tag}</span>
              ))}
            </div>
            <p className="wa-persona-suitable">{selected.suitableFor}</p>
            <label className="wa-persona-identity" htmlFor="wa-preset-keep-identity">
              <input
                id="wa-preset-keep-identity"
                type="checkbox"
                checked={keepIdentity}
                disabled={blocked || !draft.name.trim()}
                onChange={(event) => setKeepIdentity(event.target.checked)}
              />
              <span>
                保留当前名字与昵称
                <small>{keepIdentity ? draft.name : '使用「' + selected.name + '」及其内置昵称'}</small>
              </span>
            </label>
            <button
              type="button"
              className="wa-button wa-primary"
              data-testid="load-persona-preset"
              disabled={blocked}
              onClick={() => onLoad(selected.id, keepIdentity)}
            >
              载入到人设编辑器
            </button>
            <p className="wa-help">载入后可继续调整，点击“保存人设”后才用于新回复。</p>
            <p className="wa-help">当前未保存的草稿会被替换，返回编辑器后可以撤销载入。</p>
            <div className="wa-persona-scope">当前 Agent 的授权会话共用这套人设，各群的回复模式仍单独设置。</div>
          </aside>
        </div>
      </div>
    );
  }

  return (
    <div ref={root} className="wa-persona-library" data-testid="persona-library">
      <Back onClick={onBack}>返回人设设置</Back>
      <header className="wa-page-head">
        <div>
          <p className="wa-eyebrow">PERSONA COLLECTION</p>
          <h1>内置人设库</h1>
          <p className="wa-muted">{PERSONA_PRESETS.length} 套不同的相处方式。先读一读，再选一套慢慢打磨。</p>
        </div>
        <span className="wa-persona-total">{PERSONA_CATEGORIES.length} 类风格</span>
      </header>
      <div className="wa-persona-toolbar">
        <div className="wa-search">
          <svg
            viewBox="0 0 24 24"
            className="wa-icon wa-icon-small"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            aria-hidden="true"
          >
            <circle cx="10.5" cy="10.5" r="6.5" />
            <path d="m16 16 4.5 4.5" />
          </svg>
          <input
            className="wa-input"
            type="search"
            aria-label="搜索内置人设"
            data-testid="persona-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索名字、性格或场景，例如：傲娇、写作"
          />
          {query && (
            <button type="button" className="wa-search-clear" aria-label="清空人设搜索" onClick={() => setQuery('')}>
              ×
            </button>
          )}
        </div>
        <div className="wa-persona-filters" role="group" aria-label="人设类型">
          {[{ id: 'all', name: '全部' }, ...PERSONA_CATEGORIES].map((item) => (
            <button
              type="button"
              key={item.id}
              className="wa-persona-filter"
              data-category={item.id}
              aria-pressed={category === item.id}
              onClick={() => setCategory(item.id)}
            >
              {item.name}
            </button>
          ))}
        </div>
      </div>
      <p className="wa-persona-results" role="status">
        {filtered.length} 套人设
        {category !== 'all'
          ? ' · ' + PERSONA_CATEGORIES.find((item) => item.id === category)?.description
          : ' · 完整背景、互动习惯与语气示例'}
      </p>
      <div className="wa-persona-grid">
        {filtered.map((preset) => {
          const group = PERSONA_CATEGORIES.find((item) => item.id === preset.category);
          return (
            <button
              type="button"
              className="wa-persona-card"
              key={preset.id}
              data-preset-id={preset.id}
              aria-label={'预览' + preset.name + ' · ' + preset.role}
              onClick={() => setSelectedId(preset.id)}
            >
              <div className="wa-persona-card-top">
                <span className="wa-persona-heading">
                  <span className="wa-persona-category">{group.name}</span>
                  <strong>{preset.name}</strong>
                  <span className="wa-persona-role">{preset.role}</span>
                </span>
                <Emblem preset={preset} />
              </div>
              <p>{preset.summary}</p>
              <div className="wa-persona-card-meta">
                <div className="wa-persona-tags">
                  {preset.tags.map((tag) => (
                    <span key={tag}>{tag}</span>
                  ))}
                </div>
                <span className="wa-persona-arrow" aria-hidden="true">
                  ↗
                </span>
              </div>
            </button>
          );
        })}
      </div>
      {!filtered.length && (
        <div className="wa-empty">
          <h3>没有找到匹配的人设</h3>
          <p>可以换一个性格词，或查看全部类型。</p>
          <button
            type="button"
            className="wa-button"
            onClick={() => {
              setQuery('');
              setCategory('all');
            }}
          >
            查看全部人设
          </button>
        </div>
      )}
    </div>
  );
}
