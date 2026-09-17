# ============================================================================
#  YENI SUNUCU KURULUMU - sifirdan bir Windows VDS'i calisir hale getirir.
#
#  YONETICI olarak acilmis PowerShell'de calistir.
#
#  Yaptiklari:
#    1. Node.js kurulu mu bakar, degilse son LTS surumunu kurar
#    2. Git kurulu mu bakar, degilse kurar
#    3. Depoyu klonlar
#    4. npm install
#    5. pm2 kurar + sunucu yeniden baslayinca bot kendiliginden acilsin diye
#       Windows hizmeti olarak kaydeder
#    6. Panel portunu guvenlik duvarinda acar
#
#  Sonrasinda ekrana yazacagi 3 komutu sirayla calistiracaksin (hesap, token,
#  baslat) - onlar soru sordugu icin bu betige konmadi.
# ============================================================================

param(
    [string]$Klasor = 'C:\yoklama',
    [string]$Depo   = 'https://github.com/aydogans681-beep/yoklamabotuexe.git',
    [string]$Dal    = 'claude/yoklama-botu-8hxx8w',
    [int]$Port      = 3000
)

$ErrorActionPreference = 'Stop'

function Baslik($metin) {
    Write-Host ""
    Write-Host "  == $metin" -ForegroundColor Cyan
}
function Tamam($metin) { Write-Host "     $metin" -ForegroundColor Green }
function Bilgi($metin) { Write-Host "     $metin" -ForegroundColor DarkGray }
function Uyari($metin) { Write-Host "     $metin" -ForegroundColor Yellow }

# --- Yonetici mi? ---
$kimlik = [Security.Principal.WindowsIdentity]::GetCurrent()
$yetki = New-Object Security.Principal.WindowsPrincipal($kimlik)
if (-not $yetki.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host ""
    Write-Host "  Bu betik YONETICI olarak calistirilmali." -ForegroundColor Red
    Write-Host "  Baslat menusunde PowerShell'e sag tikla > 'Yonetici olarak calistir'." -ForegroundColor Yellow
    Write-Host ""
    exit 1
}

# TLS 1.2: eski Windows Server'larda indirmeler bunsuz sessizce basarisiz oluyor.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# PATH'i tazeler. Kurulumdan sonra AYNI oturumda 'node'/'git' bulunamamasi
# klasik tuzak: kurulum PATH'i makine genelinde degistiriyor ama acik olan
# PowerShell eski kopyayla calismaya devam ediyor.
function PathTazele {
    $makine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $kullanici = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = "$makine;$kullanici"
}

function KomutVar($ad) {
    return [bool](Get-Command $ad -ErrorAction SilentlyContinue)
}

# git/npm gibi YERLI komutlarin basarisizligini PowerShell kendiliginden hata
# saymiyor: npm install coker, betik akip gider ve "KURULUM TAMAM" yazar, sonra
# bot acilmaz. Cikis kodunu acikca denetliyoruz.
function CikisKontrol($ne) {
    if ($LASTEXITCODE -ne 0) { throw "$ne basarisiz oldu (cikis kodu $LASTEXITCODE)." }
}

# --- 1) Node.js ---
Baslik 'Node.js'
if (KomutVar 'node') {
    Tamam "zaten kurulu: $(node -v)"
} else {
    Bilgi 'kurulu degil, son LTS indiriliyor...'
    # Surum numarasini elle yazmiyoruz: bir sure sonra o surum kaybolur ve
    # betik "404" verip durur. Node'un kendi listesinden guncel LTS aliniyor.
    $liste = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -UseBasicParsing
    $lts = ($liste | Where-Object { $_.lts } | Select-Object -First 1).version
    if (-not $lts) { throw 'Node LTS surumu bulunamadi.' }
    $msi = Join-Path $env:TEMP "node-$lts-x64.msi"
    Bilgi "surum: $lts"
    Invoke-WebRequest -Uri "https://nodejs.org/dist/$lts/node-$lts-x64.msi" -OutFile $msi -UseBasicParsing
    Start-Process msiexec.exe -ArgumentList "/i `"$msi`" /qn /norestart" -Wait
    Remove-Item $msi -Force -ErrorAction SilentlyContinue
    PathTazele
    if (-not (KomutVar 'node')) { throw 'Node kuruldu ama bulunamadi. PowerShell''i kapatip yeniden ac ve betigi tekrar calistir.' }
    Tamam "kuruldu: $(node -v)"
}

# --- 2) Git ---
Baslik 'Git'
if (KomutVar 'git') {
    Tamam "zaten kurulu: $((git --version))"
} else {
    Bilgi 'kurulu degil, indiriliyor...'
    $surum = Invoke-RestMethod -Uri 'https://api.github.com/repos/git-for-windows/git/releases/latest' `
        -UseBasicParsing -Headers @{ 'User-Agent' = 'yoklama-kurulum' }
    $varlik = $surum.assets | Where-Object { $_.name -like '*64-bit.exe' } | Select-Object -First 1
    if (-not $varlik) { throw 'Git indirme baglantisi bulunamadi.' }
    $exe = Join-Path $env:TEMP $varlik.name
    Invoke-WebRequest -Uri $varlik.browser_download_url -OutFile $exe -UseBasicParsing
    Start-Process $exe -ArgumentList '/VERYSILENT /NORESTART /NOCANCEL /SP-' -Wait
    Remove-Item $exe -Force -ErrorAction SilentlyContinue
    PathTazele
    if (-not (KomutVar 'git')) { throw 'Git kuruldu ama bulunamadi. PowerShell''i kapatip yeniden ac ve betigi tekrar calistir.' }
    Tamam 'kuruldu'
}

# --- 3) Depo ---
Baslik 'Depo'
if (Test-Path (Join-Path $Klasor 'server\server.js')) {
    Tamam "zaten var: $Klasor"
    Bilgi 'guncelleniyor...'
    git -C $Klasor fetch origin $Dal
    git -C $Klasor checkout $Dal
    git -C $Klasor pull origin $Dal
} else {
    if (Test-Path $Klasor) {
        $dolu = @(Get-ChildItem -LiteralPath $Klasor -Force).Count
        if ($dolu -gt 0) { throw "$Klasor dolu ama icinde proje yok. Baska bir klasor sec: -Klasor C:\yoklama2" }
        Remove-Item -LiteralPath $Klasor -Force
    }
    Bilgi "klonlaniyor -> $Klasor"
    git clone -b $Dal $Depo $Klasor
    CikisKontrol 'git clone'
    Tamam 'klonlandi'
}

# --- 4) Bagimliliklar ---
Baslik 'npm install'
Push-Location (Join-Path $Klasor 'server')
try {
    npm install --no-audit --no-fund
    CikisKontrol 'npm install'
    Tamam 'paketler kuruldu'
} finally {
    Pop-Location
}

# --- 5) pm2 ---
Baslik 'pm2'
if (KomutVar 'pm2') {
    Tamam 'zaten kurulu'
} else {
    npm install -g pm2 --no-audit --no-fund
    CikisKontrol 'pm2 kurulumu'
    PathTazele
    Tamam 'kuruldu'
}
# Sunucu yeniden baslayinca bot kendiliginden acilsin. VDS'ler guncelleme
# icin yeniden basliyor; bu olmadan bot sessizce kapali kaliyor.
if (-not (KomutVar 'pm2-startup')) {
    try {
        npm install -g pm2-windows-startup --no-audit --no-fund
        PathTazele
        pm2-startup install
        Tamam 'yeniden baslatmada otomatik acilma kuruldu'
    } catch {
        Uyari 'otomatik acilma kurulamadi - bot calisir ama sunucu yeniden baslarsa elle acman gerekir'
    }
} else {
    Tamam 'otomatik acilma zaten kurulu'
}

# --- 6) Guvenlik duvari ---
Baslik "Guvenlik duvari (port $Port)"
$kural = "Yoklama Paneli $Port"
try {
    if (Get-NetFirewallRule -DisplayName $kural -ErrorAction SilentlyContinue) {
        Tamam 'kural zaten var'
    } else {
        New-NetFirewallRule -DisplayName $kural -Direction Inbound -Protocol TCP `
            -LocalPort $Port -Action Allow -Profile Any | Out-Null
        Tamam 'port acildi'
    }
} catch {
    Uyari "port acilamadi: $($_.Exception.Message)"
    Uyari "bot yine calisir; panele disaridan girilemezse bu kurali elle ekle."
}

# --- Bitti ---
# DIKKAT: "$x = try {...} catch {...}" yalnizca PowerShell 7'de gecerli.
# Yeni bir Windows Server'da 5.1 var ve orada bu AYRISTIRMA HATASI veriyor -
# yani betik hic calismiyor. Klasik ayri atama kullaniyoruz.
$ip = $null
try {
    $ip = (Invoke-RestMethod -Uri 'https://api.ipify.org?format=json' -UseBasicParsing -TimeoutSec 8).ip
} catch {
    $ip = $null
}

Write-Host ""
Write-Host "  KURULUM TAMAM." -ForegroundColor Cyan
Write-Host ""
Write-Host "  Simdi sirayla su 3 komutu calistir:" -ForegroundColor White
Write-Host ""
Write-Host "    cd $Klasor" -ForegroundColor Yellow
Write-Host "    node ilk-hesap.js        " -NoNewline -ForegroundColor Yellow
Write-Host "# panel kullanici adi + sifre belirle" -ForegroundColor DarkGray
Write-Host "    .\token.ps1              " -NoNewline -ForegroundColor Yellow
Write-Host "# Discord token'ini KOPYALA, sonra bunu calistir" -ForegroundColor DarkGray
Write-Host "    .\temizle.ps1            " -NoNewline -ForegroundColor Yellow
Write-Host "# botu baslatir" -ForegroundColor DarkGray
Write-Host ""
if ($ip) {
    Write-Host "  Panel adresi: http://${ip}:$Port" -ForegroundColor White
} else {
    Write-Host "  Panel adresi: http://<sunucu-ip>:$Port" -ForegroundColor White
}
Write-Host ""
Write-Host "  Eski yedegin varsa 'node ilk-hesap.js' YERINE:" -ForegroundColor DarkGray
Write-Host "    .\yedek-geri-yukle.ps1 C:\yol\yoklama-yedek-....zip" -ForegroundColor DarkGray
Write-Host ""
