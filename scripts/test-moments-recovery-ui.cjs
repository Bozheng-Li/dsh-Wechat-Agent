const assert = require('node:assert/strict');

module.exports = async ({ fixture, click, clickText, waitFor, stateMatches, evaluate, screenshot, assertLayout, check, window }) => {
  const seeded = await fixture('seedMomentsRecovery');
  const old = seeded.created.find(row => !row.evidence), uncertain = seeded.created.find(row => row.evidence);
  const writes = (await fixture('momentWrites')).length;
  await click('[data-testid="nav-moments"]');
  await clickText('自动发布', '[role="tablist"]');
  await waitFor(() => document.querySelector('[data-testid="moments-publishing"]')?.textContent.includes('已发布，屏蔽范围待核实'));
  await evaluate(() => [...document.querySelectorAll('[data-testid="moments-publishing"] .wa-wb-list-item')]
    .find(element => element.textContent.includes('这条曾发布的动态已经删除')).click());
  await clickText('核对微信发布状态');
  await stateMatches(state => state.moments.publishing.runs.some(run => run.state === 'deleted'));
  assert.equal((await fixture('state')).moments.publishing.runs.find(run => run.id === old.id).state, 'deleted');
  await waitFor(() => document.querySelector('[data-testid="moments-publishing"] .wa-moments-draft-detail')?.textContent.includes('已确认删除'));
  assert.equal((await fixture('momentWrites')).length, writes);
  assert(await evaluate(() => ![...document.querySelectorAll('[data-testid="moments-publishing"] .wa-moments-draft-detail button')]
    .some(element => /发布这份草稿|重新生成|核对微信发布状态/.test(element.textContent))));
  check('a legacy uncertain publication becomes confirmed deleted through receipt reconciliation without another write');
  window.setContentSize(1280, 940); await assertLayout('publication recovery desktop');
  await screenshot('moments-recovered-deletion-desktop', 'light', '[data-testid="moments-publishing"] .wa-moments-draft-detail');
  window.setContentSize(430, 920); await assertLayout('publication recovery narrow');
  await screenshot('moments-recovered-deletion-narrow', 'light', '[data-testid="moments-publishing"] .wa-moments-draft-detail');
  await evaluate(() => [...document.querySelectorAll('[data-testid="moments-publishing"] .wa-wb-list-item')]
    .find(element => element.textContent.includes('指定屏蔽对象尚未全部确认')).click());
  await waitFor(() => document.querySelector('[data-testid="moments-publishing"] .wa-moments-draft-detail')?.textContent.includes('已发布，屏蔽范围待核实'));
  const state = await fixture('state');
  assert.equal(state.moments.publishing.runs.find(run => run.id === uncertain.id).state, 'published-unverified');
  assert(await evaluate(() => ![...document.querySelectorAll('[data-testid="moments-publishing"] .wa-moments-draft-detail button')]
    .some(element => element.textContent === '发布这份草稿')));
  check('unconfirmed exclusions have a distinct publication warning and never offer republishing');
  await clickText('定时回复', '[role="tablist"]');
  await waitFor(() => document.querySelector('[data-testid="moments-unavailable-posts"]')?.textContent.includes('已跳过 2 条'));
  assert(await evaluate(() => !document.querySelector('[data-testid="moments-page"] .wa-alert.is-error')));
  await assertLayout('unavailable post summary narrow');
  await screenshot('moments-unavailable-posts-narrow', 'light', '[data-testid="moments-unavailable-posts"]');
  check('isolated unavailable posts are reported as skipped without a false global reading failure');
  assert.equal((await fixture('momentWrites')).length, writes);
};
