# Build Sparrow on Windows with the MSVC toolchain.
#
# Why MSVC: Tauri 2's WebView2 bindings and many of our transitive Rust
# deps (notably the windows-sys family) only compile cleanly against
# `x86_64-pc-windows-msvc`. The MinGW (`-gnu`) target works for some
# crates but reliably trips on linker errors for others, and Microsoft's
# WebView2Loader.dll is built against MSVC ABI anyway.
#
# What this script does:
#   1. Verifies prerequisites (Node, npm, Rust, MSVC build tools).
#   2. Ensures the `x86_64-pc-windows-msvc` Rust target is installed and
#      set as the default.
#   3. Installs npm deps if `node_modules` is missing.
#   4. Runs `npm run tauri build`.
#   5. Lists the produced installers (`.msi` and `setup.exe`).
#
# Optional signing:
#   If you have an Authenticode cert, set TAURI_SIGNING_PRIVATE_KEY and
#   TAURI_SIGNING_PRIVATE_KEY_PASSWORD in your shell BEFORE running this
#   script — Tauri's bundler picks them up automatically. This script
#   doesn't try to source certs itself; that path is too cert-specific
#   (PFX vs. HSM vs. EV token) to script generically.
#
# Usage:
#   PowerShell:  ./scripts/build-windows.ps1
#   PowerShell:  ./scripts/build-windows.ps1 -SkipInstall   # skip npm install
#   PowerShell:  ./scripts/build-windows.ps1 -Clean         # cargo clean first
#
# Run from the repository root.

[CmdletBinding()]
param(
    [switch]$SkipInstall,
    [switch]$Clean
)

# -StrictMode + ErrorAction = "blow up immediately on a typo or a failed
# external command". Tauri's build is multi-step; we'd rather stop at
# the first red flag than press on and produce a corrupt installer.
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Test-CommandExists($name) {
    return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

function Write-Step($msg) {
    Write-Host ""
    Write-Host "==> $msg" -ForegroundColor Cyan
}

function Write-OK($msg) {
    Write-Host "  OK   $msg" -ForegroundColor Green
}

function Write-WarnLn($msg) {
    Write-Host "  WARN $msg" -ForegroundColor Yellow
}

function Fail($msg) {
    Write-Host ""
    Write-Host "ERROR $msg" -ForegroundColor Red
    exit 1
}

# ---------------------------------------------------------------------------
# 1. Prerequisite checks
# ---------------------------------------------------------------------------

Write-Step "Checking prerequisites"

# Node / npm — the Tauri CLI is JS, the frontend is Vite + Vue.
if (-not (Test-CommandExists "node")) {
    Fail "Node.js not found. Install LTS from https://nodejs.org/ then re-run."
}
$nodeVer = (node --version)
Write-OK "Node: $nodeVer"

if (-not (Test-CommandExists "npm")) {
    Fail "npm not found. It should ship with Node.js — try reinstalling."
}
$npmVer = (npm --version)
Write-OK "npm: $npmVer"

# Rust — needed for `cargo build` under the hood. `rustup` is the
# canonical installer; we use it both to verify presence and (later)
# to ensure the MSVC target is installed.
if (-not (Test-CommandExists "rustc")) {
    Fail @"
Rust not found. Install via rustup:

  https://rustup.rs/

When the installer asks about the default host, pick
  x86_64-pc-windows-msvc

(not the GNU variant). Then re-run this script.
"@
}
$rustcVer = (rustc --version)
Write-OK "rustc: $rustcVer"

if (-not (Test-CommandExists "rustup")) {
    Write-WarnLn "rustup not on PATH — skipping target verification. If the build fails with 'target not installed', install rustup and rerun."
} else {
    $targets = (rustup target list --installed) -split "`n" | ForEach-Object { $_.Trim() }
    if ($targets -notcontains "x86_64-pc-windows-msvc") {
        Write-WarnLn "MSVC target not installed; installing now..."
        rustup target add x86_64-pc-windows-msvc
        if ($LASTEXITCODE -ne 0) { Fail "rustup target add failed." }
    }
    Write-OK "Rust target: x86_64-pc-windows-msvc"

    # If rustc's default host is the GNU variant, warn loudly — the build
    # will compile but the resulting binary will fail at runtime when it
    # tries to load WebView2's MSVC-built DLLs.
    $hostLine = (rustc -vV) | Select-String -SimpleMatch "host:"
    if ($hostLine -and ($hostLine -notmatch "pc-windows-msvc")) {
        Write-WarnLn "rustc default host is NOT MSVC ($hostLine)."
        Write-WarnLn "  Run:  rustup default stable-x86_64-pc-windows-msvc"
    }
}

# MSVC build tools — the linker (`link.exe`) and the Windows SDK headers.
# We don't try to invoke `cl.exe` directly because `cargo` calls it
# implicitly; checking for the presence of a Visual Studio install via
# `vswhere` is the cleanest signal. If we can't find vswhere either,
# we'll let cargo fail loudly with its own (very specific) error.
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (Test-Path $vswhere) {
    $vsInstall = & $vswhere -latest -products * `
        -requires Microsoft.VisualCpp.Tools.HostX64.TargetX64 `
        -property installationPath
    if ($vsInstall) {
        Write-OK "MSVC build tools: $vsInstall"
    } else {
        Write-WarnLn @"
MSVC C++ build tools not detected. Cargo will fail with a 'link.exe not found' error.
Install one of:

  Visual Studio 2022 (Community is free) with the
    "Desktop development with C++" workload, OR

  Build Tools for Visual Studio 2022 (standalone, smaller download):
    https://visualstudio.microsoft.com/downloads/#build-tools-for-visual-studio-2022

Make sure to include the Windows 10/11 SDK component.
"@
    }
} else {
    Write-WarnLn "vswhere.exe not found — cannot verify MSVC tools. Cargo will tell you if anything is missing."
}

# WebView2 runtime — Tauri 2 ships a fixed-runtime option but by default
# it relies on the system-installed WebView2 runtime. Newer Win11 ships
# with it; older Win10 does not.
$webview2Key = "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
if (Test-Path $webview2Key) {
    Write-OK "WebView2 runtime: installed"
} else {
    Write-WarnLn @"
WebView2 Evergreen runtime not detected. The MSI will still install but the app
won't launch on machines without it. Either:

  - Distribute the runtime separately:
      https://developer.microsoft.com/en-us/microsoft-edge/webview2/
  - Or switch to Tauri's 'fixedRuntime' WebView2 mode (bigger installer).
"@
}

# ---------------------------------------------------------------------------
# 2. Workspace setup
# ---------------------------------------------------------------------------

Write-Step "Workspace setup"

# Move to the script's parent (the repo root) regardless of where the
# user invoked us from. PowerShell's $PSScriptRoot is the directory of
# the script file.
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot
Write-OK "Working dir: $repoRoot"

if ($Clean) {
    Write-Step "Cleaning previous build artifacts"
    if (Test-Path "src-tauri/target") {
        cargo clean --manifest-path src-tauri/Cargo.toml
        if ($LASTEXITCODE -ne 0) { Fail "cargo clean failed." }
    }
    if (Test-Path "dist") {
        Remove-Item -Recurse -Force "dist"
    }
    Write-OK "Cleaned."
}

if (-not $SkipInstall) {
    if (-not (Test-Path "node_modules")) {
        Write-Step "Installing npm dependencies (first-time)"
        npm install
        if ($LASTEXITCODE -ne 0) { Fail "npm install failed." }
    } else {
        Write-OK "node_modules present — skipping npm install (pass -SkipInstall to suppress this check entirely)."
    }
} else {
    Write-WarnLn "Skipping npm install (-SkipInstall)."
}

# ---------------------------------------------------------------------------
# 3. Build
# ---------------------------------------------------------------------------

Write-Step "Building (npm run tauri build)"

# Surface the signing hint if it's set, so users running automated CI know
# their cert env wired up. We don't print the value (it's a secret).
if ($env:TAURI_SIGNING_PRIVATE_KEY) {
    Write-OK "TAURI_SIGNING_PRIVATE_KEY set — installer will be code-signed."
} else {
    Write-WarnLn "No code-signing env var set; installers will trigger SmartScreen on first launch. See docs/RELEASE_WITHOUT_SIGNING.md."
}

npm run tauri build
if ($LASTEXITCODE -ne 0) { Fail "tauri build failed. See output above." }

# ---------------------------------------------------------------------------
# 4. Report artifacts
# ---------------------------------------------------------------------------

Write-Step "Artifacts"

$bundleRoot = "src-tauri/target/release/bundle"
if (-not (Test-Path $bundleRoot)) {
    Write-WarnLn "No bundle directory found at $bundleRoot. The build may have produced only the raw .exe."
} else {
    $msi = Get-ChildItem -Path $bundleRoot -Recurse -Filter "*.msi" -ErrorAction SilentlyContinue
    $exe = Get-ChildItem -Path $bundleRoot -Recurse -Filter "*setup.exe" -ErrorAction SilentlyContinue
    if ($msi) {
        $msi | ForEach-Object { Write-Host "  MSI  $($_.FullName)" -ForegroundColor Green }
    }
    if ($exe) {
        $exe | ForEach-Object { Write-Host "  EXE  $($_.FullName)" -ForegroundColor Green }
    }
    if (-not $msi -and -not $exe) {
        Write-WarnLn "Build finished but no .msi / setup.exe were produced."
    }
}

Write-Host ""
Write-Host "Done." -ForegroundColor Cyan
