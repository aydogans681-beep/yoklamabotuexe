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
try {
    npm install --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { Write-Host "npm install basarisiz oldu." -ForegroundColor Red; exit 1 }
} finally {
    # Kok klasore geri donuyoruz: betik server\ icinde bitiyordu ve sonrasinda
    # ".\tani.ps1" gibi kokteki dosyalar "not recognized" hatasi veriyordu.
    Set-Location $kok
}

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

    # "pm2 restart" komutu, surec acilir acilmaz olse bile basarili doner.
    # Bir kez bunun yuzunden gozden kacti: baska bir klasordeki oksuz bir
    # kopya 3000 portunu tutuyordu, guncel surec her acilista EADDRINUSE
    # alip oluyordu, ama script "TAMAM" yazip geciyordu ve panelde uc
    # guncelleme boyunca eski kod calisti. Artik gercekten ayakta mi diye
    # bakiyoruz.
    Write-Host "Baslamasi bekleniyor..." -ForegroundColor DarkGray
    Start-Sleep -Seconds 12

    $surum = $null
    try {
        $cevap = Invoke-WebRequest "http://localhost:3000/api/surum" -UseBasicParsing -TimeoutSec 10
        $surum = $cevap.Content | ConvertFrom-Json
    } catch {
        $surum = $null
    }

    if ($surum -and $surum.ok) {
        Write-Host ""
        Write-Host "TAMAM - bot calisiyor." -ForegroundColor Cyan
        Write-Host "   commit    : $($surum.commit)  (dal: $($surum.dal))"
        Write-Host "   rol botu  : $($surum.rolBotId)"
        # Birden fazla zamanlanmis yoklama olabiliyor - hepsini yaz.
        if ($surum.otoYoklama -and $surum.otoYoklama.Count -gt 0) {
            $otoMetin = ($surum.otoYoklama -join ', ')
        } else {
            $otoMetin = 'yok'
        }
        Write-Host "   oto yoklama: $otoMetin"

        # git stderr'e yazarsa ErrorActionPreference='Stop' altinda sonlandirici
        # hataya donusuyor - bu kontrol yuzunden guncelleme patlamasin.
        $yerel = $null
        $eskiEAP2 = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try { $yerel = (& git rev-parse --short HEAD 2>$null | Select-Object -First 1) } catch { $yerel = $null }
        $ErrorActionPreference = $eskiEAP2
        $global:LASTEXITCODE = 0

        if ($yerel -and $surum.commit -and ($yerel.Trim() -ne $surum.commit)) {
            Write-Host ""
            Write-Host "UYARI: Diskteki kod $yerel ama calisan surec $($surum.commit)." -ForegroundColor Yellow
            Write-Host "3000 portunu baska bir kopya tutuyor olabilir. Kontrol et:" -ForegroundColor Yellow
            Write-Host "    Get-NetTCPConnection -LocalPort 3000 -State Listen | Select OwningProcess"
        }
    } else {
        Write-Host ""
        Write-Host "DIKKAT: Bot yeniden baslatildi ama 3000 portundan cevap alinamadi." -ForegroundColor Red
        Write-Host "En sik sebep: baska bir kopya portu tutuyor ve surec EADDRINUSE alip oluyor." -ForegroundColor Yellow
        Write-Host ""
        Write-Host "Sirasiyla su komutlari calistir:" -ForegroundColor Yellow
        Write-Host "    pm2 logs yoklama --err --lines 30 --nostream"
        Write-Host "    pm2 stop yoklama"
        Write-Host "    Get-NetTCPConnection -LocalPort 3000 -State Listen | Select OwningProcess"
        Write-Host ""
        Write-Host "pm2 durdurulmusken hala bir PID cikiyorsa o oksuz bir kopyadir;" -ForegroundColor Yellow
        Write-Host "Stop-Process -Id <PID> -Force ile kapatip 'pm2 start yoklama' de." -ForegroundColor Yellow
    }
    Write-Host ""
    Write-Host "Loglari gormek icin:  pm2 logs yoklama" -ForegroundColor DarkGray
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
    # pm2 yoksa calisan node surecini kendimiz bulup yeniden baslatiyoruz.
    # Elle yeniden baslatmayi unutmak en sik yasanan sorundu: dosyalar
    # guncelleniyor ama surec eski kodu calistirmaya devam ediyor ve panel
    # "Sunucu bu istegi tanimiyor" hatasi veriyordu.
    $nodeSurecleri = @()
    try {
        $nodeSurecleri = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction Stop |
            Where-Object { $_.CommandLine -and $_.CommandLine -match 'server\.js' })
    } catch {
        $nodeSurecleri = @()
    }

    if ($nodeSurecleri.Count -eq 1) {
        $eskiPid = $nodeSurecleri[0].ProcessId
        Write-Host "Calisan bot sureci bulundu (PID $eskiPid), yeniden baslatiliyor..." -ForegroundColor Green
        try {
            Stop-Process -Id $eskiPid -Force -ErrorAction Stop
            Start-Sleep -Seconds 2
            Start-Process -FilePath 'node' -ArgumentList 'server.js' `
                          -WorkingDirectory $sunucuDizini -WindowStyle Minimized
            Start-Sleep -Seconds 3
            Write-Host ""
            Write-Host "TAMAM - bot yeniden baslatildi." -ForegroundColor Cyan
            Write-Host "Yeni pencere simge durumunda acildi. Kapatirsan bot durur -" -ForegroundColor DarkGray
            Write-Host "kalici olmasi icin pm2'ye gecmeni oneririm:" -ForegroundColor DarkGray
            Write-Host "    npm install -g pm2" -ForegroundColor DarkGray
            Write-Host "    cd `"$sunucuDizini`"; pm2 start server.js --name yoklama; pm2 save" -ForegroundColor DarkGray
        } catch {
            Write-Host "Yeniden baslatilamadi: $($_.Exception.Message)" -ForegroundColor Red
            Write-Host "Elle yap:  cd `"$sunucuDizini`"  sonra  node server.js" -ForegroundColor Yellow
        }
    } elseif ($nodeSurecleri.Count -eq 0) {
        Write-Host "TAMAM - dosyalar guncellendi." -ForegroundColor Cyan
        Write-Host "Calisan bot sureci bulunamadi, baslatiliyor..." -ForegroundColor Yellow
        try {
            Start-Process -FilePath 'node' -ArgumentList 'server.js' `
                          -WorkingDirectory $sunucuDizini -WindowStyle Minimized
            Start-Sleep -Seconds 3
            Write-Host "Bot baslatildi." -ForegroundColor Cyan
        } catch {
            Write-Host "Baslatilamadi: $($_.Exception.Message)" -ForegroundColor Red
            Write-Host "Elle yap:  cd `"$sunucuDizini`"  sonra  node server.js" -ForegroundColor Yellow
        }
    } else {
        # Birden fazla node sureci var - hangisinin bot oldugunu bilemeyiz,
        # yanlis olani kapatmaktansa kullaniciya birakiyoruz.
        Write-Host "TAMAM - dosyalar guncellendi." -ForegroundColor Cyan
        Write-Host ""
        Write-Host "Birden fazla node sureci calisiyor, hangisinin bot oldugu belirsiz." -ForegroundColor Yellow
        $nodeSurecleri | ForEach-Object { Write-Host "   PID $($_.ProcessId): $($_.CommandLine)" -ForegroundColor DarkGray }
        Write-Host ""
        Write-Host "Bot penceresini kapatip elle baslat:" -ForegroundColor Yellow
        Write-Host "    cd `"$sunucuDizini`""
        Write-Host "    node server.js"
    }
}
Write-Host ""
