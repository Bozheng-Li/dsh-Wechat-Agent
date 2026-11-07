export function MemoryOverview({ document, name, longTerm = false }) {
  const stats = longTerm
    ? [
        ['有效事实', document.factCount],
        [
          '来源会话',
          document.sections.filter((section) => section.facts.some((fact) => fact.state === 'active')).length,
        ],
        ['待整理消息', document.pendingCount],
      ]
    : [
        ['近期消息', document.entries.length],
        ['记忆字符', document.chars.toLocaleString()],
        ['已压缩', document.compressions + ' 次'],
      ];
  const ratio = longTerm ? null : Math.max(0, Math.min(100, Math.round((document.chars / document.windowChars) * 100)));
  return (
    <section
      className={'wa-memory-overview' + (longTerm ? ' is-long-term' : '')}
      aria-label={longTerm ? '长期记忆概况' : '当前会话记忆概况'}
    >
      <div className="wa-memory-overview-heading">
        <span className="wa-memory-book" aria-hidden="true">
          <svg viewBox="0 0 32 32" fill="none">
            <path
              d="M6 8.5C9.5 7.2 12.8 7.7 16 10V26C12.8 23.7 9.5 23.2 6 24.5V8.5ZM26 8.5C22.5 7.2 19.2 7.7 16 10V26C19.2 23.7 22.5 23.2 26 24.5V8.5Z"
              stroke="currentColor"
              strokeWidth="1.25"
              strokeLinejoin="round"
            />
            <path
              d="M9 12.5L13 13.5M9 16L13 17M19 13.5L23 12.5M19 17L23 16"
              stroke="currentColor"
              strokeWidth="1.25"
              strokeLinecap="round"
            />
            <path d="M22 4V9L24 7.7L26 9V4H22Z" fill="currentColor" opacity=".7" />
          </svg>
        </span>
        <div>
          <p className="wa-memory-overview-label">{longTerm ? '可以延续的记忆' : '正在查看的会话'}</p>
          <h2>{longTerm ? '重要的事，留在这里' : name}</h2>
          <p className="wa-help">
            {longTerm ? '自动事实只回到来源会话；共同约定由你决定共享。' : '近期原文与已保存摘要共同组成这份会话记忆。'}
          </p>
        </div>
        {document.compacting || document.extracting ? (
          <span className="wa-badge is-accent">{longTerm ? '正在整理' : '正在压缩'}</span>
        ) : null}
      </div>
      <dl className="wa-memory-metrics">
        {stats.map(([label, value], index) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd data-testid={!longTerm && index === 0 ? 'memory-entry-count' : undefined}>{value}</dd>
          </div>
        ))}
      </dl>
      {!longTerm && (
        <div className="wa-memory-capacity">
          <div>
            <span>窗口使用</span>
            <span>
              {document.chars.toLocaleString()} / {document.windowChars.toLocaleString()} 字
            </span>
          </div>
          <div className="wa-memory-meter" aria-hidden="true">
            <span style={{ width: ratio + '%' }} />
          </div>
          <p>
            {document.chars > document.windowChars
              ? '已超过窗口，压缩后会保留近期原文和摘要。'
              : '达到窗口后整理较旧内容，原文快照另行保留。'}
          </p>
        </div>
      )}
    </section>
  );
}
