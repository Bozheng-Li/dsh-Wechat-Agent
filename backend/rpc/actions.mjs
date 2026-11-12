import { endpoints as agentEndpoints, agentMutation } from "../../modules/agent/actions.mjs";
import { endpoints as memoryEndpoints, memoryMutation } from "../../modules/memory/actions.mjs";
import { endpoints as mediaEndpoints, mediaMutation } from "../../modules/media/actions.mjs";
import { endpoints as tasksEndpoints, tasksMutation } from "../../modules/tasks/actions.mjs";
import { endpoints as settingsEndpoints, settingsMutation } from "../../modules/conversation/actions.mjs";
import { endpoints as connectionEndpoints, connectionMutation } from "../wechat/actions.mjs";
import { endpoints as adminEndpoints, administratorMutation } from '../../modules/remote/authorization/actions.mjs';
import { endpoints as workEndpoints, workMutation } from '../../modules/work/actions.mjs';
import { endpoints as timeEndpoints, timeMutation } from '../../modules/settings/time.mjs';

export const mutationHandlers = new Map([
  ...timeEndpoints.map(endpoint => [endpoint, timeMutation]),
  ...agentEndpoints.map((endpoint) => [endpoint, agentMutation]),
  ...memoryEndpoints.map((endpoint) => [endpoint, memoryMutation]),
  ...mediaEndpoints.map((endpoint) => [endpoint, mediaMutation]),
  ...tasksEndpoints.map((endpoint) => [endpoint, tasksMutation]),
  ...settingsEndpoints.map((endpoint) => [endpoint, settingsMutation]),
  ...connectionEndpoints.map((endpoint) => [endpoint, connectionMutation]),
  ...adminEndpoints.map(endpoint => [endpoint, administratorMutation]),
  ...workEndpoints.map(endpoint => [endpoint, workMutation]),
]);
