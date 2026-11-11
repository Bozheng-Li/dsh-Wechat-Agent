import { useState } from 'react';
import { WorkspacePanels, WorkspaceTabs } from '../../components/workspace-tabs.jsx';
import { MediaLibraryPage } from './library-page.jsx';
import { MomentsMaterialsPage } from '../moments/materials-page.jsx';

export function MediaWorkspace(props) {
  const [tab, setTab] = useState('chat');
  return <><WorkspaceTabs name="material-libraries" label="素材用途" active={tab} onChange={setTab}
    tabs={[["chat", "聊天图片与表情"], ["moments", "朋友圈素材"]]} />
    <WorkspacePanels name="material-libraries" tabs={['chat', 'moments']} active={tab}>
      {tab === 'moments' ? <MomentsMaterialsPage {...props} /> : <MediaLibraryPage {...props} />}
    </WorkspacePanels></>;
}
