#requires -Version 7.2
<#
.SYNOPSIS
  Fetch a fresh Proxmox SPICE console (console.vv) for a VM and open it in remote-viewer, with
  accessibility hotkeys baked in so a screen-reader user can drive a guest installer by ear.
.DESCRIPTION
  Reads connection details and an API token from <repo>/tmp/spice-console.config.psd1 (gitignored,
  loaded as data with Import-PowerShellDataFile so the file is never executed as code),
  pins the node's TLS certificate by SHA-256 fingerprint, POSTs to the Proxmox spiceproxy API to mint
  a short-lived ticket, writes <repo>/tmp/console.vv with accessibility hotkeys, and (unless
  -FetchOnly) opens it via its file association (remote-viewer). The ticket expires in ~30s, so this
  is run fresh for every connection.
#>
[CmdletBinding()]
param(
  [int]$VMID,
  [switch]$FetchOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Protect-SecretFileAcl {
  param([Parameter(Mandatory = $true)][string]$Path)

  try {
    $acl = Get-Acl -LiteralPath $Path
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($rule in @($acl.Access)) {
      $acl.RemoveAccessRuleSpecific($rule)
    }

    $inheritance = [System.Security.AccessControl.InheritanceFlags]::None
    $propagation = [System.Security.AccessControl.PropagationFlags]::None
    $allow = [System.Security.AccessControl.AccessControlType]::Allow
    $full = [System.Security.AccessControl.FileSystemRights]::FullControl
    $sids = @(
      [System.Security.Principal.WindowsIdentity]::GetCurrent().User
      [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')      # SYSTEM
      [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')  # BUILTIN\Administrators
    )
    foreach ($sid in $sids) {
      $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
        $sid,
        $full,
        $inheritance,
        $propagation,
        $allow
      )
      $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $Path -AclObject $acl
  }
  catch {
    throw "Could not harden ACLs on $Path. Fix file permissions before storing token secrets. $($_.Exception.Message)"
  }
}

# This script lives at subjects/proxmox/scripts/; the repo root is three levels up.
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..' '..' '..')).Path
$TmpDir = Join-Path $RepoRoot 'tmp'
if (-not (Test-Path -LiteralPath $TmpDir)) {
  New-Item -ItemType Directory -Path $TmpDir | Out-Null
}

$ConfigPath = Join-Path $TmpDir 'spice-console.config.psd1'
if (-not (Test-Path -LiteralPath $ConfigPath)) {
  @'
# Proxmox SPICE console settings (gitignored). Fill these in, then re-run. See guide 08.
# This is a PowerShell data file (.psd1): plain data only, never executed as code.
@{
  PveHost        = '192.168.1.10'                          # node IP or hostname
  PveNode        = 'pve'                                   # node name as in the API path
  PveTokenId     = 'spice@pve!console'                     # API token id: user@realm!name
  PveTokenSecret = '00000000-0000-0000-0000-000000000000' # API token secret
  PveFingerprint = 'AA:BB:CC:DD:...:FF'                    # node TLS cert SHA-256 fingerprint
}
'@ | Set-Content -LiteralPath $ConfigPath -Encoding utf8
  Protect-SecretFileAcl -Path $ConfigPath
  throw "Wrote a config template to $ConfigPath. Fill it in (see guide 08), then re-run."
}
Protect-SecretFileAcl -Path $ConfigPath

# Read the config as DATA, not code: Import-PowerShellDataFile uses PowerShell's
# restricted language (values only, no command execution), so a tampered or copied
# config file cannot run arbitrary code the way a dot-sourced .ps1 would.
$cfg = Import-PowerShellDataFile -LiteralPath $ConfigPath
foreach ($name in 'PveHost', 'PveNode', 'PveTokenId', 'PveTokenSecret', 'PveFingerprint') {
  if (-not $cfg.ContainsKey($name) -or [string]::IsNullOrWhiteSpace([string]$cfg[$name])) {
    throw "Config $ConfigPath is missing or empty: $name."
  }
}
$PveHost = $cfg.PveHost
$PveNode = $cfg.PveNode
$PveTokenId = $cfg.PveTokenId
$PveTokenSecret = $cfg.PveTokenSecret
$PveFingerprint = $cfg.PveFingerprint

if ($PSBoundParameters.ContainsKey('VMID')) {
  # Explicitly supplied: fail fast on a bad value rather than dropping to a prompt,
  # so an automation mistake is caught instead of silently waiting for input.
  if ($VMID -lt 100) {
    throw "VMID must be 100 or greater (Proxmox reserves ids below 100). Got: $VMID"
  }
}
else {
  # Not supplied: ask for it interactively.
  [int]$VMID = Read-Host 'VM id to open the SPICE console for (must be 100 or greater)'
  if ($VMID -lt 100) {
    throw "VMID must be 100 or greater (Proxmox reserves ids below 100). Got: $VMID"
  }
}

$expected = ($PveFingerprint -replace '[^0-9A-Fa-f]', '').ToUpperInvariant()
if ($expected.Length -ne 64) {
  throw "Config `$PveFingerprint does not look like a SHA-256 fingerprint (expected 64 hex characters after removing separators, got $($expected.Length)). On the Proxmox host run: openssl x509 -in /etc/pve/local/pve-ssl.pem -noout -fingerprint -sha256"
}

# HttpClient with certificate pinning by SHA-256 fingerprint (not a blanket skip).
$handler = [System.Net.Http.HttpClientHandler]::new()
$handler.ServerCertificateCustomValidationCallback = {
  param($req, $cert, $chain, $errs)
  if ($null -eq $cert) { return $false }
  $cert.GetCertHashString([System.Security.Cryptography.HashAlgorithmName]::SHA256).ToUpperInvariant() -eq $expected
}.GetNewClosure()
$client = [System.Net.Http.HttpClient]::new($handler)
# Fail fast instead of hanging if the host is wrong or filtered (the default is ~infinite for a
# stalled connect, which is painful from the double-click launcher).
$client.Timeout = [System.TimeSpan]::FromSeconds(20)
$request = $null
$response = $null

try {
  $uri = "https://$($PveHost):8006/api2/spiceconfig/nodes/$PveNode/qemu/$VMID/spiceproxy"
  $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Post, $uri)
  $request.Headers.Add('Authorization', "PVEAPIToken=$PveTokenId=$PveTokenSecret")
  $form = [System.Collections.Generic.Dictionary[string, string]]::new()
  $form.Add('proxy', $PveHost)
  $request.Content = [System.Net.Http.FormUrlEncodedContent]::new($form)

  $response = $client.SendAsync($request).GetAwaiter().GetResult()
  if (-not $response.IsSuccessStatusCode) {
    throw "Proxmox API returned $([int]$response.StatusCode) $($response.ReasonPhrase) for VM $VMID. Check the VMID, node name, token, and that the VM is running."
  }
  $vv = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
}
catch [System.Threading.Tasks.TaskCanceledException] {
  throw "Timed out reaching the Proxmox API at $($PveHost):8006 after 20 seconds. Check that PveHost is correct and reachable and that TCP 8006 is open."
}
catch [System.Net.Http.HttpRequestException] {
  throw "Could not reach the Proxmox API at $($PveHost):8006 ($($_.Exception.Message)). Check the host address, that the node is up, and that PveFingerprint matches the node's current certificate."
}
finally {
  if ($response) { $response.Dispose() }
  if ($request) { $request.Dispose() }
  $client.Dispose()
  $handler.Dispose()
}

if ($vv -notmatch '\[virt-viewer\]') {
  throw "The API response was not a virt-viewer file. Check the VMID, node name, and token permissions. If Proxmox returned an API error, read the host logs instead of printing the response here."
}

# Bake in accessibility hotkeys and a clear window title (read by the screen reader).
# Strip any values Proxmox already set for these keys so the override is the single
# authoritative entry, rather than relying on the parser's last-value-wins behavior.
$vv = $vv -replace '(?m)^(release-cursor|toggle-fullscreen|secure-attention|title)=.*\r?\n?', ''
$vv = $vv.TrimEnd() + @"

release-cursor=ctrl+shift+f12
toggle-fullscreen=ctrl+shift+f11
secure-attention=ctrl+alt+end
title=Proxmox SPICE install console (VM $VMID) -- Ctrl+Shift+F12 releases the keyboard

"@

$VvPath = Join-Path $TmpDir 'console.vv'
Set-Content -LiteralPath $VvPath -Value $vv -Encoding utf8
Protect-SecretFileAcl -Path $VvPath

if ($FetchOnly) {
  Write-Host "Wrote $VvPath. The SPICE ticket expires in about 30 seconds; open it now with remote-viewer."
  return
}

Start-Process -FilePath $VvPath
Write-Host "Opening the SPICE console for VM $VMID. In the guest, press Win+Ctrl+Enter to start Narrator."
