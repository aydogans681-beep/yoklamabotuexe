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
Write-Host "  commit      : $($s.commit)   dal: $($s.dal)"
Write-Host "  baslatildi  : $($s.baslatildi)  ($($s.calismaSuresiSn) sn once)"

# Diskteki kod ile calisan kod ayni mi?
$yerel = $null
$eskiEAP = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try { $yerel = (& git rev-parse --short HEAD 2>$null | Select-Object -First 1) } catch { $yerel = $null }
$ErrorActionPreference = $eskiEAP
$global:LASTEXITCODE = 0
if ($yerel -and $s.commit -and ($yerel.Trim() -ne $s.commit)) {
    Write-Host "  UYARI: diskte $($yerel.Trim()), calisan $($s.commit) - eski surec hala ayakta olabilir." -ForegroundColor Yellow
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
