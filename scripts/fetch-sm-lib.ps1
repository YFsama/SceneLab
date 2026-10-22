# fetch-sm-lib.ps1 -- fetch the NVIDIA usd-brep (SMLib) prebuilt package
# into src-tauri/sm-lib/ for the P3 exact-geometry service.
#
# The archive is BCJ2-compressed; py7zr silently truncates it, so we always
# extract with the real 7-Zip standalone console binary (7zr.exe), which the
# script downloads on first use next to itself.
#
# Re-entrant: when src-tauri/sm-lib/lib/SMLib.dll already exists, the script
# prints the manifest and exits 0 without downloading.
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts/fetch-sm-lib.ps1
#         (optionally -Destination <dir>, default: <repo>/src-tauri/sm-lib)

[CmdletBinding()]
param(
    [string]$Destination = ""
)

$ErrorActionPreference = 'Stop'

# --- resolve repo root (script lives in <repo>/scripts) -----------------------
$repo = Split-Path -Parent $PSScriptRoot
if (-not $Destination) { $Destination = Join-Path $repo 'src-tauri\sm-lib' }

$releaseTag    = 'v1.0.0'
$assetName     = 'usd_brep@1.0.0.v1-0-0.7419.dbb624c8.gl.windows-x86_64.release.7z'
$assetUrl      = "https://github.com/NVIDIA-Omniverse/usd-brep/releases/download/$releaseTag/" + [uri]::EscapeDataString($assetName)
$sevenZipUrl   = 'https://www.7-zip.org/a/7zr.exe'

$markerDll     = Join-Path $Destination 'lib\SMLib.dll'

# --- nothing to do? -----------------------------------------------------------
if (Test-Path $markerDll) {
    Write-Host "[fetch-sm-lib] $markerDll already present -- skipping download."
}
else {
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null

    # 1. 7zr.exe (standalone 7-Zip console, ~600 KB)
    $z7 = Join-Path $PSScriptRoot '7zr.exe'
    if (-not (Test-Path $z7)) {
        Write-Host "[fetch-sm-lib] downloading 7zr.exe from $sevenZipUrl"
        # TLS 1.2 for older PowerShell defaults
        try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}
        Invoke-WebRequest -Uri $sevenZipUrl -OutFile $z7
    }

    # 2. release archive (~30 MB)
    $archive = Join-Path $env:TEMP $assetName
    Write-Host "[fetch-sm-lib] downloading $assetUrl"
    try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}
    Invoke-WebRequest -Uri $assetUrl -OutFile $archive

    # 3. extract with the real 7zr (BCJ2 archives are silently corrupted by
    #    Python-based extractors)
    Write-Host "[fetch-sm-lib] extracting to $Destination"
    & $z7 x -y "-o$Destination" $archive | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "7zr extraction failed with code $LASTEXITCODE" }
    Remove-Item $archive -ErrorAction SilentlyContinue

    if (-not (Test-Path $markerDll)) {
        throw "extraction finished but $markerDll is missing -- inspect $Destination"
    }
}

# --- manifest -----------------------------------------------------------------
Write-Host "[fetch-sm-lib] manifest of $Destination"
Get-ChildItem -Recurse -File $Destination |
    Where-Object { $_.Extension -in '.dll', '.lib', '.h' } |
    ForEach-Object {
        $rel = $_.FullName.Substring($Destination.Length + 1)
        '{0,12:N0}  {1}' -f $_.Length, $rel
    }
Write-Host "[fetch-sm-lib] done."
