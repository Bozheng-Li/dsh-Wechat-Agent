import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Resolve from the installed package, equally in nested source and lib bundles. */
export function packageRoot(moduleUrl = import.meta.url) {
  let directory = path.dirname(fileURLToPath(moduleUrl));
  for (;;) {
    const manifest = path.join(directory, 'package.json');
    if (fs.existsSync(manifest) && JSON.parse(fs.readFileSync(manifest, 'utf8')).name === 'dsh-plugin-wechat-agent')
      return directory;
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error('Wechat Agent package resources could not be located');
    directory = parent;
  }
}

export const resourcePath = (...segments) => path.join(packageRoot(), ...segments);
