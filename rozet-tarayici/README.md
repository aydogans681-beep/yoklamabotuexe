# Rozet Tarayıcı (.exe)

Çift tıkla çalışır → **kendi penceresinde** açılır (tarayıcı/web sitesi DEĞİL) →
**token'ı yapıştır**, **davet linkini** gir, **Tara** de → o sunucudaki üyelerin
**nadir Discord rozetlerini** listeler.

- **Hesap (kullanıcı) token'ı** taramayı yapar (zorunlu).
- **Bot token'ı** isteğe bağlı — Discord içinde `/goster` slash komutu da istersen.

## ⚠️ RİSK
Kullanıcı hesabının otomatik sunucuya girip üye taraması **Discord ToS ihlalidir**;
hesap **banlanabilir**. **Ana hesabını KULLANMA.** Nitro/boost/Quest/Orb rozetleri
API'de yok → hiçbir bot/hesap göremez. Okunanlar: Staff, Partner, Bug Hunter 1/2,
HypeSquad Events, Erken Destekçi, Aktif Geliştirici, Erken Doğrulanmış Bot
Geliştirici, Moderatör Programı Mezunu.

## .exe nasıl elde edilir?

> Not: .exe **Windows'ta** derlenir (electron-builder). En kolay yol GitHub Actions.

### Yol 1 — GitHub Actions ile otomatik (bilgisayarına hiçbir şey kurmadan) ✅
1. Bu repoya push edilince `rozet-exe-derle` çalışması otomatik başlar.
2. Bitince repo → **Releases** → `Rozet Tarayıcı (exe)` sürümündeki
   `RozetTarayici.exe`'yi **tek tıkla** indir. (Windows runner exe'yi senin
   yerine derler; telefondan bile indirilir.)

### Yol 2 — Kendi Windows bilgisayarında (Node bir kereliğine gerekir)
1. [Node.js](https://nodejs.org) kur (LTS).
2. Bu klasörde:
   ```bash
   npm install
   npm run build
   ```
3. `dist\RozetTarayici.exe` (portable, tek dosya) oluşur. Artık **Node olmadan**
   çift tıklayıp çalıştırırsın; exe'yi başka bilgisayara da taşıyabilirsin.

## Çalıştırınca
- Uygulama **kendi penceresinde** açılır (web sitesi açılmaz).
- **1) Token & Ayarlar:** hesap token'ını yapıştır, izinli ID'leri gir, **Kaydet & Bağlan**.
- **2) Tara:** davet linkini yapıştır → **Tara** → nadir rozetli üyeler listelenir.
- Token'ların, işletim sistemindeki uygulama verisi klasöründe (`config.json`)
  saklanır — o dosyayı kimseyle paylaşma.

## Geliştirme / test
```bash
npm install
npm start      # uygulamayı Electron ile aç (kendi penceresi)
npm test       # saf mantık testleri (Discord gerektirmez)
```
