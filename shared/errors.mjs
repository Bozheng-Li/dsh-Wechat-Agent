/** Leaf error module: shared by contracts and the feature validators so the
 * contract module never becomes a cycle target. */
export class ChannelError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ChannelError';
    this.code = code;
    this.details = details;
  }
}
