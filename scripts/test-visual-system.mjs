import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Reuse the established disposable fixture, with a driver that follows the
// current UI rather than historical decorative elements or removed presets.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.WECHAT_UI_TEST_VISUAL_SYSTEM = '1';
process.env.WECHAT_UI_TEST_OUTPUT ||= path.join(root, 'storage/logs/visual-system-preview');
await import('./test-ui.mjs');
