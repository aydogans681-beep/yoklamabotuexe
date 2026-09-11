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
$ekosistem = Join-Path $kok "ecosystem.config.js"
try {
    if (Test-Path $ekosistem) {
        # guncelle.ps1 ile AYNI yol. Eskiden burada "pm2 restart yoklama"
        # vardi; o komut sureci pm2'nin ESKI kayitli ayarlariyla aciyor ve
        # ecosystem.config.js'i (watch=false, max_restarts, min_uptime ve
        # 12 saatlik cron_restart) gormuyordu.
        Set-Location $kok
        & pm2 startOrRestart $ekosistem --update-env 2>&1 | Out-Null
    } else {
        Set-Location $sunucuDizini
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
    Yaz "Bot ayakta." "Cyan"

    # --- Gercekten YENI kod mu calisiyor? ---
    # "commit" diskteki .git'ten okunuyor: git pull biter bitmez yeni gorunur ve
    # eski kodu bellekte calistiran bir sureci ELE VERMEZ. KOD_SURUMU ise
    # server.js'in ICINDE gomulu - yalnizca surec yeniden basladiginda degisir.
    $diskKod = $null
    try {
        $sj = Join-Path $sunucuDizini 'server.js'
        if (Test-Path $sj) {
            $m = Select-String -Path $sj -Pattern "^const KOD_SURUMU = '([^']+)'" | Select-Object -First 1
            if ($m) { $diskKod = $m.Matches[0].Groups[1].Value }
        }
    } catch { $diskKod = $null }

    Write-Host "   commit     : $($surum.commit)   <- diskteki .git (calisan kodu kanitlamaz)"
    Write-Host "   kod surumu : $($surum.kodSurumu)   (diskte: $diskKod)"
    if ($surum.ozellikler) { Write-Host "   ozellikler : $($surum.ozellikler -join ', ')" }

    if ($diskKod -and $surum.kodSurumu -and ($diskKod -eq $surum.kodSurumu)) {
        Yaz "   -> CALISAN KOD GUNCEL." "Cyan"
    } elseif ($diskKod) {
        Write-Host ""
        Yaz "DIKKAT: Calisan surec ESKI kodu kullaniyor." "Red"
        Yaz "        diskte '$diskKod' ama calisan '$($surum.kodSurumu)'." "Red"
        Yaz "3000 portunu BASKA BIR KLASORDEKI kopya tutuyor olabilir. Kim tutuyor:" "Yellow"
        Yaz "    Get-NetTCPConnection -LocalPort 3000 -State Listen | Select OwningProcess" "Yellow"
        Yaz '    Get-CimInstance Win32_Process -Filter "ProcessId = <PID>" | Select CommandLine' "Yellow"
        Yaz "Cikan yol bu klasor DEGILSE, o sureci kapat:  Stop-Process -Id <PID> -Force" "Yellow"
    }

    # --- Bizim botun kac kopyasi var? ---
    # ONEMLI: pm2'de BASKA uygulamalar da ProcessContainerFork ile calisir.
    # Eskiden onlar da sayiliyor, "hala birden fazla surec" uyarisi bot tek
    # kopyayken bile cikip sonsuz "tekrar calistir" dongusune sokuyordu.
    # Artik yalnizca komut satirinda server.js GECEN (pm2 disi, elle acilmis)
    # kopyalar sayiliyor - gercek hayaletler bunlar.
    $oksuz = @(BotSurecleri | Where-Object { $_.CommandLine -match 'server\.js' })
    if ($oksuz.Count -gt 0) {
        Write-Host ""
        Yaz "UYARI: pm2 disinda elle acilmis $($oksuz.Count) bot sureci var:" "Yellow"
        foreach ($p in $oksuz) {
            Write-Host ("   PID {0}  {1}" -f $p.ProcessId, $p.CommandLine) -ForegroundColor DarkGray
        }
        Yaz "Kapat:  Stop-Process -Id <PID> -Force" "Yellow"
    }

    Write-Host ""
    Yaz "Ayrinti icin:  .\tani.ps1" "DarkGray"
} else {
    Yaz "DIKKAT: bot cevap vermiyor." "Red"
    Yaz "    pm2 logs yoklama --err --lines 30 --nostream" "Yellow"
}
Write-Host ""
