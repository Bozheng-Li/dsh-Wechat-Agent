import { Glyph } from '../../components/glyph.jsx';
import { PageHead } from '../../components/page-ui.jsx';

export function SettingsIndex({ status, onNavigate }) {
  const groups = [
    {
      title: '助手与能力',
      description: '定义它如何理解和回应。',
      items: [
        { page: 'persona', icon: 'person', title: '默认助手', text: '名字、唤醒词与表达偏好', value: status.persona?.name || '微信助手' },
        { page: 'identity', icon: 'shield', title: '全局身份', text: '共同遵循的身份与行为规则' },
        { page: 'model', icon: 'model', title: '模型设置', text: 'DSH 回复模型、生成参数与联网搜索', value: status.model?.model || '跟随 DSH 默认' },
        { page: 'image-generation', icon: 'image', title: '图片生成', text: '生图接口、模型与凭据', value: status.imageGeneration?.enabled ? '已启用' : '已关闭' },
      ],
    },
    {
      title: '运行与数据',
      description: '管理权限、保存位置与运行状态。',
      items: [
        { page: 'administrators', icon: 'shield', title: '管理员', text: '远程查询与工作权限', value: (status.remote?.globalAdminIds?.length || 0) + ' 位管理员' },
        { page: 'storage', icon: 'folder', title: '工作目录', text: '记录、记忆与任务的保存位置' },
        { page: 'diagnostics', icon: 'spark', title: '运行检查', text: '连接、模型与发送能力的检查结果' },
        { page: 'changelog', icon: 'history', title: '更新日志', text: '查看版本与更新内容', value: status.version || '' },
      ],
    },
  ];
  return <>
    <PageHead icon="settings" title="设置" description="管理助手能力、运行权限与数据。" />
    <div className="wa-settings-sections">
      {groups.map(group => <section className="wa-settings-section" key={group.title}>
        <header className="wa-settings-section-head"><h2>{group.title}</h2><p>{group.description}</p></header>
        <div className="wa-settings-list">
          {group.items.map(item => <button type="button" className="wa-setting-link"
            data-testid={'open-' + item.page} key={item.page} onClick={() => onNavigate(item.page, 'settings')}>
            <span className="wa-setting-symbol"><Glyph name={item.icon} /></span>
            <div className="wa-setting-copy"><h3>{item.title}</h3><p>{item.text}</p></div>
            <span className="wa-setting-value">{item.value || ''}</span>
            <Glyph name="arrow" className="wa-icon-small" />
          </button>)}
        </div>
      </section>)}
    </div>
  </>;
}
