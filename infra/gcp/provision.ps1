# Operant GCP provisioning — approved budget: e2-standard-8 on-demand, hard cap $120 total.
#
# Deliberate choices, all reversible and recorded in docs/reports/cost-estimate.md:
#   - dedicated VPC with NO default-allow-ssh; the default VPC's 0.0.0.0/0 SSH rule
#     is exactly the exposure this mission forbids
#   - SSH only through Identity-Aware Proxy (authenticated, encrypted, no public port)
#   - Tailscale is installed later by the operator (needs an account auth key we do
#     not hold); until then IAP is the transport
#   - no GPU, no arm64 image, no accelerator scheduling
#   - the VM self-stops after 300 billed hours (≈$99.6) via a systemd watchdog,
#     because budget alerts alone never stop billing
#
# Idempotent: re-running skips anything that already exists.
$ErrorActionPreference = 'Stop'

$Project = 'project-ba289c9c-3c25-4e15-9dc'
$Zone    = 'asia-south1-c'
$Region  = 'asia-south1'
$Name    = 'operant-core'
$Vpc     = 'operant-vpc'
$Subnet  = 'operant-subnet'
$Billing = '01CE1D-5EAC9D-E82F06'
$CapUsd  = 120
$Here    = Split-Path -Parent $MyInvocation.MyCommand.Path
$Repo    = Split-Path -Parent (Split-Path -Parent $Here)

function Say($m) { Write-Host ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m) }

# A gcloud list with no matches prints nothing. Comparing that to '' with -ne
# returns $true for an empty result (PowerShell array semantics), which made
# every "does it exist?" check a false positive on the first run. Compare the
# joined text instead.
function HasName([string[]]$GcloudArgs) {
  $out = (& gcloud @GcloudArgs 2>$null | Out-String).Trim()
  return ($out.Length -gt 0 -and $out -notmatch 'not found|ERROR')
}

# No interactive y/N prompts ever (they silently abort in a background job).
$env:CLOUDSDK_CORE_DISABLE_PROMPTS = '1'

Say "project=$Project zone=$Zone name=$Name cap=`$$CapUsd"

# --------------------------------------------------------------- required APIs
foreach ($api in 'billingbudgets.googleapis.com') {
  $enabled = (& gcloud services list --enabled --project $Project --format 'value(config.name)' 2>$null) -contains $api
  if (-not $enabled) {
    Say "enabling $api (needed for budget alerts)"
    & gcloud services enable $api --project $Project 2>&1 | Out-Null
  }
}

# ------------------------------------------------------------------ network
if (-not (HasName @('compute','networks','list','--project',$Project,'--filter',"name=$Vpc",'--format','value(name)'))) {
  Say "creating VPC $Vpc (custom mode: no auto subnets, no default ingress)"
  & gcloud compute networks create $Vpc --project $Project --subnet-mode=custom --bgp-routing-mode=regional
} else { Say "VPC $Vpc exists" }

if (-not (HasName @('compute','networks','subnets','list','--project',$Project,'--filter',"name=$Subnet",'--format','value(name)'))) {
  Say "creating subnet $Subnet 10.42.0.0/24"
  & gcloud compute networks subnets create $Subnet --project $Project --network $Vpc `
    --region $Region --range 10.42.0.0/24 --enable-private-ip-google-access
} else { Say "subnet $Subnet exists" }

# SSH from IAP only. 35.235.240.0/20 is Google's documented IAP TCP-forwarding range.
$fwName = 'operant-allow-iap-ssh'
if (-not (HasName @('compute','firewall-rules','list','--project',$Project,'--filter',"name=$fwName",'--format','value(name)'))) {
  Say "creating firewall $fwName (tcp:22 from 35.235.240.0/20 only)"
  & gcloud compute firewall-rules create $fwName --project $Project --network $Vpc `
    --direction INGRESS --action ALLOW --rules tcp:22 --source-ranges 35.235.240.0/20 `
    --target-tags operant-node --priority 1000
} else { Say "firewall $fwName exists" }

# ------------------------------------------------------------- budget + alerts
# Alerts do not stop billing (the VM watchdog does); they are the early warning.
try {
  $existing = (& gcloud billing budgets list --billing-account $Billing --format 'value(displayName)' 2>$null | Out-String)
  if ($existing -notmatch 'operant-hard-cap') {
    Say "creating billing budget 'operant-hard-cap' = `$$CapUsd with 50/90/100% alerts"
    & gcloud billing budgets create --billing-account $Billing --display-name 'operant-hard-cap' `
      --budget-amount=$CapUsd --calendar-period=MONTH `
      --threshold-rule=percent=0.5 --threshold-rule=percent=0.9 --threshold-rule=percent=1.0
  } else { Say "budget already present" }
} catch {
  Say "WARN: could not create budget automatically: $($_.Exception.Message)"
  Say "      fallback: create a $CapUsd USD budget on billing account $Billing in the console."
}

# ------------------------------------------------------------------ the VM
if (-not (HasName @('compute','instances','list','--project',$Project,'--filter',"name=$Name",'--format','value(name)'))) {
  Say "creating $Name (e2-standard-8, ubuntu-2404-lts-amd64, 100GB pd-balanced)"
  # Built as an argument array with `key=value` pairs. Passing comma-separated
  # flags as bare tokens (--labels a=b,c=d) is mangled by PowerShell's native
  # argument splitting, and gcloud then rejects the value. This form is the one
  # verified to create the instance successfully.
  $createArgs = @(
    'compute','instances','create',$Name,
    "--project=$Project","--zone=$Zone",
    '--machine-type=e2-standard-8',
    '--image-family=ubuntu-2404-lts-amd64','--image-project=ubuntu-os-cloud',
    '--boot-disk-size=100GB','--boot-disk-type=pd-balanced',
    '--boot-disk-device-name=operant-boot',
    '--network=operant-vpc','--subnet=operant-subnet','--tags=operant-node',
    "--metadata-from-file=startup-script=$Here\startup.sh",
    '--maintenance-policy=MIGRATE','--restart-on-failure'
  )
  & gcloud @createArgs
} else {
  Say "VM $Name exists — not recreating"
}

$ip = (& gcloud compute instances describe $Name --project $Project --zone $Zone --format 'value(networkInterfaces[0].accessConfigs[0].natIP)' 2>$null | Out-String).Trim()
Say "external IP: $ip"

$state = [ordered]@{
  name = $Name; project = $Project; zone = $Zone; ip = $ip
  machine = 'e2-standard-8'; disk = '100GB pd-balanced'
  createdUtc = (Get-Date).ToUniversalTime().ToString('o'); capUsd = $CapUsd; hourCap = 300
}
$stateDir = Join-Path $Repo 'data'
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
$state | ConvertTo-Json | Set-Content (Join-Path $stateDir 'gcp-instance.json') -Encoding utf8
Say "state written to data\gcp-instance.json"

if ($ip) {
  Say "waiting for guest boot + SSH (IAP) to become ready..."
  Start-Sleep -Seconds 20
  $ready = $false
  for ($i = 1; $i -le 20 -and -not $ready; $i++) {
    & gcloud compute ssh $Name --project $Project --zone $Zone --tunnel-through-iap `
      --command 'cloud-init status --wait >/dev/null 2>&1; echo READY' 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) { $ready = $true; Say "SSH ready (attempt $i)" } else { Start-Sleep -Seconds 15 }
  }
  if (-not $ready) { Say "WARN: IAP SSH not ready yet; guest bootstrap continues on its own." }
}

Say "DONE"