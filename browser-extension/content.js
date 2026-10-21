// Adds an engine/model/effort bar above Antigravity's prompt box. The selection is turned into
// a one-line instruction that is inserted in front of the prompt when the message is sent, so the
// agent routes the task through AI Factory with exactly that engine and model.
//
// Google's markup is minified and changes between deployments, so nothing here depends on their
// class names: the editor is found by its placeholder text and the send button by its position
// next to that editor. The search walks into shadow roots, which a plain querySelectorAll cannot
// see, and the bar carries its own stylesheet so it looks right wherever it ends up.
//
// Set localStorage['ai-factory-picker-debug'] = '1' to log what each search found.

const STORAGE_KEY = 'ai-factory-picker';
const DEBUG_KEY = 'ai-factory-picker-debug';
const EDITOR_HINT = /ask anything|@ to mention|\/ for actions/i;
const BAR_ID = 'ai-factory-bar';

const STYLES = `
#${BAR_ID} {
  display: flex; flex-wrap: wrap; align-items: center; gap: 6px;
  margin: 0 0 6px; padding: 4px 2px;
  font: 12px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; color: #c9d1d9;
}
#${BAR_ID} .aif-toggle {
  padding: 3px 10px; border: 1px solid #3fb950; border-radius: 999px;
  background: rgba(63, 185, 80, 0.14); color: #3fb950; font: inherit; font-weight: 600; cursor: pointer;
}
#${BAR_ID} .aif-toggle.aif-off { border-color: #6e7681; background: transparent; color: #8b949e; }
#${BAR_ID} .aif-select {
  max-width: 230px; padding: 3px 6px; border: 1px solid #30363d; border-radius: 6px;
  background: #161b22; color: #c9d1d9; font: inherit; cursor: pointer;
}
#${BAR_ID} .aif-select:disabled { opacity: 0.5; cursor: default; }
#${BAR_ID} .aif-select[hidden] { display: none; }
#${BAR_ID} .aif-hint { color: #6e7681; font-size: 11px; }
@media (prefers-color-scheme: light) {
  #${BAR_ID} { color: #24292f; }
  #${BAR_ID} .aif-select { background: #fff; border-color: #d0d7de; color: #24292f; }
}
`;

const state = Object.assign({ enabled: true, engine: 'auto', model: '', effort: '' }, readStoredState());

function readStoredState() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch { return {}; }
}

function saveState() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* private window */ }
}

let debugEnabled = false;
try { debugEnabled = localStorage.getItem(DEBUG_KEY) === '1'; } catch { /* ignore */ }
function debug(...args) {
  if (debugEnabled) console.log('[AI Factory]', ...args);
}

// ── Finding the composer ──────────────────────────────────────────────────────────────────

// querySelectorAll stops at a shadow boundary, and this app may render the composer inside one.
function deepQueryAll(selector, root = document, found = [], seen = new Set()) {
  if (seen.has(root)) return found;
  seen.add(root);
  for (const element of root.querySelectorAll('*')) {
    if (element.matches(selector)) found.push(element);
    if (element.shadowRoot) deepQueryAll(selector, element.shadowRoot, found, seen);
  }
  return found;
}

function placeholderOf(element) {
  return element.getAttribute('placeholder') ||
    element.getAttribute('aria-label') ||
    element.getAttribute('data-placeholder') ||
    element.getAttribute('aria-placeholder') || '';
}

function isVisible(element) {
  const rect = element.getBoundingClientRect();
  return rect.width > 120 && rect.height > 0;
}

function findEditor() {
  const candidates = deepQueryAll('textarea, [contenteditable="true"], [contenteditable=""], [role="textbox"]')
    .filter(isVisible);
  if (candidates.length === 0) return null;
  const labelled = candidates.find(element => EDITOR_HINT.test(placeholderOf(element)) ||
    EDITOR_HINT.test(element.parentElement?.textContent?.slice(0, 120) || '') ||
    EDITOR_HINT.test(element.closest('[aria-label]')?.getAttribute('aria-label') || ''));
  if (labelled) return labelled;
  // Otherwise take the lowest one on screen, which is where a chat composer sits.
  return candidates.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top).pop();
}

function isButtonVisible(button) {
  const rect = button.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 && !button.disabled;
}

function findSendButton(editor) {
  let scope = editor.parentElement || editor.getRootNode().host;
  for (let depth = 0; depth < 6 && scope; depth++) {
    const buttons = deepQueryAll('button, [role="button"]', scope).filter(isButtonVisible);
    const labelled = buttons.find(button => /send|gönder|submit/i.test(
      button.getAttribute('aria-label') || button.getAttribute('title') || ''));
    if (labelled) return labelled;
    if (buttons.length > 0 && depth > 0) return buttons[buttons.length - 1];
    scope = scope.parentElement || scope.getRootNode?.()?.host;
  }
  return null;
}

// Walks with parentNode, not parentElement: inside a shadow root the top element's
// parentElement is null because its parent is the ShadowRoot itself.
function composerOf(editor, sendButton) {
  let scope = editor.parentNode;
  while (scope && scope !== document.body && scope.nodeType === Node.ELEMENT_NODE) {
    if (!sendButton || scope.contains(sendButton)) {
      if (scope.getBoundingClientRect().width > 240) return scope;
    }
    scope = scope.parentNode;
  }
  return editor.parentNode?.nodeType === Node.ELEMENT_NODE ? editor.parentNode : editor;
}

// ── The instruction added to the prompt ───────────────────────────────────────────────────

function buildDirective() {
  if (!state.enabled || state.engine === 'auto') return '';
  const engine = AI_FACTORY_MODELS.engines[state.engine];
  if (!engine) return '';
  const model = state.model || engine.default;
  let flags = `--engine ${state.engine} --model ${model}`;
  if (engine.effort.length > 0 && state.effort) flags += ` --reasoning-effort ${state.effort}`;
  return `[AI Factory] Delegate this task through the AI Factory router with ${flags} --no-fallback, ` +
    'and report the router\'s execution report. Task: ';
}

// ── Inserting into the editor ─────────────────────────────────────────────────────────────

function editorText(editor) {
  return (editor.tagName === 'TEXTAREA' ? editor.value : editor.innerText).trim();
}

// execCommand goes through the browser's own editing pipeline, so the page's editor sees the
// same input events it would get from typing. Setting .value or .textContent does not.
function insertAtStart(editor, text) {
  editor.focus();
  if (editor.tagName === 'TEXTAREA') {
    editor.setSelectionRange(0, 0);
  } else {
    const range = document.createRange();
    range.setStart(editor, 0);
    range.collapse(true);
    const selection = (editor.getRootNode().getSelection?.() || window.getSelection());
    selection.removeAllRanges();
    selection.addRange(range);
  }
  return document.execCommand('insertText', false, text);
}

let submitting = false;

function injectThenSubmit(editor, submit) {
  const directive = buildDirective();
  if (!directive || submitting || !editorText(editor)) return false;
  if (editorText(editor).startsWith('[AI Factory]')) return false;
  if (!insertAtStart(editor, directive)) { debug('insertText was refused'); return false; }
  submitting = true;
  setTimeout(() => {
    try { submit(); } finally { setTimeout(() => { submitting = false; }, 300); }
  }, 0);
  return true;
}

// A listener on document sees events from inside a shadow root retargeted to the host;
// composedPath()[0] is the element the event actually started on.
function realTarget(event) {
  return event.composedPath?.()[0] || event.target;
}

function activeEditorFor(node) {
  const editor = findEditor();
  if (!editor) return null;
  return editor === node || editor.contains(node) ? editor : null;
}

document.addEventListener('keydown', event => {
  if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.isComposing || event.keyCode === 229) return;
  const editor = activeEditorFor(realTarget(event));
  if (!editor) return;
  if (!injectThenSubmit(editor, () => {
    const button = findSendButton(editor);
    if (button) button.click();
    else editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  })) return;
  event.preventDefault();
  event.stopImmediatePropagation();
}, true);

document.addEventListener('click', event => {
  if (submitting) return;
  const clicked = realTarget(event).closest?.('button, [role="button"]');
  if (!clicked) return;
  const editor = findEditor();
  if (!editor || clicked !== findSendButton(editor)) return;
  if (!injectThenSubmit(editor, () => clicked.click())) return;
  event.preventDefault();
  event.stopImmediatePropagation();
}, true);

// ── The bar ───────────────────────────────────────────────────────────────────────────────

function option(value, label, selected) {
  const element = document.createElement('option');
  element.value = value;
  element.textContent = label;
  element.selected = selected;
  return element;
}

function fillModels(select) {
  select.replaceChildren();
  const engine = AI_FACTORY_MODELS.engines[state.engine];
  if (!engine) { select.disabled = true; return; }
  select.disabled = false;
  for (const model of engine.models) {
    select.append(option(model, model === engine.default ? `${model} (default)` : model,
      model === (state.model || engine.default)));
  }
}

function fillEffort(select) {
  const levels = AI_FACTORY_MODELS.engines[state.engine]?.effort || [];
  select.replaceChildren();
  select.disabled = levels.length === 0;
  select.append(option('', levels.length ? 'effort: auto' : 'effort: n/a', !state.effort));
  for (const level of levels) select.append(option(level, level, level === state.effort));
}

function buildBar() {
  const bar = document.createElement('div');
  bar.id = BAR_ID;

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'aif-toggle';

  const engineSelect = document.createElement('select');
  engineSelect.className = 'aif-select';
  engineSelect.append(option('auto', 'auto (free chain)', state.engine === 'auto'));
  for (const name of Object.keys(AI_FACTORY_MODELS.engines)) {
    engineSelect.append(option(name, name, name === state.engine));
  }

  const modelSelect = document.createElement('select');
  modelSelect.className = 'aif-select aif-model';
  const effortSelect = document.createElement('select');
  effortSelect.className = 'aif-select';
  const hint = document.createElement('span');
  hint.className = 'aif-hint';

  function render() {
    toggle.textContent = state.enabled ? 'AI Factory: on' : 'AI Factory: off';
    toggle.classList.toggle('aif-off', !state.enabled);
    const routed = state.enabled && state.engine !== 'auto';
    modelSelect.hidden = !routed;
    effortSelect.hidden = !routed || (AI_FACTORY_MODELS.engines[state.engine]?.effort.length || 0) === 0;
    engineSelect.disabled = !state.enabled;
    hint.textContent = routed ? '' : 'chain: ' + AI_FACTORY_MODELS.chain.join(' → ');
  }

  toggle.addEventListener('click', () => { state.enabled = !state.enabled; saveState(); render(); });
  engineSelect.addEventListener('change', () => {
    state.engine = engineSelect.value;
    state.model = '';
    state.effort = '';
    saveState();
    fillModels(modelSelect);
    fillEffort(effortSelect);
    render();
  });
  modelSelect.addEventListener('change', () => { state.model = modelSelect.value; saveState(); });
  effortSelect.addEventListener('change', () => { state.effort = effortSelect.value; saveState(); });

  fillModels(modelSelect);
  fillEffort(effortSelect);
  bar.append(toggle, engineSelect, modelSelect, effortSelect, hint);
  render();
  return bar;
}

// The bar can land inside a shadow root, where the manifest's stylesheet does not reach.
function ensureStyles(root) {
  const host = root instanceof ShadowRoot ? root : document.head;
  if (!host || host.querySelector('style[data-ai-factory]')) return;
  const style = document.createElement('style');
  style.dataset.aiFactory = '1';
  style.textContent = STYLES;
  host.append(style);
}

function mount() {
  const editor = findEditor();
  if (!editor) { debug('no editor found yet'); return; }
  const sendButton = findSendButton(editor);
  const composer = composerOf(editor, sendButton);
  // parentNode, so the bar can also be inserted directly into a shadow root.
  const parent = composer?.parentNode;
  if (!parent) { debug('no composer container around', editor); return; }
  const root = composer.getRootNode();
  const existing = root.querySelector?.('#' + BAR_ID);
  if (existing) {
    if (existing.nextElementSibling === composer) return;
    existing.remove();
  }
  ensureStyles(root);
  parent.insertBefore(buildBar(), composer);
  debug('bar mounted', { editor, sendButton, composer, inShadowRoot: root instanceof ShadowRoot });
}

let pending = null;
function scheduleMount() {
  clearTimeout(pending);
  pending = setTimeout(mount, 300);
}

new MutationObserver(scheduleMount).observe(document.documentElement, { childList: true, subtree: true });
// A single-page app can finish rendering without further mutations, so poll briefly as well.
setInterval(() => { if (!document.querySelector('#' + BAR_ID)) scheduleMount(); }, 3000);
mount();
debug('content script loaded on', location.href);
