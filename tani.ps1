# ============================================================================
# tani.ps1 - Panelin su anki durumunu ozetler.
#
# Kullanim (PowerShell, bu klasorun icinde):
#     .\tani.ps1
#
# "Menu gorunmuyor", "guncelledim ama degismedi" gibi durumlarda ilk bakilacak
# yer. Giris gerektirmiyor, sadece localhost'tan okuyor.
#
# NOT: Ciktida Format-Table KULLANILMIYOR - bazi PowerShell ortamlarinda
# (ozellikle betik dosyasi olarak calistirildiginda) hicbir sey basmiyor,
# tablo bos gorunuyordu. Duz donguyle yaziliyor.
# ============================================================================

$ErrorActionPreference = "Stop"
$adres = "http://localhost:3000/api/surum"

Write-Host ""
Write-Host "=== MD PvP Yoklama Botu - durum ===" -ForegroundColor Cyan

try {
    $s = (Invoke-WebRequest $adres -UseBasicParsing -TimeoutSec 10).Content | ConvertFrom-Json
} catch {
    Write-Host ""
    Write-Host "Panele ulasilamadi ($adres)." -ForegroundColor Red
    Write-Host "Bot calismiyor ya da 3000 portunu baska bir surec tutuyor olabilir:" -ForegroundColor Yellow
    Write-Host "    pm2 list"
    Write-Host "    pm2 logs yoklama --err --lines 30 --nostream"
    Write-Host "    Get-NetTCPConnection -LocalPort 3000 -State Listen | Select OwningProcess"
    Write-Host ""
    exit 1
}

Write-Host ""
Write-Host "Calisan kod" -ForegroundColor Green
Write-Host "  commit      : $($s.commit)   dal: $($s.dal)   <- DISKTEKI .git (calisan kodu kanitlamaz)"
Write-Host "  baslatildi  : $($s.baslatildi)  ($($s.calismaSuresiSn) sn once)"

# GERCEK tazelik kontrolu: KOD_SURUMU kaynak dosyanin icinde gomulu oldugu icin
# yalnizca surec yeniden basladiginda degisir. "commit" ise git pull biter bitmez
# yeni gorunur ve eski kodu calistiran bir sureci ele vermez.
$diskKod = $null
try {
    $sj = Join-Path (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'server') 'server.js'
    if (Test-Path $sj) {
        $m = Select-String -Path $sj -Pattern "^const KOD_SURUMU = '([^']+)'" | Select-Object -First 1
        if ($m) { $diskKod = $m.Matches[0].Groups[1].Value }
    }
} catch { $diskKod = $null }

Write-Host "  kod surumu  : $($s.kodSurumu)   (diskte: $diskKod)"
if ($s.ozellikler) {
    Write-Host "  ozellikler  : $($s.ozellikler -join ', ')"
}
if ($diskKod -and (-not $s.kodSurumu)) {
    Write-Host "  DIKKAT: calisan surec kod surumunu bildirmiyor -> ESKI kod calisiyor." -ForegroundColor Red
    Write-Host "          Yeni menuler/uclar gelmez. Cozum:  .\temizle.ps1" -ForegroundColor Yellow
} elseif ($diskKod -and $s.kodSurumu -and ($diskKod -ne $s.kodSurumu)) {
    Write-Host "  DIKKAT: diskte $diskKod ama CALISAN $($s.kodSurumu) - eski surec hala ayakta." -ForegroundColor Red
    Write-Host "          Cozum:  .\temizle.ps1" -ForegroundColor Yellow
} elseif ($diskKod) {
    Write-Host "  Calisan kod GUNCEL." -ForegroundColor Cyan
}

Write-Host ""
Write-Host "Rol botu" -ForegroundColor Green
Write-Host "  bot ID      : $($s.rolBotId)"
Write-Host "  komut ID    : ver=$($s.rolVerKomutId)  al=$($s.rolAlKomutId)"
Write-Host "  komut adi   : ver=$($s.rolVerKomutu)  al=$($s.rolAlKomutu)"

Write-Host ""
Write-Host "Otomatik yoklama" -ForegroundColor Green
if ($s.otoYoklama -and $s.otoYoklama.Count -gt 0) {
    foreach ($y in $s.otoYoklama) { Write-Host "  $y" }
} else {
    Write-Host "  yok"
}

Write-Host ""
Write-Host "Log kanallari" -ForegroundColor Green
$sorunlu = 0
foreach ($c in $s.logKanallari) {
    $satir = "  {0,-6} {1,-13} {2,-20} {3,-8} {4,5} mesaj" -f $c.group, $c.label, $c.channelId, $c.durum, $c.mesaj
    if ($c.hata) {
        Write-Host "$satir  HATA: $($c.hata)" -ForegroundColor Red
        $sorunlu++
    } elseif ($c.durum -ne 'hazir') {
        Write-Host $satir -ForegroundColor Yellow
    } else {
        Write-Host $satir
    }
}

Write-Host ""
if ($sorunlu -gt 0) {
    Write-Host "$sorunlu kanal cekilemedi - kanal ID'si yanlis olabilir ya da bot" -ForegroundColor Yellow
    Write-Host "hesabinin o kanali gorme izni yoktur." -ForegroundColor Yellow
} else {
    Write-Host "Butun kanallar okundu." -ForegroundColor Cyan
}
Write-Host ""
Write-Host "Bir menu panelde gorunmuyor ama yukarida 'hazir' yaziyorsa, sorun" -ForegroundColor DarkGray
Write-Host "sunucuda degil o hesabin YETKISINDEDIR:" -ForegroundColor DarkGray
Write-Host "Ayarlar > Panel Hesaplari > Yetkiler bolumunden kanali isaretle." -ForegroundColor DarkGray
Write-Host ""
