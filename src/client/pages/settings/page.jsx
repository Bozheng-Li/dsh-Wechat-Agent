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
      value: '共同边界 · 会话口吻 · 相关记忆',
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
      <PageHead
        title="设置"
        eyebrow="MAKE IT YOURS"
        description="从性格到日常习惯，让这个 Agent 更像你期待的样子。"
      />
      <div className="wa-settings-sections">
        {[
          {
            title: '表达与性格',
            description: '决定它是谁，如何理解与回应。',
            pages: ['persona', 'identity', 'model'],
          },
          {
            title: '会话与工作空间',
            description: '安排相处方式，管理数据与更新。',
            pages: ['authorization', 'storage', 'changelog'],
          },
        ].map((group, index) => (
          <section className="wa-settings-section" key={group.title}>
            <header className="wa-settings-section-head">
              <span aria-hidden="true">0{index + 1}</span>
              <div>
                <h2>{group.title}</h2>
                <p>{group.description}</p>
              </div>
            </header>
            <div className="wa-setting-grid">
              {group.pages.map((page) => items.find((item) => item.page === page)).map((item) => (
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
          </section>
        ))}
      </div>
    </>
  );
}
