// Step 9 — finish. Summarise real outcomes, including failures and manual work.

export const id = 'finish';
export const title = 'Summary and start command';
export const why = 'A real summary — including what failed and what you still have to do by hand.';
export const needsRoot = false;

const LABELS = {
  pending: 'NOT RUN',
  running: 'RUNNING',
  ok: 'PASS',
  failed: 'FAIL',
};

const ORDER = [
  'hardware',
  'network',
  'secrets',
  'packages',
  'ai-stack',
  'theming',
  'whatsapp',
  'browser',
];

export async function run(ctx) {
  ctx.log('This is the closing summary. It reads the recorded outcomes; it does not re-run anything.');

  ctx.logSection('Outcomes');
  let passed = 0;
  let failed = 0;
  let notRun = 0;
  const failures = [];
  for (const stepId of ORDER) {
    const previous = ctx.previous[stepId] || { status: 'pending', summary: '' };
    if (previous.status === 'ok') passed += 1;
    else if (previous.status === 'failed') {
      failed += 1;
      failures.push(stepId);
    } else notRun += 1;
    const label = LABELS[previous.status] || 'UNKNOWN';
    ctx.log(
      `${label.padEnd(8)} ${stepId.padEnd(9)} ${String(previous.summary || '(no summary recorded)').slice(0, 140)}`,
    );
  }
  ctx.log('');
  ctx.log(`${passed} passed · ${failed} failed · ${notRun} not run`);

  if (failures.length > 0) {
    ctx.log('');
    ctx.log(
      `Failed steps kept their real error in their own screen: ${failures.join(', ')}. ` +
        'Fix the cause or run the printed command, then rerun that step — this summary never turns a failure into a pass.',
      'err',
    );
  }

  ctx.logSection('What remains manual (by design, not by omission)');
  ctx.log(`1. Operant configuration is not written by this wizard.`);
  ctx.log(`   cd ${ctx.repoDir}`);
  ctx.log('   cp .env.example .env');
  ctx.log('   # set OPERANT_BOT_TOKEN and DSH_CREDENTIALS_FILE in .env');
  ctx.log('   mkdir -p secrets');
  ctx.log('   # create secrets/.credentials.yaml: version: 1, refs: SURPLUS_API_KEY: <your key>');
  ctx.log('   chmod 600 secrets/.credentials.yaml');
  ctx.log(
    `   The root-owned ${ctx.secretsPath} is the canonical secret store; it is deliberately not copied ` +
      'into the repo. See docs/runbooks/portable-deploy.md §2.',
    'info',
  );

  const dockerGroup = await ctx.exec('id', ['-nG', ctx.humanUser], { timeoutMs: 10_000 });
  const dockerGroups = dockerGroup.ok ? dockerGroup.stdout.trim().split(/\s+/) : [];
  if (!dockerGroups.includes('docker')) {
    ctx.log(`2. ${ctx.humanUser} is not in the docker group. Adding it is root-equivalent and stays manual:`);
    ctx.log(`   sudo usermod -aG docker ${ctx.humanUser}`);
    ctx.log('   Log out and back in afterwards, or use sudo docker.');
  } else {
    ctx.log(`2. ${ctx.humanUser} is in the docker group.`);
  }

  const theming = ctx.previous.theming;
  if (theming?.status === 'ok') {
    ctx.log('3. Theming: no system-wide change was applied. Choose the Windows 11 pieces in System Settings yourself.');
  } else {
    ctx.log('3. Theming: not applied (and never applied automatically). The theming screen explains the options.');
  }

  const whatsapp = ctx.previous.whatsapp;
  if (whatsapp?.status === 'ok') {
    ctx.log('4. WhatsApp: ZapZap is unofficial. Pair your phone inside the app; account risk is yours.');
  } else {
    ctx.log('4. WhatsApp: no wrapper installed. The whatsapp screen has the Flatpak commands.');
  }

  if (ctx.previous.browser?.status === 'ok') {
    ctx.log('5. Browser RAM: the three measurement commands are in the browser step output. No winner was guessed.');
  } else {
    ctx.log('5. Browser RAM: not measured. Install both browsers first, then use the browser step’s commands.');
  }

  if (ctx.previous.secrets?.status !== 'ok') {
    ctx.log(
      '6. Secrets: /etc/operant/secrets.env was not written. The secrets screen explains the root requirement; ' +
        'do not put keys in shell history.',
      'err',
    );
  }

  ctx.logSection('Start the platform');
  ctx.log(`cd ${ctx.repoDir}`);
  ctx.log('docker compose -f docker-compose.yml -f docker-compose.appliance.yml up -d --build');
  ctx.log('curl -s http://127.0.0.1:8787/v1/health');
  ctx.log('');
  ctx.log('The first boot applies packages/db/migrations on an empty pgdata volume.');
  ctx.log('For an existing volume, run the migration explicitly:', 'info');
  ctx.log('pnpm --filter @operant/db run migrate');
  ctx.log('Dashboard (separate Next.js dev process, optional):', 'info');
  ctx.log('pnpm --filter @operant/web dev        # http://127.0.0.1:3000');

  ctx.logSection('What this wizard did NOT do');
  ctx.log('· It did not sign in to any account or accept any third-party licence.');
  ctx.log('· It did not change the desktop theme, run a third-party theme script, or reboot the machine.');
  ctx.log('· It did not copy /etc/operant/secrets.env into the repository or into shell history.');
  ctx.log('· It did not commit or push anything.');

  const blocker = failures.length > 0 || notRun > 0;
  return {
    ok: true,
    summary:
      `${passed}/${ORDER.length} passed` +
      `${failed ? ` · ${failed} failed` : ''}` +
      `${notRun ? ` · ${notRun} not run` : ''}` +
      (blocker ? ' · manual work remains' : ' · complete'),
  };
}