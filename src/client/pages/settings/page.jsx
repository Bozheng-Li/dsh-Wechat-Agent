import { Glyph } from '../../components/glyph.jsx';
import { PageHead } from '../../components/page-ui.jsx';

export function SettingsIndex({ status, onNavigate }) {
  const items = [
    {
      page: 'model',
      icon: 'model',
      title: '模型设置',
      text: '选择 DSH 模型，配置生成参数与当前账号的补充回复要求。',
      value: status.model?.model || '跟随 DSH 默认模型',
    },
    {
      page: 'identity',
      icon: 'shield',
      title: '全局身份',
      text: '编辑所有会话共同遵循的身份与行为规则，每轮从 AGENT.md 读取。',
      value: '全局身份 → 会话人设 → 相关记忆',
    },
    {
      page: 'persona',
      icon: 'person',
      title: '默认人设',
      text: '未自定义人设的会话使用此设定，每个会话可独立覆盖。',
      value: status.persona?.name || '微信助手',
    },
    {
      page: 'storage',
      icon: 'folder',
      title: '全局工作目录',
      text: '只需设置一个目录，插件数据在其下自动分类保存。',
      value: status.storage?.basePath || '所有插件数据 · 统一迁移',
    },
    {
      page: 'authorization',
      icon: 'shield',
      title: '会话人设与回复模式',
      text: '搜索授权会话，为每个会话设置独立人设和回复方式。',
      value: (status.settings?.privatePeers?.length || 0) + (status.settings?.groups?.length || 0) + ' 个已授权会话',
    },
    {
      page: 'changelog',
      icon: 'history',
      title: '更新日志',
      text: '查看当前版本的变化、历史更新和未发布内容。',
      value: status.version || '插件版本记录',
    },
  ];
  return (
    <>
      <PageHead title="设置" description="按职责配置你的 Agent，每个入口都有独立的设置页面。" />
      <div className="wa-setting-grid">
        {items.map((item) => (
          <button
            type="button"
            className="wa-setting-link"
            data-testid={'open-' + item.page}
            key={item.page}
            onClick={() => onNavigate(item.page, 'settings')}
          >
            <div className="wa-card-icon">
              <Glyph name={item.icon} />
            </div>
            <div>
              <h3>{item.title}</h3>
              <p>{item.text}</p>
              <span className="wa-setting-caption">{item.value}</span>
            </div>
            <Glyph name="arrow" className="wa-icon-small" />
          </button>
        ))}
      </div>
    </>
  );
}
