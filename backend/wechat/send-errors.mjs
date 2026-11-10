// Only known protocol explanations and numeric server status cross IPC.
// Unexpected transport messages can contain credentials or packet contents.
const protocolMessages = new Map([
  ...[
    '图片上传回执缺少状态，发送结果未知，请勿自动重发',
    '图片上传回执的客户端标识或收发会话不匹配，发送结果未知',
    '图片上传回执的长度或分片位置不匹配，发送结果未知',
    '图片上传结束但缺少微信消息 ID，发送结果未知，请勿自动重发',
    '图片上传缺少最终确认，发送结果未知',
  ].map(message => [message, message]),
  ['Longlink response account/command mismatch', '微信回执的账号或请求类型不匹配，发送结果未知'],
  ['Longlink checksum mismatch', '微信回执校验未通过，发送结果未知'],
  ['SendMsg ACK is missing its message ID or matching client IDs', '文字回执缺少匹配的消息 ID，发送结果未知'],
]);
export function publicSendErrorMessage(error) {
  const ret = error?.details?.ret;
  const status = Number.isSafeInteger(ret) && ret >= -0x80000000 && ret <= 0x7fffffff ? `（ret=${ret}）` : '';
  if (error?.code === 'ERR_PROTOCOL') return (protocolMessages.get(error.message) ?? '微信回执协议校验未通过，发送结果未知') + status;
  if (error?.code === 'ERR_SEND_REJECTED') return '微信服务端拒绝接收消息' + status;
  if (['ERR_REQUEST_TIMEOUT', 'ERR_ACK_TIMEOUT'].includes(error?.code)) return '等待微信回执超时，发送结果未知，未自动重发';
  if (error?.code === 'ERR_CONNECTION_CLOSED') return '微信连接已断开，请核对已有回执，未自动重发';
  return undefined;
}
