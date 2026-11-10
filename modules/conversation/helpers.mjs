export const matches = (record, selector) =>
  !selector ||
  (['accountId', 'chatType', 'peerId'].every(
    (field) => selector[field] === undefined || record[field] === selector[field]
  ) &&
    (!selector.mediaOnly || !!record.replyMedia) &&
    (!selector.assetIds || selector.assetIds.includes(record.replyMedia?.id)));
