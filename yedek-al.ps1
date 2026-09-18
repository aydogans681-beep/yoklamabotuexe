# ============================================================================
#  YEDEK AL - botun URETTIGI, git'te OLMAYAN her seyi tek zip'e koyar.
#
#  Kod GitHub'da duruyor; bu betik kodu yedeklemiyor. Yedeklediklerinin
#  tamami YENIDEN URETILEMEZ veriler: Discord token'i, panel hesaplari,
#  90 gunluk ses kaydi, uyari gecmisi, yoklama katilimi, AC tokenlari.
#  Bunlar giderse yeni sunucuda sifirdan baslarsin.
#
#  Kullanim:  .\yedek-al.ps1
#  Calismazsa: powershell -ExecutionPolicy Bypass -File .\yedek-al.ps1
# ============================================================================

# -Hedef: zip'in yazilacagi klasor. Varsayilan masaustu, ama ZAMANLANMIS
# GOREV olarak calisirken masaustu yolu kullaniciya gore degistiginden
# (ya da hic olmadigindan) disaridan verilebilmesi gerekiyor.
param(
    [string]$Hedef = ''
)

$ErrorActionPreference = 'Continue'

# Betigin kendi klasoru = proje kokü. Cift tiklayarak da calissin diye
# bulundugun dizine degil betigin yerine bakiyoruz.
$kaynak = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $kaynak) { $kaynak = (Get-Location).Path }

Write-Host ""
Write-Host "  Kaynak klasor: $kaynak" -ForegroundColor Cyan
Write-Host ""

$zaman = Get-Date -Format 'yyyy-MM-dd_HHmm'
if ($Hedef) {
    $masaustu = $Hedef
    New-Item -ItemType Directory -Force -Path $masaustu | Out-Null
} else {
    $masaustu = [Environment]::GetFolderPath('Desktop')
}
if (-not $masaustu) { $masaustu = $kaynak }
$gecici = Join-Path $masaustu "yoklama-yedek-$zaman"
New-Item -ItemType Directory -Force -Path $gecici | Out-Null

# --- Yedeklenecekler ---
# Sira onem sirasi: en ustteki gitse bot hic acilmaz.
$dosyalar = @(
    # GIZLI - bunlar olmadan bot Discord'a baglanamaz
    'config.env',
    'config.env.yedek',
    'ac-anahtar.key',          # bu gitse ac-tokenlari.json cozulemez
    'ac-tokenlari.json',
    'ac-kilit.json',
    'ac-nexora-api.json',
    'ac-tetik-kelime.json',
    'ac-kirli-kelime.json',
    'ac-gif.gif',

    # PANEL - hesaplar, ayarlar, gorunum
    'panel-auth.json',         # panel hesaplari (sifre hash'leri)
    'panel-settings.json',     # oto yoklama saatleri, rol botu, ticket mesaji
    'panel-audit.json',
    'panel-oturumlar.json',
    'panel-gorunum.json',
    'panel-hedefler.json',
    'panel-sicil.json',

    # VERI - yeniden uretilemez, en degerlisi bunlar
    'voice-activity.json',     # 90 gunluk ses kaydi
    'yoklama-katilim.json',
    'warning-history.json',    # uyari gecmisi + aktif uyarilar
    'yayin-kayitlari.json',
    'yetkili-listesi.json',
    'log-isaretleri.json',
    'canli-sahiplenme.json',

    # pm2 yapilandirmasi (depoda var ama elle degistirilmis olabilir)
    'ecosystem.config.js'
)

$bulunan = 0
$eksik = 0
$toplamBayt = 0

foreach ($ad in $dosyalar) {
    $yol = Join-Path $kaynak $ad
    if (Test-Path -LiteralPath $yol) {
        Copy-Item -LiteralPath $yol -Destination $gecici -Force
        $boyut = (Get-Item -LiteralPath $yol).Length
        $script:toplamBayt += $boyut
        $script:bulunan++
        $kb = [math]::Round($boyut / 1KB, 1)
        Write-Host ("  + {0,-28} {1,8} KB" -f $ad, $kb) -ForegroundColor Green
    } else {
        $script:eksik++
        Write-Host ("  - {0,-28} (yok)" -f $ad) -ForegroundColor DarkGray
    }
}

# --- Sunucu logosu (adi logo.png / Logo.JPG ... olabilir) ---
$publicYol = Join-Path $kaynak 'server\public'
if (Test-Path -LiteralPath $publicYol) {
    Get-ChildItem -LiteralPath $publicYol -Filter 'logo.*' -File -ErrorAction SilentlyContinue |
        ForEach-Object {
            Copy-Item -LiteralPath $_.FullName -Destination $gecici -Force
            $script:bulunan++
            $script:toplamBayt += $_.Length
            Write-Host ("  + {0,-28} {1,8} KB" -f $_.Name, ([math]::Round($_.Length / 1KB, 1))) -ForegroundColor Green
        }
}

# --- AC masaustu surumunun panel adresi ---
$adresYol = Join-Path $kaynak 'ac-masaustu\adres.json'
if (Test-Path -LiteralPath $adresYol) {
    Copy-Item -LiteralPath $adresYol -Destination (Join-Path $gecici 'ac-masaustu-adres.json') -Force
    $script:bulunan++
    Write-Host ("  + {0,-28}" -f 'ac-masaustu/adres.json') -ForegroundColor Green
}

# --- Hangi surumden yedek aldigimizi da yaziyoruz ---
# Yeni sunucuda "hangi commit'teydim" sorusunu cevapliyor.
$not = @()
$not += "Yedek tarihi : $(Get-Date -Format 'dd.MM.yyyy HH:mm')"
$not += "Kaynak       : $kaynak"
$not += "Bilgisayar   : $env:COMPUTERNAME"
try {
    $dal = (git -C $kaynak rev-parse --abbrev-ref HEAD 2>$null)
    $commit = (git -C $kaynak rev-parse --short HEAD 2>$null)
    if ($commit) { $not += "Git          : $dal @ $commit" }
} catch { }
try {
    $js = Get-Content (Join-Path $kaynak 'server\server.js') -TotalCount 7000 -ErrorAction SilentlyContinue
    $satir = $js | Select-String -Pattern "const KOD_SURUMU = '([^']+)'" | Select-Object -First 1
    if ($satir) { $not += "Kod surumu   : $($satir.Matches[0].Groups[1].Value)" }
} catch { }
$not += ""
$not += "BU YEDEKTE OLMAYANLAR (bilerek):"
$not += "  node_modules/  -> yeni sunucuda 'npm install' ile gelir"
$not += "  log-cache/     -> Discord'dan yeniden cekilir"
$not += "  indirmeler/    -> exe yeniden derlenir"
$not += "  kod            -> GitHub'da"
$not | Set-Content -Path (Join-Path $gecici '_YEDEK-BILGI.txt') -Encoding UTF8

# --- Zip ---
Write-Host ""
if ($bulunan -eq 0) {
    Write-Host "  HIC DOSYA BULUNAMADI." -ForegroundColor Red
    Write-Host "  Betigi projenin kok klasorunde calistirdigindan emin ol" -ForegroundColor Yellow
    Write-Host "  (icinde 'server' klasoru ve 'guncelle.ps1' olan yer)." -ForegroundColor Yellow
    Remove-Item -LiteralPath $gecici -Recurse -Force
    exit 1
}

$zip = "$gecici.zip"
if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
Compress-Archive -Path (Join-Path $gecici '*') -DestinationPath $zip -Force
Remove-Item -LiteralPath $gecici -Recurse -Force

$zipBoyut = [math]::Round((Get-Item -LiteralPath $zip).Length / 1KB, 1)
Write-Host "  TAMAM. $bulunan dosya yedeklendi ($eksik dosya bu kurulumda yok)." -ForegroundColor Cyan
Write-Host ""
Write-Host "  $zip" -ForegroundColor White
Write-Host "  Zip boyutu: $zipBoyut KB" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  BU ZIP'I KIMSEYLE PAYLASMA." -ForegroundColor Yellow
Write-Host "  Icinde Discord token'in ve panel sifre hash'lerin var." -ForegroundColor Yellow
Write-Host "  Kendi bilgisayarina indir, sunucuda birakma." -ForegroundColor Yellow
Write-Host ""
