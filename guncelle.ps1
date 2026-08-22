# ============================================================================
# guncelle.ps1 - VDS'teki web panelini gunceller.
#
# Kullanim (PowerShell, bu klasorun icinde):
#     .\guncelle.ps1
#
# Ilk calistirmada Windows script calistirmayi engellerse, once su komutu ver:
#     Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
#
# Bu script config.env, panel-auth.json ve warning-history.json dosyalarina
# DOKUNMAZ - onlar .gitignore'da oldugu icin guncelleme sirasinda oldugu gibi
# kalir. Yani token'in ve panel hesaplarin silinmez.
# ============================================================================

$ErrorActionPreference = "Stop"
$dal = "claude/bunu-botu-anla-dpliwm"
$kok = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $kok

Write-Host ""
Write-Host "=== MD PvP Yoklama Botu - guncelleme ===" -ForegroundColor Cyan
Write-Host "Klasor: $kok"
Write-Host ""

# --- 0) Gizli dosyalar yerinde mi? ---
if (-not (Test-Path (Join-Path $kok "config.env"))) {
    Write-Host "UYARI: config.env bulunamadi. Bot token olmadan baslamaz." -ForegroundColor Yellow
}

# --- 1) Yerel degisiklik var mi? ---
# VDS'te dosyalari elle duzenlediysen git pull catisir. Once uyariyoruz.
$degisen = git status --porcelain
if ($degisen) {
    Write-Host "DUR: Bu klasorde kaydedilmemis yerel degisiklikler var:" -ForegroundColor Red
    git status --short
    Write-Host ""
    Write-Host "Bunlari saklamak istiyorsan:   git stash" -ForegroundColor Yellow
    Write-Host "Atmak istiyorsan:              git checkout -- ." -ForegroundColor Yellow
    Write-Host "Sonra bu scripti tekrar calistir."
    exit 1
}

# --- 2) Yeni surumu cek ---
Write-Host "[1/3] Guncellemeler cekiliyor..." -ForegroundColor Green
git pull origin $dal
if ($LASTEXITCODE -ne 0) { Write-Host "git pull basarisiz oldu." -ForegroundColor Red; exit 1 }

# --- 3) Bagimliliklar ---
Write-Host ""
Write-Host "[2/3] Bagimliliklar kontrol ediliyor..." -ForegroundColor Green
$sunucuDizini = Join-Path $kok "server"
Set-Location $sunucuDizini
npm install --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { Write-Host "npm install basarisiz oldu." -ForegroundColor Red; exit 1 }

# --- 4) Yeniden baslat ---
Write-Host ""
Write-Host "[3/3] Bot yeniden baslatiliyor..." -ForegroundColor Green

$pm2Var = Get-Command pm2 -ErrorAction SilentlyContinue
$pm2Kayitli = $false
if ($pm2Var) {
    pm2 describe yoklama *> $null
    if ($LASTEXITCODE -eq 0) { $pm2Kayitli = $true }
}

if ($pm2Kayitli) {
    pm2 restart yoklama
    Write-Host ""
    Write-Host "TAMAM - bot pm2 uzerinden yeniden baslatildi." -ForegroundColor Cyan
    Write-Host "Loglari gormek icin:  pm2 logs yoklama"
} else {
    Write-Host ""
    Write-Host "TAMAM - dosyalar guncellendi." -ForegroundColor Cyan
    Write-Host "Bot pm2 ile yonetilmiyor; su an calisan 'node server.js' penceresini" -ForegroundColor Yellow
    Write-Host "kapatip su klasorde yeniden baslatman gerekiyor:" -ForegroundColor Yellow
    Write-Host "    cd `"$sunucuDizini`""
    Write-Host "    node server.js"
}
Write-Host ""
