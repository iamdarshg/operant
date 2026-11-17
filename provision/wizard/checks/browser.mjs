// Step 8 — browsers: Firefox + Brave, then the exact three RAM measurement commands.

export const id = 'browser';
export const title = 'Browsers and a real RAM comparison';
export const why = 'Two browsers, one repeatable measurement, so the RAM choice is yours and not a guess.';
export const needsRoot = true;

const BRAVE_FLATPAK = 'com.brave.Browser';
const FLATHUB = 'https://flathub.org/repo/flathub.flatpakrepo';

function printManualFallback(ctx) {
  ctx.log('Manual equivalents, in your own terminal:', 'info');
  ctx.log('sudo pacman -S --needed firefox');
  ctx.log('paru -S --needed brave-bin          # Brave is AUR-only on plain Arch');
  ctx.log(`flatpak install --user -y flathub ${BRAVE_FLATPAK}   # official Brave Flatpak instead`);
}

async function ensureFirefox(ctx) {
  if (ctx.which('firefox')) {
    ctx.log('Firefox is already installed.');
    return { ok: true };
  }
  const install = await ctx.runRoot(
    'pacman',
    ['-S', '--needed', '--noconfirm', 'firefox'],
    { stream: true, timeoutMs: 20 * 60 * 1000 },
  );
  if (install.needsRoot) return { ok: false, needsRoot: true };
  if (!install.ok) return { ok: false, detail: `pacman failed (exit ${install.code ?? 'n/a'})` };
  if (!ctx.which('firefox')) return { ok: false, detail: 'Firefox is still not on PATH' };
  ctx.log('Firefox installed.');
  return { ok: true };
}

async function ensureBraveViaFlatpak(ctx) {
  let flatpak = ctx.which('flatpak');
  if (!flatpak) {
    ctx.log('Flatpak is missing; installing it to host Brave’s official Flatpak build.', 'info');
    const installFlatpak = await ctx.runRoot(
      'pacman',
      ['-S', '--needed', '--noconfirm', 'flatpak'],
      { stream: true, timeoutMs: 15 * 60 * 1000 },
    );
    if (installFlatpak.needsRoot) return { ok: false, needsRoot: true };
    if (!installFlatpak.ok) return { ok: false, detail: 'Flatpak installation failed' };
    flatpak = ctx.which('flatpak');
    if (!flatpak) return { ok: false, detail: 'Flatpak is still not on PATH' };
  }

  const already = await ctx.runAsHuman(
    flatpak,
    ['info', '--user', BRAVE_FLATPAK],
    { echo: false, timeoutMs: 30_000, cwd: ctx.humanHome },
  );
  if (already.ok) {
    ctx.log('Brave is already installed as a Flatpak.');
    return { ok: true, kind: 'flatpak' };
  }

  const remote = await ctx.runAsHuman(
    flatpak,
    ['remote-add', '--if-not-exists', '--user', 'flathub', FLATHUB],
    { stream: true, timeoutMs: 120_000, cwd: ctx.humanHome },
  );
  if (!remote.ok) return { ok: false, detail: `Flathub remote could not be added (exit ${remote.code ?? 'n/a'})` };

  const install = await ctx.runAsHuman(
    flatpak,
    ['install', '--user', '-y', 'flathub', BRAVE_FLATPAK],
    { stream: true, timeoutMs: 20 * 60 * 1000, cwd: ctx.humanHome },
  );
  if (!install.ok) return { ok: false, detail: `Flatpak install failed (exit ${install.code ?? 'n/a'})` };

  const verify = await ctx.runAsHuman(
    flatpak,
    ['info', '--user', BRAVE_FLATPAK],
    { echo: false, timeoutMs: 30_000, cwd: ctx.humanHome },
  );
  if (!verify.ok) return { ok: false, detail: 'Flatpak reports success but `flatpak info` cannot find Brave' };
  ctx.log('Brave installed as the official Flatpak build.');
  return { ok: true, kind: 'flatpak' };
}

async function ensureBrave(ctx) {
  if (ctx.which('brave') || ctx.which('brave-browser')) {
    ctx.log('Brave is already installed natively.');
    return { ok: true, kind: 'native' };
  }

  ctx.logSection('Brave — native package');
  const native = await ctx.runRoot(
    'pacman',
    ['-S', '--needed', '--noconfirm', 'brave-bin'],
    { stream: true, timeoutMs: 20 * 60 * 1000 },
  );
  if (native.ok && (ctx.which('brave') || ctx.which('brave-browser'))) {
    ctx.log('Brave installed natively from the configured repositories.');
    return { ok: true, kind: 'native' };
  }
  if (native.needsRoot) {
    ctx.log('Native Brave needs root and non-interactive sudo is unavailable.', 'info');
  } else {
    ctx.log(
      'brave-bin was not available from the configured repositories. Brave is AUR-only on plain Arch; ' +
        'CachyOS may or may not carry it. Falling back to Brave’s official Flatpak build.',
      'info',
    );
  }

  ctx.logSection('Brave — official Flatpak fallback');
  return ensureBraveViaFlatpak(ctx);
}

function printRamMethod(ctx) {
  ctx.logSection('The exact three commands (nothing is measured automatically)');
  ctx.log(
    'Open the same tabs in each browser, one browser at a time, and let the page set settle for a minute ' +
      'before sampling. Then run these in a terminal:',
  );
  ctx.log('');
  ctx.log('1. Firefox total resident memory (all of its processes):');
  ctx.log(
    `   ps -eo rss=,args= | awk '/[f]irefox/ {s+=$1} END {printf "Firefox  %6.0f MiB\\n", s/1024}'`,
  );
  ctx.log('2. Brave total resident memory (all of its processes):');
  ctx.log(
    `   ps -eo rss=,args= | awk '/[b]rave/ {s+=$1} END {printf "Brave    %6.0f MiB\\n", s/1024}'`,
  );
  ctx.log('3. Both, three samples five seconds apart, for a median instead of one lucky number:');
  ctx.log(
    `   n=1; while [ $n -le 3 ]; do ps -eo rss=,args= | awk -v n="$n" '/[f]irefox/ {f+=$1} /[b]rave/ {b+=$1} END {printf "sample %d  Firefox %6.0f MiB  Brave %6.0f MiB\\n", n, f/1024, b/1024}'; n=$((n+1)); sleep 5; done`,
  );
  ctx.log('');
  ctx.log('Read this honestly: RSS double-counts shared library pages, so it overstates both totals.', 'info');
  ctx.log('Use the same tab set, cold-start both, close other big apps, and compare medians — not one sample.', 'info');
  ctx.log('The pattern matching also counts processes whose command line contains "firefox"/"brave".', 'info');
}

export async function run(ctx) {
  if (!ctx.isLinux) {
    ctx.log(
      `This step installs Linux packages and measures processes with ps/awk. Current platform: ${ctx.platform}. ` +
        'No commands were run.',
      'err',
    );
    return { ok: false, summary: `Requires Linux; not run on ${ctx.platform}.` };
  }

  ctx.logSection('Firefox');
  const firefox = await ensureFirefox(ctx);
  if (firefox.needsRoot) {
    ctx.log('Firefox needs root and non-interactive sudo is unavailable. Nothing was installed.', 'err');
    printManualFallback(ctx);
    return { ok: false, needsRoot: true, summary: 'Needs root; Firefox and Brave were not installed.' };
  }

  const brave = await ensureBrave(ctx);
  if (brave.needsRoot) {
    ctx.log('Brave needs root and non-interactive sudo is unavailable. Nothing was installed.', 'err');
    printManualFallback(ctx);
    return { ok: false, needsRoot: true, summary: 'Needs root; Brave was not installed.' };
  }

  const braveNative = Boolean(ctx.which('brave') || ctx.which('brave-browser'));
  let braveFlatpak = false;
  const flatpak = ctx.which('flatpak');
  if (!braveNative && flatpak) {
    const info = await ctx.runAsHuman(
      flatpak,
      ['info', '--user', BRAVE_FLATPAK],
      { echo: false, timeoutMs: 30_000, cwd: ctx.humanHome },
    );
    braveFlatpak = info.ok;
  }

  const ok = firefox.ok && brave.ok && (braveNative || braveFlatpak);
  printRamMethod(ctx);

  if (!ok) {
    printManualFallback(ctx);
    const details = [firefox.detail, brave.detail].filter(Boolean).join('; ');
    return {
      ok: false,
      summary: `Browser installation incomplete${details ? `: ${details}` : ''}. The measurement commands are still above.`,
    };
  }

  return {
    ok: true,
    summary:
      `Firefox and Brave installed (${braveNative ? 'native' : 'official Flatpak'}). ` +
      'The three RAM measurement commands are in the output.',
  };
}