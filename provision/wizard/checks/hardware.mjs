// Step 1 — hardware. Read-only: this module never writes to the machine.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const id = 'hardware';
export const title = 'Hardware inventory';
export const why = 'Know exactly what this machine is before installing anything on it.';
export const needsRoot = false;

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return null;
  }
}

function short(value, limit = 120) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function listSessionFiles(directory) {
  try {
    return fs
      .readdirSync(directory)
      .filter((name) => name.endsWith('.desktop'))
      .map((name) => name.replace(/\.desktop$/, ''))
      .sort();
  } catch {
    return [];
  }
}

export async function run(ctx) {
  ctx.log('Read-only inventory. No settings, disks or packages are changed by this step.');
  const cpus = os.cpus();
  const logicalCpus = cpus.length;
  const cpuModel = short(cpus[0]?.model || 'unknown');

  ctx.logSection('CPU');
  ctx.log(`Model: ${cpuModel}`);
  ctx.log(`Logical CPUs: ${logicalCpus}${logicalCpus ? ` (OS-visible; the machine may have ${Math.floor(logicalCpus / 2)} physical cores if SMT is on)` : ''}`);

  let lscpu = null;
  if (ctx.isLinux) {
    lscpu = await ctx.run('lscpu', [], { echo: false, timeoutMs: 15_000 });
    if (!lscpu.ok) {
      ctx.log('lscpu did not return usable output; the os.cpus() figures above still apply.', 'info');
    } else {
      const wanted = /^(Model name|Socket\(s\)|Core\(s\) per socket|Thread\(s\) per core|CPU\(s\)|CPU max MHz|CPU min MHz):/;
      const lines = lscpu.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => wanted.test(line));
      for (const line of lines) ctx.log(line);
    }
  } else {
    ctx.log(`lscpu is Linux-only; not run on ${ctx.platform}.`, 'info');
  }

  ctx.logSection('Memory');
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  ctx.log(`Total RAM (OS-visible): ${ctx.fmtBytes(totalBytes)} (${(totalBytes / 1024 ** 3).toFixed(2)} GiB)`);
  ctx.log(`Currently free: ${ctx.fmtBytes(freeBytes)}`);
  if (ctx.isLinux) {
    const meminfo = readText('/proc/meminfo');
    const totalLine = meminfo && meminfo.match(/^MemTotal:\s*(\d+)\s*kB$/m);
    if (totalLine) {
      const memTotalKb = Number(totalLine[1]);
      ctx.log(`/proc/meminfo MemTotal: ${ctx.fmtBytes(memTotalKb * 1024)}`);
    }
  }

  ctx.logSection('GPU');
  let gpuSummary = 'not probed (Linux-only probe)';
  if (ctx.isLinux) {
    let foundDrm = false;
    try {
      const cards = fs
        .readdirSync('/sys/class/drm')
        .filter((name) => /^card\d+$/.test(name))
        .sort();
      for (const card of cards) {
        foundDrm = true;
        const deviceDir = path.join('/sys/class/drm', card, 'device');
        const vendor = readText(path.join(deviceDir, 'vendor'));
        const device = readText(path.join(deviceDir, 'device'));
        let driver = null;
        try {
          driver = path.basename(fs.readlinkSync(path.join(deviceDir, 'driver')));
        } catch {
          // no driver bound
        }
        ctx.log(
          `/sys/class/drm/${card}: vendor ${vendor || '?'} device ${device || '?'}` +
            (driver ? ` · driver ${driver}` : ' · no driver bound'),
        );
      }
      if (!foundDrm) ctx.log('/sys/class/drm has no card* entries.', 'info');
    } catch (error) {
      ctx.log(`Could not read /sys/class/drm: ${error.message}`, 'err');
    }

    const lspci = await ctx.run('lspci', ['-nnk'], { echo: false, timeoutMs: 15_000 });
    if (lspci.missing) {
      ctx.log('lspci is not installed; GPU details rely on /sys above.', 'info');
    } else if (lspci.ok) {
      const blocks = [];
      let keep = false;
      for (const line of lspci.stdout.split('\n')) {
        if (/VGA compatible controller|3D controller|Display controller/.test(line)) {
          keep = true;
        } else if (!line.trim() || /^[0-9a-f]{2}:[0-9a-f]{2}\.[0-9a-f]\s/i.test(line)) {
          keep = false;
        }
        if (keep) blocks.push(line.replace(/\s+$/, ''));
      }
      if (blocks.length === 0) {
        ctx.log('lspci reported no VGA/3D/display controllers.', 'info');
      } else {
        for (const line of blocks) ctx.log(line);
        const first = blocks.find((line) => /VGA compatible controller|3D controller|Display controller/.test(line));
        if (first) {
          const withoutAddress = first.replace(/^[0-9a-f]+:[0-9a-f.]+\s+/i, '');
          const afterColon = withoutAddress.split(':').slice(1).join(':').trim();
          gpuSummary = short(afterColon.replace(/\[[0-9a-f]{4}:[0-9a-f]{4}\]/gi, '').trim() || 'detected');
        }
      }
    } else {
      ctx.log(`lspci failed (exit ${lspci.code}); GPU details rely on /sys above.`, 'info');
    }
    if (gpuSummary === 'not probed (Linux-only probe)' && foundDrm) gpuSummary = 'card present (name unknown)';
  } else {
    ctx.log(`GPU detection via /sys and lspci is Linux-only; not run on ${ctx.platform}.`, 'info');
  }

  ctx.logSection('Disks');
  if (ctx.isLinux) {
    const lsblk = await ctx.run(
      'lsblk',
      ['-J', '-o', 'NAME,SIZE,TYPE,MODEL,FSTYPE,MOUNTPOINTS'],
      { echo: false, timeoutMs: 20_000 },
    );
    if (lsblk.missing) {
      ctx.log('lsblk is not installed; no disk inventory was read.', 'info');
    } else if (!lsblk.ok) {
      ctx.log(`lsblk failed (exit ${lsblk.code}). Its stderr follows:`, 'err');
      if (lsblk.stderr.trim()) ctx.log(lsblk.stderr.trim(), 'err');
    } else {
      let parsed = null;
      try {
        parsed = JSON.parse(lsblk.stdout);
      } catch (error) {
        ctx.log(`lsblk did not return JSON: ${error.message}`, 'err');
      }
      if (parsed && Array.isArray(parsed.blockdevices)) {
        const walk = (devices, depth) => {
          for (const device of devices) {
            const flags = [
              device.type,
              device.fstype || null,
              Array.isArray(device.mountpoints)
                ? device.mountpoints.filter(Boolean).join(', ')
                : device.mountpoint || null,
            ]
              .filter(Boolean)
              .join(' · ');
            const model = device.model ? ` [${String(device.model).trim()}]` : '';
            ctx.log(
              `${'  '.repeat(depth)}${device.name}  ${device.size || '?'}  ${flags || 'unmounted'}${model}`,
            );
            if (Array.isArray(device.children)) walk(device.children, depth + 1);
          }
        };
        walk(parsed.blockdevices, 0);
      }
    }
  } else {
    ctx.log(`lsblk is Linux-only; no disk inventory was read on ${ctx.platform}.`, 'info');
  }

  ctx.logSection('Display session');
  const sessionFields = {
    XDG_SESSION_TYPE: process.env.XDG_SESSION_TYPE || '(unset)',
    XDG_CURRENT_DESKTOP: process.env.XDG_CURRENT_DESKTOP || '(unset)',
    DESKTOP_SESSION: process.env.DESKTOP_SESSION || '(unset)',
    WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY || '(unset)',
    DISPLAY: process.env.DISPLAY || '(unset)',
  };
  for (const [name, value] of Object.entries(sessionFields)) ctx.log(`${name}=${value}`);

  if (ctx.isLinux) {
    const xorg = listSessionFiles('/usr/share/xsessions');
    const wayland = listSessionFiles('/usr/share/wayland-sessions');
    ctx.log(`Xorg sessions installed: ${xorg.length ? xorg.join(', ') : 'none found'}`);
    ctx.log(`Wayland sessions installed: ${wayland.length ? wayland.join(', ') : 'none found'}`);
    if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
      ctx.log(
        'This server process sees no DISPLAY or WAYLAND_DISPLAY. If it runs as a systemd user ' +
          'service, that is expected: session variables live in the desktop session, not in the ' +
          'service manager. The session files above are the reliable inventory.',
        'info',
      );
    }
  } else {
    ctx.log(`Session-directory checks (/usr/share/{x,wayland}-sessions) are Linux-only on ${ctx.platform}.`, 'info');
  }

  return {
    ok: true,
    summary:
      `${short(cpuModel, 52)} · ${logicalCpus} logical CPUs · ${ctx.fmtBytes(totalBytes)} RAM` +
      ` · GPU: ${gpuSummary}`,
  };
}