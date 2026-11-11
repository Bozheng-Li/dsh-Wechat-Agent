import { ChannelError } from '../../shared/contracts.mjs';
import { prepareWechatImageStream } from '../media/wechat-image-stream.mjs';

export function prepareMomentsVisionImage(bytes) {
  try { return prepareWechatImageStream(bytes); }
  catch (error) {
    if (error?.code === 'WECHAT_IMAGE_INVALID')
      throw new ChannelError('MOMENTS_IMAGE_INVALID', '朋友圈图片数据不完整，未把损坏图片用于评论');
    throw error;
  }
}
