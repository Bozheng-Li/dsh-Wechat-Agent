import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export function atomicJson(file: string, value: unknown) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = openSync(temporary, 'wx', 0o600);
    try {
      // Flush the bytes before the rename publishes them: otherwise a crash can
      // leave a valid-looking but truncated conversation behind.
      writeFileSync(handle, JSON.stringify(value, null, 2) + '\n');
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    for (let attempt = 0; ; attempt++) {
      try {
        renameSync(temporary, file);
        break;
      } catch (error) {
        // Windows readers/scanners can briefly deny replacement. Keep the old
        // file intact and bound retries to 310 ms for this synchronous API.
        if (
          process.platform !== 'win32' ||
          attempt >= 5 ||
          !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')
        )
          throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * 2 ** attempt);
      }
    }
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      /* Preserve the original write failure. */
    }
    throw error;
  }
}
