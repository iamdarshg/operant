// Step 7 — WhatsApp via ZapZap (an unofficial Flatpak wrapper around WhatsApp Web).

export const id = 'whatsapp';
export const title = 'WhatsApp (unofficial wrapper)';
export const why =
  'There is no official Linux client, so the honest option is an unofficial wrapper you install knowingly.';
export const needsRoot = true;

const ZAPZAP_ID = 'com.rtosta.zapzap';

function manualCommands(ctx) {
  ctx.log('Run these yourself if you prefer not to run the wizard as root:', 'info');
  ctx.log('sudo pacman -S --needed flatpak');
  ctx.log('flatpak remote-add --if-not-exists --user flathub https://flathub.org/repo/flathub.flatpakrepo');
  ctx.log(`flatpak install --user -y flathub ${ZAPZAP_ID}`);
}

export async function run(ctx) {
  if (!ctx.isLinux) {
    ctx.log(
      `Flatpak and ZapZap are Linux-only. Current platform: ${ctx.platform}. No commands were run.`,
      'err',
    );
    return { ok: false, summary: `Requires Linux; not run on ${ctx.platform}.` };
  }

  ctx.log('Facts, not marketing:');
  ctx.log('  · Meta does not ship an official WhatsApp desktop client for Linux.');
  ctx.log('  · ZapZap is an unofficial wrapper around WhatsApp Web (PyQt). It is not affiliated with Meta.');
  ctx.log('  · It can break when WhatsApp changes its web client, and WhatsApp’s terms still apply.');
  ctx.log(`  · Flathub app id: ${ZAPZAP_ID} — https://flathub.org/apps/${ZAPZAP_ID}`);

  let flatpak = ctx.which('flatpak');
  if (!flatpak) {
    ctx.logSection('Flatpak is missing');
    const installFlatpak = await ctx.runRoot(
      'pacman',
      ['-S', '--needed', '--noconfirm', 'flatpak'],
      { stream: true, timeoutMs: 15 * 60 * 1000 },
    );
    if (installFlatpak.needsRoot) {
      manualCommands(ctx);
      return { ok: false, needsRoot: true, summary: 'Needs root to install Flatpak; nothing was installed.' };
    }
    if (!installFlatpak.ok) {
      manualCommands(ctx);
      return { ok: false, summary: 'Flatpak installation failed; ZapZap was not installed.' };
    }
    flatpak = ctx.which('flatpak');
    if (!flatpak) {
      ctx.log('Flatpak still is not on PATH after installation.', 'err');
      return { ok: false, summary: 'Flatpak is unavailable; ZapZap was not installed.' };
    }
  }

  ctx.logSection('ZapZap');
  const already = await ctx.runAsHuman(
    flatpak,
    ['info', '--user', ZAPZAP_ID],
    { echo: false, timeoutMs: 30_000, cwd: ctx.humanHome },
  );
  if (already.ok) {
    ctx.log('ZapZap is already installed for this user.');
  } else {
    ctx.log('Adding the Flathub remote for this user (no system-wide change).');
    const remote = await ctx.runAsHuman(
      flatpak,
      ['remote-add', '--if-not-exists', '--user', 'flathub', 'https://flathub.org/repo/flathub.flatpakrepo'],
      { stream: true, timeoutMs: 120_000, cwd: ctx.humanHome },
    );
    if (!remote.ok) {
      manualCommands(ctx);
      return { ok: false, summary: `Could not add Flathub (exit ${remote.code ?? 'n/a'}).` };
    }

    ctx.log(`Installing ${ZAPZAP_ID} as a per-user Flatpak.`);
    const install = await ctx.runAsHuman(
      flatpak,
      ['install', '--user', '-y', 'flathub', ZAPZAP_ID],
      { stream: true, timeoutMs: 20 * 60 * 1000, cwd: ctx.humanHome },
    );
    if (!install.ok) {
      manualCommands(ctx);
      return {
        ok: false,
        summary: `ZapZap installation failed (exit ${install.code ?? 'n/a'}); see the output.`,
      };
    }
  }

  const verify = await ctx.runAsHuman(
    flatpak,
    ['info', '--user', ZAPZAP_ID],
    { echo: false, timeoutMs: 30_000, cwd: ctx.humanHome },
  );
  if (!verify.ok) {
    ctx.log('Flatpak reported success, but `flatpak info` cannot find the app. Treating it as not installed.', 'err');
    return { ok: false, summary: 'ZapZap verification failed; installation is not usable.' };
  }

  ctx.logSection('Launch and limits');
  ctx.log(`Launch: flatpak run ${ZAPZAP_ID}`);
  ctx.log('You still have to pair your phone with WhatsApp Web inside the app. The wizard does not sign you in.');
  ctx.log('It is an unofficial client: use your judgement about the account risk.');
  ctx.log(`Uninstall: flatpak uninstall --user ${ZAPZAP_ID}`);

  return {
    ok: true,
    summary: `ZapZap (${ZAPZAP_ID}) installed as a per-user Flatpak; unofficial wrapper.`,
  };
}