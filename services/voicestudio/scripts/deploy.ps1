#!/usr/bin/env pwsh
#requires -Version 7
<#
.SYNOPSIS
    Ship services/voicestudio to the operant-core VM and (re)start the stack.

.DESCRIPTION
    Idempotent. Pushes compose.yaml/.env.example/scripts via IAP, then runs
    `docker compose up -d --wait` so the command fails loudly if the container
    never reaches `healthy`. It never creates or destroys the VM, and never
    touches ufw: the port stays published on 127.0.0.1 only.

.EXAMPLE
    ./scripts/deploy.ps1
    ./scripts/deploy.ps1 -SkipPush   # just restart what is already up there
#>
[CmdletBinding()]
param(
    [string]$Instance   = 'operant-core',
    [string]$Project    = 'project-ba289c9c-3c25-4e15-9dc',
    [string]$Zone       = 'asia-south1-c',
    [string]$RemoteDir  = '/opt/operant/voicestudio',
    [switch]$SkipPush
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Root    = Split-Path -Parent $PSScriptRoot      # services/voicestudio
$Gcloud  = @('compute', 'ssh', $Instance,
             "--project=$Project", "--zone=$Zone", '--tunnel-through-iap',
             '--quiet', '--strict-host-key-checking=no')
$Scp     = @('compute', 'scp')

function Invoke-Remote {
    param([Parameter(Mandatory)][string]$Command)
    & gcloud @Gcloud --command $Command
    if ($LASTEXITCODE -ne 0) { throw "remote command failed (exit $LASTEXITCODE): $Command" }
}

function Send-File {
    param([Parameter(Mandatory)][string]$Local, [Parameter(Mandatory)][string]$Remote)
    & gcloud @Scp $Local "${Instance}:$Remote" "--project=$Project" "--zone=$Zone" '--tunnel-through-iap' '--quiet'
    if ($LASTEXITCODE -ne 0) { throw "scp failed for $Local" }
}

if (-not $SkipPush) {
    Write-Host '== pushing release files ==' -ForegroundColor Cyan
    Invoke-Remote "sudo mkdir -p $RemoteDir/scripts $RemoteDir/bench && sudo chown -R iamdarshg:iamdarshg $RemoteDir"

    Send-File -Local (Join-Path $Root 'compose.yaml')   -Remote "$RemoteDir/compose.yaml"
    Send-File -Local (Join-Path $Root '.env.example')   -Remote "$RemoteDir/.env.example"
    foreach ($s in Get-ChildItem (Join-Path $Root 'scripts') -Filter *.sh) {
        Send-File -Local $s.FullName -Remote "$RemoteDir/scripts/$($s.Name)"
    }
    Invoke-Remote "chmod +x $RemoteDir/scripts/*.sh"
}

Write-Host '== docker compose up -d --wait ==' -ForegroundColor Cyan
Invoke-Remote "cd $RemoteDir && sudo docker compose up -d --wait --wait-timeout 600 2>&1 | tail -20"

Write-Host '== status ==' -ForegroundColor Cyan
Invoke-Remote "sudo docker compose -f $RemoteDir/compose.yaml ps"