// Step 5 — AI stack: DSH, corepack/pnpm, the Operant checkout, install and build.

import fs from 'node:fs';
import path from 'node:path';

export const id = 'ai-stack';
export const title = 'AI stack and Operant build';
export const why = 'The agent runtime and the Operant checkout are what actually make this an Operant machine.';
export const needsRoot = true;

const DSH_SPEC = '@deepseek-ai/dsh@0.2.2-rc.1';
const FALLBACK_PNPM = '11.19.0';
const LONG_TIMEOUT = 30 * 60 * 1000;

function readPackageJson(directory) {
  try {
    return JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

function pnpmVersionFrom(directory) {
  const packageJson = readPackageJson(directory);
  const packageManager = typeof packageJson?.packageManager === 'string' ? packageJson.packageManager : '';
  const match = packageManager.match(/^pnpm@([^+\s]+)/);
  if (!match || !/^[0-9][0-9A-Za-z.+-]*$/.test(match[1])) return FALLBACK_PNPM;
  return match[1];
}

function directoryIsEmpty(directory) {
  try {
    return fs.readdirSync(directory).length === 0;
  } catch {
    return false;
  }
}

export async function run(ctx) {
  if (!ctx.isLinux) {
    ctx.log(
      `This step installs a global CLI, enables corepack and builds a pnpm workspace — Arch-based Linux ` +
        `(CachyOS) only. Current platform: ${ctx.platform}. No commands were run.`,
      'err',
    );
    return { ok: false, summary: `Requires Linux; not run on ${ctx.platform}.` };
  }

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (!Number.isFinite(nodeMajor) || nodeMajor < 22) {
    ctx.log(`Node 22+ is required; this server is running Node ${process.versions.node}. Nothing was run.`, 'err');
    return { ok: false, summary: `Node ${process.versions.node} is too old; 22+ required.` };
  }
  if (!ctx.which('git')) {
    ctx.log('git was not found. Run the packages step first; nothing was cloned.', 'err');
    return { ok: false, summary: 'git is missing; nothing was installed.' };
  }

  const repoDir = ctx.repoDir;
  ctx.log(`Operant checkout: ${repoDir}`);
  ctx.log(`Repository URL: ${ctx.repoUrlDisplay || '(none known)'}`);

  ctx.logSection('Checkout');
  let repoExists = false;
  if (fs.existsSync(repoDir)) {
    let stat = null;
    try {
      stat = fs.statSync(repoDir);
    } catch (error) {
      ctx.log(`Cannot stat ${repoDir}: ${error.message}`, 'err');
      return { ok: false, summary: 'Repository path is not readable.' };
    }
    if (!stat.isDirectory()) {
      ctx.log(`${repoDir} exists but is not a directory. Nothing was cloned.`, 'err');
      return { ok: false, summary: 'Repository path is not a directory.' };
    }
    if (fs.existsSync(path.join(repoDir, 'package.json'))) {
      const manifest = readPackageJson(repoDir);
      if (manifest && manifest.name && manifest.name !== 'operant') {
        ctx.log(
          `${repoDir} contains package.json for ${JSON.stringify(manifest.name)}, not Operant. ` +
            'Refusing to build an unrelated project.',
          'err',
        );
        return { ok: false, summary: 'Configured repository directory is not the Operant checkout.' };
      }
      repoExists = true;
      ctx.log('Using the existing checkout (package.json is present).');
      if (!fs.existsSync(path.join(repoDir, '.git'))) {
        ctx.log('It has no .git directory; continuing because the package manifest is present.', 'info');
      }
    } else if (directoryIsEmpty(repoDir)) {
      ctx.log('The target directory exists and is empty; the clone may use it.');
    } else {
      ctx.log(
        `${repoDir} exists, is not empty, and has no package.json. Refusing to clone over it.`,
        'err',
      );
      return { ok: false, summary: 'Target directory is not an Operant checkout.' };
    }
  }

  if (!repoExists) {
    if (!ctx.repoUrl) {
      ctx.log('No repository URL is known, so the checkout cannot be cloned.', 'err');
      ctx.log('Fix one of these and restart the wizard:', 'info');
      ctx.log('  OPERANT_REPO_URL=https://example.com/you/operant.git node provision/wizard/server.mjs');
      ctx.log(`  or write ${path.join(ctx.provisionDir, 'install.json')} with a repoUrl field.`);
      ctx.log('Or clone it yourself, then rerun this step:', 'info');
      ctx.log(`  git clone <url> ${repoDir}`);
      return { ok: false, summary: 'No repository URL configured; nothing was cloned.' };
    }
    ctx.log('Cloning the Operant repository (shallow, one commit).');
    const clone = await ctx.runAsHuman(
      'git',
      ['clone', '--depth', '1', '--', ctx.repoUrl, repoDir],
      { cwd: ctx.humanHome, stream: true, timeoutMs: 20 * 60 * 1000 },
    );
    if (!clone.ok) {
      return {
        ok: false,
        summary: `git clone failed (exit ${clone.code ?? 'n/a'}); see the real output.`,
      };
    }
    if (!fs.existsSync(path.join(repoDir, 'package.json'))) {
      ctx.log(`Clone reported success but ${path.join(repoDir, 'package.json')} is missing.`, 'err');
      return { ok: false, summary: 'Clone succeeded but the checkout is incomplete.' };
    }
    repoExists = true;
  }

  if (ctx.isRoot) {
    ctx.log(
      `Repository commands are run as the owner of ${repoDir} where possible, so node_modules is not root-owned.`,
      'info',
    );
  }

  ctx.logSection('DeepSeek Harness');
  if (!ctx.which('npm')) {
    ctx.log('npm was not found. Run the packages step first; nothing was installed.', 'err');
    return { ok: false, summary: 'npm is missing; DSH was not installed.' };
  }
  const dshInstall = await ctx.runRoot(
    'npm',
    ['install', '-g', DSH_SPEC],
    { stream: true, timeoutMs: 15 * 60 * 1000 },
  );
  if (dshInstall.needsRoot) {
    return { ok: false, needsRoot: true, summary: 'Needs root; DSH was not installed.' };
  }
  if (!dshInstall.ok) {
    return {
      ok: false,
      summary: `npm install -g ${DSH_SPEC} failed (exit ${dshInstall.code ?? 'n/a'}).`,
    };
  }
  if (!ctx.which('dsh')) {
    ctx.log('npm reported success, but dsh is still not on PATH. Treating that as a failed install.', 'err');
    return { ok: false, summary: 'dsh is not on PATH after npm install; install is not usable.' };
  }
  const dshVersion = await ctx.run('dsh', ['--version'], { echo: false, timeoutMs: 30_000 });
  if (dshVersion.ok) {
    const line = `${dshVersion.stdout}\n${dshVersion.stderr}`.split('\n').find((entry) => entry.trim());
    ctx.log(`dsh: ${line ? line.trim() : '(no version text)'}`);
  }

  ctx.logSection('Corepack and pnpm');
  let corepack = ctx.which('corepack');
  if (!corepack) {
    ctx.log('corepack is not installed; installing it with npm first.', 'info');
    const corepackInstall = await ctx.runRoot(
      'npm',
      ['install', '-g', 'corepack'],
      { stream: true, timeoutMs: 10 * 60 * 1000 },
    );
    if (corepackInstall.needsRoot) {
      return { ok: false, needsRoot: true, summary: 'Needs root; corepack was not installed.' };
    }
    if (!corepackInstall.ok) {
      return { ok: false, summary: 'corepack installation failed; pnpm was not enabled.' };
    }
    corepack = ctx.which('corepack');
    if (!corepack) {
      return { ok: false, summary: 'corepack is still missing after installation.' };
    }
  }

  const enable = await ctx.runRoot('corepack', ['enable'], {
    stream: true,
    timeoutMs: 120_000,
  });
  if (enable.needsRoot) {
    return { ok: false, needsRoot: true, summary: 'Needs root; corepack was not enabled.' };
  }
  if (!enable.ok) {
    return { ok: false, summary: `corepack enable failed (exit ${enable.code ?? 'n/a'}).` };
  }

  const pnpmVersion = pnpmVersionFrom(repoDir);
  ctx.log(`Activating pnpm ${pnpmVersion} from the repository's packageManager field.`);
  const prepare = await ctx.runRoot(
    'corepack',
    ['prepare', `pnpm@${pnpmVersion}`, '--activate'],
    { stream: true, timeoutMs: 15 * 60 * 1000 },
  );
  if (prepare.needsRoot) {
    return { ok: false, needsRoot: true, summary: 'Needs root; pnpm was not activated.' };
  }
  if (!prepare.ok) {
    return { ok: false, summary: `corepack prepare pnpm@${pnpmVersion} failed.` };
  }

  const pnpmBinary = ctx.which('pnpm');
  const pnpmCommand = pnpmBinary ? ['pnpm'] : ['corepack', 'pnpm'];
  if (!pnpmBinary) {
    ctx.log('pnpm is not on PATH; falling back to `corepack pnpm`.', 'info');
  } else {
    const pnpmCheck = await ctx.run('pnpm', ['--version'], { echo: false, timeoutMs: 30_000 });
    if (pnpmCheck.ok) ctx.log(`pnpm: ${pnpmCheck.stdout.trim() || pnpmCheck.stderr.trim()}`);
  }

  ctx.logSection('Install workspace dependencies');
  const install = await ctx.runAsHuman(
    pnpmCommand[0],
    [...pnpmCommand.slice(1), 'install'],
    { cwd: repoDir, stream: true, timeoutMs: LONG_TIMEOUT },
  );
  if (!install.ok) {
    return {
      ok: false,
      summary: `pnpm install failed (exit ${install.code ?? 'n/a'}); the build was not attempted.`,
    };
  }

  ctx.logSection('Build the workspace');
  const build = await ctx.runAsHuman(
    pnpmCommand[0],
    [...pnpmCommand.slice(1), '-r', '--if-present', 'run', 'build'],
    { cwd: repoDir, stream: true, timeoutMs: LONG_TIMEOUT },
  );
  if (!build.ok) {
    return {
      ok: false,
      summary: `pnpm build failed (exit ${build.code ?? 'n/a'}); no success is claimed.`,
    };
  }

  ctx.logSection('Verify build artifacts');
  const artifacts = ['apps/api/dist/server.js', 'apps/worker/dist/main.js'];
  const missing = [];
  for (const relative of artifacts) {
    const fullPath = path.join(repoDir, relative);
    const present = fs.existsSync(fullPath);
    ctx.log(`${relative}: ${present ? 'present' : 'MISSING'}`);
    if (!present) missing.push(relative);
  }
  if (missing.length > 0) {
    return {
      ok: false,
      summary: `Build exited 0 but required artifacts are missing: ${missing.join(', ')}.`,
    };
  }

  return {
    ok: true,
    summary:
      `DSH 0.2.2-rc.1 installed · pnpm ${pnpmVersion} · checkout ${repoDir} · ` +
      'install and build succeeded; api/worker artifacts present.',
  };
}