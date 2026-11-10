import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** Publish one complete UTF-8/binary file; a failed replacement keeps the old file. */
export function atomicBytes(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    for (let attempt = 0; ; attempt++) {
      try { fs.renameSync(temporary, file); break; }
      catch (error) {
        if (process.platform !== 'win32' || attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * 2 ** attempt);
      }
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') { /* Keep the publish error. */ } }
  }
}
