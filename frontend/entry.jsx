import { Glyph } from "./components/glyph.jsx";
import { WechatPanel } from "./panel.jsx";

export const inject = ['slots', 'connection', 'modelDirectories'];

export const PANEL_ID = 'wechat-agent';

export function Icon() {
  return <Glyph name="chat" size={20} />;
}

export function apply(ctx) {
  ctx.slots.inject('main', () =>
    ctx.slots.register({ name: 'main', key: PANEL_ID }, () => (
      <WechatPanel connection={ctx.connection} catalog={ctx.modelDirectories.catalog} />
    ))
  );
  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 5, label: () => '微信 Agent' }, Icon)
  );
}
