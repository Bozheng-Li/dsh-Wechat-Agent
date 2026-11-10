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
        <div>
          <h2>{longTerm ? '长期记忆概况' : name}</h2>
          <p className="wa-help">
            {longTerm ? '自动事实仅用于来源会话，共同约定可共享。' : '近期消息与已保存摘要。'}
          </p>
        </div>
        {document.compacting || document.extracting || document.compressionQueued ? (
          <span className="wa-badge is-accent">{longTerm ? '正在整理' : document.compacting ? '正在压缩' : '等待压缩'}</span>
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
            {document.chars > document.windowChars ? '已超过窗口，等待压缩；近期原文与摘要会保留。' : '达到窗口后自动压缩，原文快照保留。'}
          </p>
        </div>
      )}
    </section>
  );
}
