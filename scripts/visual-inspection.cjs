// Runs inside the isolated renderer. Keep this function self-contained so the
// driver can serialize it without exposing Node or a real application profile.
function inspectVisualState() {
  const panel = document.querySelector('.wa-panel');
  const visible = el => {
    if (!el.getClientRects().length || getComputedStyle(el).visibility === 'hidden' || el.closest('[hidden],svg') || getComputedStyle(el).display === 'none') return false;
    // Chromium may retain layout boxes under a closed details element, while
    // skipping its paint and color transitions. Only its summary is visible.
    for (let ancestor = el.parentElement; ancestor; ancestor = ancestor.parentElement)
      if (ancestor.tagName === 'DETAILS' && !ancestor.open && !ancestor.querySelector(':scope > summary')?.contains(el)) return false;
    return true;
  };
  const describe = el => ({ tag: el.tagName.toLowerCase(), className: el.className,
    label: el.getAttribute('aria-label') || el.textContent.trim().slice(0, 85) });
  const roots = ['.wa-panel', '.wa-shell', '.wa-workspace'].map(selector => {
    const el = document.querySelector(selector); return { selector, client: el?.clientWidth, scroll: el?.scrollWidth };
  });
  // A dialog must fit its own content width even when its overflow:auto masks
  // the excess from page-level checks. Nested image/code scrollers stay valid.
  roots.push(...[...document.querySelectorAll('[role=dialog],[role=alertdialog]')].filter(visible)
    .map(el => ({ selector: '[role=' + el.getAttribute('role') + ']', label: el.getAttribute('aria-label') || el.id,
      client: el.clientWidth, scroll: el.scrollWidth })));
  const ids = [...document.querySelectorAll('[id]')].map(el => el.id);
  const nameless = [...panel.querySelectorAll('button')].filter(visible).filter(el =>
    !el.textContent.trim() && !el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby') && !el.title).map(describe);
  const tabs = [...panel.querySelectorAll('[role=tab]')].filter(visible)
    .map(el => {
      const target = document.getElementById(el.getAttribute('aria-controls'));
      return { id: el.id, target: !!target && target.getAttribute('role') === 'tabpanel',
        labeled: el.getAttribute('aria-selected') !== 'true' || !!target?.getAttribute('aria-labelledby')?.split(/\s+/).includes(el.id) };
    });
  const unlabeled = [...panel.querySelectorAll('input,textarea,select')].filter(visible)
    .filter(el => el.type !== 'hidden' && getComputedStyle(el).opacity !== '0')
    .filter(el => !el.getAttribute('aria-label')?.trim() && !el.getAttribute('aria-labelledby')?.split(/\s+/).some(id => document.getElementById(id)?.textContent.trim()) &&
      ![...(el.labels || [])].some(label => label.textContent.trim()) && !el.title).map(describe);
  const overflow = [...panel.querySelectorAll('*')].filter(visible).filter(el => {
    const box = el.getBoundingClientRect();
    if (box.width <= 1 || (box.left >= -1 && box.right <= innerWidth + 1)) return false;
    // Horizontal scrollers (navigation, code, thumbnails) are intentional.
    // A clipping ancestor must itself be inside the viewport to be exempt.
    for (let parent = el.parentElement; parent && parent !== panel; parent = parent.parentElement) {
      const style = getComputedStyle(parent), bounds = parent.getBoundingClientRect();
      if (['auto', 'scroll', 'hidden', 'clip'].includes(style.overflowX) && bounds.left >= -1 && bounds.right <= innerWidth + 1) return false;
    }
    return true;
  }).map(el => ({ ...describe(el), left: Math.round(el.getBoundingClientRect().left), right: Math.round(el.getBoundingClientRect().right) }));

  const context = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  context.canvas.width = context.canvas.height = 1;
  const parse = color => {
    context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1);
    return [...context.getImageData(0, 0, 1, 1).data].map((value, i) => i === 3 ? value / 255 : value);
  };
  const over = (front, back) => {
    const alpha = front[3] + back[3] * (1 - front[3]);
    return [...front.slice(0, 3).map((value, i) => alpha ? (value * front[3] + back[i] * back[3] * (1 - front[3])) / alpha : 0), alpha];
  };
  const luminance = color => color.slice(0, 3).map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
    .reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
  const candidates = new Map();
  const walker = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const el = node.parentElement;
    if (node.textContent.trim() && visible(el) && !el.closest('style,script,option,select,[aria-hidden=true]')) candidates.set(el, node.textContent.trim());
  }
  for (const el of panel.querySelectorAll('input,textarea,select')) if (visible(el) && el.value && el.type !== 'checkbox' && el.type !== 'file')
    candidates.set(el, el.tagName === 'SELECT' ? el.selectedOptions[0]?.textContent : el.value);
  const contrast = [], contrastSkipped = []; let contrastChecked = 0;
  for (const [el, text] of candidates) {
    if (el.closest(':disabled,[aria-disabled=true]')) continue;
    const style = getComputedStyle(el), ancestors = [];
    let opacity = 1, gradient = false;
    for (let parent = el; parent; parent = parent.parentElement) {
      const inherited = getComputedStyle(parent);
      opacity *= Number(inherited.opacity);
      ancestors.push(inherited);
      if (inherited.backgroundImage !== 'none') gradient = true;
    }
    if (opacity < .01) continue;
    // Gradients, images and blending need screenshot review; do not claim an
    // exact ratio from a single invented background color.
    if (gradient || style.mixBlendMode !== 'normal') { contrastSkipped.push({ ...describe(el), text: text.slice(0, 85), reason: 'Image, gradient or blend background' }); continue; }
    let background = [255, 255, 255, 1];
    for (const inherited of ancestors.reverse()) background = over(parse(inherited.backgroundColor), background);
    const foreground = parse(style.color); foreground[3] *= opacity;
    const a = luminance(over(foreground, background)), b = luminance(background);
    const ratio = (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
    const minimum = Number.parseFloat(style.fontSize) >= 24 || (Number.parseFloat(style.fontSize) >= 18.66 && Number(style.fontWeight) >= 700) ? 3 : 4.5;
    contrastChecked++;
    if (ratio + .02 < minimum) contrast.push({ ...describe(el), text: text.slice(0, 85), ratio: Number(ratio.toFixed(2)), minimum, color: style.color, opacity });
  }
  return { page: panel.dataset.page, viewport: innerWidth, document: document.documentElement.scrollWidth,
    heights: { viewport: innerHeight, document: { client: document.documentElement.clientHeight, scroll: document.documentElement.scrollHeight },
      body: { client: document.body.clientHeight, scroll: document.body.scrollHeight },
      roots: ['#root', '.wa-panel', '.wa-shell', '.wa-workspace'].map(selector => { const el = document.querySelector(selector); return { selector, client: el?.clientHeight, scroll: el?.scrollHeight }; }) },
    positionedInputs: [...panel.querySelectorAll('input')].filter(el => ['absolute', 'fixed'].includes(getComputedStyle(el).position))
      .map(el => ({ ...describe(el), position: getComputedStyle(el).position, offsetParent: el.offsetParent?.className || el.offsetParent?.tagName,
        top: el.getBoundingClientRect().top, bottom: el.getBoundingClientRect().bottom })),
    roots, duplicateIds: [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))], nameless, tabs, unlabeled, overflow,
    contrastChecked, contrast, contrastSkipped, foreground: getComputedStyle(panel).color, background: getComputedStyle(panel).backgroundColor };
}

module.exports = { inspectVisualState };
