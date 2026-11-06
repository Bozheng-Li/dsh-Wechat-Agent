import React from 'react';
import { createRoot } from 'react-dom/client';
import { WechatPanel } from '../../src/client.jsx';

const headers = { 'content-type': 'application/json', 'x-fixture-key': window.__UI_FIXTURE_KEY__ };
const connection = { rpc: { async call(_channel, endpoint, payload, signal) {
  const response = await fetch('/rpc', { method: 'POST', headers, body: JSON.stringify({ endpoint, payload }), signal });
  return response.json();
} } };
const listeners = new Set();
let snapshot = { status: 'ready', value: {
  groups: [{ id: 'fixture', name: '本地测试服务', models: [{ id: 'alpha', name: '测试模型 A' }, { id: 'beta', name: '测试模型 B' }] }],
  default: { provider: 'fixture', model: 'alpha' }, failures: []
} };
const catalog = {
  store: { subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); }, getSnapshot: () => snapshot },
  load: async () => snapshot.value,
  refresh: async () => { snapshot = { ...snapshot }; for (const listener of listeners) listener(); return snapshot.value; }
};
window.__uiFixture = async (command, payload = {}) => {
  const response = await fetch('/fixture', { method: 'POST', headers, body: JSON.stringify({ command, payload }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || 'UI fixture failed');
  return result;
};
createRoot(document.getElementById('root')).render(<WechatPanel connection={connection} catalog={catalog}/>);
