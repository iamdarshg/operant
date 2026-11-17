// Step 3 — secrets. Collects credentials in the browser, writes one root-only
// env file. Values are never echoed, logged, or persisted in wizard state.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const id = 'secrets';
export const title = 'API keys and bearer token';
export const why =
  'The platform needs keys, and they must land in one root-only file rather than in shell history or the repo.';
export const needsRoot = true;

export const fields = [
  {
    name: 'OPERANT_BOT_TOKEN',
    label: 'Operant bearer token',
    hint:
      'Required by the API (minimum 16 characters). Generate one with: ' +
      "node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
    required: true,
    minLength: 16,
  },
  {
    name: 'DEEPSEEK_API_KEY',
    label: 'DeepSeek API key',
    hint: 'Optional. Used only if you route model calls through the official DeepSeek API.',
    required: false,
    minLength: 8,
  },
  {
    name: 'SURPLUS_API_KEY',
    label: 'Surplus Intelligence API key',
    hint: 'Optional. The Operant DSH profile on this machine can route through Surplus.',
    required: false,
    minLength: 8,
  },
  {
    name: 'ANTSEED_API_KEY',
    label: 'AntSeed API key',
    hint: 'Optional. Alternative model-provider credential.',
    required: false,
    minLength: 8,
  },
  {
    name: 'DISCORD_BOT_TOKEN',
    label: 'Discord bot token',
    hint: 'Optional. Needed only for the chat interface.',
    required: false,
    minLength: 8,
  },
  {
    name: 'GITHUB_TOKEN',
    label: 'GitHub token',
    hint: 'Optional. Useful if the Operant checkout is a private repository.',
    required: false,
    minLength: 8,
  },
];

const ALLOWED = new Set(fields.map((field) => field.name));
const FIELD_BY_NAME = new Map(fields.map((field) => [field.name, field]));
const MAX_VALUE_LENGTH = 4096;

function rejected(ctx, message) {
  ctx.log(message, 'err');
  return { ok: false, summary: 'Rejected; nothing was written.' };
}

export async function run(ctx, input) {
  ctx.log('This step writes /etc/operant/secrets.env with owner root:root and mode 0600.');
  ctx.log('Values are sent once, never echoed, and never written to wizard state or server logs.');

  const submitted = input && typeof input.values === 'object' && input.values !== null ? input.values : {};
  const values = new Map();

  for (const [name, rawValue] of Object.entries(submitted)) {
    if (!ALLOWED.has(name)) {
      return rejected(ctx, `Refusing unknown credential name ${JSON.stringify(name)}.`);
    }
    if (typeof rawValue !== 'string') {
      return rejected(ctx, `Refusing ${name}: the value is not a string.`);
    }
    let value = rawValue.trim();
    if (value === '') continue;
    if (/[\r\n\0]/.test(value)) {
      return rejected(ctx, `Refusing ${name}: a credential cannot contain a line break or NUL byte.`);
    }
    if (value.length > MAX_VALUE_LENGTH) {
      return rejected(ctx, `Refusing ${name}: the value is longer than ${MAX_VALUE_LENGTH} characters.`);
    }
    const definition = FIELD_BY_NAME.get(name);
    if (definition?.minLength && value.length < definition.minLength) {
      return rejected(
        ctx,
        `Refusing ${name}: it is shorter than the required ${definition.minLength} characters.`,
      );
    }
    values.set(name, value);
    value = '';
  }

  if (values.size === 0) {
    return rejected(ctx, 'No credentials were supplied. Enter at least one value and run the step again.');
  }
  if (!values.has('OPERANT_BOT_TOKEN')) {
    return rejected(
      ctx,
      'OPERANT_BOT_TOKEN is required: the Operant API refuses to start without a bearer token of at least 16 characters.',
    );
  }

  if (!ctx.isLinux || !ctx.isRoot) {
    const whyNot = !ctx.isLinux
      ? `This step is Linux-only, and the wizard is on ${ctx.platform}.`
      : `The wizard is running as ${ctx.humanUser} (uid ${ctx.uid}), not root, so it cannot create a root-owned file under /etc.`;
    ctx.log(whyNot, 'err');
    ctx.log('Nothing was written. The values you entered were not stored anywhere.', 'info');
    ctx.log('Finish this one step with the wizard elevated:', 'info');
    ctx.log(`systemctl --user stop operant-provision 2>/dev/null || true`);
    ctx.log(`sudo ${ctx.fmtCmd('node', [ctx.serverPath])}`);
    ctx.log('Then open http://127.0.0.1:8788, enter the values again, and run this step. The wizard still binds 127.0.0.1 only.');
    ctx.log('Afterwards, stop the elevated wizard and restart the user service:', 'info');
    ctx.log('systemctl --user start operant-provision');
    values.clear();
    return {
      ok: false,
      needsRoot: true,
      summary: 'Needs root; no secrets were written. The exact commands are in the output.',
    };
  }

  const directory = path.dirname(ctx.secretsPath);
  if (fs.existsSync(ctx.secretsPath)) {
    if (!input || input.confirmReplace !== true) {
      ctx.log(
        `${ctx.secretsPath} already exists. Nothing was replaced because the replace checkbox ` +
          'was not ticked. Run the step again with replacement confirmed to overwrite it.',
        'err',
      );
      return {
        ok: false,
        needsRoot: true,
        summary: 'Existing secrets file left untouched; replacement was not confirmed.',
      };
    }
    ctx.log(`${ctx.secretsPath} exists and replacement was explicitly confirmed.`, 'info');
  }

  try {
    await fsp.mkdir(directory, { recursive: true, mode: 0o750 });
    const directoryStat = await fsp.stat(directory);
    if (!directoryStat.isDirectory()) {
      ctx.log(`${directory} exists but is not a directory. Nothing was written.`, 'err');
      return { ok: false, summary: 'Cannot write secrets: /etc/operant is not a directory.' };
    }
    if ((directoryStat.mode & 0o777) !== 0o750) {
      await fsp.chmod(directory, 0o750);
      ctx.log(`${directory}: mode corrected to 0750.`, 'info');
    }
    if (directoryStat.uid !== 0 || directoryStat.gid !== 0) {
      await fsp.chown(directory, 0, 0);
      ctx.log(`${directory}: ownership corrected to root:root.`, 'info');
    }
  } catch (error) {
    ctx.log(`Could not prepare ${directory}: ${error.message}`, 'err');
    return { ok: false, summary: 'Cannot prepare /etc/operant; nothing was written.' };
  }

  const names = [...values.keys()];
  const lines = [
    '# Operant secrets — written by the first-boot provisioning wizard.',
    `# Created: ${new Date().toISOString()}`,
    '# Owner root:root, mode 0600. Never commit this file; exclude it from backups you do not control.',
    '# The wizard did not log these values and does not store them in its own state file.',
    '',
    ...names.map((name) => `${name}=${values.get(name)}`),
    '',
  ];

  const tempPath = path.join(
    directory,
    `.secrets.env.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`,
  );
  let handle = null;
  try {
    handle = await fsp.open(tempPath, 'wx', 0o600);
    await handle.writeFile(lines.join('\n'), 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fsp.chmod(tempPath, 0o600);
    await fsp.chown(tempPath, 0, 0);
    await fsp.rename(tempPath, ctx.secretsPath);

    const finalStat = await fsp.stat(ctx.secretsPath);
    const mode = finalStat.mode & 0o777;
    if (mode !== 0o600 || finalStat.uid !== 0 || finalStat.gid !== 0) {
      ctx.log(
        `Wrote ${ctx.secretsPath}, but verification failed: mode ${mode.toString(8)}, ` +
          `uid ${finalStat.uid}, gid ${finalStat.gid}. Expected 600 root:root.`,
        'err',
      );
      return { ok: false, summary: 'Secrets written but permissions do not match 0600 root:root.' };
    }

    ctx.log(`Wrote ${names.length} credential${names.length === 1 ? '' : 's'}: ${names.join(', ')}.`);
    ctx.log(`Verified: ${ctx.secretsPath} — mode 0600, owner root:root, ${finalStat.size} bytes.`);
    ctx.log('Values were not echoed, logged, or saved in the wizard state file.', 'info');
    ctx.log(
      'This file is the root-owned source of truth. The platform itself reads .env plus ' +
        'secrets/.credentials.yaml in the repo; wiring those is listed in the finish summary.',
      'info',
    );
    return {
      ok: true,
      summary: `${names.length} credentials written to /etc/operant/secrets.env (0600 root:root).`,
    };
  } catch (error) {
    ctx.log(`Could not write ${ctx.secretsPath}: ${error.message}`, 'err');
    return { ok: false, summary: 'Writing /etc/operant/secrets.env failed; see the error above.' };
  } finally {
    if (handle) {
      await handle.close().catch(() => {});
    }
    await fsp.rm(tempPath, { force: true }).catch(() => {});
    values.clear();
  }
}