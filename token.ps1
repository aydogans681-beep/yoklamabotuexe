# ============================================================================
# token.ps1 - Discord token'ini config.env'e guvenli sekilde yazar.
#
# Kullanim (PowerShell, bu klasorun icinde):
#     .\token.ps1
#
# Neden gerekiyor: token'i Not Defteri ile elle girmek bes ayri yerde SESSIZCE
# yanlis gidebiliyor ve besi de ayni sonucu veriyor - bot acilir, panel calisir,
# ama Discord girisi olmaz:
#   1. Yanlis klasor. "notepad config.env" komutu server\ icinden calistirilirsa
#      bos bir dosya acilir; gercek dosya depo KOKUNDE durur (server.js
#      ROOT_DIR/config.env okuyor, ROOT_DIR = server\'in bir ustu).
#   2. Yapistirirken basa ya da sona kacan fazladan karakter / bosluk.
#   3. Not Defteri'nin UTF-8 BOM'u: dosyanin ilk anahtari gorunmez bir
#      karakterle basliyor, dotenv onu USER_TOKEN olarak taniyamiyor.
#   4. Token'in suresi dolmus olabiliyor (sifre degisimi, "her yerden cikis")
#      ama bu ancak bot yeniden baslatilip gateway 4004 dondurunce anlasiliyor.
#   5. Dosya duzeltiliyor ama bot yeniden baslatilmiyor - config.env yalnizca
#      acilista okunuyor.
#
# Bu betik besini de kapatiyor: kendi klasorunu kendisi buluyor, girdiyi
# temizliyor, DISKE YAZMADAN ONCE token'i Discord'a sorup gecerli mi diye
# dogruluyor, dosyayi BOM'suz yaziyor ve sonunda botu yeniden baslatiyor.
#
# Token ekrana YAZILMIYOR. Yalnizca uzunlugu, parca boylari ve hesap adi
# gosteriliyor - teshis icin bu yetiyor.
# config.env'deki diger satirlar (WEB_PORT vb.) oldugu gibi korunuyor.
# ============================================================================

$ErrorActionPreference = "Stop"
$kok = Split-Path -Parent $MyInvocation.MyCommand.Path
$dosya = Join-Path $kok "config.env"

function Yaz($m, $r = "Gray") { Write-Host $m -ForegroundColor $r }

Yaz ""
Yaz "=== Discord token ayari ===" "Cyan"
Yaz ""

# --- 1) Dogru klasorde miyiz? ---
# Betik nereden cagrilirsa cagrilsin KENDI klasorunu kullaniyor - "yanlis
# dizindeydim" hatasi bu yuzden mumkun degil. Yine de betigin baska bir yere
# kopyalanmis olma ihtimaline karsi kontrol ediliyor.
if (-not (Test-Path (Join-Path $kok "server\server.js"))) {
    Yaz "Bu betik depo kokunde durmali - server\server.js bulunamadi." "Red"
    Yaz "Bulundugu klasor: $kok" "Yellow"
    exit 1
}
Yaz "Hedef dosya: $dosya" "DarkGray"
Yaz ""

# --- 2) Token'i al ---
Yaz "Token'i yapistirip Enter'a bas (yazdigin ekranda GORUNMEZ):" "Yellow"
$sec = Read-Host -AsSecureString
$token = (New-Object System.Net.NetworkCredential('', $sec)).Password

# Gorunmez karakterleri at: kontrol karakterleri, BOM (U+FEFF) ve
# sifir genislikli bosluklar (U+200B..U+200D). Kopyala-yapistir bunlari
# beraberinde getiriyor ve ekranda hicbir iz birakmadan token'i bozuyorlar.
$token = $token -replace '[\u0000-\u001F\u007F\uFEFF\u200B-\u200D]', ''
$token = $token.Trim().Trim('"').Trim("'").Trim()

if ([string]::IsNullOrWhiteSpace($token)) {
    Yaz ""
    Yaz "Token bos - hicbir sey yazilmadi." "Red"
    exit 1
}

# --- 3) Bicim kontrolu ---
$parcalar = $token.Split('.')
Yaz ""
Yaz "Okunan token" "Green"
Yaz "  uzunluk   : $($token.Length)"
Yaz "  parcalar  : $(($parcalar | ForEach-Object { $_.Length }) -join '/')"

if ($parcalar.Count -ne 3) {
    Yaz ""
    Yaz "Token 3 parcali olmali (id.zaman.imza), $($parcalar.Count) parca bulundu." "Red"
    Yaz "Yapistirma eksik kalmis ya da fazladan karakter kapmis olabilir." "Yellow"
    exit 1
}

# Ilk parca, hesap ID'sinin base64'u. Cozulemiyorsa token'in basina fazladan
# karakter kacmis demektir - gecen sefer basa bir "O" kacmisti ve hata tam
# olarak burada yakalanirdi.
$b64 = $parcalar[0].Replace('-', '+').Replace('_', '/')
while ($b64.Length % 4 -ne 0) { $b64 += '=' }
$hesapId = $null
try {
    $hesapId = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64))
} catch {
    $hesapId = $null
}

if (-not ($hesapId -match '^\d{17,20}$')) {
    Yaz ""
    Yaz "Token'in ilk parcasi bir Discord hesap ID'sine cozulmuyor." "Red"
    Yaz "Bu, basa ya da sona fazladan karakter kactiginda olur." "Yellow"
    Yaz "Token'i bastan kopyalayip yeniden dene." "Yellow"
    exit 1
}
Yaz "  hesap ID  : $hesapId"

# --- 4) Discord kabul ediyor mu? ---
# Diske YAZMADAN once soruluyor. Gecersiz bir token'i dosyaya yazmak, sorunu
# ancak bot yeniden baslatildiginda ve gateway 4004 dondurdugunde fark edilen
# bir hataya cevirir - tam olarak bu betigin engellemek istedigi sey.
Yaz ""
Yaz "Discord'a soruluyor..." "Green"
try {
    # Windows PowerShell 5.1 varsayilan olarak eski TLS deniyor; Discord
    # yalnizca TLS 1.2 kabul ediyor. Bu satir olmadan istek baglanti
    # hatasiyla duser ve gecerli bir token gecersiz sanilirdi.
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
} catch {
    # Cok eski bir .NET ise devam ediyoruz - istek yine de calisabilir.
}

$kullanici = $null
try {
    $kullanici = Invoke-RestMethod -Uri 'https://discord.com/api/v10/users/@me' `
        -Headers @{ Authorization = $token } -TimeoutSec 20
} catch {
    Yaz ""
    Yaz "Discord bu token'i KABUL ETMEDI - dosyaya YAZILMADI." "Red"
    Yaz "  $($_.Exception.Message)" "DarkGray"
    Yaz ""
    Yaz "En sik sebep: token'in suresi dolmus. Sifre degistirmek, 'her yerden" "Yellow"
    Yaz "cikis yap' demek ve Discord'un guvenlik sifirlamasi token'i ANINDA" "Yellow"
    Yaz "gecersiz kilar. Hesabin GUNCEL token'ini alip yeniden dene." "Yellow"
    exit 1
}

Yaz "  kabul edildi -> $($kullanici.username)  (id: $($kullanici.id))" "Green"

if ("$($kullanici.id)" -ne "$hesapId") {
    # Olmasi beklenmez; olursa token'i yanlis ayristirmisiz demektir.
    Yaz "  UYARI: token icindeki ID ($hesapId) ile hesap ID'si farkli." "Yellow"
}

# --- 5) Dosyayi yaz ---
# Mevcut satirlar korunuyor ki WEB_PORT gibi ayarlar silinmesin. Okurken
# -Encoding UTF8 varsa BOM'u temizliyor, biz de BOM'suz geri yaziyoruz -
# yani dosyada eskiden kalma bir BOM varsa bu adim onu da duzeltiyor.
$mevcut = @()
if (Test-Path $dosya) {
    Copy-Item -Path $dosya -Destination "$dosya.yedek" -Force
    $mevcut = @(Get-Content -Path $dosya -Encoding UTF8)
}

$yeniSatir = 'USER_TOKEN="' + $token + '"'
$cikti = @()
$yazildi = $false
foreach ($s in $mevcut) {
    if ($s -match '^\s*USER_TOKEN\s*=') {
        # Ayni anahtardan birden fazlasi varsa yalnizca ilki korunuyor:
        # dotenv SONUNCUYU okur, yani geride kalan eski bir satir yenisini
        # sessizce ezerdi.
        if (-not $yazildi) {
            $cikti += $yeniSatir
            $yazildi = $true
        }
    } else {
        $cikti += $s
    }
}
if (-not $yazildi) { $cikti = @($yeniSatir) + $cikti }

$portVar = $false
foreach ($s in $cikti) { if ($s -match '^\s*WEB_PORT\s*=') { $portVar = $true } }
if (-not $portVar) { $cikti += "WEB_PORT=3000" }

# BOM'suz UTF-8. Set-Content -Encoding UTF8 (PowerShell 5.1) BOM ekler ve
# dosyanin ILK anahtarini dotenv icin okunamaz hale getirir.
$metin = ($cikti -join "`r`n") + "`r`n"
[System.IO.File]::WriteAllText($dosya, $metin, (New-Object System.Text.UTF8Encoding($false)))

Yaz ""
Yaz "config.env yazildi." "Green"
if (Test-Path "$dosya.yedek") { Yaz "Onceki hali: config.env.yedek" "DarkGray" }

# --- 6) Yeniden baslat ---
# config.env yalnizca acilista okunuyor; yeniden baslatmadan degisiklik gecmez.
Yaz ""
$cevap = Read-Host "Botu simdi yeniden baslatayim mi? (E/h)"
if ($cevap -eq '' -or $cevap -match '^[eEyY]') {
    $temizle = Join-Path $kok "temizle.ps1"
    if (Test-Path $temizle) {
        Yaz ""
        & $temizle
    } else {
        # temizle.ps1 depoda takipli, yani normalde buraya dusulmez. Yine de
        # pm2 kurulu degilse "Stop" tercihi yuzunden ciplak bir yigin hatasi
        # verirdi - ne yapilacagini soyleyen bir mesaj daha faydali.
        try {
            & pm2 restart yoklama
        } catch {
            Yaz "pm2 calistirilamadi: $($_.Exception.Message)" "Red"
            Yaz "Botu elle yeniden baslat - token dosyaya YAZILDI." "Yellow"
        }
    }
    Yaz ""
    Yaz "Kontrol icin:" "Cyan"
    Yaz "    .\tani.ps1"
    Yaz "    pm2 logs yoklama --lines 20 --nostream"
    Yaz ""
    Yaz "Aranan satir: [Baglanti] Giris yapildi (ready olayi): ..." "DarkGray"
} else {
    Yaz ""
    Yaz "Degisikligin gecerli olmasi icin botu yeniden baslat:" "Yellow"
    Yaz "    .\temizle.ps1"
}
Yaz ""
