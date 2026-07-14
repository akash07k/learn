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

# This script lives at subjects/proxmox/scripts/; the repo root is three levels up.
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..' '..' '..')).Path
$TmpDir = Join-Path $RepoRoot 'tmp'
if (-not (Test-Path -LiteralPath $TmpDir)) {
  New-Item -ItemType Directory -Path $TmpDir | Out-Null
}

function Protect-SecretFileAcl {
  # Best-effort: restrict a secret file (the token config, the SPICE ticket) to the current user,
  # SYSTEM, and Administrators so other local accounts on a shared machine cannot read it. Windows
  # only -- Get-Acl/Set-Acl have no cross-platform equivalent, so this is a no-op elsewhere -- and
  # non-fatal: a permissions hiccup warns rather than aborting a console launch. The token is
  # already least-privilege (PVEVMUser on one VM), so treat this as defence in depth, not the only
  # guard; the DESCRIPTION still tells the operator to keep the file private.
  param([Parameter(Mandatory = $true)][string]$Path)

  if (-not $IsWindows) { return }

  try {
    $acl = Get-Acl -LiteralPath $Path
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($rule in @($acl.Access)) {
      $null = $acl.RemoveAccessRuleSpecific($rule)
    }
    $none = [System.Security.AccessControl.InheritanceFlags]::None
    $prop = [System.Security.AccessControl.PropagationFlags]::None
    $allow = [System.Security.AccessControl.AccessControlType]::Allow
    $full = [System.Security.AccessControl.FileSystemRights]::FullControl
    $sids = @(
      [System.Security.Principal.WindowsIdentity]::GetCurrent().User
      [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')      # SYSTEM
      [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')  # BUILTIN\Administrators
    )
    foreach ($sid in $sids) {
      $acl.AddAccessRule(
        [System.Security.AccessControl.FileSystemAccessRule]::new($sid, $full, $none, $prop, $allow))
    }
    Set-Acl -LiteralPath $Path -AclObject $acl
  }
  catch {
    Write-Warning "Could not restrict permissions on $Path ($($_.Exception.Message)). It may be readable by other local users; keep it private or fix its ACLs by hand."
  }
}

$ConfigPath = Join-Path $TmpDir 'spice-console.config.psd1'
if (-not (Test-Path -LiteralPath $ConfigPath)) {
  @'
# Proxmox SPICE console settings (gitignored). Fill these in, then re-run. See guide 08.
# Keep this file private: it holds an API token secret. It lives under gitignored tmp/ so it is
# never committed; do not copy it to a shared or multi-user location.
# This is a PowerShell data file (.psd1): plain data only, never executed as code.
@{
  PveHost        = '192.168.1.10'                          # node IP or hostname
  PveNode        = 'pve'                                   # node name as in the API path
  PveTokenId     = 'spice@pve!console'                     # API token id: user@realm!name
  PveTokenSecret = '00000000-0000-0000-0000-000000000000' # API token secret
  PveFingerprint = 'AA:BB:CC:DD:...:FF'                    # node TLS cert SHA-256 fingerprint
}
'@ | Set-Content -LiteralPath $ConfigPath -Encoding utf8
  throw "Wrote a config template to $ConfigPath. Fill it in (see guide 08), then re-run. Keep it private: it holds an API token secret."
}

# Once filled in, the config holds a long-lived token secret; restrict it every run (the template
# above only ever holds a placeholder, so hardening the real secret has to happen here on read).
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
# The validation callback runs on a .NET thread-pool thread during the TLS handshake, where
# no PowerShell runspace exists, so a PowerShell script block cannot be used here (it throws
# "There is no Runspace available to run scripts in this thread" before TLS completes). Compile a
# tiny pure-.NET type instead: its static method is a real delegate that runs correctly on any
# thread. The expected fingerprint is passed through a static field.
if (-not ('PveCertPinner' -as [type])) {
  Add-Type -TypeDefinition @'
using System.Net.Http;
using System.Net.Security;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;

public static class PveCertPinner
{
    public static string Expected = "";

    public static bool Validate(HttpRequestMessage request, X509Certificate2 cert, X509Chain chain, SslPolicyErrors errors)
    {
        if (cert == null) { return false; }
        return string.Equals(
            cert.GetCertHashString(HashAlgorithmName.SHA256),
            Expected,
            System.StringComparison.OrdinalIgnoreCase);
    }
}
'@
}
[PveCertPinner]::Expected = $expected

$handler = [System.Net.Http.HttpClientHandler]::new()
$handler.ServerCertificateCustomValidationCallback = [PveCertPinner]::Validate
$client = [System.Net.Http.HttpClient]::new($handler)
# Fail fast instead of hanging if the host is wrong or filtered (the default is ~infinite for a
# stalled connect, which is painful from the double-click launcher).
$client.Timeout = [System.TimeSpan]::FromSeconds(20)
$request = $null
$response = $null

try {
  $uri = "https://$($PveHost):8006/api2/spiceconfig/nodes/$PveNode/qemu/$VMID/spiceproxy"
  $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Post, $uri)
  # Use TryAddWithoutValidation: HttpRequestHeaders.Add parses Authorization as a structured
  # scheme/parameter header and rejects the "PVEAPIToken=user@realm!name=secret" shape (the '=' and
  # '!' fail its validation). Sending it verbatim is what the Proxmox API expects.
  if (-not $request.Headers.TryAddWithoutValidation('Authorization', "PVEAPIToken=$PveTokenId=$PveTokenSecret")) {
    throw "Could not set the Authorization header from the token in $ConfigPath. Check PveTokenId and PveTokenSecret."
  }
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
# IMPORTANT: do NOT set release-cursor. SPICE's built-in ungrab is Left Ctrl + Left Alt, which is
# the most reliable way off the guest on Windows; setting a custom release-cursor OVERRIDES that
# default, and if the custom key does not fire (as some Windows builds do with function-key combos)
# the operator is trapped in the guest. Leaving release-cursor unset keeps Left Ctrl + Left Alt.
# Strip any release-cursor Proxmox set (so the default is restored) plus the keys we do override,
# so each is the single authoritative entry rather than relying on last-value-wins.
$vv = $vv -replace '(?m)^(release-cursor|toggle-fullscreen|secure-attention|title)=.*\r?\n?', ''
$vv = $vv.TrimEnd() + @"

toggle-fullscreen=Shift+F11
secure-attention=Ctrl+Alt+End
title=Proxmox SPICE install console (VM $VMID) -- Left Ctrl+Left Alt releases the keyboard

"@

$VvPath = Join-Path $TmpDir 'console.vv'
Set-Content -LiteralPath $VvPath -Value $vv -Encoding utf8
# The .vv carries a live (if short-lived) SPICE ticket; restrict it so another local user cannot
# grab it from tmp/ during its validity window.
Protect-SecretFileAcl -Path $VvPath

if ($FetchOnly) {
  Write-Host "Wrote $VvPath. The SPICE ticket expires in about 30 seconds; open it now with remote-viewer."
  return
}

# Launch remote-viewer with --hotkeys so the fullscreen/secure-attention keys are GLOBAL (effective
# even while the guest holds focus). Deliberately omit release-cursor here so SPICE's built-in
# Left Ctrl + Left Alt ungrab stays active as the reliable way back to the host. Find
# remote-viewer.exe (PATH first, then the standard VirtViewer install dir); if it cannot be found,
# fall back to opening the .vv by file association. remote-viewer prints a lot of harmless GLib and
# GSpice diagnostics to stderr on Windows (missing usbdk, app enumeration); redirect its streams to
# a log under tmp/ so they do not flood the launcher console.
$Hotkeys = 'toggle-fullscreen=shift+f11,secure-attention=ctrl+alt+end'
$rvCommand = Get-Command 'remote-viewer' -ErrorAction SilentlyContinue
$remoteViewer = if ($rvCommand) { $rvCommand.Source } else { $null }
if (-not $remoteViewer) {
  foreach ($root in @($env:ProgramFiles, ${env:ProgramFiles(x86)})) {
    if (-not $root) { continue }
    $found = Get-ChildItem -Path (Join-Path $root 'VirtViewer*') -Filter 'remote-viewer.exe' -Recurse -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if ($found) { $remoteViewer = $found.FullName; break }
  }
}

if ($remoteViewer) {
  $rvOut = Join-Path $TmpDir 'remote-viewer.out.log'
  $rvErr = Join-Path $TmpDir 'remote-viewer.err.log'
  Start-Process -FilePath $remoteViewer -ArgumentList @("--hotkeys=$Hotkeys", $VvPath) -RedirectStandardOutput $rvOut -RedirectStandardError $rvErr
  Write-Host "Opening the SPICE console for VM $VMID. Press Left Ctrl + Left Alt to release the keyboard back to the host. In the guest, press Win+Ctrl+Enter to start Narrator."
}
else {
  Write-Warning "Could not find remote-viewer.exe, so opening $VvPath by file association instead. The fullscreen and secure-attention hotkeys may not be global, but Left Ctrl + Left Alt still releases the keyboard back to the host."
  Start-Process -FilePath $VvPath
  Write-Host "Opening the SPICE console for VM $VMID. Press Left Ctrl + Left Alt to release the keyboard back to the host. In the guest, press Win+Ctrl+Enter to start Narrator."
}
