# ============================================================================
# temizle.ps1 - Botun TEK kopya halinde temiz calismasini saglar.
#
# Kullanim (PowerShell, bu klasorun icinde):
#     .\temizle.ps1
#
# Neden gerekiyor: eskiden portu alamayan kopyalar olmuyor, Discord baglantisi
# canli halde ayakta kaliyordu. Bu "hayalet" kopyalar ticket'a ayri mesaj
# atiyor, yoklamada ayri rol veriyor ve panele ESKI kodla cevap veriyordu.
# Yeni surum yeni hayalet olusmasini engelliyor ama HALIHAZIRDA calisanlari
# oldurmuyor - bu betik onlari temizliyor.
#
# pm2 daemon'una DOKUNMAZ; yalnizca server.js calistiran surecleri hedefler.
# ============================================================================

$ErrorActionPreference = "Stop"
$kok = Split-Path -Parent $MyInvocation.MyCommand.Path
$sunucuDizini = Join-Path $kok "server"

function Yaz($m, $r = "Gray") { Write-Host $m -ForegroundColor $r }

Write-Host ""
Yaz "=== Bot temizligi ===" "Cyan"
Write-Host ""

# --- 1) Ortalikta ne var? ---
function BotSurecleri {
    try {
        return @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction Stop |
            Where-Object {
                $_.CommandLine -and
                # pm2'nin kendi daemon'unu ve yardimci sureclerini HARIC tut
                $_.CommandLine -notmatch 'pm2[\\/]lib[\\/]Daemon' -and
                ($_.CommandLine -match 'server\.js' -or $_.CommandLine -match 'ProcessContainerFork')
            })
    } catch {
        return @()
    }
}

$once = BotSurecleri
Yaz "[1/4] Calisan bot surecleri: $($once.Count)" "Green"
foreach ($p in $once) {
    Write-Host ("   PID {0}" -f $p.ProcessId)
}

# --- 2) pm2'yi durdur ---
Write-Host ""
Yaz "[2/4] pm2 'yoklama' durduruluyor..." "Green"
$eskiEAP = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
& pm2 stop yoklama 2>&1 | Out-Null
$ErrorActionPreference = $eskiEAP
$global:LASTEXITCODE = 0
Start-Sleep -Seconds 3

# --- 3) Port hala tutuluyorsa o bir hayalettir ---
Write-Host ""
Yaz "[3/4] 3000 portu kontrol ediliyor..." "Green"
$tutanlar = @()
try {
    $tutanlar = @(Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue)
} catch {
    $tutanlar = @()
}

if ($tutanlar.Count -eq 0) {
    Yaz "   Port bos - hayalet surec yok." "Cyan"
} else {
    foreach ($t in $tutanlar) {
        $pid2 = $t.OwningProcess
        # pm2 durduruldugu halde portu tutan surec = hayalet
        $bilgi = $null
        try {
            # -First 1: dizi donerse ".CommandLine -match" boolean yerine
            # eslesenlerin dizisini doner ve her zaman "dogru" gorunur -
            # daemon olmayan bir sureci daemon sanip atlardik.
            $bilgi = Get-CimInstance Win32_Process -Filter "ProcessId = $pid2" -ErrorAction SilentlyContinue |
                Select-Object -First 1
        } catch { $bilgi = $null }

        if ($bilgi -and [string]$bilgi.CommandLine -match 'pm2[\\/]lib[\\/]Daemon') {
            Yaz "   PID $pid2 pm2 daemon'u - DOKUNULMUYOR." "Yellow"
            continue
        }
        Yaz "   PID $pid2 pm2 durdurulmusken hala portu tutuyor - hayalet, kapatiliyor." "Yellow"
        try {
            Stop-Process -Id $pid2 -Force -ErrorAction Stop
            Yaz "   PID $pid2 kapatildi." "Cyan"
        } catch {
            Yaz "   PID $pid2 kapatilamadi: $($_.Exception.Message)" "Red"
        }
    }
    Start-Sleep -Seconds 2
}

# --- 3b) Portu TUTMAYAN hayaletler ---
# Baglanamayan kopyalar portu hic almiyor, yani port kontrolu onlari kacirir.
# Ticket'a fazladan mesaj atanlar tam olarak bunlar. pm2 durdurulmusken ayakta
# kalan her bot sureci hayalettir - ama pm2'de BASKA uygulamalar da olabilir ve
# ProcessContainerFork komut satirinda hangi betigi calistirdigini yazmiyor.
# Bu yuzden korukorune oldurmuyoruz, listeleyip ONAY istiyoruz.
Write-Host ""
$kalanlar = BotSurecleri
if ($kalanlar.Count -gt 0) {
    Yaz "[3b] pm2 durdurulmusken hala $($kalanlar.Count) bot sureci ayakta:" "Yellow"
    foreach ($p in $kalanlar) {
        Write-Host ("   PID {0}  {1}" -f $p.ProcessId, $p.CommandLine)
    }
    Write-Host ""
    Yaz "Bunlar hayalet kopyalardir. pm2'de BASKA uygulamalarin varsa" "Yellow"
    Yaz "onlarin surecleri de bu listede olabilir - once bak, sonra onayla." "Yellow"
    $cevap = Read-Host "Hepsini kapatayim mi? (e/h)"
    if ($cevap -eq 'e' -or $cevap -eq 'E') {
        foreach ($p in $kalanlar) {
            try {
                Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop
                Yaz "   PID $($p.ProcessId) kapatildi." "Cyan"
            } catch {
                Yaz "   PID $($p.ProcessId) kapatilamadi: $($_.Exception.Message)" "Red"
            }
        }
        Start-Sleep -Seconds 2
    } else {
        Yaz "   Atlandi - hayaletler ayakta kaliyor." "DarkGray"
    }
}

# --- 4) Temiz baslat ---
Write-Host ""
Yaz "[4/4] Bot baslatiliyor..." "Green"
$ErrorActionPreference = 'Continue'
Set-Location $sunucuDizini
try {
    & pm2 describe yoklama 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) {
        & pm2 restart yoklama 2>&1 | Out-Null
    } else {
        & pm2 start server.js --name yoklama --node-args="--max-old-space-size=4096" 2>&1 | Out-Null
    }
    & pm2 save 2>&1 | Out-Null
} finally {
    Set-Location $kok
    $ErrorActionPreference = $eskiEAP
    $global:LASTEXITCODE = 0
}

Yaz "   Baslamasi bekleniyor..." "DarkGray"
Start-Sleep -Seconds 15

$surum = $null
try {
    $surum = (Invoke-WebRequest "http://localhost:3000/api/surum" -UseBasicParsing -TimeoutSec 10).Content | ConvertFrom-Json
} catch {
    $surum = $null
}

Write-Host ""
if ($surum -and $surum.ok) {
    Yaz "TAMAM - bot tek kopya calisiyor." "Cyan"
    Write-Host "   commit : $($surum.commit)"
    $sonra = BotSurecleri
    Write-Host "   surec  : $($sonra.Count)"
    if ($sonra.Count -gt 1) {
        Write-Host ""
        Yaz "UYARI: hala birden fazla surec gorunuyor. Tekrar .\temizle.ps1 calistir." "Yellow"
    }
    Write-Host ""
    Yaz "Simdi .\tani.ps1 ile kanallara bakabilirsin." "DarkGray"
} else {
    Yaz "DIKKAT: bot cevap vermiyor." "Red"
    Yaz "    pm2 logs yoklama --err --lines 30 --nostream" "Yellow"
}
Write-Host ""
