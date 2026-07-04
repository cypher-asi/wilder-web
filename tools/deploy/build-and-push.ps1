<#
.SYNOPSIS
    Build the Wilder gateway image locally and push it to GHCR so Render can
    deploy a prebuilt image (no compiling RocksDB on Render's builders).

.DESCRIPTION
    Does all the heavy lifting on your machine:
      1. Builds the multi-stage Dockerfile for linux/amd64 (Render's arch).
      2. Tags the image :latest and :<git-sha>.
      3. Pushes both tags to ghcr.io/cypher-asi/wilder-gibson.

    First-time setup (once per machine):
      - Start Docker Desktop.
      - Create a GitHub PAT (classic) with the `write:packages` scope.
      - Log in:  $env:CR_PAT="<token>"; $env:CR_PAT | docker login ghcr.io -u <github-username> --password-stdin
      - Make the package public once (GitHub > your profile > Packages >
        wilder-gibson > Package settings > Change visibility > Public) so
        Render can pull it without credentials.

.EXAMPLE
    ./tools/deploy/build-and-push.ps1

.EXAMPLE
    # Build only, don't push (smoke-test the image locally):
    ./tools/deploy/build-and-push.ps1 -NoPush
#>
[CmdletBinding()]
param(
    [string]$Image = "ghcr.io/cypher-asi/wilder-gibson",
    [switch]$NoPush
)

$ErrorActionPreference = "Stop"

# Run from the repo root regardless of where the script is invoked.
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
Push-Location $repoRoot
try {
    # Fail fast if the Docker daemon isn't up.
    docker info *> $null
    if ($LASTEXITCODE -ne 0) {
        throw "Docker daemon is not running. Start Docker Desktop and retry."
    }

    $sha = (git rev-parse --short HEAD).Trim()
    $tags = @("$Image`:latest", "$Image`:$sha")
    Write-Host "Building $Image (linux/amd64) at commit $sha ..." -ForegroundColor Cyan

    $args = @(
        "buildx", "build",
        "--platform", "linux/amd64",
        "-f", "Dockerfile"
    )
    foreach ($t in $tags) { $args += @("-t", $t) }

    if ($NoPush) {
        # --load brings the built image into the local daemon for testing.
        $args += "--load"
    } else {
        $args += "--push"
    }
    $args += "."

    docker @args
    if ($LASTEXITCODE -ne 0) { throw "docker buildx build failed." }

    if ($NoPush) {
        Write-Host "Built locally (not pushed): $($tags -join ', ')" -ForegroundColor Green
        Write-Host "Smoke-test:  docker run --rm -p 8080:8080 -e PORT=8080 $Image`:$sha" -ForegroundColor DarkGray
    } else {
        Write-Host "Pushed: $($tags -join ', ')" -ForegroundColor Green
        Write-Host "Now trigger a deploy in Render (Manual Deploy > Deploy latest reference)," -ForegroundColor DarkGray
        Write-Host "or hit your Render deploy hook. Render will pull the new :latest image." -ForegroundColor DarkGray
    }
}
finally {
    Pop-Location
}
