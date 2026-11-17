#!/usr/bin/env node
// Operant first-boot provisioning wizard — local HTTP server.
//
// Deliberate constraints:
//   * binds 127.0.0.1 only; refuses anything that looks like a remote bind
//   * one job at a time, spawned with an argv array (never a shell string)
//   * no third-party dependencies — node:http and the standard library only
//   * never logs or persists credential values

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// Constants and startup guard
// ---------------------------------------------------------------------------

const HOST = '127.0.0.1';
const PORT = (() => {
  const raw = process.env.PROVISION_PORT;
  if (!raw) return 8788;
  const value = Number(raw);
  return Number.isInteger(value) && value > 1024 && value < 65536 ? value : 8788;
})();

const WIZARD_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROVISION_DIR = path.resolve(WIZARD_DIR, '..');
const UI_DIR = path.join(WIZARD_DIR, 'ui');
const CHECKS_DIR = path.join(WIZARD_DIR, 'checks');
const SECRETS_PATH = '/etc/operant/secrets.env';
const INSTALL_FILE = path.join(PROVISION_DIR, 'install.json');

const STEP_IDS = [
  'hardware',
  'network',
  'secrets',
  'packages',
  'ai-stack',
  'theming',
  'whatsapp',
  'browser',
  'finish',
];

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const MAX_BODY_BYTES = 64 * 1024;
const MAX_OUTPUT_LINES = 1500;
const MAX_OUTPUT_CHARS = 256 * 1024;
const MAX_LINE_CHARS = 2000;
const MAX_CAPTURE_CHARS = 1024 * 1024;

function fail(message) {
  console.error(`\nRefusing to start: ${message}\n`);
  process.exit(1);
}

function hostLooksLoopback(value) {
  let host = String(value).trim().toLowerCase();
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return end > 0 && LOOPBACK_HOSTS.has(host.slice(1, end));
  }
  const firstColon = host.indexOf(':');
  if (firstColon !== -1 && firstColon === host.lastIndexOf(':')) host = host.slice(0, firstColon);
  return LOOPBACK_HOSTS.has(host);
}

// A network-exposed wizard would be a credential-collection endpoint on a LAN.
// There is no supported remote mode; make that a hard failure, not a warning.
for (const name of [
  'PROVISION_HOST',
  'PROVISION_BIND',
  'PROVISION_ADDRESS',
  'PROVISION_BIND_ADDRESS',
  'HOST',
  'BIND_ADDRESS',
]) {
  const value = process.env[name];
  if (value && !hostLooksLoopback(value)) {
    fail(
      `${name}=${JSON.stringify(value)} would bind beyond loopback. ` +
        'This wizard only listens on 127.0.0.1:8788.',
    );
  }
}
if (process.env.PROVISION_ALLOW_REMOTE === '1') {
  fail('PROVISION_ALLOW_REMOTE is not supported. The wizard has no remote mode.');
}
if (Number(process.env.LISTEN_FDS || 0) > 0) {
  fail(
    'socket activation (LISTEN_FDS) is set. The wizard refuses to inherit a ' +
      'socket it did not bind to 127.0.0.1 itself.',
  );
}

// ---------------------------------------------------------------------------
// User, home and repository context
// ---------------------------------------------------------------------------

function safeUserInfo() {
  try {
    return os.userInfo();
  } catch {
    return {
      username: process.env.USER || process.env.USERNAME || 'unknown',
      homedir: os.homedir(),
    };
  }
}

function passwdEntries() {
  try {
    return fs
      .readFileSync('/etc/passwd', 'utf8')
      .split('\n')
      .map((line) => line.split(':'))
      .filter((parts) => parts.length >= 7);
  } catch {
    return [];
  }
}

function fieldFromPasswd(selector, field) {
  const entry = passwdEntries().find((parts) => selector(parts));
  return entry ? entry[field] : null;
}

function homeOfUser(name) {
  return fieldFromPasswd((parts) => parts[0] === name, 5);
}

function uidOfUser(name) {
  const raw = fieldFromPasswd((parts) => parts[0] === name, 2);
  return raw === null ? null : Number(raw);
}

function gidOfUser(name) {
  const raw = fieldFromPasswd((parts) => parts[0] === name, 3);
  return raw === null ? null : Number(raw);
}

function nameOfUid(uid) {
  return fieldFromPasswd((parts) => Number(parts[2]) === Number(uid), 0);
}

const current = safeUserInfo();
const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
const isRoot = currentUid === 0;
const sudoUser = (process.env.SUDO_USER || '').trim();

let humanUser = sudoUser || current.username;
if (humanUser !== current.username && !homeOfUser(humanUser)) humanUser = current.username;
const humanHome = homeOfUser(humanUser) || current.homedir || os.homedir();
const humanUid = uidOfUser(humanUser) ?? currentUid ?? 0;
const humanGid = gidOfUser(humanUser) ?? humanUid;

function readInstallConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(INSTALL_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

const installConfig = readInstallConfig();

function hasPackageJson(dir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return parsed && typeof parsed === 'object';
  } catch {
    return false;
  }
}

function gitOriginOf(dir) {
  try {
    const config = fs.readFileSync(path.join(dir, '.git', 'config'), 'utf8');
    let inOrigin = false;
    for (const rawLine of config.split('\n')) {
      const line = rawLine.trim();
      if (line.startsWith('[')) {
        inOrigin = /^\[remote\s+"origin"\]$/.test(line);
      } else if (inOrigin) {
        const match = line.match(/^url\s*=\s*(.+)$/);
        if (match) return match[1].trim();
      }
    }
  } catch {
    // no git checkout, or a worktree .git file: fall through
  }
  return '';
}

const sourceRoot = path.resolve(PROVISION_DIR, '..');
let repoDir =
  (typeof process.env.OPERANT_REPO_DIR === 'string' && process.env.OPERANT_REPO_DIR.trim()) ||
  (typeof installConfig.repoDir === 'string' && installConfig.repoDir.trim()) ||
  (hasPackageJson(sourceRoot) ? sourceRoot : path.join(humanHome, 'operant'));
repoDir = String(repoDir).replace(/^~(?=$|[\\/])/, humanHome);
if (!path.isAbsolute(repoDir)) repoDir = path.resolve(humanHome, repoDir);

const repoUrl = String(
  (typeof process.env.OPERANT_REPO_URL === 'string' && process.env.OPERANT_REPO_URL.trim()) ||
    (typeof installConfig.repoUrl === 'string' && installConfig.repoUrl.trim()) ||
    gitOriginOf(repoDir) ||
    gitOriginOf(sourceRoot) ||
    '',
);

const STATE_DIR = process.env.PROVISION_STATE_DIR
  ? path.resolve(process.env.PROVISION_STATE_DIR)
  : path.join(
      process.env.XDG_STATE_HOME || path.join(humanHome, '.local', 'state'),
      'operant-provision',
    );
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const MARKER_FILE = path.join(STATE_DIR, 'wizard-finished');
const SERVER_PATH = path.join(WIZARD_DIR, 'server.mjs');

const startedAt = new Date().toISOString();

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function redact(value) {
  return String(value)
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)([^/\s@]+)@/gi, '$1***@')
    .replace(/([?&](?:token|access_token|auth|key|api_key)=)[^&\s]+/gi, '$1***');
}

function quoteArg(value) {
  const text = String(value);
  if (text === '') return "''";
  if (/^[A-Za-z0-9_@%+=:,./~-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function fmtCmd(cmd, args = []) {
  return [cmd, ...args].map((part) => quoteArg(redact(part))).join(' ');
}

function fmtBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  const shown = value / 1024 ** index;
  return `${shown.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

// ---------------------------------------------------------------------------
// Static UI (loaded once; no filesystem reads per request)
// ---------------------------------------------------------------------------

const STATIC_FILES = new Map();

function addStatic(route, filename, type) {
  const fullPath = path.join(UI_DIR, filename);
  try {
    STATIC_FILES.set(route, { body: fs.readFileSync(fullPath), type });
  } catch (error) {
    fail(`cannot read ${fullPath}: ${error.message}`);
  }
}

addStatic('/', 'index.html', 'text/html; charset=utf-8');
addStatic('/index.html', 'index.html', 'text/html; charset=utf-8');
addStatic('/app.js', 'app.js', 'text/javascript; charset=utf-8');
addStatic('/style.css', 'style.css', 'text/css; charset=utf-8');

// ---------------------------------------------------------------------------
// Step modules
// ---------------------------------------------------------------------------

const definitions = [];
const byId = new Map();

function normalizeField(field, stepId) {
  if (!field || typeof field.name !== 'string' || !/^[A-Z][A-Z0-9_]{1,63}$/.test(field.name)) {
    fail(`step ${stepId} exports an invalid field name: ${JSON.stringify(field?.name)}`);
  }
  return {
    name: field.name,
    label: String(field.label || field.name),
    hint: String(field.hint || ''),
    required: field.required === true,
    minLength: Number.isInteger(field.minLength) ? field.minLength : null,
  };
}

for (const id of STEP_IDS) {
  let mod;
  try {
    mod = await import(pathToFileURL(path.join(CHECKS_DIR, `${id}.mjs`)).href);
  } catch (error) {
    fail(`cannot load checks/${id}.mjs: ${error.message}`);
  }
  if (mod.id !== id) fail(`checks/${id}.mjs exports id ${JSON.stringify(mod.id)}; expected "${id}"`);
  if (typeof mod.title !== 'string' || !mod.title.trim()) fail(`checks/${id}.mjs needs a title`);
  if (typeof mod.why !== 'string' || !mod.why.trim()) fail(`checks/${id}.mjs needs a why`);
  if (typeof mod.run !== 'function') fail(`checks/${id}.mjs needs a run(ctx) function`);
  const fields = Array.isArray(mod.fields) ? mod.fields.map((field) => normalizeField(field, id)) : [];
  const definition = {
    id,
    title: mod.title,
    why: mod.why,
    run: mod.run,
    needsRoot: mod.needsRoot === true,
    fields,
  };
  definitions.push(definition);
  byId.set(id, definition);
}

// ---------------------------------------------------------------------------
// State (metadata + output; never credential values)
// ---------------------------------------------------------------------------

function blankRuntime() {
  return {
    status: 'pending',
    summary: '',
    output: [],
    truncated: false,
    startedAt: null,
    finishedAt: null,
    needsRoot: false,
    chars: 0,
    seq: 0,
  };
}

function blankState() {
  return {
    version: 1,
    steps: Object.fromEntries(STEP_IDS.map((id) => [id, blankRuntime()])),
    updatedAt: null,
  };
}

let state = blankState();

function capOutput(runtime) {
  while (
    runtime.output.length > MAX_OUTPUT_LINES ||
    (runtime.chars || 0) > MAX_OUTPUT_CHARS
  ) {
    const dropped = runtime.output.shift();
    if (!dropped) break;
    runtime.chars = Math.max(0, (runtime.chars || 0) - String(dropped.text).length);
    runtime.truncated = true;
  }
}

function loadState() {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error(`[state] ignoring unreadable ${STATE_FILE}: ${error.message}`);
    }
    return;
  }
  if (!parsed || typeof parsed !== 'object' || !parsed.steps) return;
  for (const id of STEP_IDS) {
    const saved = parsed.steps[id];
    if (!saved || typeof saved !== 'object') continue;
    const runtime = state.steps[id];
    if (['pending', 'running', 'ok', 'failed'].includes(saved.status)) runtime.status = saved.status;
    if (typeof saved.summary === 'string') runtime.summary = saved.summary;
    if (Number.isFinite(saved.startedAt)) runtime.startedAt = saved.startedAt;
    if (Number.isFinite(saved.finishedAt)) runtime.finishedAt = saved.finishedAt;
    runtime.needsRoot = saved.needsRoot === true;
    if (Array.isArray(saved.output)) {
      for (const entry of saved.output) {
        if (!entry || typeof entry.text !== 'string') continue;
        const stream = ['out', 'err', 'cmd', 'info'].includes(entry.stream) ? entry.stream : 'out';
        let text = entry.text;
        if (text.length > MAX_LINE_CHARS) text = `${text.slice(0, MAX_LINE_CHARS)} … [truncated]`;
        runtime.seq += 1;
        const sequence = Number.isFinite(entry.seq) && entry.seq > 0 ? entry.seq : runtime.seq;
        runtime.seq = Math.max(runtime.seq, sequence);
        runtime.output.push({ seq: sequence, stream, text });
        runtime.chars += text.length;
      }
      capOutput(runtime);
    }
    if (Number.isFinite(saved.seq) && saved.seq > runtime.seq) runtime.seq = saved.seq;
    if (runtime.status === 'running') {
      runtime.status = 'failed';
      runtime.summary = 'Interrupted by a wizard server restart; run the step again.';
      runtime.finishedAt = Date.now();
      appendOutput(id, 'info', 'The server restarted while this step was running. Its outcome is unknown; nothing is assumed.');
    }
  }
  if (typeof parsed.updatedAt === 'string') state.updatedAt = parsed.updatedAt;
}

function outputSnapshot(id) {
  const runtime = state.steps[id];
  return runtime.output.map((entry) => ({ seq: entry.seq, stream: entry.stream, text: entry.text }));
}

let saveInFlight = false;
let saveAgain = false;

async function saveState() {
  if (saveInFlight) {
    saveAgain = true;
    return;
  }
  saveInFlight = true;
  try {
    await fsp.mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
    if (isRoot && humanUid !== 0) {
      await fsp.chown(STATE_DIR, humanUid, humanGid).catch(() => {});
    }
    state.updatedAt = new Date().toISOString();
    const tempPath = `${STATE_FILE}.${process.pid}.tmp`;
    await fsp.writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await fsp.chmod(tempPath, 0o600);
    if (isRoot && humanUid !== 0) {
      await fsp.chown(tempPath, humanUid, humanGid).catch(() => {});
    }
    await fsp.rename(tempPath, STATE_FILE);
  } catch (error) {
    console.error(`[state] could not save ${STATE_FILE}: ${error.message}`);
  } finally {
    saveInFlight = false;
    if (saveAgain) {
      saveAgain = false;
      void saveState();
    }
  }
}

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void saveState();
  }, 2500);
}

async function syncMarker(complete) {
  try {
    if (complete) {
      await fsp.mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
      const tempPath = `${MARKER_FILE}.${process.pid}.tmp`;
      await fsp.writeFile(tempPath, `${new Date().toISOString()}\n`, { mode: 0o600 });
      await fsp.chmod(tempPath, 0o600);
      if (isRoot && humanUid !== 0) {
        await fsp.chown(tempPath, humanUid, humanGid).catch(() => {});
        await fsp.chown(STATE_DIR, humanUid, humanGid).catch(() => {});
      }
      await fsp.rename(tempPath, MARKER_FILE);
    } else {
      await fsp.rm(MARKER_FILE, { force: true });
    }
  } catch (error) {
    console.error(`[state] could not update completion marker: ${error.message}`);
  }
}

function appendOutput(stepId, stream, text) {
  const runtime = state.steps[stepId];
  if (!runtime) return;
  const allowed = stream === 'err' || stream === 'cmd' || stream === 'info' ? stream : 'out';
  const raw = String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (raw === '') {
    pushLine(runtime, allowed, '');
    return;
  }
  const lines = raw.split('\n');
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  for (const line of lines) pushLine(runtime, allowed, line);
}

function pushLine(runtime, stream, line) {
  let text = String(line);
  if (text.length > MAX_LINE_CHARS) text = `${text.slice(0, MAX_LINE_CHARS)} … [truncated]`;
  runtime.seq = (runtime.seq || 0) + 1;
  runtime.output.push({ seq: runtime.seq, stream, text });
  runtime.chars = (runtime.chars || 0) + text.length;
  capOutput(runtime);
  scheduleSave();
}

function logSection(stepId, title) {
  appendOutput(stepId, 'info', '');
  appendOutput(stepId, 'info', `── ${title} ${'─'.repeat(Math.max(3, 54 - String(title).length))}`);
}

// ---------------------------------------------------------------------------
// Child processes (argv arrays only)
// ---------------------------------------------------------------------------

const activeChildren = new Set();
let sudoProbePromise = null;

const BASE_ENV = {
  LANG: 'C',
  LC_ALL: 'C',
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: '/bin/false',
  COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
  NPM_CONFIG_UPDATE_NOTIFIER: 'false',
  npm_config_update_notifier: 'false',
};

function makeExec(logStream) {
  return function exec(cmd, args = [], options = {}) {
    if (typeof cmd !== 'string' || !cmd || cmd.includes('\0')) {
      return Promise.resolve({
        ok: false,
        code: null,
        signal: null,
        stdout: '',
        stderr: 'invalid command',
        missing: false,
        timedOut: false,
        durationMs: 0,
      });
    }
    const argv = Array.isArray(args) ? args : [];
    for (const arg of argv) {
      if (typeof arg !== 'string' || arg.includes('\0')) {
        return Promise.resolve({
          ok: false,
          code: null,
          signal: null,
          stdout: '',
          stderr: 'invalid argv entry',
          missing: false,
          timedOut: false,
          durationMs: 0,
        });
      }
    }

    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 120_000;
    const stream = options.stream === true;
    const cwd = typeof options.cwd === 'string' ? options.cwd : undefined;
    const environment = { ...process.env, ...BASE_ENV, ...(options.env || {}) };
    const began = Date.now();

    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(cmd, argv, {
          cwd,
          env: environment,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          shell: false,
        });
      } catch (error) {
        resolve({
          ok: false,
          code: null,
          signal: null,
          stdout: '',
          stderr: error.message,
          missing: error.code === 'ENOENT',
          timedOut: false,
          durationMs: Date.now() - began,
        });
        return;
      }

      activeChildren.add(child);
      let stdout = '';
      let stderr = '';
      let outPending = '';
      let errPending = '';
      let timedOut = false;
      let settled = false;
      let spawnError = null;
      let killTimer = null;

      const settle = (result) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        activeChildren.delete(child);
        resolve(result);
      };

      const capture = (chunk, isError) => {
        const text = chunk.toString('utf8');
        if (isError) {
          if (stderr.length < MAX_CAPTURE_CHARS) {
            stderr += text.slice(0, MAX_CAPTURE_CHARS - stderr.length);
          }
        } else if (stdout.length < MAX_CAPTURE_CHARS) {
          stdout += text.slice(0, MAX_CAPTURE_CHARS - stdout.length);
        }
        if (!stream) return;

        const combined = (isError ? errPending : outPending) + text;
        const parts = combined.split('\n');
        const rest = parts.pop() ?? '';
        if (isError) errPending = rest;
        else outPending = rest;
        for (const line of parts) {
          logStream(isError ? 'err' : 'out', line.replace(/\r$/, ''));
        }
      };

      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              timedOut = true;
              try {
                child.kill('SIGTERM');
              } catch {
                // already gone
              }
              killTimer = setTimeout(() => {
                try {
                  child.kill('SIGKILL');
                } catch {
                  // already gone
                }
              }, 3000);
            }, timeoutMs)
          : null;

      if (child.stdout) {
        child.stdout.on('data', (chunk) => capture(chunk, false));
      }
      if (child.stderr) {
        child.stderr.on('data', (chunk) => capture(chunk, true));
      }

      child.on('error', (error) => {
        spawnError = error;
        settle({
          ok: false,
          code: null,
          signal: null,
          stdout,
          stderr: error.message,
          missing: error.code === 'ENOENT',
          timedOut,
          durationMs: Date.now() - began,
        });
      });

      child.on('close', (code, signal) => {
        if (stream) {
          if (outPending) logStream('out', outPending.replace(/\r$/, ''));
          if (errPending) logStream('err', errPending.replace(/\r$/, ''));
          outPending = '';
          errPending = '';
        }
        if (spawnError) {
          settle({
            ok: false,
            code,
            signal,
            stdout,
            stderr,
            missing: spawnError.code === 'ENOENT',
            timedOut,
            durationMs: Date.now() - began,
          });
          return;
        }
        settle({
          ok: code === 0 && !timedOut,
          code,
          signal,
          stdout,
          stderr,
          missing: false,
          timedOut,
          durationMs: Date.now() - began,
        });
      });
    });
  };
}

function which(cmd) {
  if (typeof cmd !== 'string' || !cmd) return null;
  if (/[\\/]/.test(cmd)) {
    try {
      fs.accessSync(cmd, fs.constants.X_OK);
      return cmd;
    } catch {
      return null;
    }
  }
  const pathValue = process.env.PATH || process.env.Path || '';
  const extensions =
    process.platform === 'win32'
      ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
      : [''];
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) continue;
    const candidates =
      process.platform === 'win32'
        ? [cmd, ...extensions.map((ext) => cmd + ext), ...extensions.map((ext) => cmd + ext.toLowerCase())]
        : [cmd];
    for (const candidate of candidates) {
      const fullPath = path.join(directory, candidate);
      try {
        fs.accessSync(fullPath, fs.constants.X_OK);
        return fullPath;
      } catch {
        // keep looking
      }
    }
  }
  return null;
}

function secretsFileExists() {
  try {
    return fs.statSync(SECRETS_PATH).isFile();
  } catch (error) {
    return error.code === 'ENOENT' ? false : null;
  }
}

function allPriorOk() {
  return STEP_IDS.filter((id) => id !== 'finish').every(
    (id) => state.steps[id] && state.steps[id].status === 'ok',
  );
}

function previousSummary() {
  return Object.fromEntries(
    definitions.map((definition) => {
      const runtime = state.steps[definition.id];
      return [
        definition.id,
        {
          status: runtime.status,
          summary: runtime.summary,
          startedAt: runtime.startedAt,
          finishedAt: runtime.finishedAt,
        },
      ];
    }),
  );
}

// ---------------------------------------------------------------------------
// Context handed to each check module
// ---------------------------------------------------------------------------

function createContext(stepId, input) {
  const exec = makeExec((stream, text) => appendOutput(stepId, stream, text));
  const log = (text, stream = 'out') => appendOutput(stepId, stream, text);

  async function run(cmd, args = [], options = {}) {
    log(`$ ${fmtCmd(cmd, args)}`, 'cmd');
    const result = await exec(cmd, args, options);
    if (!options.stream && options.echo !== false) {
      if (result.stdout && result.stdout.trim()) log(result.stdout.replace(/\s+$/, ''));
      if (result.stderr && result.stderr.trim()) log(result.stderr.replace(/\s+$/, ''), 'err');
    }
    if (result.missing) {
      log(`${cmd}: command not found on PATH`, 'err');
    }
    if (result.timedOut) {
      log(`${cmd}: timed out after ${Math.round((options.timeoutMs ?? 120_000) / 1000)}s`, 'err');
    } else if (!result.ok && Number.isInteger(result.code) && result.code !== 0) {
      log(`exit code ${result.code}`, 'info');
    }
    return result;
  }

  async function canSudoNonInteractive() {
    if (isRoot) return true;
    if (!sudoProbePromise) {
      sudoProbePromise = exec('sudo', ['-n', 'true'], { timeoutMs: 5000 }).then((result) => result.ok);
    }
    return sudoProbePromise;
  }

  async function runRoot(cmd, args = [], options = {}) {
    if (isRoot) return run(cmd, args, options);
    if (await canSudoNonInteractive()) {
      return run('sudo', ['-n', cmd, ...args], options);
    }
    const manual = `sudo ${fmtCmd(cmd, args)}`;
    log(
      'This action needs root. Non-interactive sudo is unavailable, so the wizard did not ask for a password in the browser and did not run it.',
      'err',
    );
    log(manual, 'cmd');
    return {
      ok: false,
      code: null,
      signal: null,
      stdout: '',
      stderr: 'root is required and non-interactive sudo is unavailable',
      missing: false,
      timedOut: false,
      durationMs: 0,
      needsRoot: true,
      manual: [manual],
    };
  }

  async function runAsHuman(cmd, args = [], options = {}) {
    if (!isRoot) return run(cmd, args, options);
    const target = typeof options.cwd === 'string' ? options.cwd : repoDir;
    let owner = null;
    try {
      owner = fs.statSync(target).uid;
    } catch {
      try {
        owner = fs.statSync(humanHome).uid;
      } catch {
        owner = humanUid;
      }
    }
    if (!owner || owner === 0) return run(cmd, args, options);
    const targetUser = nameOfUid(owner) || humanUser;
    if (!targetUser || targetUser === 'root') return run(cmd, args, options);
    return run('sudo', ['-u', targetUser, '--', cmd, ...args], options);
  }

  return {
    stepId,
    input: input ?? null,
    platform: process.platform,
    isLinux: process.platform === 'linux',
    isRoot,
    uid: currentUid,
    user: current.username,
    humanUser,
    humanHome,
    humanUid,
    repoDir,
    repoUrl,
    repoUrlDisplay: redact(repoUrl),
    provisionDir: PROVISION_DIR,
    serverPath: SERVER_PATH,
    stateDir: STATE_DIR,
    secretsPath: SECRETS_PATH,
    allPriorOk: allPriorOk(),
    previous: previousSummary(),
    env: process.env,
    exec,
    run,
    runRoot,
    runAsHuman,
    which,
    fmtBytes,
    fmtCmd,
    redact,
    log,
    logSection: (title) => logSection(stepId, title),
    secretsFileExists,
  };
}

// ---------------------------------------------------------------------------
// Job runner (one at a time)
// ---------------------------------------------------------------------------

let activeJob = null;

function startStep(stepId, input) {
  if (activeJob) {
    return {
      status: 409,
      body: {
        error: `Another step is already running: ${activeJob.stepId}`,
        running: { stepId: activeJob.stepId, startedAt: activeJob.startedAt },
      },
    };
  }
  const definition = byId.get(stepId);
  if (!definition) return { status: 404, body: { error: 'Unknown step' } };

  const runtime = state.steps[stepId];
  runtime.status = 'running';
  runtime.summary = '';
  runtime.output = [];
  runtime.truncated = false;
  runtime.chars = 0;
  runtime.seq = 0;
  runtime.needsRoot = false;
  runtime.startedAt = Date.now();
  runtime.finishedAt = null;
  activeJob = { stepId, startedAt: runtime.startedAt };
  void saveState();
  if (stepId !== 'finish') void syncMarker(false);
  console.log(`[step] ${stepId} started`);

  void (async () => {
    const context = createContext(stepId, input);
    let result = null;
    try {
      const returned = await definition.run(context, input);
      result =
        returned && typeof returned === 'object'
          ? returned
          : { ok: false, summary: 'The step returned no result object; treating it as failed.' };
      if (typeof result.ok !== 'boolean') {
        appendOutput(stepId, 'err', 'The step returned an invalid result; treating it as failed.');
        result = { ...result, ok: false, summary: 'The step returned an invalid result.' };
      }
    } catch (error) {
      appendOutput(stepId, 'err', `Step crashed: ${error && error.message ? error.message : String(error)}`);
      if (process.env.PROVISION_DEBUG === '1' && error && error.stack) {
        appendOutput(stepId, 'err', error.stack);
      }
      result = { ok: false, summary: 'The step threw before finishing; see the real error above.' };
    } finally {
      runtime.status = result && result.ok === true ? 'ok' : 'failed';
      runtime.summary = String(
        result && result.summary ? result.summary : runtime.status === 'ok' ? 'Completed.' : 'Failed.',
      );
      runtime.finishedAt = Date.now();
      if (result && result.needsRoot === true) runtime.needsRoot = true;
      context.input = null;
      try {
        if (stepId === 'finish') {
          const complete = allPriorOk() && runtime.status === 'ok';
          appendOutput(
            stepId,
            'info',
            complete
              ? 'Completion marker written: the autostart entry will not reopen this wizard.'
              : 'Completion marker removed: the wizard will open again at login until every step passes.',
          );
          await syncMarker(complete);
        }
        await saveState();
      } finally {
        activeJob = null;
      }
      const elapsed = ((runtime.finishedAt - runtime.startedAt) / 1000).toFixed(1);
      console.log(`[step] ${stepId} ${runtime.status} in ${elapsed}s`);
    }
  })().catch((error) => {
    console.error(`[step] ${stepId} job failed outside its handler: ${error && error.stack ? error.stack : error}`);
    try {
      const runtime = state.steps[stepId];
      runtime.status = 'failed';
      runtime.summary = 'Internal wizard error; see the server log.';
      runtime.finishedAt = Date.now();
    } catch {
      // state is gone; nothing more to record
    }
    activeJob = null;
    void saveState();
  });

  return {
    status: 202,
    body: { ok: true, stepId, startedAt: runtime.startedAt },
  };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function securityHeaders(extra = {}) {
  return {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'geolocation=(), camera=(), microphone=()',
    'Content-Security-Policy':
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
      "connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'; " +
      "frame-ancestors 'none'",
    ...extra,
  };
}

function sendJson(res, status, body, extraHeaders = {}) {
  if (res.writableEnded) return;
  const payload = Buffer.from(`${JSON.stringify(body)}\n`, 'utf8');
  res.writeHead(status, {
    ...securityHeaders(),
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
    ...extraHeaders,
  });
  res.end(payload);
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  if (res.writableEnded) return;
  const payload = Buffer.from(text, 'utf8');
  res.writeHead(status, {
    ...securityHeaders(),
    'Content-Type': type,
    'Content-Length': payload.length,
  });
  res.end(payload);
}

function hostnameOfHostHeader(value) {
  let host = String(value || '').trim().toLowerCase();
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return end > 0 ? host.slice(1, end) : host;
  }
  const colon = host.lastIndexOf(':');
  if (colon !== -1 && colon === host.indexOf(':')) host = host.slice(0, colon);
  return host;
}

function originAllowed(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:') return false;
  const port = parsed.port ? Number(parsed.port) : 80;
  return LOOPBACK_HOSTS.has(parsed.hostname) && port === PORT;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      req.resume();
      reject(new HttpError(413, 'Request body is too large.'));
      return;
    }
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new HttpError(413, 'Request body is too large.'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', (error) => reject(new HttpError(400, `Could not read request body: ${error.message}`)));
  });
}

function publicServerInfo() {
  return {
    platform: process.platform,
    node: process.versions.node,
    isRoot,
    uid: currentUid,
    user: current.username,
    humanUser,
    repoDir,
    repoUrl: redact(repoUrl),
    stateDir: STATE_DIR,
    secretsPath: SECRETS_PATH,
    startedAt,
    pid: process.pid,
  };
}

function publicSteps() {
  return {
    server: publicServerInfo(),
    running: activeJob ? { stepId: activeJob.stepId, startedAt: activeJob.startedAt } : null,
    steps: definitions.map((definition) => {
      const runtime = state.steps[definition.id];
      return {
        id: definition.id,
        title: definition.title,
        why: definition.why,
        needsRoot: definition.needsRoot,
        fields: definition.fields,
        status: runtime.status,
        summary: runtime.summary,
        startedAt: runtime.startedAt,
        finishedAt: runtime.finishedAt,
        output: outputSnapshot(definition.id),
        outputSeq: runtime.seq || 0,
        truncated: runtime.truncated === true,
        needsRootReported: runtime.needsRoot === true,
        secretsFileExists: definition.id === 'secrets' ? secretsFileExists() : null,
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Request routing
// ---------------------------------------------------------------------------

async function handleRequest(req, res) {
  const requestHost = req.headers.host;
  if (!requestHost || !LOOPBACK_HOSTS.has(hostnameOfHostHeader(requestHost))) {
    sendText(res, 403, 'Forbidden: this server only answers requests addressed to localhost.');
    return;
  }
  const origin = req.headers.origin;
  if (origin && !originAllowed(origin)) {
    sendText(res, 403, 'Forbidden: cross-origin request.');
    return;
  }
  if (String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') {
    sendText(res, 403, 'Forbidden: cross-site request.');
    return;
  }

  let url;
  try {
    url = new URL(req.url || '/', `http://${HOST}:${PORT}`);
  } catch {
    sendText(res, 400, 'Bad request.');
    return;
  }
  const pathname = url.pathname;

  if (STATIC_FILES.has(pathname)) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendText(res, 405, 'Method not allowed.', 'text/plain; charset=utf-8');
      return;
    }
    const asset = STATIC_FILES.get(pathname);
    const headers = {
      ...securityHeaders(),
      'Content-Type': asset.type,
      'Content-Length': asset.body.length,
    };
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : asset.body);
    return;
  }

  if (pathname === '/favicon.ico') {
    res.writeHead(204, securityHeaders());
    res.end();
    return;
  }

  if (pathname === '/api/health') {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'Use GET.' }, { Allow: 'GET' });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      pid: process.pid,
      uptimeSeconds: Math.round(process.uptime()),
      startedAt,
    });
    return;
  }

  if (pathname === '/api/steps') {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'Use GET.' }, { Allow: 'GET' });
      return;
    }
    sendJson(res, 200, publicSteps());
    return;
  }

  const runMatch = pathname.match(/^\/api\/steps\/([a-z0-9-]+)\/run$/);
  if (runMatch) {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'Use POST.' }, { Allow: 'POST' });
      return;
    }
    const stepId = runMatch[1];
    const definition = byId.get(stepId);
    if (!definition) {
      sendJson(res, 404, { error: 'Unknown step.' });
      return;
    }

    let input = null;
    if (stepId === 'secrets') {
      const contentType = String(req.headers['content-type'] || '').toLowerCase();
      if (!contentType.includes('application/json')) {
        sendJson(res, 415, { error: 'Credentials must be sent as application/json.' });
        return;
      }
      const raw = await readBody(req);
      if (!raw.trim()) {
        sendJson(res, 400, { error: 'Expected a JSON body with a "values" object.' });
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        sendJson(res, 400, { error: 'Invalid JSON body.' });
        return;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        sendJson(res, 400, { error: 'Expected a JSON object.' });
        return;
      }
      if (!parsed.values || typeof parsed.values !== 'object' || Array.isArray(parsed.values)) {
        sendJson(res, 400, { error: '"values" must be an object of credential names to values.' });
        return;
      }
      input = { values: parsed.values, confirmReplace: parsed.confirmReplace === true };
    } else {
      req.resume();
    }

    const outcome = startStep(stepId, input);
    sendJson(res, outcome.status, outcome.body);
    return;
  }

  if (pathname.startsWith('/api/')) {
    sendJson(res, 404, { error: 'Not found.' });
    return;
  }

  sendText(res, 404, 'Not found.');
}

const server = http.createServer((req, res) => {
  void handleRequest(req, res).catch((error) => {
    if (error instanceof HttpError) {
      sendJson(res, error.status, { error: error.message });
      return;
    }
    console.error(`[http] ${req.method} ${req.url}: ${error && error.stack ? error.stack : error}`);
    if (!res.headersSent) {
      sendJson(res, 500, { error: 'Internal server error.' });
    } else {
      try {
        res.end();
      } catch {
        // socket already gone
      }
    }
  });
});

server.headersTimeout = 15_000;
server.requestTimeout = 30_000;

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(
      `Port ${PORT} is already in use. Stop the other wizard instance ` +
        `(systemctl --user stop operant-provision) or set PROVISION_PORT for development.`,
    );
  } else {
    console.error(`Server error: ${error.message}`);
  }
  process.exit(1);
});

loadState();

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('Operant first-boot provisioning wizard');
  console.log(`  URL      http://${HOST}:${PORT}/`);
  console.log(`  user     ${current.username} (uid ${currentUid ?? 'n/a'}), root: ${isRoot ? 'yes' : 'no'}`);
  console.log(`  platform ${process.platform}, node ${process.versions.node}`);
  console.log(`  repo     ${repoDir}${repoUrl ? ` (${redact(repoUrl)})` : ' (no origin URL known)'}`);
  console.log(`  state    ${STATE_DIR}`);
  console.log('  bind     127.0.0.1 only; no remote mode; no dependency install');
  if (isRoot) {
    console.log('  warning  running elevated: privileged steps will execute directly.');
  }
  console.log('');
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[server] ${signal}: shutting down`);
  for (const child of activeChildren) {
    try {
      child.kill('SIGTERM');
    } catch {
      // already gone
    }
  }
  void saveState();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));