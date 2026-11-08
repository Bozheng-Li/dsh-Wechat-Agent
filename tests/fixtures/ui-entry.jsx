import React from 'react';
import { createRoot } from 'react-dom/client';
import { WechatPanel } from '../../src/client/panel.jsx';
import { uiFixtureModels } from './model-catalog.mjs';

const headers = { 'content-type': 'application/json', 'x-fixture-key': window.__UI_FIXTURE_KEY__ };
const connection = { rpc: { async call(_channel, endpoint, payload, signal) {
  const response = await fetch('/rpc', { method: 'POST', headers, body: JSON.stringify({ endpoint, payload }),
    signal: endpoint === 'model.info' && window.__uiIgnoreModelInfoAbort ? undefined : signal });
  return response.json();
} } };
const listeners = new Set();
let snapshot = { status: 'ready', value: {
  groups: [{ id: 'fixture', name: '本地测试服务', models: uiFixtureModels.map(({ reasoning, ...model }) => model) }],
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
  if (command === 'modelCatalog') {
    snapshot = { ...snapshot, value: { ...snapshot.value, groups: [{ ...snapshot.value.groups[0], models: result.models }] } };
    for (const listener of listeners) listener();
  }
  return result;
};
createRoot(document.getElementById('root')).render(<WechatPanel connection={connection} catalog={catalog}/>);
