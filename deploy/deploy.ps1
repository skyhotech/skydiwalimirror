# Installs the commit checked out in D:\sky\diwali\repo. db.sqlite3, media, backups and .env stay in place.
$Root = 'D:\sky\diwali'
$Repo = "$Root\repo"
$Backend = "$Root\backend"
$Py = "$Root\venv\Scripts\python.exe"
$Caddy = 'D:\sky\caddy\bin-2.11.7\caddy.exe'
$Winsw = "$Root\service\Sky-diwali.exe"
$Conf = 'D:\sky\caddy\Caddyfile'
function Run($exe) {
  & $exe @args 2>&1 | ForEach-Object { "$_" }
  if ($LASTEXITCODE -ne 0) { throw "failed: $exe $args" }
}
function Copy-Tree($from, $to) {
  & robocopy $from $to /MIR /NFL /NDL /NJH /NJS /NP @args | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "copy failed: $from" }
}
try {
  Set-Location $Repo
  Run npm.cmd ci
  Run npm.cmd run build

  if (-not (Test-Path $Py)) { Run C:\python\python.exe -m venv "$Root\venv" }
  Run $Py -m pip install -q -r backend\requirements.txt

  if (-not (Test-Path "$Backend\.env")) {
    New-Item -ItemType Directory -Force $Backend | Out-Null
    $secret = & $Py -c "import secrets; print(secrets.token_urlsafe(50))"
    @(
      "DJANGO_SECRET_KEY=$secret", 'DJANGO_DEBUG=0', 'DJANGO_SSL_REDIRECT=0',
      'MEDIA_ROOT=D:/sky/diwali/media', 'DJANGO_ALLOWED_HOSTS=.skymobile.in',
      'CORS_ALLOWED_ORIGINS=https://diwali.skymobile.in,https://dreamdiwali.skymobile.in',
      'CSRF_TRUSTED_ORIGINS=https://*.skymobile.in', 'TRUSTED_PROXIES=1'
    ) | Set-Content -Encoding ascii "$Backend\.env"
  }
  # Caddy sits in front: trust its X-Forwarded-For so rate limits are per
  # visitor. Added to servers installed before this setting existed.
  if (-not (Select-String -Path "$Backend\.env" -Pattern '^TRUSTED_PROXIES=' -Quiet)) {
    Add-Content -Encoding ascii "$Backend\.env" 'TRUSTED_PROXIES=1'
  }
  $firstInstall = -not (Test-Path "$Backend\db.sqlite3")

  if (Get-Service Sky-diwali -ErrorAction SilentlyContinue) { Stop-Service Sky-diwali }
  Copy-Tree "$Repo\backend" $Backend /XD media backups staticfiles __pycache__ /XF db.sqlite3* .env
  Copy-Tree "$Repo\public\frames" "$Root\public\frames"

  Set-Location $Backend
  if (-not $firstInstall) { Run $Py manage.py backup }
  Run $Py manage.py migrate --noinput
  Run $Py manage.py collectstatic --noinput
  if ($firstInstall) { Run $Py manage.py seed_mirrors }

  New-Item -ItemType Directory -Force "$Root\service\logs" | Out-Null
  Copy-Item "$Repo\deploy\Sky-diwali.xml" "$Root\service\Sky-diwali.xml"
  if (-not (Get-Service Sky-diwali -ErrorAction SilentlyContinue)) {
    Copy-Item D:\sky\tools\WinSW-x64.exe $Winsw
    Run $Winsw install
  }
  Start-Service Sky-diwali

  $ok = $false
  foreach ($i in 1..20) {
    Start-Sleep 2
    $code = & curl.exe -s -o NUL -w '%{http_code}' -H 'Host: diwali.skymobile.in' -H 'X-Forwarded-Proto: https' http://127.0.0.1:8003/api/mirrors/version/
    if ($code -eq '200') { $ok = $true; break }
  }
  if (-not $ok) { throw "health check failed: HTTP $code" }

  Copy-Tree "$Repo\dist" "$Root\site"

  $live = 'D:\sky\caddy\sites\diwali.caddy'
  $previous = Get-Content $live -Raw
  Copy-Item "$Repo\deploy\diwali.caddy" $live
  & cmd /c "`"$Caddy`" validate --config $Conf --adapter caddyfile 2>&1"
  if ($LASTEXITCODE -ne 0) {
    [IO.File]::WriteAllText($live, $previous)
    throw 'Caddy config invalid; previous site file restored'
  }
  Run $Caddy reload --config $Conf --adapter caddyfile
  exit 0
} catch {
  Write-Output "deploy error: $_"
  exit 1
}
