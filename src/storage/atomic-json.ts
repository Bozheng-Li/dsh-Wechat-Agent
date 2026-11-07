import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export function atomicJson(file: string, value: unknown) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
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
