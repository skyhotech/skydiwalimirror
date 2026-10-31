# Runs every minute as the Sky-diwali-deploy scheduled task. Deploys origin/main once its CI has passed.
$Root = 'D:\sky\diwali'
$Repo = "$Root\repo"
$ApiRepo = 'skyhotech/skydiwalimirror'
function Log($m) { "$(Get-Date -Format s) $m" | Add-Content -Encoding utf8 "$Root\logs\deploy.log" }
function Git { & git -c safe.directory=* -C $Repo @args }
function ReadSha($f) { if (Test-Path $f) { (Get-Content $f -Raw).Trim() } else { '' } }

[Net.ServicePointManager]::SecurityProtocol = 'Tls12'
New-Item -ItemType Directory -Force "$Root\logs" | Out-Null
$sha = ((& git ls-remote "https://github.com/$ApiRepo.git" refs/heads/main) -split '\s+')[0]
if (-not $sha -or $sha -eq (ReadSha "$Root\deployed.sha") -or $sha -eq (ReadSha "$Root\failed.sha")) { exit 0 }

$checks = (Invoke-RestMethod "https://api.github.com/repos/$ApiRepo/commits/$sha/check-runs" -Headers @{ 'User-Agent' = 'sky-diwali-deploy' }).check_runs
if (-not $checks -or ($checks | Where-Object { $_.status -ne 'completed' })) { exit 0 }
if ($checks | Where-Object { $_.conclusion -ne 'success' }) {
  Log "$sha not deployed: CI failed"
  Set-Content "$Root\failed.sha" $sha
  exit 1
}

Log "deploying $sha"
Git fetch -q origin main
Git reset -q --hard $sha
# A child process, so a commit that changes the deploy step takes effect immediately.
& powershell -NoProfile -ExecutionPolicy Bypass -File "$Repo\deploy\deploy.ps1" *>> "$Root\logs\deploy.log"
if ($LASTEXITCODE -eq 0) {
  Set-Content "$Root\deployed.sha" $sha
  Log "deployed $sha"
} else {
  Set-Content "$Root\failed.sha" $sha
  Log "FAILED $sha, see above; push a fix to retry"
  exit 1
}
