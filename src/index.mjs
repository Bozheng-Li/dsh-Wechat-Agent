// Stable DSH server entry. Runtime composition and RPC live in app/.
export { inject, apply } from './app/plugin.mjs';
export { createPluginService } from './app/service.mjs';
export { rpcHandler } from './app/rpc.mjs';
