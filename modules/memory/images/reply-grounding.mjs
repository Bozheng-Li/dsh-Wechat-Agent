/** Reuse the existing single-pass reply review only when a draft contradicts
 * concrete image evidence or unnecessarily asks for an already readable file. */
export function imageReplyFlags(input, draft) {
  const evidence = input.imageEvidence;
  if (evidence?.available !== true) return [];
  const flags = [];
  if (evidence.sent === true && /(?:我|这边)[^。！？\n]{0,12}(?:没有|没|从未)[^。！？\n]{0,18}发(?:过|给|送|图)/u.test(draft))
    flags.push('image-delivery-contradiction');
  if (evidence.visionEnabled === true && /(?:没法|没办法|无法|不能)[^。！？\n]{0,8}(?:查看|读取|看懂|判断)[^。！？\n]{0,10}(?:图|画面)/u.test(draft))
    flags.push('image-capability-contradiction');
  if (evidence.visionEnabled === true && /(?:重发|重新发|再发(?:一遍|一次|一下)|重新上传)[^。！？\n]{0,12}(?:图|照片)|(?:图|照片)[^。！？\n]{0,8}(?:重发|再发|重新上传)/u.test(draft))
    flags.push('unnecessary-image-reupload');
  return flags;
}
