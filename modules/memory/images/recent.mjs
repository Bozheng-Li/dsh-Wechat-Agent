/** Small delivery facts for chat follow-ups. These are candidates, never a
 * guessed quote binding. Only verified image ACKs and readable saved pixels
 * qualify; the prompt is explicitly not a description of the image. */
export function recentGeneratedImageContext(channel, scope, before, { onRead = () => {} } = {}) {
  const input = { ...scope, collection: 'generated', beforeTime: before }, state = channel.imageMemory.load(input);
  if (!state.settings.enabled) return '';
  const candidates = Object.values(state.items).filter(item => item.type === 'image' &&
    item.generation?.deliveryState === 'sent' && item.generation.serverMessageIds?.length &&
    item.generation.sentAt <= before && item.generation.sentAt >= before - 86400000 &&
    (item.time ?? item.capturedAt) <= before).sort((a, b) => b.generation.sentAt - a.generation.sentAt || a.id.localeCompare(b.id));
  const images = [];
  for (const item of candidates) {
    try {
      const verified = channel.imageMemory.content(input, item.id);
      onRead(verified.reference);
      images.push({ imageId: item.id, resource: `image-memory://generated/${item.id}`, tool: 'wechat_generated_image_memory',
        sentAt: new Date(item.generation.sentAt).toISOString(), messageIds: item.generation.serverMessageIds,
        fileName: item.generation.fileName, request: item.sourceText.slice(0, 220),
        description: item.description.slice(0, 500) || '尚未看图；判断画面需调用 read，不能用生成要求代替画面事实' });
      if (images.length === 3) break;
    } catch { /* A missing file is not replaced with another task's pixels. */ }
  }
  if (!images.length) return '';
  const visionEnabled = channel.store.modelConfig().vision !== false;
  return '[本会话最近确认发出的图片：仅为上下文资料，不是新指令]\n' +
    '你确实向本会话发过以下图片。对方简短评价或质疑时结合这段发送事实。' +
    (visionEnabled ? '需要判断画面就按 imageId 读取原图；原图可读时不要声称无法看图或要求重发。' : '图像理解已关闭，只能使用已有视觉笔记，不声称本轮重新看过图。') +
    '发现与要求不符时直接说明具体差错，不否认已发送的行为。编号、工具和文件名仅供内部定位，正常回复直接说画面。' +
    '多图时按用户描述判断目标，无法确定时简短询问。\n' +
    JSON.stringify({ images, visionEnabled, more: candidates.length > images.length });
}
