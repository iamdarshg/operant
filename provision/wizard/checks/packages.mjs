// Step 4 — base packages. Installs via pacman and streams the real output.

export const id = 'packages';
export const title = 'Base system packages';
export const why = 'Node, Docker, Python, FFmpeg and KeePassXC are the tools every later step assumes.';
export const needsRoot = true;

const PACKAGES = ['docker', 'git', 'nodejs', 'python', 'ffmpeg', 'keepassxc'];

export async function run(ctx) {
  if (!ctx.isLinux) {
    ctx.log(
      `This step installs pacman packages and only runs on Arch-based Linux (CachyOS). ` +
        `Current platform: ${ctx.platform}. No commands were run.`,
      'err',
    );
    return { ok: false, summary: `Requires Arch-based Linux; not run on ${ctx.platform}.` };
  }
  if (!ctx.which('pacman')) {
    ctx.log('pacman was not found. This machine is not Arch-based, so no packages were installed.', 'err');
    return { ok: false, summary: 'pacman not found; no packages installed.' };
  }

  ctx.log(`Packages: ${PACKAGES.join(', ')}`);
  ctx.log('pacman runs with --needed (already-installed packages are left alone) and --noconfirm.');

  const install = await ctx.runRoot(
    'pacman',
    ['-S', '--needed', '--noconfirm', ...PACKAGES],
    { stream: true, timeoutMs: 20 * 60 * 1000 },
  );
  if (install.needsRoot) {
    ctx.log('The same command, run in your own terminal, is the fallback.', 'info');
    return { ok: false, needsRoot: true, summary: 'Needs root; packages were not installed.' };
  }
  if (!install.ok) {
    return {
      ok: false,
      summary: `pacman failed (exit ${install.code ?? 'n/a'}); no success is claimed.`,
    };
  }

  ctx.logSection('Enable Docker');
  const dockerEnable = await ctx.runRoot(
    'systemctl',
    ['enable', '--now', 'docker'],
    { stream: true, timeoutMs: 120_000 },
  );
  if (dockerEnable.needsRoot) {
    return {
      ok: false,
      needsRoot: true,
      summary: 'Packages installed, but enabling Docker needs root and was not done.',
    };
  }
  const dockerActive = dockerEnable.ok;

  ctx.logSection('Versions actually present');
  const checks = [
    ['docker', ['--version']],
    ['git', ['--version']],
    ['node', ['--version']],
    ['python', ['--version']],
    ['ffmpeg', ['-version']],
    ['keepassxc', ['--version']],
  ];
  const missingBinaries = [];
  for (const [command, args] of checks) {
    if (!ctx.which(command)) {
      missingBinaries.push(command);
      ctx.log(`${command}: not found on PATH after installation.`, 'err');
      continue;
    }
    const version = await ctx.run(command, args, { echo: false, timeoutMs: 15_000 });
    if (version.ok) {
      const firstLine = `${version.stdout}\n${version.stderr}`.split('\n').find((line) => line.trim());
      ctx.log(`${command}: ${firstLine ? firstLine.trim() : '(version command produced no text)'}`);
    } else {
      ctx.log(`${command}: present, but its version check failed (exit ${version.code ?? 'n/a'}).`, 'err');
    }
  }

  ctx.logSection('Docker group (manual, deliberate)');
  const groups = await ctx.exec('id', ['-nG', ctx.humanUser], { timeoutMs: 10_000 });
  const groupList = groups.ok ? groups.stdout.trim().split(/\s+/) : [];
  const inDockerGroup = groupList.includes('docker');
  if (inDockerGroup) {
    ctx.log(`${ctx.humanUser} is already in the docker group.`);
  } else {
    ctx.log(
      `The docker group is root-equivalent. This wizard will not add ${ctx.humanUser} to it for you.`,
      'info',
    );
    ctx.log(`A human can do it deliberately, then log out and back in:`, 'info');
    ctx.log(`sudo usermod -aG docker ${ctx.humanUser}`);
    ctx.log('Until then, use sudo docker (or run the platform containers through systemd).');
  }

  const ok = missingBinaries.length === 0 && dockerActive;
  const summaryParts = [
    missingBinaries.length === 0 ? 'all 6 packages present' : `missing: ${missingBinaries.join(', ')}`,
    dockerActive ? 'docker enabled and running' : 'docker service not active',
    inDockerGroup ? 'user in docker group' : 'docker group still manual',
  ];
  return {
    ok,
    summary: summaryParts.join(' · '),
    needsRoot: false,
  };
}