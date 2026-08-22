# MD PvP Yoklama Botu - Web Paneli

Discord sunucusundaki yetkililerin ses kanalında olup olmadığını denetleyen,
mazeretlerine göre kademeli uyarı rolü veren web paneli. Masaüstü (Electron)
sürümünün sunucuda 7/24 çalışan, tarayıcıdan erişilen karşılığı.

> Not: Bu panel bir **kullanıcı hesabı token'ı** ile çalışır (selfbot).
> Selfbot kullanımı Discord'un kullanım şartlarına aykırıdır ve tespit
> edilirse hesap kapatılabilir.

## Kurulum

```bash
cd server
npm install
```

Depo kökünde `config.env` oluştur (`config.env.example` dosyasını kopyala):

```
USER_TOKEN="discord-kullanici-token"
WEB_PORT=3000          # istege bagli, varsayilan 3000
```

Çalıştır:

```bash
cd server
npm start
```

Panel `http://localhost:3000` adresinde açılır.

### Önemli: gizli dosyalar

`config.env`, `panel-auth.json` ve `warning-history.json` **`.gitignore`'da** —
token ve şifre hash'leri asla depoya girmez. Sunucuda elle oluşturulur.

## Dizin yapısı

```
config.env            GİZLİ - Discord token'ı (depoda yok)
panel-auth.json       GİZLİ - panel hesapları (depoda yok)
warning-history.json  Uyarı geçmişi (depoda yok, masaüstü sürümüyle paylaşılır)
server/
  server.js           Backend: Discord istemcisi + HTTP/WebSocket API
  public/             Ön yüz (index.html, app.js, style.css)
```

`server/server.js` içindeki `ROOT_DIR`, `server/`'ın **bir üstünü** işaret eder;
paylaşılan dosyalar (token, hesaplar, uyarı geçmişi) orada durur. Masaüstü
sürümü aynı dosyaları okur.

## Sekmeler

### Yoklama

- **Taramayı Başlat** - yetkili rollerindeki herkesi listeler, kim seste kim
  değil gösterir; seste olmayanların günlük (24 saat) ve uzun (7 gün) mazeret
  mesajlarını tepkileriyle birlikte getirir.
- **Panoya Kopyala** - tarama sonucunu düz metin rapor olarak kopyalar.
- **Yoklamayı Al!** - tarama yapar ve seste olmayanları mazeret tepkilerine
  göre ayırır:

  | Durum | Sonuç |
  |---|---|
  | Seste | Uyarı yok |
  | Mazerette ✅ | Uyarı yok |
  | Mazerette ❌ | **Uyarı** |
  | Mazeret var, tepki yok | **Uyarı** |
  | Mazeret yok | **Uyarı** |

  Günlük ve uzun mazeretten **birinde bile ✅ varsa** uyarı yazılmaz.
  Uyarılar doğrudan uygulanmaz: önce kimin ne alacağını gösteren bir önizleme
  penceresi açılır, onaydan sonra sırayla uygulanır.
- **Toplu Uyarı** - elle seçilen kişilere uyarı verme / geri alma.
- **Acil Toplantı** - sesteki tüm yetkilileri kendi ses kanalına çeker.

Uyarı merdiveni: `Sözlü Uyarı → 1x → 2x → 3x`. Roller doğrudan verilmez;
komut kanalına rol botuna `/rol-ver` (geri alma için `/rol-al`) slash komutu
gönderilir.

### TX Logs

Log kanallarının **tüm geçmişi**, sunucu Discord'a bağlanır bağlanmaz arka
planda çekilip bellekte tutulur; panele girildiğinde veri hazırdır. Sekme
açıkken yeni gelen log mesajları canlı olarak eklenir.

Menüler: Ban, Unban, Kick, Warn, DM, Duyuru, Revive.
Her menüde 100'erli sayfalama ve içerik + embed üzerinde arama var.

**Kanal ID'si eklemek:** `server/server.js` içindeki `LOG_CHANNELS` listesine
yaz. ID'si boş bırakılan menü arayüzde "ID yok" olarak görünür ve veri çekmez.

### Ayarlar

- **Kendi Hesabım** - mevcut şifreyle doğrulayarak kullanıcı adı ve/veya şifre
  değiştirme. Değişiklikten sonra o hesabın diğer tüm oturumları düşer.
- **Panel Hesapları** - birden fazla panel hesabı ekleme/silme. Son hesap
  silinemez.

`panel-auth.json` biçimi:

```json
{
  "username": "...", "salt": "...", "hash": "...",
  "users": [ { "username": "...", "salt": "...", "hash": "...", "createdAt": 0 } ]
}
```

Üstteki `username`/`salt`/`hash` alanları **listedeki ilk hesabın aynasıdır** ve
bilerek korunur: masaüstü sürümü hâlâ tek hesaplı okuma yaptığı için o kod
değişmeden çalışmaya devam eder. Eski tek hesaplı dosya ilk açılışta otomatik
olarak çok kullanıcılı biçime çevrilir.

## Güvenlik

- Şifreler `scrypt` + hesaba özel salt ile saklanır, karşılaştırma
  `timingSafeEqual` ile yapılır.
- Oturumlar bellekte tutulur (httpOnly cookie, 7 gün). Sunucu yeniden
  başlarsa herkes tekrar giriş yapar.
- Giriş denemesi sınırı: aynı IP'den 10 dakikada 8 başarısız denemeden sonra
  geçici engel.
- WebSocket bağlantısı da aynı oturum cookie'siyle doğrulanır.
- Ters vekil (nginx) arkasında `trust proxy` açık - gerçek istemci IP'si ve
  HTTPS bilgisi `X-Forwarded-*` başlıklarından okunur.

## API

| Uç | Açıklama |
|---|---|
| `POST /api/login`, `/api/logout`, `GET /api/me` | Oturum |
| `GET /api/hesaplar`, `POST /api/hesaplar/ekle`, `/api/hesaplar/sil` | Hesap yönetimi |
| `POST /api/hesap/guncelle` | Kendi kullanıcı adı/şifresini değiştirme |
| `GET /api/status` | Discord bağlantı durumu |
| `POST /api/yoklama/tara` | Yoklama taraması |
| `POST /api/yoklama/al-onizleme`, `/api/yoklama/al-uygula` | Yoklamayı Al |
| `POST /api/yoklama/rol-ver`, `/rol-geri-al` | Tekli uyarı |
| `POST /api/yoklama/toplu-uyari-ver`, `/toplu-rol-geri-al` | Toplu uyarı |
| `POST /api/yoklama/acil-toplanti` | Acil toplantı |
| `GET /api/loglar`, `/api/loglar/:key`, `POST /api/loglar/:key/yenile` | TX Logs |
| `GET /api/uyari-gecmisi` | Uyarı geçmişi |
| `WS /ws` | Canlı durum, log ilerlemesi, toplu işlem ilerlemesi |
