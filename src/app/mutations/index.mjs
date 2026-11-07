import { endpoints as agentEndpoints, agentMutation } from './agent.mjs';
import { endpoints as memoryEndpoints, memoryMutation } from './memory.mjs';
import { endpoints as mediaEndpoints, mediaMutation } from './media.mjs';
import { endpoints as tasksEndpoints, tasksMutation } from './tasks.mjs';
import { endpoints as settingsEndpoints, settingsMutation } from './settings.mjs';
import { endpoints as connectionEndpoints, connectionMutation } from './connection.mjs';

export const mutationHandlers = new Map([
  ...agentEndpoints.map((endpoint) => [endpoint, agentMutation]),
  ...memoryEndpoints.map((endpoint) => [endpoint, memoryMutation]),
  ...mediaEndpoints.map((endpoint) => [endpoint, mediaMutation]),
  ...tasksEndpoints.map((endpoint) => [endpoint, tasksMutation]),
  ...settingsEndpoints.map((endpoint) => [endpoint, settingsMutation]),
  ...connectionEndpoints.map((endpoint) => [endpoint, connectionMutation]),
]);
