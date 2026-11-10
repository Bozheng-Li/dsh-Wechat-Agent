import { MemoryPage } from "./conversation-page.jsx";
import { LongTermMemoryPage } from "./long-term-page.jsx";
import { ImageMemoryPage } from "./images-page.jsx";
import { MemoryReviewPage } from "./review-page.jsx";
import { WorkspaceTabs } from "../../components/workspace-tabs.jsx";

export function MemoryWorkspace({ tab, setTab, ...props }) {
  const tabs = [
    ['conversation', '会话记忆'],
    ['global', '长期记忆'],
    ['images', '图片记忆'],
    ['review', '维护'],
  ];
  return (
    <>
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
      <div id="wa-memory-panel-images" role="tabpanel" aria-labelledby="wa-memory-tab-images" hidden={tab !== 'images'}>
        <ImageMemoryPage {...props} active={tab === 'images'} />
      </div>
      <div id="wa-memory-panel-review" role="tabpanel" aria-labelledby="wa-memory-tab-review" hidden={tab !== 'review'}>
        {tab === 'review' && <MemoryReviewPage {...props} />}
      </div>
    </>
  );
}
