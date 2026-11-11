export function MessageReferences({ references }) {
  if (!references?.length) return null;
  return (
    <section className="wa-record-answer" data-testid="record-message-references">
      <h3>引用消息</h3>
      {references.map((ref, index) => (
        <div key={index}>
          <p className="wa-help">{ref.senderName || ref.senderId || '原发言者未提供'} · {ref.messageType === 3 ? '图片' : ref.messageType === 1 ? '文字' : '引用消息'}</p>
          {ref.content && <p className="wa-record-reply">{ref.content}</p>}
          {ref.images?.length ? ref.images.map(image => (
            <div key={image.collection + image.id}>
              <p className="wa-record-reply">{image.description || '图片已保存，尚未按需理解。'}</p>
              <p className="wa-help">{image.collection === 'generated' ? '生成图片记忆' : '会话图片记忆'}{image.quality === 'thumbnail' ? ' · 当前仅有缩略图' : ''}</p>
              <p className="wa-record-reply wa-mono">image-memory://{image.collection}/{image.id}</p>
            </div>
          )) : ref.messageType === 3 && <p className="wa-record-reply">{ref.unavailable || '尚未关联原图，保留原消息编号以便查找。'}</p>}
          <p className="wa-help">原消息编号：{ref.messageId || '微信未提供'}</p>
        </div>
      ))}
    </section>
  );
}
