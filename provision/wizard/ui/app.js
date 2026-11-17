// Operant first-boot wizard — browser client.
// Every value written into the DOM here goes through textContent, never innerHTML.

'use strict';

const els = {
  banner: document.getElementById('banner'),
  list: document.getElementById('step-list'),
  railProgress: document.getElementById('rail-progress'),
  platformNote: document.getElementById('platform-note'),
  serverContext: document.getElementById('server-context'),
  eyebrow: document.getElementById('step-eyebrow'),
  position: document.getElementById('step-position'),
  title: document.getElementById('step-title'),
  why: document.getElementById('step-why'),
  chips: document.getElementById('step-chips'),
  run: document.getElementById('run-button'),
  prev: document.getElementById('prev-button'),
  next: document.getElementById('next-button'),
  runNote: document.getElementById('run-note'),
  status: document.getElementById('step-status'),
  summary: document.getElementById('step-summary'),
  secretsBlock: document.getElementById('secrets-block'),
  secretsForm: document.getElementById('secrets-form'),
  output: document.getElementById('output'),
  outputNote: document.getElementById('output-note'),
  copy: document.getElementById('copy-output'),
};

const STATUS_TEXT = {
  pending: 'Not run yet',
  running: 'Running',
  ok: 'Passed',
  failed: 'Failed',
};

const RAIL_TEXT = {
  pending: 'not run',
  running: 'running',
  ok: 'pass',
  failed: 'fail',
};

let data = null;
let selectedId = null;
let pollTimer = null;
let refreshing = false;
let refreshAgain = false;
let secretsRenderedFor = null;
let secretsFormElement = null;
let outputToken = null;
let outputSeq = 0;

function setText(element, text) {
  if (element && element.textContent !== text) element.textContent = text;
}

function showBanner(message) {
  setText(els.banner, message);
  els.banner.hidden = false;
}

function hideBanner() {
  els.banner.hidden = true;
  setText(els.banner, '');
}

async function request(pathname, options = {}) {
  const response = await fetch(pathname, { cache: 'no-store', ...options });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!response.ok) {
    const error = new Error(body && body.error ? body.error : `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return body;
}

function currentStep() {
  return data && data.steps ? data.steps.find((step) => step.id === selectedId) || null : null;
}

function schedule(delay) {
  if (pollTimer) clearTimeout(pollTimer);
  const effective = document.visibilityState === 'hidden' ? Math.max(delay, 5000) : delay;
  pollTimer = setTimeout(() => {
    pollTimer = null;
    void refresh();
  }, effective);
}

async function refresh() {
  if (refreshing) {
    refreshAgain = true;
    return;
  }
  refreshing = true;
  try {
    data = await request('/api/steps');
    hideBanner();
    const steps = Array.isArray(data.steps) ? data.steps : [];
    if (!selectedId || !steps.some((step) => step.id === selectedId)) {
      selectedId = (data.running && data.running.stepId) || (steps[0] && steps[0].id) || null;
      if (selectedId) {
        history.replaceState(null, '', `#${encodeURIComponent(selectedId)}`);
        outputToken = null;
        outputSeq = 0;
      }
    }
    buildRailIfNeeded();
    render();
    schedule(data.running ? 800 : 2500);
  } catch (error) {
    showBanner(
      `Cannot reach the wizard server at ${location.host}. ${error.message} ` +
        'If it has stopped, restart it with: node provision/wizard/server.mjs',
    );
    schedule(3000);
  } finally {
    refreshing = false;
    if (refreshAgain) {
      refreshAgain = false;
      schedule(60);
    }
  }
}

function buildRailIfNeeded() {
  const steps = data.steps || [];
  const links = els.list.querySelectorAll('.step-link');
  if (links.length === steps.length && !els.list.querySelector('.step-skeleton')) return;

  els.list.textContent = '';
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    const item = document.createElement('li');
    const link = document.createElement('a');
    link.className = 'step-link';
    link.href = `#${encodeURIComponent(step.id)}`;
    link.dataset.stepId = step.id;
    link.addEventListener('click', (event) => {
      event.preventDefault();
      selectStep(step.id, { updateHash: true, focus: true });
    });

    const number = document.createElement('span');
    number.className = 'step-number';
    number.setAttribute('aria-hidden', 'true');
    number.textContent = String(index + 1).padStart(2, '0');

    const label = document.createElement('span');
    label.className = 'step-label';
    label.textContent = step.title;

    const status = document.createElement('span');
    status.className = 'step-status-text';

    link.append(number, label, status);
    item.append(link);
    els.list.append(item);
  }
}

function renderRail() {
  const steps = data.steps || [];
  const links = els.list.querySelectorAll('.step-link');
  for (const link of links) {
    const step = steps.find((candidate) => candidate.id === link.dataset.stepId);
    if (!step) continue;
    link.dataset.status = step.status;
    setText(link.querySelector('.step-status-text'), RAIL_TEXT[step.status] || step.status);
    if (step.id === selectedId) link.setAttribute('aria-current', 'step');
    else link.removeAttribute('aria-current');
  }
  const passed = steps.filter((step) => step.status === 'ok').length;
  setText(els.railProgress, `${passed} / ${steps.length} passed`);
}

function renderChips(step) {
  els.chips.textContent = '';
  const add = (text, tone) => {
    const chip = document.createElement('span');
    chip.className = `chip${tone ? ` chip-${tone}` : ''}`;
    chip.textContent = text;
    els.chips.append(chip);
  };
  add(step.needsRoot ? 'Needs root' : 'Runs as you', step.needsRoot ? 'warn' : 'muted');
}

function defaultSummary(step) {
  if (step.status === 'running') return 'Running now. Output is arriving live below.';
  if (step.status === 'ok') return 'Completed; the server recorded a real pass.';
  if (step.status === 'failed') return 'Failed; the real error is in the output below.';
  return 'Not run yet. The status will change only after the server returns a real outcome.';
}

function renderSecrets(step) {
  if (!data.server || !Array.isArray(step.fields) || step.fields.length === 0) {
    els.secretsBlock.hidden = true;
    if (secretsFormElement) {
      for (const input of secretsFormElement.querySelectorAll('input[type="password"]')) {
        input.value = '';
      }
    }
    secretsRenderedFor = null;
    secretsFormElement = null;
    return;
  }
  els.secretsBlock.hidden = false;
  if (secretsRenderedFor === step.id && secretsFormElement) return;

  secretsRenderedFor = step.id;
  els.secretsForm.textContent = '';

  const form = document.createElement('form');
  form.id = 'secrets-form-element';
  form.noValidate = true;
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void runCurrent();
  });

  for (const field of step.fields) {
    const inputId = `cred-${field.name.toLowerCase()}`;
    const wrap = document.createElement('div');
    wrap.className = 'field';

    const label = document.createElement('label');
    label.htmlFor = inputId;
    label.textContent = field.label;
    if (field.required) {
      const required = document.createElement('span');
      required.className = 'req';
      required.textContent = 'required';
      label.append(required);
    }

    const input = document.createElement('input');
    input.type = 'password';
    input.id = inputId;
    input.name = field.name;
    input.autocomplete = 'new-password';
    input.spellcheck = false;
    input.maxLength = 4096;
    input.setAttribute('autocapitalize', 'off');
    input.setAttribute('autocorrect', 'off');
    input.setAttribute('aria-describedby', `${inputId}-hint`);

    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.id = `${inputId}-hint`;
    hint.textContent = field.hint || '';

    wrap.append(label, input);
    if (field.hint) wrap.append(hint);
    form.append(wrap);
  }

  const checkline = document.createElement('div');
  checkline.className = 'checkline';
  const check = document.createElement('input');
  check.type = 'checkbox';
  check.id = 'cred-confirm-replace';
  check.name = 'confirmReplace';
  const checkLabel = document.createElement('label');
  checkLabel.htmlFor = 'cred-confirm-replace';
  let replaceText = 'Replace /etc/operant/secrets.env if it already exists.';
  if (step.secretsFileExists === true) {
    replaceText += ' A file exists now; without this tick the step refuses to overwrite it.';
  } else if (step.secretsFileExists === null) {
    replaceText += ' The server could not check; without this tick it will refuse to overwrite.';
  } else {
    replaceText += ' No file exists now; this only matters on a later rerun.';
  }
  checkLabel.textContent = replaceText;
  checkline.append(check, checkLabel);

  const error = document.createElement('p');
  error.className = 'form-error';
  error.id = 'secrets-error';
  error.hidden = true;
  error.tabIndex = -1;

  const actions = document.createElement('div');
  actions.className = 'form-actions';
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'btn btn-primary';
  submit.textContent = 'Write secrets';
  const note = document.createElement('p');
  note.className = 'hint form-note';
  note.textContent = 'Same action as Run step above. Press Enter in any field to submit.';
  actions.append(submit, note);

  form.append(checkline, error, actions);

  els.secretsForm.append(form);
  secretsFormElement = form;
}

function setFormError(message) {
  const element = document.getElementById('secrets-error');
  if (!element) return;
  setText(element, message || '');
  element.hidden = !message;
  if (message) element.focus();
}

function readSecrets(step) {
  if (!secretsFormElement) return { error: 'The credential form is not ready yet.' };
  const values = {};
  for (const field of step.fields) {
    const input = secretsFormElement.querySelector(`input[name="${field.name}"]`);
    if (!input) continue;
    const value = input.value.trim();
    if (!value) {
      if (field.required) return { error: `${field.label} is required.` };
      continue;
    }
    if (field.minLength && value.length < field.minLength) {
      return { error: `${field.label} must be at least ${field.minLength} characters.` };
    }
    values[field.name] = value;
  }
  if (Object.keys(values).length === 0) return { error: 'Enter at least one credential value.' };
  const checkbox = secretsFormElement.querySelector('input[name="confirmReplace"]');
  return { values, confirmReplace: Boolean(checkbox && checkbox.checked) };
}

function clearSecretsForm() {
  if (!secretsFormElement) return;
  for (const input of secretsFormElement.querySelectorAll('input[type="password"]')) {
    input.value = '';
  }
  const checkbox = secretsFormElement.querySelector('input[name="confirmReplace"]');
  if (checkbox) checkbox.checked = false;
  setFormError('');
}

function renderOutput(step) {
  const entries = Array.isArray(step.output) ? step.output : [];
  const token = `${step.id}:${step.startedAt || 'none'}`;
  const serverSeq = Number.isFinite(step.outputSeq) ? step.outputSeq : entries.length;
  const nearBottom =
    els.output.scrollHeight - els.output.scrollTop - els.output.clientHeight < 48;

  let rebuild = token !== outputToken || serverSeq < outputSeq;
  let startIndex = 0;
  if (!rebuild && serverSeq > outputSeq) {
    startIndex = entries.findIndex((entry) => Number.isFinite(entry.seq) && entry.seq > outputSeq);
    if (startIndex === -1) {
      rebuild = true;
    } else if (entries[startIndex].seq > outputSeq + 1) {
      /* Lines were dropped by the server's cap between polls: redraw the tail. */
      rebuild = true;
    }
  } else if (!rebuild && serverSeq === outputSeq) {
    startIndex = entries.length;
  }

  if (rebuild) {
    outputToken = token;
    outputSeq = 0;
    startIndex = 0;
    els.output.textContent = '';
    if (entries.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'output-empty';
      if (step.status === 'running') {
        empty.textContent = 'Starting… output will stream here.';
      } else {
        empty.textContent = 'Nothing has run yet. Press “Run step” to see the real result here.';
      }
      els.output.append(empty);
    }
  }

  if (entries.length > 0) {
    const placeholder = els.output.querySelector('.output-empty');
    if (placeholder) placeholder.remove();
  }

  for (let index = startIndex; index < entries.length; index += 1) {
    const entry = entries[index] || {};
    const line = document.createElement('p');
    const stream = entry.stream === 'err' || entry.stream === 'cmd' || entry.stream === 'info' ? entry.stream : 'out';
    line.className = `line ${stream}`;
    line.textContent = String(entry.text ?? '');
    els.output.append(line);
  }

  if (entries.length > 0) {
    const last = entries[entries.length - 1];
    outputSeq = Number.isFinite(last.seq) ? last.seq : serverSeq;
  } else {
    outputSeq = serverSeq;
  }

  /* A completed step opens at its beginning. Live output follows the tail. */
  const followTail = nearBottom && !(rebuild && step.status !== 'running');
  if (entries.length > 0 && followTail) {
    els.output.scrollTop = els.output.scrollHeight;
  }

  els.copy.disabled = entries.length === 0;
  if (step.truncated) {
    els.outputNote.textContent =
      'Earlier output was trimmed so the page stays responsive. The summary still reflects the real exit status.';
    els.outputNote.hidden = false;
  } else {
    els.outputNote.hidden = true;
    els.outputNote.textContent = '';
  }
  els.output.setAttribute('aria-busy', step.status === 'running' ? 'true' : 'false');
}

function render() {
  if (!data || !Array.isArray(data.steps)) return;
  renderRail();
  const step = currentStep();
  if (!step) return;
  const steps = data.steps;
  const index = steps.findIndex((candidate) => candidate.id === step.id);
  const total = steps.length;

  setText(els.eyebrow, `Step ${index + 1} of ${total}`);
  setText(els.position, `${String(index + 1).padStart(2, '0')} / ${String(total).padStart(2, '0')}`);
  setText(els.title, step.title);
  setText(els.why, step.why);
  renderChips(step);

  const running = data.running;
  const thisRunning = Boolean(running && running.stepId === step.id);
  const otherRunning = Boolean(running && running.stepId !== step.id);
  els.run.disabled = Boolean(running);
  els.run.setAttribute('aria-busy', thisRunning ? 'true' : 'false');
  if (thisRunning) {
    setText(els.run, 'Running…');
  } else if (otherRunning) {
    setText(els.run, 'Another step is running');
  } else if (step.status === 'ok' || step.status === 'failed') {
    setText(els.run, 'Run again');
  } else {
    setText(els.run, 'Run step');
  }

  els.prev.disabled = index <= 0;
  els.next.disabled = index < 0 || index >= total - 1;

  if (otherRunning) {
    const other = steps.find((candidate) => candidate.id === running.stepId);
    setText(
      els.runNote,
      `Only one step runs at a time. ${other ? other.title : running.stepId} is still running; wait for it.`,
    );
  } else if (step.needsRoot && data.server && !data.server.isRoot) {
    setText(
      els.runNote,
      'This step needs root. The wizard uses passwordless sudo if it is available; otherwise it prints the exact command and changes nothing. It never asks for a password in the browser.',
    );
  } else {
    setText(els.runNote, 'Output streams below as the command runs. Nothing advances automatically.');
  }

  setText(els.status, STATUS_TEXT[step.status] || step.status);
  if (els.status.dataset.status !== step.status) els.status.dataset.status = step.status;
  setText(els.summary, step.summary || defaultSummary(step));

  renderSecrets(step);
  renderOutput(step);

  const formSubmit = els.secretsForm.querySelector('button[type="submit"]');
  if (formSubmit) {
    formSubmit.disabled = Boolean(running);
    setText(formSubmit, thisRunning ? 'Running…' : 'Write secrets');
  }

  if (data.server) {
    const mode = data.server.isRoot ? 'server root' : 'server not root';
    const uid = data.server.uid === null || data.server.uid === undefined ? 'uid n/a' : `uid ${data.server.uid}`;
    setText(
      els.serverContext,
      `${data.server.platform} · node ${data.server.node}\n${uid} · ${mode}\nrepo ${data.server.repoDir}`,
    );
    if (data.server.platform !== 'linux') {
      setText(
        els.platformNote,
        `This host is ${data.server.platform}, not Linux. Steps that need pacman, Flatpak or systemd will fail with a platform message; nothing is simulated.`,
      );
      els.platformNote.hidden = false;
    } else {
      els.platformNote.hidden = true;
      setText(els.platformNote, '');
    }
  }
}

function selectStep(id, options = {}) {
  if (!data || !data.steps) return;
  const step = data.steps.find((candidate) => candidate.id === id);
  if (!step) return;
  selectedId = id;
  if (options.updateHash) {
    history.pushState(null, '', `#${encodeURIComponent(id)}`);
  }
  render();
  if (options.focus) els.title.focus();
}

function move(delta) {
  if (!data || !data.steps) return;
  const index = data.steps.findIndex((step) => step.id === selectedId);
  const next = index + delta;
  if (next < 0 || next >= data.steps.length) return;
  selectStep(data.steps[next].id, { updateHash: true, focus: true });
}

async function runCurrent() {
  const step = currentStep();
  if (!step || !data || data.running) return;

  let payload = null;
  if (Array.isArray(step.fields) && step.fields.length > 0) {
    const read = readSecrets(step);
    if (read.error) {
      setFormError(read.error);
      return;
    }
    payload = { values: read.values, confirmReplace: read.confirmReplace };
  }
  setFormError('');
  els.run.disabled = true;
  setText(els.run, 'Starting…');

  try {
    await request(`/api/steps/${encodeURIComponent(step.id)}/run`, {
      method: 'POST',
      headers: payload ? { 'content-type': 'application/json' } : {},
      body: payload ? JSON.stringify(payload) : undefined,
    });
    payload = null;
    if (Array.isArray(step.fields) && step.fields.length > 0) clearSecretsForm();
    await refresh();
  } catch (error) {
    payload = null;
    if (error.status === 409) {
      showBanner('Another step is already running. Wait for it to finish, then try again.');
    } else {
      showBanner(`Could not start “${step.title}”: ${error.message}`);
    }
    els.run.disabled = false;
  }
}

async function copyOutput() {
  const step = currentStep();
  if (!step || !Array.isArray(step.output) || step.output.length === 0) return;
  const text = step.output.map((entry) => String(entry.text ?? '')).join('\n');
  try {
    await navigator.clipboard.writeText(text);
    setText(els.copy, 'Copied');
    setTimeout(() => setText(els.copy, 'Copy output'), 1600);
  } catch {
    showBanner('Copy failed. Select the output text and copy it manually.');
    els.output.focus();
  }
}

function readHashStep() {
  const raw = location.hash.replace(/^#/, '');
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function syncFromHash() {
  const id = readHashStep();
  if (data && id && data.steps.some((step) => step.id === id) && id !== selectedId) {
    outputToken = null;
    outputSeq = 0;
    selectStep(id, { updateHash: false, focus: true });
  }
}

function onKeyDown(event) {
  if (!event.altKey) return;
  const tag = event.target && event.target.tagName ? event.target.tagName.toLowerCase() : '';
  if (tag === 'input' || tag === 'textarea' || tag === 'select' || (event.target && event.target.isContentEditable)) {
    return;
  }
  if (event.key === 'ArrowLeft') {
    event.preventDefault();
    move(-1);
  } else if (event.key === 'ArrowRight') {
    event.preventDefault();
    move(1);
  }
}

function init() {
  const initial = readHashStep();
  if (initial) selectedId = initial;

  els.run.addEventListener('click', () => {
    void runCurrent();
  });
  els.prev.addEventListener('click', () => move(-1));
  els.next.addEventListener('click', () => move(1));
  els.copy.addEventListener('click', () => {
    void copyOutput();
  });
  document.addEventListener('keydown', onKeyDown);
  window.addEventListener('hashchange', syncFromHash);
  window.addEventListener('popstate', syncFromHash);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') schedule(0);
  });

  void refresh();
}

init();