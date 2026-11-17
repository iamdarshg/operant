# Quickstart — from a bare drive to a running Operant host

Written to be followed with the machine in front of you. Every step says what you
should see, so a step that silently fails is obvious.

---

## 1. The drive you were given

The 1 TB NVMe in the USB enclosure has been flashed with
**CachyOS Desktop 260809** (`cachyos-desktop-linux-260809.iso`, 3.0 GiB,
sha256 verified before writing and the first 32 MB read back afterwards).

It is a **live installer**, not an installed system. Booting it gives you the
CachyOS desktop running from RAM — that is deliberate: you install *onto* the same
drive, and the installer keeps running from memory while it does.

## 2. Boot it

1. Put the drive into the machine (M.2 slot), or leave it in the enclosure and boot from USB.
2. Enter the boot menu (usually `F8`, `F11` or `Del` — depends on the board).
3. Pick the drive. You should see a CachyOS boot menu; choose the default entry.
4. Wait for the Plasma desktop. If you land on a black screen with a cursor, that
   is the Xorg issue described in `APPLIANCE.md` §2 — boot the Wayland session
   instead, or add `nomodeset` to the kernel line to get in and install Xorg.

## 3. Install

Open **Install CachyOS** from the desktop.

- Disk: the **1 TB NVMe**. The installer will warn that it is about to erase the
  disk — that is correct, it is erasing the installer.
- Desktop: **KDE Plasma**.
- Filesystem: **btrfs** (snapshots before upgrades — worth it on a rolling release).
- Create your user, and **set a root password**.

When it finishes: reboot and remove/ignore the installer device.

## 4. First boot

Log in. Then open a terminal and run **one** command:

```bash
curl -fsSL https://raw.githubusercontent.com/iamdarshg/operant/main/provision/install.sh | bash
```

That fetches the provisioning wizard, installs it to `~/.operant-provision`, adds a
desktop launcher and a systemd user service, then opens it in your browser.

If you would rather read it before running it — sensible — do:

```bash
git clone https://github.com/iamdarshg/operant
cd operant
less provision/install.sh
bash provision/install.sh
```

## 5. What the wizard does

It walks you through, one screen at a time, and never claims success it did not
observe:

| Step | What it does | What can fail |
|---|---|---|
| Hardware | CPU, RAM, GPU, disks, session type | Driver missing → tells you exactly what it could not read |
| Network | DNS + HTTPS reachability | Reports which endpoint failed |
| Secrets | Writes `/etc/operant/secrets.env` (0600, root) | Needs sudo; says so instead of silently skipping |
| Packages | docker, git, nodejs, python, ffmpeg, keepassxc | Names the package that failed |
| AI stack | `@deepseek-ai/dsh`, corepack/pnpm, clone + build Operant | Streams real output |
| Theming | Windows-11 look, component by component | Does not apply system-wide changes without your click |
| WhatsApp | Explains there is no official Linux client; offers ZapZap | Flatpak install failure is shown verbatim |
| Browser | Firefox + Brave, plus the commands to measure RAM yourself | — |
| Finish | What worked, what did not, what is still manual | — |

## 6. After the wizard

```bash
# bring the platform up
cd ~/operant
docker compose -f docker-compose.appliance.yml up -d
curl -sS http://127.0.0.1:8787/v1/health
```

A healthy response looks like:

```json
{"state":"healthy","checks":[{"name":"postgres","state":"healthy"}]}
```

If that JSON does not appear, the platform is not up — do not proceed to using it.

## 7. If something goes wrong

- **Black screen at login** → Xorg missing (`APPLIANCE.md` §2). Install
  `xorg-server plasma-x11-session kwin-x11`, or use Wayland.
- **`docker: permission denied`** → you were added to the `docker` group but have
  not logged out and back in.
- **The wizard will not start** → `node --version` must be 22 or newer;
  `journalctl --user -u operant-provision -n 50` shows why.
- **No network** → the wizard's network step names the failure; `nmcli device wifi list`
  gets you connected first.

## 8. Honest limits

- The wizard is written to **report**, not to magic things into working. Steps that
  need root will tell you.
- Theming is deliberately manual: a global theme that half-applies is worse than no
  theme.
- Nothing in this repository contains your keys, and the wizard never sends them
  anywhere except the local file it writes.