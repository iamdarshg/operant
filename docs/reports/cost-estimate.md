# Cloud resource and operating cost report

Measured 2026-11-15. **Provenance: prices were read from the Google Cloud
Billing Catalog API** (`cloudbilling.googleapis.com/v1/services/6F81-5844-456A/skus`,
`currencyCode=USD`, filtered to `serviceRegions=asia-south1`), using the project's
own OAuth identity. They are not recalled list prices.

## 1. Approved spend

| Item | Value |
|---|---|
| Approved by operator | **On-demand `e2-standard-8`, hard cap $120 total** |
| GPU | None. None is scheduled, priced, or installed. |
| Region/zone | `asia-south1` / `asia-south1-c` (Mumbai) |

## 2. Measured unit prices (asia-south1, USD)

| SKU | Rate |
|---|---|
| E2 Instance Core (custom-core rate used as upper bound) | $0.027509 / vCPU-hr |
| E2 Instance Ram | $0.003511 / GB-hr |
| Spot/Preemptible E2 core | $0.015720 / vCPU-hr |
| Spot/Preemptible E2 ram | $0.002106 / GB-hr |
| Storage PD Capacity (pd-standard, zonal) | $0.048 / GB-mo |
| Balanced PD (zonal = regional $0.24 ÷ 2) | $0.120 / GB-mo |
| SSD-backed PD (zonal = regional $0.408 ÷ 2) | $0.204 / GB-mo |
| PD snapshot storage | $0.052 / GB-mo |
| Static IP (in use) | $0.000 |

Note: the predefined `E2 Instance Core` SKU was not present in the 24 000 SKUs
scanned; the custom-core rate is **higher**, so the estimates below are an upper
bound rather than an optimistic floor. Reconcile against the first invoice.

## 3. e2-standard-8 (8 vCPU, 32 GiB) monthly

| Basis | Compute / hr | Compute / mo (730 h) |
|---|---|---|
| On-demand | 8×0.027509 + 32×0.003511 = **$0.33242** | **$242.67** |
| Spot | 8×0.015720 + 32×0.002106 = **$0.193152** | **$141.00** |

## 4. Monthly total at the approved configuration

| Line | Monthly |
|---|---|
| e2-standard-8 on-demand | $242.67 |
| 100 GB pd-balanced | $12.00 |
| Snapshots (~30 GB retained) | $1.56 |
| Egress (Discord/API control traffic, small) | ≈ $1–5 |
| **Infrastructure subtotal** | **≈ $257–261** |
| Model API (Surplus gateway, already paid by operator) | variable, metered per job in `usage_event` |

## 5. What $120 actually buys — the enforcement arithmetic

Instance + disk burn ≈ $0.33242 + $0.01644 = **$0.3489/hr**.

| Control | Value |
|---|---|
| Enterprise hour cap written into the VM | **300 billed hours** |
| 300 h × $0.3489 | **≈ $104.66** |
| Headroom to the $120 cap | ≈ $15 (snapshots, egress, rounding) |

So the approved cap corresponds to roughly **12.5 days of continuous uptime**.
Because the cap is enforced by a *stopping* mechanism rather than an alert, the
VM halts itself when the budget is consumed.

## 6. Guardrails actually implemented

1. **VM-side watchdog** (`/usr/local/lib/operant/cost-watchdog.sh`, systemd timer,
   5-minute period) accumulating billed uptime in `/var/lib/operant/runtime-seconds`
   and issuing `shutdown` once 300 h is reached, unless `/etc/operant/keepalive`
   exists. Deterministic; does not depend on any cloud API.
2. **Budget alerts** (`operant-hard-cap`, $120, 50/90/100%). ⚠️ The API create call
   returned `INVALID_ARGUMENT`; alerts therefore need one retry or a 30-second
   in-console creation. This is a *notification* control only.
3. **A stopped VM still bills its disk.** Stopping saves the $242.67/mo compute,
   not the $12/mo disk. Destroying the instance is the only zero-cost state; the
   boot disk must be kept to preserve `/opt/operant/data`.
4. **Egress is metered.** Large file uploads to Discord count against it; artifacts
   are therefore served from the VM over the private network where possible.

## 7. Emergency shutdown procedure

```powershell
# Costs stop accruing on compute immediately; disk continues at $0.12/GB-mo.
gcloud compute instances stop operant-core --zone=asia-south1-c `
  --project=project-ba289c9c-3c25-4e15-9dc

# Full teardown (destroys data — snapshot first):
gcloud compute instances delete operant-core --zone=asia-south1-c `
  --project=project-ba289c9c-3c25-4e15-9dc
```

Restart without losing data:
```powershell
gcloud compute instances start operant-core --zone=asia-south1-c `
  --project=project-ba289c9c-3c25-4e15-9dc
```

## 8. Rejected alternatives (and why)

| Alternative | Monthly | Why not chosen |
|---|---|---|
| `e2-standard-8` Spot | $141 | Operator chose on-demand to avoid preemption during live verification; durable jobs would survive it, but demos would not. |
| `e2-standard-4` | ≈ $121 | Deviates from the required specification; not substituted silently. |
| `n2-custom-8-32768` | not measured | Investigate only if materially better on measured latency/cost; E2 is cheaper per vCPU here. |
| Any GPU (`g2`, `a2`, `L4`) | $200–$600+ | Mission forbids GPU; CPU-first speech is the requirement. |
| Streaming/CPU-only VoiceStudio slimming | n/a | Upstream ships a single combined image; no slim variant exists. |