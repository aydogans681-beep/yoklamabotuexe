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
# SADECE takip edilen dosyalardaki degisiklikler guncellemeyi engelliyor -
# git pull yalnizca onlarla catisir. Takip edilmeyen dosyalar (?? ile
# baslayanlar: sunucunun urettigi kayit dosyalari, logo vs.) pull'u
# engellemez, o yuzden sadece bilgi olarak yaziliyor. Onlara "git checkout"
# zaten islemez; eskiden yanlislikla onlar da yolu kapatiyordu.
# DIKKAT: PowerShell'de -like icinde "?" joker karakterdir, yani '??*' her
# satiri eslestirir. Takipsiz dosyalari ayirmak icin duz metin karsilastirmasi
# (StartsWith) kullaniliyor.
$durum = @(git status --porcelain)
$takipsiz = @($durum | Where-Object { $_.StartsWith('??') })
$degisen  = @($durum | Where-Object { -not $_.StartsWith('??') })

if ($degisen.Count -gt 0) {
    Write-Host "DUR: Takip edilen dosyalarda kaydedilmemis degisiklik var:" -ForegroundColor Red
    $degisen | ForEach-Object { Write-Host "   $_" }
    Write-Host ""
    Write-Host "Saklamak istiyorsan:   git stash" -ForegroundColor Yellow
    Write-Host "Atmak istiyorsan:      git checkout -- ." -ForegroundColor Yellow
    Write-Host "Sonra bu scripti tekrar calistir."
    exit 1
}
if ($takipsiz.Count -gt 0) {
    Write-Host "Not: Depoda olmayan $($takipsiz.Count) dosya var (guncellemeyi etkilemez):" -ForegroundColor DarkGray
    $takipsiz | ForEach-Object { Write-Host "   $_" -ForegroundColor DarkGray }
    Write-Host ""
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

# pm2 var mi, "yoklama" surecini taniyor mu?
# DIKKAT: ErrorActionPreference="Stop" acikken, ciktisi yonlendirilen bir dis
# komutun stderr'e yazmasi PowerShell'de sonlandirici hataya donusuyor.
# "pm2 describe" kayitli olmayan surec icin stderr'e WARN yaziyor - bu yuzden
# tespit blogu boyunca hata tercihini gecici olarak Continue'ya aliyoruz.
$pm2Kurulu  = [bool](Get-Command pm2 -ErrorAction SilentlyContinue)
$pm2Kayitli = $false

if ($pm2Kurulu) {
    $eskiEAP = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & pm2 describe yoklama 2>&1 | Out-Null
        $pm2Kayitli = ($LASTEXITCODE -eq 0)
    } catch {
        $pm2Kayitli = $false
    } finally {
        $ErrorActionPreference = $eskiEAP
        $global:LASTEXITCODE = 0
    }
}

Write-Host ""
if ($pm2Kayitli) {
    $eskiEAP = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & pm2 restart yoklama 2>&1 | Out-Null
    $ErrorActionPreference = $eskiEAP
    Write-Host "TAMAM - bot pm2 uzerinden yeniden baslatildi." -ForegroundColor Cyan
    Write-Host "Loglari gormek icin:  pm2 logs yoklama"
} elseif ($pm2Kurulu) {
    Write-Host "TAMAM - dosyalar guncellendi." -ForegroundColor Cyan
    Write-Host ""
    Write-Host "pm2 kurulu ama 'yoklama' surecini tanimiyor - hic kaydedilmemis." -ForegroundColor Yellow
    Write-Host "Botu pm2'ye bir kez kaydedersen bundan sonra bu script kendisi" -ForegroundColor Yellow
    Write-Host "yeniden baslatir (ve bot pencere kapaninca olmez):" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "    cd `"$sunucuDizini`""
    Write-Host "    pm2 start server.js --name yoklama"
    Write-Host "    pm2 save"
} else {
    Write-Host "TAMAM - dosyalar guncellendi." -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Bot pm2 ile yonetilmiyor; su an calisan 'node server.js' penceresini" -ForegroundColor Yellow
    Write-Host "kapatip su klasorde yeniden baslatman gerekiyor:" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "    cd `"$sunucuDizini`""
    Write-Host "    node server.js"
}
Write-Host ""
