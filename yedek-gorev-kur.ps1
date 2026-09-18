# ============================================================================
#  HAFTALIK OTOMATIK YEDEK - Windows Zamanlanmis Gorev olarak kurar.
#
#  Bir VDS'in suresi dolunca elde yedek olmamasi pahaliya mal oluyor.
#  Bu gorev her hafta yedek-al.ps1'i calistirip zip uretiyor.
#
#  YONETICI PowerShell'de calistir:  .\yedek-gorev-kur.ps1
#  Kaldirmak icin:                   .\yedek-gorev-kur.ps1 -Kaldir
# ============================================================================

param(
    [string]$Klasor = 'C:\yoklama-yedek',   # zip'lerin birikecegi yer
    [int]$Gun = 1,                          # 1=Pazartesi ... 7=Pazar
    [string]$Saat = '05:00',
    [int]$Sakla = 8,                        # kac yedek saklansin
    [switch]$Kaldir
)

$ErrorActionPreference = 'Stop'
$gorevAdi = 'Yoklama Haftalik Yedek'

$kimlik = [Security.Principal.WindowsIdentity]::GetCurrent()
$yetki = New-Object Security.Principal.WindowsPrincipal($kimlik)
if (-not $yetki.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "  Bu betik YONETICI olarak calistirilmali." -ForegroundColor Red
    exit 1
}

if ($Kaldir) {
    if (Get-ScheduledTask -TaskName $gorevAdi -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $gorevAdi -Confirm:$false
        Write-Host "  Gorev kaldirildi." -ForegroundColor Green
    } else {
        Write-Host "  Boyle bir gorev yok." -ForegroundColor DarkGray
    }
    exit 0
}

$kok = Split-Path -Parent $MyInvocation.MyCommand.Path
$betik = Join-Path $kok 'yedek-al.ps1'
if (-not (Test-Path -LiteralPath $betik)) {
    Write-Host "  yedek-al.ps1 bulunamadi: $betik" -ForegroundColor Red
    exit 1
}

New-Item -ItemType Directory -Force -Path $Klasor | Out-Null

# Eski yedekleri temizleyen sarmalayici. Yedek klasoru yillar icinde
# sessizce diski doldurmasin diye son N tanesi saklaniyor.
$sarmal = Join-Path $kok 'yedek-gorev-calistir.ps1'
@"
# Zamanlanmis gorev bunu calistiriyor. Elle duzenleme - yedek-gorev-kur.ps1
# her calistiginda bu dosyayi yeniden yaziyor.
& '$betik' -Hedef '$Klasor'
Get-ChildItem -LiteralPath '$Klasor' -Filter 'yoklama-yedek-*.zip' |
    Sort-Object LastWriteTime -Descending |
    Select-Object -Skip $Sakla |
    Remove-Item -Force -ErrorAction SilentlyContinue
"@ | Set-Content -Path $sarmal -Encoding UTF8

$eylem = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$sarmal`""
$tetik = New-ScheduledTaskTrigger -Weekly -DaysOfWeek ([DayOfWeek]$($Gun % 7)) -At $Saat
# S4U: sifre saklamadan, kullanici oturum acmamis olsa bile calisir.
$kimlikAyari = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType S4U -RunLevel Highest
$ayar = New-ScheduledTaskSettingsSet -StartWhenAvailable `
    -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries

if (Get-ScheduledTask -TaskName $gorevAdi -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $gorevAdi -Confirm:$false
}
# S4U bazi kurulumlarda "Log on as a batch job" hakki olmadigi icin
# reddediliyor. Sessizce yedeksiz kalmamak icin SYSTEM'e dusuyoruz: zip
# klasoru zaten -Hedef ile acikca veriliyor, masaustu yoluna bagli degil.
try {
    Register-ScheduledTask -TaskName $gorevAdi -Action $eylem -Trigger $tetik `
        -Principal $kimlikAyari -Settings $ayar `
        -Description 'Yoklama botunun uretilmis verilerini haftalik yedekler.' | Out-Null
} catch {
    Write-Host "  Kullanici hesabiyla kurulamadi ($($_.Exception.Message))" -ForegroundColor Yellow
    Write-Host "  SYSTEM olarak deneniyor..." -ForegroundColor DarkGray
    $sistem = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    Register-ScheduledTask -TaskName $gorevAdi -Action $eylem -Trigger $tetik `
        -Principal $sistem -Settings $ayar `
        -Description 'Yoklama botunun uretilmis verilerini haftalik yedekler.' | Out-Null
    Write-Host "  SYSTEM olarak kuruldu." -ForegroundColor Green
}

# Kurulan gorev GERCEKTEN duruyor mu? Register sessizce basarisiz olursa
# kullanici yedegi var sanip yedeksiz kalir.
$dogrula = Get-ScheduledTask -TaskName $gorevAdi -ErrorAction SilentlyContinue
if (-not $dogrula) {
    Write-Host "  GOREV KURULAMADI - yedek otomatik alinmayacak." -ForegroundColor Red
    Write-Host "  Haftada bir elle calistir: .\yedek-al.ps1" -ForegroundColor Yellow
    exit 1
}

Write-Host ""
Write-Host "  Haftalik yedek gorevi kuruldu." -ForegroundColor Green
Write-Host "    Ne zaman : her hafta $([DayOfWeek]$($Gun % 7)) $Saat" -ForegroundColor DarkGray
Write-Host "    Nereye   : $Klasor" -ForegroundColor DarkGray
Write-Host "    Saklanan : son $Sakla yedek" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  Hemen bir kez denemek icin:" -ForegroundColor White
Write-Host "    Start-ScheduledTask -TaskName '$gorevAdi'" -ForegroundColor Yellow
Write-Host ""
Write-Host "  NOT: zip'ler SUNUCUDA duruyor. Sunucu giderse onlar da gider -" -ForegroundColor Yellow
Write-Host "  ara sira kendi bilgisayarina indir." -ForegroundColor Yellow
Write-Host ""
