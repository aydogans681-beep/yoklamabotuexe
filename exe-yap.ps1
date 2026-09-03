# ============================================================================
# exe-yap.ps1 - AC'ler icin masaustu surumunu (exe) derler.
#
# Kullanim (PowerShell, depo kokunde):
#     .\exe-yap.ps1 -Adres "panel.site.com"
#     .\exe-yap.ps1                          # adres gommeden
#
# -Adres: exe'ye GOMULEN varsayilan panel adresi. AC exe'yi acinca hicbir sey
# sormadan panele baglanir. Vermezsen exe ilk acilista adresi kendisi sorar
# (AC'nin adresi bilmesi gerekir). Adres sonradan uygulamanin menusunden de
# degistirilebilir - gomulu deger yalnizca varsayilan.
#
# Sonuc: indirmeler\MD-AC-Panel.exe
# Panel bu dosyayi "Masaustu surumu" butonuyla AC'lere sunuyor. indirmeler/
# .gitignore'da - exe depoya girmez, her sunucu kendi derler.
#
# NEDEN AYRI BIR BETIK: derleme node + ~100 MB electron indirir ve dakikalar
# surer. guncelle.ps1'e koysaydik her guncelleme bunu bekletirdi; exe ise
# nadiren degisiyor (panelin kendisi degisince exe'yi yeniden derlemek
# GEREKMIYOR - exe paneli uzaktan aciyor, kendi icinde tasimiyor).
# ============================================================================

param(
    [string]$Adres = ""
)

$ErrorActionPreference = "Stop"
$kok = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $kok

$uygulamaDizini = Join-Path $kok "ac-masaustu"
$indirmeler     = Join-Path $kok "indirmeler"
$hedefExe       = Join-Path $indirmeler "MD-AC-Panel.exe"

Write-Host ""
Write-Host "=== AC masaustu surumu derleniyor ===" -ForegroundColor Cyan
Write-Host "Klasor: $uygulamaDizini"
Write-Host ""

if (-not (Test-Path $uygulamaDizini)) {
    Write-Host "ac-masaustu klasoru yok. Once 'git pull' ile guncelle." -ForegroundColor Red
    exit 1
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Host "npm bulunamadi. Node.js kurulu olmali: https://nodejs.org" -ForegroundColor Red
    exit 1
}

# --- 1) Gomulu adres ---
# adres.json her calistirmada YENIDEN yaziliyor: -Adres verilmediginde eski
# bir derlemeden kalan adres sessizce exe'ye gomulmesin.
$adresDosyasi = Join-Path $uygulamaDizini "adres.json"
$temizAdres = $Adres.Trim()
if ($temizAdres) {
    @{ adres = $temizAdres } | ConvertTo-Json | Set-Content -Path $adresDosyasi -Encoding UTF8
    Write-Host "[1/3] Gomulu adres: $temizAdres" -ForegroundColor Green
} else {
    @{ adres = "" } | ConvertTo-Json | Set-Content -Path $adresDosyasi -Encoding UTF8
    Write-Host "[1/3] Adres gomulmedi - exe ilk acilista soracak." -ForegroundColor Yellow
    Write-Host "      Gommek istersen:  .\exe-yap.ps1 -Adres `"panel.site.com`"" -ForegroundColor DarkGray
}

# --- 2) Bagimliliklar ---
Write-Host ""
Write-Host "[2/3] Bagimliliklar kuruluyor (ilk seferde electron inecek, uzun surer)..." -ForegroundColor Green
Set-Location $uygulamaDizini
try {
    npm install --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) {
        Write-Host "npm install basarisiz oldu." -ForegroundColor Red
        exit 1
    }
} finally {
    Set-Location $kok
}

# --- 3) Derleme ---
Write-Host ""
Write-Host "[3/3] exe derleniyor..." -ForegroundColor Green
Set-Location $uygulamaDizini
$derlemeTamam = $false
try {
    # electron-builder ilerlemeyi stderr'e yaziyor; ErrorActionPreference="Stop"
    # ile bu sonlandirici hataya donusuyordu (guncelle.ps1'de ayni tuzak var).
    $eskiEAP = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    npx --no-install electron-builder --win portable
    $derlemeTamam = ($LASTEXITCODE -eq 0)
    $ErrorActionPreference = $eskiEAP
} finally {
    Set-Location $kok
    $global:LASTEXITCODE = 0
}

if (-not $derlemeTamam) {
    Write-Host ""
    Write-Host "Derleme basarisiz oldu." -ForegroundColor Red
    Write-Host "Cikan hatayi yukarida gorebilirsin. Sik sebep: disk dolu ya da" -ForegroundColor Yellow
    Write-Host "electron indirilemedi (ag/proxy)." -ForegroundColor Yellow
    exit 1
}

# --- 4) indirmeler/ altina kopyala ---
# electron-builder cikti adini package.json'daki portable.artifactName'den
# aliyor. Yine de dosyayi ADIYLA degil, "dist icindeki tek .exe" olarak
# ariyoruz: ad degisirse betik sessizce eski exe'yi sunmaya devam etmesin.
$dist = Join-Path $uygulamaDizini "dist"
$uretilen = @(Get-ChildItem -Path $dist -Filter *.exe -File -ErrorAction SilentlyContinue |
              Sort-Object LastWriteTime -Descending)

if ($uretilen.Count -eq 0) {
    Write-Host "Derleme bitti ama dist klasorunde exe bulunamadi: $dist" -ForegroundColor Red
    exit 1
}

New-Item -ItemType Directory -Force -Path $indirmeler | Out-Null
Copy-Item -Path $uretilen[0].FullName -Destination $hedefExe -Force

$boyutMB = [math]::Round($uretilen[0].Length / 1MB, 1)
Write-Host ""
Write-Host "TAMAM - exe hazir." -ForegroundColor Cyan
Write-Host "   dosya : $hedefExe"
Write-Host "   boyut : $boyutMB MB"
if ($temizAdres) {
    Write-Host "   adres : $temizAdres (gomulu)"
} else {
    Write-Host "   adres : gomulu degil - exe ilk acilista soracak"
}
Write-Host ""
Write-Host "AC'ler artik panelin sol altindaki 'Masaustu surumu' butonundan" -ForegroundColor DarkGray
Write-Host "indirebilir. Butonun gorunmesi icin paneli yenilemeleri yeterli," -ForegroundColor DarkGray
Write-Host "botu yeniden baslatmak gerekmiyor." -ForegroundColor DarkGray
Write-Host ""
