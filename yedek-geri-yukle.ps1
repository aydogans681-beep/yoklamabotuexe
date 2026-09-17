# ============================================================================
#  YEDEGI GERI YUKLE - yeni sunucuda calistirilir.
#
#  Sirasi onemli:
#    1) Yeni sunucuda depoyu klonla       (git clone ...)
#    2) npm install                        (server klasorunde)
#    3) BU BETIK                           (.\yedek-geri-yukle.ps1 yedek.zip)
#    4) pm2 ile baslat                     (.\temizle.ps1 ya da pm2 start)
#
#  Kullanim:  .\yedek-geri-yukle.ps1 C:\Users\Administrator\Desktop\yoklama-yedek-....zip
# ============================================================================

param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$ZipYolu
)

$ErrorActionPreference = 'Stop'

$hedef = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $hedef) { $hedef = (Get-Location).Path }

if (-not (Test-Path -LiteralPath $ZipYolu)) {
    Write-Host "  Zip bulunamadi: $ZipYolu" -ForegroundColor Red
    exit 1
}

# Projenin dogru klasorunde miyiz? Yanlis yere acilan yedek dosyalari
# ortaliga sacar ve bot yine calismaz.
if (-not (Test-Path -LiteralPath (Join-Path $hedef 'server\server.js'))) {
    Write-Host "  Burasi proje klasoru degil: $hedef" -ForegroundColor Red
    Write-Host "  Once depoyu klonla, sonra bu betigi proje icinde calistir." -ForegroundColor Yellow
    exit 1
}

Write-Host ""
Write-Host "  Hedef klasor: $hedef" -ForegroundColor Cyan
Write-Host ""

$gecici = Join-Path $env:TEMP "yoklama-geri-$(Get-Date -Format 'HHmmss')"
Expand-Archive -LiteralPath $ZipYolu -DestinationPath $gecici -Force

# Yedegin ne zaman/hangi surumden alindigini goster - yanlis zip'i acmayalim.
$bilgi = Join-Path $gecici '_YEDEK-BILGI.txt'
if (Test-Path -LiteralPath $bilgi) {
    Get-Content -LiteralPath $bilgi | Select-Object -First 5 | ForEach-Object {
        Write-Host "  $_" -ForegroundColor DarkGray
    }
    Write-Host ""
}

$yazilan = 0
$atlanan = 0

Get-ChildItem -LiteralPath $gecici -File | ForEach-Object {
    $ad = $_.Name
    if ($ad -eq '_YEDEK-BILGI.txt') { return }

    # Logo ve AC adresi kendi yerlerine gidiyor, kok klasore degil.
    if ($ad -like 'logo.*') {
        $yer = Join-Path $hedef 'server\public'
        New-Item -ItemType Directory -Force -Path $yer | Out-Null
        Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $yer $ad) -Force
        Write-Host "  -> server/public/$ad" -ForegroundColor Green
        $script:yazilan++
        return
    }
    if ($ad -eq 'ac-masaustu-adres.json') {
        $yer = Join-Path $hedef 'ac-masaustu'
        New-Item -ItemType Directory -Force -Path $yer | Out-Null
        Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $yer 'adres.json') -Force
        Write-Host "  -> ac-masaustu/adres.json" -ForegroundColor Green
        $script:yazilan++
        return
    }

    # Ustune yazmadan once VAR OLANI yedekliyoruz: yanlis zip acilirsa
    # yeni sunucuda olusmus veriyi geri alabilelim.
    $varis = Join-Path $hedef $ad
    if (Test-Path -LiteralPath $varis) {
        Copy-Item -LiteralPath $varis -Destination "$varis.oncesi" -Force
        Write-Host "  -> $ad  (eskisi $ad.oncesi olarak saklandi)" -ForegroundColor Yellow
    } else {
        Write-Host "  -> $ad" -ForegroundColor Green
    }
    Copy-Item -LiteralPath $_.FullName -Destination $varis -Force
    $script:yazilan++
}

Remove-Item -LiteralPath $gecici -Recurse -Force

Write-Host ""
Write-Host "  $yazilan dosya geri yuklendi." -ForegroundColor Cyan
Write-Host ""

# --- Kontrol: botun acilmasi icin SART olanlar ---
$sart = @('config.env', 'panel-auth.json')
$eksikSart = @()
foreach ($d in $sart) {
    if (-not (Test-Path -LiteralPath (Join-Path $hedef $d))) { $eksikSart += $d }
}
if ($eksikSart.Count -gt 0) {
    Write-Host "  DIKKAT - bunlar olmadan bot acilmaz:" -ForegroundColor Red
    $eksikSart | ForEach-Object { Write-Host "    $_" -ForegroundColor Red }
    Write-Host ""
} else {
    Write-Host "  config.env ve panel-auth.json yerinde." -ForegroundColor Green
}

Write-Host "  Sirada: npm install  ->  .\temizle.ps1" -ForegroundColor White
Write-Host ""
