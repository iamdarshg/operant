// Step 6 — theming. Report only. No system-wide theme change is applied here.

import fs from 'node:fs';

export const id = 'theming';
export const title = 'Windows 11 desktop look';
export const why =
  'The desktop is part of the appliance; decide the look deliberately instead of letting a third-party theme break the panel.';
export const needsRoot = false;

function exists(file) {
  try {
    return fs.existsSync(file);
  } catch {
    return false;
  }
}

function firstLine(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean) || '';
}

export async function run(ctx) {
  ctx.log('This is a report, not a theme installer. Nothing is changed by pressing Run.');
  if (!ctx.isLinux) {
    ctx.log(
      `Plasma detection is Linux-only. Current platform: ${ctx.platform}. No theme was touched.`,
      'err',
    );
    return { ok: false, summary: `Requires Linux; not run on ${ctx.platform}.` };
  }

  ctx.logSection('What this desktop is');
  const plasma = await ctx.run('plasmashell', ['--version'], { echo: false, timeoutMs: 10_000 });
  const plasmaVersion = plasma.ok ? firstLine(plasma.stdout || plasma.stderr) : '';
  const desktopName = process.env.XDG_CURRENT_DESKTOP || '(unset)';
  const sessionType = process.env.XDG_SESSION_TYPE || '(unset)';
  ctx.log(`XDG_CURRENT_DESKTOP=${desktopName}`);
  ctx.log(`XDG_SESSION_TYPE=${sessionType}`);
  if (plasmaVersion) {
    ctx.log(`plasmashell: ${plasmaVersion}`);
  } else if (plasma.missing) {
    ctx.log('plasmashell was not found on PATH.', 'info');
  } else {
    ctx.log('plasmashell did not report a version.', 'info');
  }

  const kwinWayland = await ctx.run('kwin_wayland', ['--version'], { echo: false, timeoutMs: 10_000 });
  const kwinX11 = await ctx.run('kwin_x11', ['--version'], { echo: false, timeoutMs: 10_000 });
  if (kwinWayland.ok) ctx.log(`kwin_wayland: ${firstLine(kwinWayland.stdout || kwinWayland.stderr)}`);
  if (kwinX11.ok) ctx.log(`kwin_x11: ${firstLine(kwinX11.stdout || kwinX11.stderr)}`);

  const plasmaMajorMatch = plasmaVersion.match(/(\d+)(?:\.\d+)*\s*$/);
  const plasmaMajor = plasmaMajorMatch ? Number(plasmaMajorMatch[1]) : null;
  const looksLikePlasma = Boolean(plasmaVersion) || /KDE|PLASMA/i.test(desktopName);
  ctx.log(
    looksLikePlasma
      ? `Plasma detected${plasmaMajor ? ` (major version ${plasmaMajor})` : ''}.`
      : 'KDE Plasma was not detected. The Windows 11 look below is a Plasma route, not a GNOME route.',
    looksLikePlasma ? 'info' : 'out',
  );

  ctx.logSection('What is already installed');
  for (const [name, command] of [
    ['systemsettings', ['--version']],
    ['paru (AUR helper)', ['--version']],
    ['snapper (btrfs snapshots)', ['--version']],
    ['flatpak', ['--version']],
  ]) {
    if (!ctx.which(command[0])) {
      ctx.log(`${name}: not found`);
      continue;
    }
    const result = await ctx.run(command[0], command.slice(1), { echo: false, timeoutMs: 10_000 });
    ctx.log(`${name}: ${result.ok ? firstLine(result.stdout || result.stderr) || 'present' : 'present (version check failed)'}`);
  }

  ctx.logSection('The Windows 11 route (manual, component by component)');
  ctx.log(
    'Do not install one Plasma 5-era "global theme" wholesale on Plasma 6: it can break panels or ' +
      'the launcher. Apply the pieces below one at a time so a bad piece is one revert.',
    'info',
  );
  if (looksLikePlasma && plasmaMajor !== null && plasmaMajor >= 6) {
    ctx.log('Preferred global theme: “Windows Eleven Plasma 6” — https://store.kde.org/p/2141475');
  } else {
    ctx.log('Older route (Plasma 5-era; check panel compatibility): “Win11OS-kde” — https://github.com/yeyushengfan258/Win11OS-kde');
  }
  ctx.log('Icons and cursors: Win11-icon-theme / Win11-cursors (same author). They install per-user.');
  ctx.log('Font: Inter or Selawik (metric-compatible with Segoe UI). A common Arch package name is inter-font.');
  ctx.log('Window decorations: Breeze with a Win11 decoration; rounded corners usually mean LightlyShaders.');
  ctx.log('Panel: bottom, centred icons, no labels — manual layout, not a package.');

  ctx.logSection('Commands you may choose to run (none were run)');
  if (exists('/usr/bin/snapper') || ctx.which('snapper')) {
    ctx.log('1. Snapshot first (rollback is one command if the theme breaks Plasma):');
    ctx.log('   sudo snapper -c root create --description "pre-theme"');
  } else {
    ctx.log('1. Make a snapshot/backup first if your root filesystem supports it. snapper was not found.');
  }
  ctx.log('2. Optional official packages for the font/theme engine (review before running):');
  ctx.log('   sudo pacman -S --needed inter-font kvantum');
  ctx.log('3. Open the settings application and apply Appearance → Global Theme → Get New… yourself:');
  if (ctx.which('systemsettings')) ctx.log('   systemsettings');
  else ctx.log('   (systemsettings was not found; use your launcher → System Settings)');

  ctx.logSection('Third-party script route (not executed)');
  ctx.log(
    'https://github.com/ashloverscn/cachyos-tweaks contains a win11_theme_install.sh. It edits system ' +
      'files. Read it first; this wizard never runs third-party scripts for you.',
    'info',
  );
  ctx.log(
    'Cost warning: blur, rounded corners and animations are the expensive part on an RX 580. If agents ' +
      'run jobs while you use the desktop, disable animations rather than paying 5–10% of a core for them.',
    'info',
  );

  ctx.logSection('Result');
  ctx.log('No theme change was applied. The next click is yours, in System Settings (or your terminal).');
  return {
    ok: true,
    summary: looksLikePlasma
      ? `Plasma${plasmaMajor ? ` ${plasmaMajor}` : ''} detected; Win11 route explained; nothing changed.`
      : 'No Plasma detected; theming route not applicable; nothing changed.',
  };
}