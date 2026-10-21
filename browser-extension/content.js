// Adds an engine/model/effort bar above Antigravity's prompt box. The selection is turned into
// a one-line instruction that is inserted in front of the prompt when the message is sent, so the
// agent routes the task through AI Factory with exactly that engine and model.
//
// Google's markup is minified and changes between deployments, so nothing here depends on their
// class names: the editor is found by its placeholder text and the send button by its position
// next to that editor.

const STORAGE_KEY = 'ai-factory-picker';
const EDITOR_HINT = /ask anything|@ to mention/i;
const BAR_ID = 'ai-factory-bar';

const state = Object.assign(
  { enabled: true, engine: 'auto', model: '', effort: '' },
  readStoredState()
);

function readStoredState() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  } catch {
    return {};
  }
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Private windows and blocked site data are fine; the bar just stops remembering.
  }
}

function placeholderOf(element) {
  return element.getAttribute('placeholder') ||
    element.getAttribute('aria-label') ||
    element.getAttribute('data-placeholder') || '';
}

function isVisible(element) {
  const rect = element.getBoundingClientRect();
  return rect.width > 120 && rect.height > 0;
}

function findEditor() {
  const candidates = [...document.querySelectorAll('textarea, [contenteditable="true"]')].filter(isVisible);
  if (candidates.length === 0) return null;
  const labelled = candidates.find(element => EDITOR_HINT.test(placeholderOf(element)) ||
    EDITOR_HINT.test(element.parentElement?.textContent?.slice(0, 80) || ''));
  if (labelled) return labelled;
  // Otherwise take the lowest one on screen, which is where a chat composer sits.
  return candidates.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top).pop();
}

function findSendButton(editor) {
  let scope = editor.parentElement;
  for (let depth = 0; depth < 6 && scope; depth++) {
    const buttons = [...scope.querySelectorAll('button')].filter(isButtonVisible);
    const labelled = buttons.find(button => /send|gönder|submit/i.test(
      button.getAttribute('aria-label') || button.getAttribute('title') || ''));
    if (labelled) return labelled;
    if (buttons.length > 0 && depth > 0) return buttons[buttons.length - 1];
    scope = scope.parentElement;
  }
  return null;
}

function isButtonVisible(button) {
  const rect = button.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 && !button.disabled;
}

function composerOf(editor, sendButton) {
  let scope = editor.parentElement;
  while (scope && scope !== document.body) {
    if (!sendButton || scope.contains(sendButton)) {
      const rect = scope.getBoundingClientRect();
      if (rect.width > 240) return scope;
    }
    scope = scope.parentElement;
  }
  return editor.parentElement;
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
    const selection = window.getSelection();
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
  if (!insertAtStart(editor, directive)) return false;
  submitting = true;
  setTimeout(() => {
    try { submit(); } finally { setTimeout(() => { submitting = false; }, 300); }
  }, 0);
  return true;
}

function activeEditor() {
  const editor = findEditor();
  if (!editor) return null;
  const active = document.activeElement;
  return editor === active || editor.contains(active) ? editor : null;
}

document.addEventListener('keydown', event => {
  if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.isComposing || event.keyCode === 229) return;
  const editor = activeEditor();
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
  const button = event.target.closest?.('button');
  if (!button || submitting) return;
  const editor = findEditor();
  if (!editor || button !== findSendButton(editor)) return;
  if (!injectThenSubmit(editor, () => button.click())) return;
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

  toggle.addEventListener('click', () => {
    state.enabled = !state.enabled;
    saveState();
    render();
  });
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

function mount() {
  const editor = findEditor();
  if (!editor) return;
  const composer = composerOf(editor, findSendButton(editor));
  if (!composer || !composer.parentElement) return;
  const existing = document.getElementById(BAR_ID);
  if (existing) {
    if (existing.nextElementSibling === composer) return;
    existing.remove();
  }
  composer.parentElement.insertBefore(buildBar(), composer);
}

let pending = null;
const observer = new MutationObserver(() => {
  clearTimeout(pending);
  pending = setTimeout(mount, 300);
});
observer.observe(document.body, { childList: true, subtree: true });
mount();
