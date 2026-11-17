# Appliance build — bare metal to a working Operant host

This is the runbook for turning a pile of parts into the machine Operant runs on,
and then for moving that machine onto its final NVMe.

> **Status: unrehearsed.** Nothing in this document has been executed against the
> hardware — the parts are not assembled yet. Commands are written to be run in
> order and to fail loudly, but treat every step as unverified until you have run
> it. Where something depends on a version I could not check, it says so.

---

## 0. The parts, and what each one is actually for

| Part | Role | Honest note |
|---|---|---|
| **i7-10700F / 10700KF** | CPU, 8C/16T, Comet Lake | Either suffix works. **Both have no integrated GPU**, so there is no QuickSync: video encode/decode is CPU or the RX 580, never the iGPU. Neither has AVX-512, which is irrelevant here because nothing we run needs it. |
| **RX 580 (8 GB)** | Display, Vulkan/OpenGL | Excellent desktop GPU, **useless for AI compute**. AMD dropped ROCm support for Polaris (gfx803) years ago, and VoiceStudio only ships CUDA and CPU images. Plan on CPU inference; the RX 580 exists to drive the monitors. |
| **32 GB DDR4** | Everything | Comfortable. Postgres, the worker and a browser coexist without swapping if the worker stays at 3 concurrent jobs. |
| **2 × NVMe** | One system, one data | The destination of this whole exercise. See §6. |
| **NTFS hard disk** | Bulk data | Mountable on Linux via the in-kernel `ntfs3` driver. See the caveat in §1.3. |

---

## 1. First boot: prove the hardware before installing anything

### 1.1 Memory test first, OS never

Do this **before** the OS install, from the same USB stick, and let it finish at
least one full pass (a 32 GB kit takes hours — start it and walk away).

```bash
# From the CachyOS live ISO's boot menu: "Memory test (memtest86+)"
# If the menu entry is missing, write memtest86+ to a separate USB.
```

Pass criteria: zero errors across one complete pass. Any error means reseat the
DIMMs, then retest, then RMA. Do not install an OS over failing RAM — it produces
corruption that looks like software bugs for weeks.

### 1.2 Component checks (from the live ISO, before installing)

```bash
lscpu | grep -E 'Model name|CPU\(s\)|MHz'      # 8 cores / 16 threads
free -h                                        # ~31 GiB visible, none reserved away
lspci -k | grep -A3 -E 'VGA|3D'                # RX 580 with amdgpu bound
lsblk -o NAME,SIZE,MODEL,TRAN,FSTYPE           # both NVMe + the HDD
sudo smartctl -a /dev/nvme0                    # SMART clean on both NVMe
sudo dmesg -l err,crit                         # no ACPI / PCIe / MCE errors
```

Burn-in, ~15 minutes, watching for thermal or power faults:

```bash
sudo pacman -S --needed stress-ng lm_sensors
sensors                                        # idle temps before starting
stress-ng --cpu 16 --vm 8 --vm-bytes 2G --timeout 900s --metrics-brief
```

A stable machine finishes with `sensors` still under ~90 °C and no dmesg errors.

### 1.3 The NTFS disk — decide now, not later

The in-kernel `ntfs3` driver works, but NTFS has no POSIX ownership or permission
bits. Anything that expects Unix permissions on that disk (git checkouts, dotfiles,
container volumes, a Steam library) will misbehave in ways that are annoying to
diagnose.

- **If the disk never needs to be read by Windows:** format it ext4 or btrfs and
  stop worrying.
- **If it must be shared with a Windows dual-boot:** keep NTFS, but mount it with
  explicit options and never put anything on it that cares about permissions:

  ```bash
  # /etc/fstab — uid/gid map everything to your user; noexec is deliberate
  UUID=<uuid>  /mnt/data  ntfs3  rw,uid=1000,gid=1000,noexec,noatime,big_writes  0 0
  ```

---

## 2. CachyOS install

1. Boot the CachyOS ISO, choose the **KDE Plasma** desktop, install to the
   **1 TB NVMe** (this is the drive the operating system owns).
2. **Xorg is no longer installed by default.** As of the 26.01 installer, CachyOS
   dropped `xorg-server` and with it `plasma-x11-session` / `kwin-x11`. Install
   without it and you get a **black screen at login**. Either stay on Wayland
   deliberately, or install Xorg first:
   [CachyOS KDE notes](https://wiki.cachyos.org/configuration/desktop_environments/kde/)

   ```bash
   sudo pacman -S --needed xorg-server plasma-x11-session kwin-x11
   ```
3. Filesystem: **btrfs** with subvolumes gives you snapshot-before-upgrade, which
   on a rolling-release distro is the difference between a five-minute rollback
   and a reinstall. Ext4 is fine if you prefer boring.
4. Create your user, and **set a root password** — several steps below need it.
5. First boot, then update everything before adding anything:

   ```bash
   sudo pacman -Syu
   ```

CachyOS ships `paru` as its AUR helper. If it is not present: `sudo pacman -S --needed base-devel git && paru -S paru`.

---

## 3. Base system packages

```bash
sudo pacman -S --needed \
  base-devel git curl wget openssh \
  docker docker-compose docker-buildx \
  nodejs npm python python-pip \
  firefox \
  keepassxc \
  ntfs-3g \
  lm_sensors smartmontools htop btop \
  ffmpeg

sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"     # log out and back in for this to take effect
```

Verify Docker works **as your user, after re-login**:

```bash
docker run --rm hello-world
```

Node must be 22 or newer for this project; check with `node --version` and install
`pnpm` through corepack:

```bash
sudo corepack enable
corepack prepare pnpm@11.19.0 --activate
```

---

## 4. Make Plasma look like Windows 11

Plasma 6 changed the theming APIs, and several popular "Windows 11" global themes
were written for Plasma 5 and now break panels or the application launcher.
**Apply components individually rather than installing one global theme**, so a
broken piece is one revert instead of a wrecked desktop.

| Piece | What to use | Caveat |
|---|---|---|
| Global theme | [`Win11OS-kde`](https://github.com/yeyushengfan258/Win11OS-kde) (light) or [`Win11OS-dark`](https://store.kde.org/p/1554642/) (dark) | Plasma 5-era; check whether the panel layout survives Plasma 6 |
| Plasma 6 global theme | [Windows Eleven Plasma 6](https://store.kde.org/p/2141475) | Written for Plasma 6 — prefer this one |
| Scripted route | [`cachyos-tweaks/win11_theme_install.sh`](https://github.com/ashloverscn/cachyos-tweaks/blob/main/win11_theme_install.sh) | Third-party script: read it before running it, it edits system files |
| Icons | `Win11-icon-theme` (`yeyushengfan258/Win11-icon-theme`) | Actively maintained; installs to `~/.local/share/icons` |
| Cursors | `Win11-cursors` from the same author | |
| Window decorations | Breeze with a Win11 decoration, or `LightlyShaders` for rounded corners | Rounded corners + blur is the single most expensive thing you can enable on this GPU |
| Panel | Bottom panel, centred app icons, no labels | Manual layout — 20 minutes, no package |
| Fonts | Segoe UI substitution: **Inter** or **Selawik** (metric-compatible with Segoe) | Selawik is the closer match; Inter renders better |
| Start menu | The stock launcher skinned via the global theme | Third-party menu replacements are the most common breakage point |

Keep a snapshot before theming so you can roll back in one command:

```bash
sudo snapper -c root create --description "pre-theme"
```

**Cost warning:** blur + rounded corners + animations on an RX 580 is fine, but
"Windows 11 feel" often means compositor effects that cost 5–10 % of one core.
Disable animations if the machine is running agent jobs at the same time.

---

## 5. The AI stack

Order matters: the runtime, then the database, then the app.

```bash
# 1. DeepSeek Harness CLI (pin the version — npm "latest" for this package is a prerelease)
npm install -g @deepseek-ai/dsh@0.2.2-rc.1

# 2. Postgres for the durable queue
docker compose -f docker-compose.yml up -d postgres

# 3. The platform itself
git clone <this repo> ~/operant && cd ~/operant
cp .env.example .env                 # then fill in the keys per §5.1
pnpm install && pnpm -r run build
pnpm --filter @operant/db run migrate
```

For a machine that runs jobs continuously, use the appliance compose file, which
sets worker concurrency, memory limits and log rotation:

```bash
docker compose -f docker-compose.appliance.yml up -d
```

CPU inference settings that match this CPU (8C/16T, no AVX-512):

```bash
OMP_NUM_THREADS=4        # leave room for Postgres and the browser
WHISPER_MODEL=small      # 0.258 RTF on CPU; base is faster and less accurate
```

### 5.1 Secrets — on the disk, never in the repository

This repository is **public**. Nothing in §5.1 may ever be committed.

```bash
sudo install -d -m 700 -o root -g root /etc/operant
sudo install -m 600 -o root -g root /dev/null /etc/operant/secrets.env
sudoedit /etc/operant/secrets.env
```

Layout:

```ini
# /etc/operant/secrets.env  — chmod 600, root-owned, never in git
OPERANT_BOT_TOKEN=<control-plane bearer, 32+ hex>
OPERANT_MCP_TOKEN=<speech MCP bearer>
SURPLUS_API_KEY=<model provider>
ANTSEED_API_KEY=<model provider>
DISCORD_BOT_TOKEN=<if the bot is ever enabled>
DISCORD_APP_ID=<same file>
```

Then reference it from the systemd units rather than from the repo:

```ini
# /etc/systemd/system/operant-worker.service.d/secrets.conf
[Service]
EnvironmentFile=/etc/operant/secrets.env
```

**What to copy to the new machine, and what not to:**

| Credential | Copy it? | How |
|---|---|---|
| DSH / provider API keys | Yes | The file above, copied while the disk is unmounted |
| `~/.dsh/` profile and credentials | Yes | Plain directory copy |
| Control-plane / MCP tokens | Yes | Same file |
| **Steam password** | **No — never** | Do not store a Steam password on disk |
| Steam login session | Yes, with caveats | `~/.local/share/Steam/config/loginusers.vdf` and the `ssfn*` files. Steam Guard will still likely force re-verification on new hardware — treat that as normal |

If the data NVMe is not already encrypted, encrypt it before putting keys on it:

```bash
# Destroys the volume — do it before there is anything on it.
sudo cryptsetup luksFormat /dev/nvme1n1p1
sudo cryptsetup open /dev/nvme1n1p1 operant-data
sudo mkfs.btrfs /dev/mapper/operant-data
```

An unencrypted disk holding your Steam session and every provider key is a disk
you should not lose track of. LUKS is the only thing standing between "I lost a
drive" and "I lost every account I own".

---

## 6. Drive mapping (and why "D:" stops existing)

Windows drive letters do not exist on Linux. On the new machine the two NVMe
disks get device names, and where they are mounted is a choice you make once.

| You say | Linux sees | Mounted at | Holds |
|---|---|---|---|
| **eDrive, 1 TB** | first NVMe, e.g. `/dev/nvme0n1` | `/` | The OS, `/home`, Docker's images |
| **D drive, other NVMe** | second NVMe, e.g. `/dev/nvme1n1` | `/mnt/data` | Secrets, models, Steam library, backups, the repo |
| NTFS HDD | `/dev/sda` | `/mnt/storage` | Bulk media only (no permissions — see §1.3) |

Put the heavy, regenerable things on the data disk so the system disk stays small
enough to snapshot:

```bash
sudo mkdir -p /mnt/data/{models,backups,steam,git}
# Docker images are the biggest consumer after the OS:
sudo systemctl stop docker
sudo mkdir -p /mnt/data/docker && sudo rsync -aHAX /var/lib/docker/ /mnt/data/docker/
# then point /var/lib/docker at /mnt/data/docker via /etc/fstab or a bind mount
```

---

## 7. Moving to the final NVMe

The migration is: **install onto the destination disk, then carry the data**, not
"clone the disk and hope".

1. Snapshot the source: `sudo snapper -c root create --description "pre-migration"`.
2. Back up the things that cannot be regenerated — `/etc/operant/secrets.env`,
   `~/.dsh/`, `~/.local/share/Steam/config/`, the Postgres volume:
   ```bash
   docker exec operant-pg pg_dump -U operant -Fc operant > /mnt/data/backups/operant-$(date +%F).dump
   ```
3. Install CachyOS fresh on the new NVMe (§2), apply §3–§5.
4. Restore the data, then verify — not "looks fine", but:
   ```bash
   curl -sS http://127.0.0.1:8787/v1/health
   pnpm -r run test           # 250 tests
   ```
5. Only after a verified boot from the new disk, wipe the old one.

Keep the old disk intact until the new one has served one real request end to end.

---

## 8. Browser: fastest / least RAM

There is no single winner, because "least RAM" depends on tab count and whether
you use extensions. What is true:

- **Chromium-family browsers share a renderer process across same-site tabs**, so
  20 tabs on one site cost far less than 20 Firefox processes.
- **Firefox** has lower baseline overhead and better per-process accounting, but
  costs more as tab count grows, especially with `Fission` enabled.
- **Brave** is Chromium without Google's background services; it usually lands
  below Chrome on memory.
- **Vivaldi** is the heaviest of the Chromium family — do not pick it for RAM.

Recommendation for this machine: **install both Firefox and Brave, and measure
your own workload** rather than trusting a blog:

1. Open the same 20 tabs you actually use in each.
2. Wait 60 seconds for them to settle.
3. Compare `ps_mem -p $(pgrep -d, firefox)` against `ps_mem -p $(pgrep -d, brave)`.

```bash
sudo pacman -S --needed brave-bin ps_mem     # brave-bin is in the AUR
```

Note that Firefox is also the browser *you* use personally, so it is installed
either way; the question is only which one the desktop defaults to.

## 9. WhatsApp

There is **no official WhatsApp client for Linux.** The options, in order of how
much I would trust them:

| Option | What it is | Trade-off |
|---|---|---|
| WhatsApp Web / PWA | Official web client, installed as an app | Needs the browser running; full functionality |
| **ZapZap** (Flathub) | Native Qt wrapper around WhatsApp Web | Best desktop integration of the wrappers; still an unofficial client |
| `whatsapp-for-linux` (AUR) | GTK wrapper | Simpler, less maintained |
| Android in a VM | Actual app | Heavy; only worth it if you need calling |

```bash
# ZapZap
flatpak install flathub com.github.eneshecan.WhatsZap
```

Unofficial wrappers can break whenever WhatsApp changes its web client, and using
one is technically outside WhatsApp's supported clients. Accept that or use the PWA.

---

## 10. Open questions

These change the plan and I could not answer them from the hardware description:

1. **10700F or 10700KF?** Either works. It only matters if you ever want
   overclocking (KF) — nothing here needs it.
2. **Does the NTFS disk need to be readable by a Windows install?** If not,
   reformat (§1.3) and half the caveats disappear.
3. **Is the data NVMe going to be encrypted?** If you want keys on it, it should be.
4. **Dual boot, or Linux only?** This document assumes Linux only. A Windows
   partition changes the disk layout in §6 and the NTFS decision in §1.3.