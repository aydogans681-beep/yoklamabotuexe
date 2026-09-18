# Rozet Tarayıcı (.exe)

Çift tıkla çalışır → tarayıcıda panel açılır → **token'ı yapıştır**, **davet linkini**
gir, **Tara** de → o sunucudaki üyelerin **nadir Discord rozetlerini** listeler.

- **Hesap (kullanıcı) token'ı** taramayı yapar (zorunlu).
- **Bot token'ı** isteğe bağlı — Discord içinde `/goster` slash komutu da istersen.

## ⚠️ RİSK
Kullanıcı hesabının otomatik sunucuya girip üye taraması **Discord ToS ihlalidir**;
hesap **banlanabilir**. **Ana hesabını KULLANMA.** Nitro/boost/Quest/Orb rozetleri
API'de yok → hiçbir bot/hesap göremez. Okunanlar: Staff, Partner, Bug Hunter 1/2,
HypeSquad Events, Erken Destekçi, Aktif Geliştirici, Erken Doğrulanmış Bot
Geliştirici, Moderatör Programı Mezunu.

## .exe nasıl elde edilir?

> Not: .exe **Windows'ta** derlenmeli (Linux'ta pkg Windows binary'si üretemiyor).
> Aşağıdaki iki yoldan biri:

### Yol 1 — Kendi Windows bilgisayarında (Node bir kereliğine gerekir)
1. [Node.js](https://nodejs.org) kur (LTS).
2. Bu klasörde:
   ```bash
   npm install
   npm run build
   ```
3. `dist\RozetTarayici.exe` oluşur. Artık **Node olmadan** çift tıklayıp çalıştırırsın
   (exe'yi başka bilgisayara da taşıyabilirsin). Yanında oluşan `config.json`'da
   token'ların saklanır — o dosyayı kimseyle paylaşma.

### Yol 2 — GitHub Actions ile otomatik (bilgisayarına Node kurmadan)
1. Bu projeyi bir GitHub reposuna at (`main` dalı).
2. Repo → **Actions** sekmesi → `exe-derle` çalışması biter → **Artifacts**'tan
   `RozetTarayici-exe`'yi indir. (Windows runner exe'yi senin yerine derler.)

## Çalıştırınca
- Panel `http://localhost:3000`'de açılır.
- **1) Token & Ayarlar:** hesap token'ını yapıştır, izinli ID'leri gir, **Kaydet & Bağlan**.
- **2) Tara:** davet linkini yapıştır → **Tara** → nadir rozetli üyeler listelenir.

## Geliştirme / test
```bash
npm install
npm start      # paneli Node ile çalıştır (localhost:3000)
npm test       # saf mantık testleri (Discord gerektirmez)
```
