import { workTools } from './work-execution.mjs';
import { workSessionTools } from './work-sessions.mjs';
import { modelToolList } from './registry.mjs';
import { momentsTool, momentsCommentsTool, momentsWriteTools, momentsAudienceTool } from './moments.mjs';
import { workMomentsMedia } from '../moments/media.mjs';
import { momentsPublishingTools } from './moments-publishing.mjs';
export { momentsPublishingTools } from './moments-publishing.mjs';

export { modelToolList, registerModelTools } from './registry.mjs';
export { momentsTool, momentsCommentsTool, momentsWriteTools, momentsAudienceTool } from './moments.mjs';
export { workSessionTools, WORK_TURN_TASK_LIMIT } from './work-sessions.mjs';

/** All WeChat work capabilities enter the native DSH session through this
 * registry. Availability depends on the verified execution context; the
 * legacy dialogue/task surfaces remain available for stored integrations. */
export function workModelTools({ surface, ...context }) {
  if (surface === 'dialogue') return modelToolList(workSessionTools(context));
  if (surface === 'task') return modelToolList(workTools(context));
  if (surface === 'native') {
    const { sessionManagement, moments, ...execution } = context;
    const definitions = workTools(execution), names = new Set(definitions.map(tool => tool.name));
    if (moments) { definitions.push(momentsTool({ read: moments.read, assertAllowed: execution.assertAllowed, onOperation: execution.onOperation })); names.add('wechat_moments_read'); }
    if (moments) { definitions.push(momentsCommentsTool({ read: moments.read, assertAllowed: execution.assertAllowed, onOperation: execution.onOperation })); names.add('wechat_moments_comments'); }
    if (moments?.audience) { definitions.push(momentsAudienceTool({ audience: moments.audience, assertAllowed: execution.assertAllowed, onOperation: execution.onOperation })); names.add('wechat_moments_audience'); }
    if (moments?.write) for (const tool of momentsWriteTools({ write: moments.write, media: workMomentsMedia(execution.cwd), assertAllowed: execution.assertAllowed, onOperation: execution.onOperation })) {
      definitions.push(tool); names.add(tool.name);
    }
    if (moments?.manage) for (const tool of momentsPublishingTools({ manage: moments.manage, assertAllowed: execution.assertAllowed, onOperation: execution.onOperation })) { definitions.push(tool); names.add(tool.name); }
    if (sessionManagement) for (const definition of workSessionTools(sessionManagement)) {
      if (names.has(definition.name)) continue;
      definitions.push({ ...definition, execute: async (args, exec) => {
        const value = await definition.execute(args, exec), result = JSON.parse(value);
        await execution.onOperation({ tool: definition.name, result });
        return value;
      } });
      names.add(definition.name);
    }
    return modelToolList(definitions);
  }
  throw new TypeError('Work tools require a native, dialogue or task execution context');
}
