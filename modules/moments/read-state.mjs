export const unavailableMoment = error => error?.code === 'ERR_MOMENTS_TARGET_UNAVAILABLE' ||
  error?.code === 'ERR_MOMENTS_REJECTED' && error.details?.ret === -2;

export function nextMomentReadFailure(previous, error, now) {
  const attempts = Math.min(10, (previous?.attempts ?? 0) + 1);
  return { code: error.code, ...(Number.isSafeInteger(error.details?.ret) ? { ret: error.details.ret } : {}),
    attempts, failedAt: now, retryAt: now + Math.min(6 * 3600000, 5 * 60000 * 2 ** (attempts - 1)),
    message: '微信暂时无法读取这条动态，已跳过；其他动态继续检查。可手动重新读取。' };
}
