import { MemoryPage } from "./conversation-page.jsx";
import { LongTermMemoryPage } from "./long-term-page.jsx";
import { ImageMemoryPage } from "./images-page.jsx";
import { MemoryReviewPage } from "./review-page.jsx";
import { RoleCardsPage } from './role-cards-page.jsx';
import { WorkspaceTabs } from "../../components/workspace-tabs.jsx";

export function MemoryWorkspace({ tab, setTab, ...props }) {
  const tabs = [
    ['conversation', '会话记忆'],
    ['global', '长期记忆'],
    ['roles', '人物角色卡'],
    ['images', '会话图片记忆'],
    ['generated-images', '生成图片记忆'],
    ['review', '维护'],
  ];
  return (
    <section className="wa-memory-workspace">
      <WorkspaceTabs
        name="memory"
        label="记忆类型"
        tabs={tabs}
        active={tab}
        onChange={setTab}
        className="wa-memory-workspace-tabs"
      />
      <div
        id="wa-memory-panel-conversation"
        role="tabpanel"
        aria-labelledby="wa-memory-tab-conversation"
        hidden={tab !== 'conversation'}
      >
        <MemoryPage {...props} />
      </div>
      <div id="wa-memory-panel-global" role="tabpanel" aria-labelledby="wa-memory-tab-global" hidden={tab !== 'global'}>
        <LongTermMemoryPage {...props} />
      </div>
      <div id="wa-memory-panel-roles" role="tabpanel" aria-labelledby="wa-memory-tab-roles" hidden={tab !== 'roles'}>
        {tab === 'roles' && <RoleCardsPage {...props} />}
      </div>
      <div id="wa-memory-panel-images" role="tabpanel" aria-labelledby="wa-memory-tab-images" hidden={tab !== 'images'}>
        <ImageMemoryPage {...props} active={tab === 'images'} />
      </div>
      <div id="wa-memory-panel-generated-images" role="tabpanel" aria-labelledby="wa-memory-tab-generated-images" hidden={tab !== 'generated-images'}>
        <ImageMemoryPage {...props} collection="generated" active={tab === 'generated-images'} />
      </div>
      <div id="wa-memory-panel-review" role="tabpanel" aria-labelledby="wa-memory-tab-review" hidden={tab !== 'review'}>
        {tab === 'review' && <MemoryReviewPage {...props} />}
      </div>
    </section>
  );
}
