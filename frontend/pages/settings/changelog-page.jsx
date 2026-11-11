import React, { useEffect, useMemo, useState } from 'react';
import { call } from "../../shared/rpc.mjs";
import { Button } from "../../components/button.jsx";
import { PageHead, Empty, Back } from "../../components/page-ui.jsx";

export function Changelog({ connection, onBack }) {
  const [markdown, setMarkdown] = useState(null),
    [error, setError] = useState(''),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setMarkdown(null);
    setError('');
    void call(connection, 'changelog', {}, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setMarkdown(typeof value?.markdown === 'string' ? value.markdown : '');
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(error.message);
      });
    return () => controller.abort();
  }, [connection, revision]);
  const blocks = useMemo(() => {
    if (!markdown) return [];
    return markdown
      .trim()
      .split(/\r?\n\s*\r?\n/)
      .filter((block) => !/^#\s+更新日志\s*$/.test(block))
      .map((block, index) => {
        const lines = block.split(/\r?\n/),
          heading = /^(#{1,6})\s+(.+)$/.exec(block);
        if (heading) return React.createElement(heading[1].length <= 2 ? 'h2' : 'h3', { key: index }, heading[2]);
        if (lines.every((line) => /^\s*[-*]\s+/.test(line)))
          return (
            <ul key={index}>
              {lines.map((line, row) => (
                <li key={row}>{line.replace(/^\s*[-*]\s+/, '')}</li>
              ))}
            </ul>
          );
        return <p key={index}>{block}</p>;
      });
  }, [markdown]);
  return (
    <>
      <Back onClick={onBack} />
      <PageHead icon="history" title="更新日志" description="查看插件的版本变化与更新记录。" />
      <article className="wa-content-narrow wa-changelog" data-testid="changelog-content">
        {error ? (
          <div className="wa-alert is-error" role="alert">
            <p>{error}</p>
            <Button icon="refresh" onClick={() => setRevision((value) => value + 1)}>
              重新读取更新日志
            </Button>
          </div>
        ) : markdown === null ? (
          <p className="wa-help" role="status">
            正在读取更新日志…
          </p>
        ) : blocks.length ? (
          blocks
        ) : (
          <Empty icon="history" title="暂无更新记录" description="当前插件包暂未提供更新日志。" />
        )}
      </article>
    </>
  );
}
