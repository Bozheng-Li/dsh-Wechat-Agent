import { tokenCss } from './tokens.mjs';
import { foundationCss } from './foundation.mjs';
import { layoutCss } from './layout.mjs';
import { automationCss } from './automation.mjs';
import { contentCss } from './content.mjs';
import { settingsCss } from './settings.mjs';
import { interactionCss } from './interactions.mjs';

// Each family owns its selectors. Do not append another global theme override.
export const css = tokenCss + foundationCss + layoutCss + automationCss + contentCss + settingsCss + interactionCss;
