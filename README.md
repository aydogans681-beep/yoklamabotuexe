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
panel-settings.json   Panel ayarları: otomatik yoklama, rol botu, ticket mesajı
panel-audit.json      Hesap Logları (kim ne yaptı)
voice-activity.json   Aktiflik sekmesi - günlük ses süreleri
yoklama-katilim.json  "Yoklamaya Katıl" kayıtları (gün gün)
log-cache/            Log geçmişi önbelleği (silinebilir, yeniden üretilir)
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
  | Panelden "Yoklamaya Katıl" demiş | Uyarı yok |
  | Mazerette ✅ | Uyarı yok |
  | Mazerette ❌ | **Uyarı** |
  | Mazeret var, tepki yok | **Uyarı** |
  | Mazeret yok | **Uyarı** |

  Günlük ve uzun mazeretten **birinde bile ✅ varsa** uyarı yazılmaz.
  Uyarılar doğrudan uygulanmaz: önce kimin ne alacağını gösteren bir önizleme
  penceresi açılır, onaydan sonra sırayla uygulanır.
- **Yoklamaya Katıl** - panel hesabına Discord ID'si bağlı olan yetkili,
  kendini o günün yoklamasında katıldı olarak işaretler; o gün uyarı almaz.
  Kayıt `yoklama-katilim.json` dosyasında gün gün tutulur. Hesabına ID bağlı
  değilse buton **kapanmaz**: basınca Ayarlar > Kendi Hesabım'a götürüp Discord
  ID alanını odaklar. (Kapalı buton "yok" gibi göründüğü için kullanıcılar ne
  yapacaklarını anlamıyordu.) Yönetici, Panel Hesapları'ndaki **Discord ID**
  düğmesiyle mevcut hesaplara da ID atayabilir - önceden ID yalnızca hesap
  açılırken girilebiliyordu, daha önce açılmış hesaplarda bu düğme çalışmıyordu.
  Aynı ID iki hesaba bağlanamaz.
- **Toplu Uyarı** - elle seçilen kişilere uyarı verme / geri alma.
- **Acil Toplantı** - sesteki tüm yetkilileri kendi ses kanalına çeker.

Uyarı merdiveni: `Sözlü Uyarı → 1x → 2x → 3x`. Roller doğrudan verilmez;
komut kanalına rol botuna slash komut gönderilir.

Komut **ID ile** çözülür. Kütüphanenin `sendSlash`'i komutu yalnızca ada göre
arıyor ve ad birebir tutmazsa `SlashCommand ... is not found` atıp rol vermeyi
sessizce düşürüyordu. Komut ID'si hem komutu hem hangi uygulamaya ait olduğunu
tek başına belirlediği için ad tahmin etmeye gerek kalmıyor - komut başka bir
bota ait olsa bile çalışır. ID boş bırakılırsa ada göre aramaya düşülür.
Komut bulunamazsa hata, dizindeki gerçek komutları ID'leriyle birlikte yazar.

Uyarı duyurusundaki **"Uyarı veren"** satırında, uyarıyı veren panel
kullanıcısının Ayarlar'dan bağladığı Discord ID'si görünür. Bağlı ID yoksa
botun kendi hesabı yazılır.

### TX Logs

Log kanallarının **tüm geçmişi**, sunucu Discord'a bağlanır bağlanmaz arka
planda çekilip bellekte tutulur; panele girildiğinde veri hazırdır. Sekme
açıkken yeni gelen log mesajları canlı olarak eklenir.

**Çekme hızı.** Geçmiş `log-cache/` altına diske yazılır; yeniden başlatmada
baştan çekilmez, yalnızca en son görülen mesajdan sonrası (`after`) alınır.
Kanallar ayrıca 3'erli paralel çekilir - Discord mesaj geçmişi kotası kanal
başına ayrı işlediği için bu güvenli. 54.000 mesajlık bir kurulumda ölçüm:

| | Süre |
|---|---|
| Eskiden (sıralı, önbelleksiz) | 192 sn |
| İlk çekim (3 paralel) | 48 sn |
| Yeniden başlatma (önbellekli) | 3 sn |

Önbellek bozuksa, sürümü eskiyse ya da kanal ID'si değişmişse yok sayılıp tam
çekime dönülür. **Yenile** düğmesi her zaman tam çekim yapar - artımlı çekim
yalnızca yeni mesajları görür, silinen/düzenlenen mesajlar ancak tam çekimde
yansır.

Menüler: Ban, Unban, Kick, Warn, DM, Duyuru, Revive, Ek Log, Para Verme.
Her menüde 100'erli sayfalama ve içerik + embed üzerinde arama var.

**Kanal ID'si eklemek:** `server/server.js` içindeki `LOG_CHANNELS` listesine
yaz. ID'si boş bırakılan menü arayüzde "ID yok" olarak görünür ve veri çekmez.

**Kısmi çekim:** Bir kanala `ilkCekimSiniri: 100` verilirse tüm geçmiş inmez,
yalnızca en yeni 100 mesaj çekilir; sonrasında kanala gelen yeni mesajlar canlı
eklenir ve sayı büyür. Şu an sadece **Ek Log** böyle. "Yenile" yine en yeni 100'ü
çeker, yani biriken satırlar sınıra döner. Menü ipucunda ve durum satırında
belirtilir.
Her kaydın `group` alanı hangi sekmede görüneceğini belirler (`tx` ya da
`mute`); yeni bir grup eklemek için `LOG_GROUPS`'a bir satır ve arayüzde bir
sekme yeter - çekme, saklama, arama ve canlı güncelleme kodu ortak.

### Mute Logları ve Felox

TX Logs ile **aynı makine**, ayrı sekmeler: Mute Logları (Mute + Unmute) ve
Felox (tek kanal). Üç sekme de `createLogTab()` fabrikasından üretiliyor, yani
sayfalama/arama/canlı güncelleme tek yerde duruyor ve her sekme kendi seçimini
bağımsız koruyor. Yeni bir grup eklemek `LOG_GROUPS`'a bir satır, `LOG_CHANNELS`'a
kanal(lar) ve arayüzde bir sekme + bir `createLogTab()` çağrısı demek.

### Ayarlar

- **Kendi Hesabım** - mevcut şifreyle doğrulayarak kullanıcı adı, şifre
  ve **Discord ID** değiştirme. Değişiklikten sonra o hesabın diğer tüm
  oturumları düşer. Discord ID 17-20 haneli olmalı; `sil` yazıp kaydedersen
  bağlantı kaldırılır.
- **Otomatik Günlük Yoklama** - **birden fazla saat** tanımlanabilir; her satır
  kendi saatinde yoklama alır ve **uyarıları kimse başında olmadan verir**.
  Her satırın kendi duyuru kanalı, kendi uyarı sebebi ve kendi açık/kapalı
  anahtarı vardır - kanal boş bırakılırsa varsayılan uyarı kanalı kullanılır.
  Kurulum varsayılanı: `20:30` (varsayılan kanal) ve `22:30`
  (`1470230485820112950`). Satırdaki "Şimdi" ile beklemeden denenebilir; deneme
  o günün zamanlanmış çalışmasını iptal etmez. Her çalışma Hesap Logları'na
  yazılır. Aynı saatin iki kez girilmesi engellenir (ikisi de aynı dakikada
  tetiklenip biri hiç çalışmamış gibi görünürdü).
- **Rol Botu Komutları** - rol verme/alma **komut ID'leri** (önerilen), ada göre
  yedek arama için komut adları, ve rol botunun ID'si. "Botun komutlarını
  listele" sunucudaki komutları ID'leriyle listeler; ID'ye tıklayınca panoya
  kopyalanır. Ayarlı ID'lerin dizinde gerçekten bulunup bulunmadığı kartın
  üstünde ✓/✗ olarak gösterilir.
- **Panel Hesapları** *(yalnızca yönetici)* - birden fazla panel hesabı
  ekleme/silme (istersen eklerken Discord ID de verilebilir). Son hesap ve
  yönetici hesabı silinemez.

`panel-auth.json` biçimi:

```json
{
  "username": "...", "salt": "...", "hash": "...",
  "users": [
    { "username": "...", "salt": "...", "hash": "...",
      "discordId": "892001875669434378", "createdAt": 0 }
  ]
}
```

Üstteki `username`/`salt`/`hash` alanları **listedeki ilk hesabın aynasıdır** ve
bilerek korunur: masaüstü sürümü hâlâ tek hesaplı okuma yaptığı için o kod
değişmeden çalışmaya devam eder. Eski tek hesaplı dosya ilk açılışta otomatik
olarak çok kullanıcılı biçime çevrilir.

## Performans ve bellek

**Tarama neden uzun sürebiliyor?** `guild.members.fetch()` sunucudaki *tüm*
üyeleri gateway üzerinden indiriyor; büyük sunucularda bu dakikalar alabilir.
Sonuç önbelleğe alındığı için bedel yalnızca ilk çağrıya çıkıyordu - yani
"Taramayı Başlat"a ilk basan kişi bekliyordu.

Artık üye listesi Discord'a bağlanır bağlanmaz **arka planda** çekiliyor
(TX Logs'tan önce, çünkü tarama buna bağlı). Panelde durumu görünür:
"Üye listesi hazırlanıyor..." → "Üye listesi hazır: N üye". Hazır olduktan
sonra tarama saniyenin altında bitiyor.

Her taramadan sonra süre dökümü hem panelde hem logda yazılıyor:

```
[Yoklama] Tarama tamamlandi: 46 yetkili, 12 sesde. Sureler -> uyeler: 0.0sn,
mazeretler: 3.4sn, toplam: 3.4sn. Bellek -> heap 210/260 MB, rss 340 MB.
```

Hangi aşamanın yavaş olduğu buradan okunur.

**Bellek.** TX Logs tüm log geçmişini bellekte tuttuğu için büyük log
kanallarında kullanım artar. Sunucu açılışta bellek sınırını yazıyor ve
yarım saatte bir kullanımı loglıyor:

```
[Sistem] Node bellek siniri: 4096 MB · su anki rss: 120 MB
[Bellek] heap 210/260 MB · rss 340 MB · bellekteki log kaydi: 84300
```

`rss` sınıra yaklaşıyorsa belleği yükselt:

```bash
cd server
npm run start-buyuk          # node --max-old-space-size=4096 server.js
```

pm2 ile:

```bash
pm2 delete yoklama
pm2 start server.js --name yoklama --node-args="--max-old-space-size=4096"
pm2 save
```

Belleği yükseltmek taramayı **hızlandırmaz** - yavaşlık üye listesinden
geliyorsa orada bir etkisi olmaz. Önce yukarıdaki süre dökümüne bak.

## Tarih aralığı (Etkinlik ve Aktiflik)

Her iki sekme de tek gün yerine **tarih aralığı** ile çalışabiliyor: aralıktaki
günlerin sayıları kişi başına toplanıyor.

Hazır dönemler: Bugün · Son 7 gün · **Bu hafta (Cuma–Perş.)** · Geçen hafta ·
Son 30 gün. Başlangıç ve bitiş elle de girilebilir.

"Cumadan cumaya" dönem, Cuma günü başlayan 7 günlük dilimdir (Cuma → Perşembe).
Ayın 15'i Cuma ise dönem 15–21'dir. Dönem içindeki hangi güne bakılırsa
bakılsın aynı aralık bulunur.

`←` / `→` düğmeleri **aralık uzunluğu kadar** kaydırır: 7 günlük dönemdeyken bir
önceki 7 güne gider, tek gündeyken bir önceki güne. Tek gün adımı atsaydı
haftalık dönemler örtüşürdü.

Uçlar `?bas=YYYY-AA-GG&bit=YYYY-AA-GG` alır; eski `?gun=` tek gün için çalışmaya
devam eder. Aralık ters verilirse düzeltilir. Gün hesabı UTC üzerinden yapılır -
yaz saati geçişlerinde bir günün atlanmaması ya da iki kez sayılmaması için.

## Yetkiler

**Yönetici** her şeyi görür ve hesap açar/siler, Discord ID bağlar, başka
hesaplara yetki verir. Hesap listesinin **ilk kaydı** (masaüstü sürümünün de
kullandığı ana hesap) her zaman yöneticidir ve yetkileri kısıtlanamaz - aksi
halde panelde hiç yönetici kalmayabilir ve kimse geri veremezdi. Diğer
hesaplara yöneticilik **Ayarlar > Panel Hesapları > Yetkiler**'den verilir.

Yönetici olmayan hesaplar için tek tek seçilir:

- **Görebileceği sekmeler**: Yoklama, Yetkililer, Rol Ver/Al, Aktiflik,
  Etkinlik, TX Logs, Mute Logları, Felox, Ayarlar
- **Görebileceği log kanalları**: her log grubunun içindeki menüler ayrı ayrı
  (ör. yalnızca Ban ve Unban). Grubun sekmesi kapalıysa içindeki kanalların
  hükmü kalmaz - pencerede bu açıkça yazar.

Hesap yönetimi (**Panel Hesapları**) ve **Hesap Logları** her zaman yalnızca
yöneticiye açıktır, sekme izni olarak verilemez.

Kısıt **hem sunucuda hem arayüzde** uygulanır. Arayüzde izinsiz sekmeler menüden
kalkar ve izinsiz log kanalları listeye hiç girmez; sunucuda ilgili uçlar 403
döner. Arayüzü gizlemek tek başına yeterli değildir - tarayıcı konsolundan uca
istek atılabilir.

401 yerine 403 kullanılır: istemci 401'i "oturum düştü" sayıp kullanıcıyı giriş
ekranına atardı.

Yetkisi değiştirilen hesabın **açık oturumları düşürülür** - yoksa daralan yetki
o kişi sayfayı yenileyene kadar eski haliyle açık kalırdı.

Yetki alanı hiç tanımlanmamış hesaplar (bu özellikten önce açılmış olanlar) tüm
sekmeleri ve kanalları görmeye devam eder - güncelleme kimseyi kilitlemez.

**Yeni log kanalı eklenince:** yetkisi elle ayarlanmış hesaplar yeni kanalı
görmez, çünkü izin listelerinde yoktur. Görmelerini istiyorsan Yetkiler
penceresinden işaretlemen gerekir. Yetkisi hiç ayarlanmamış hesaplar ve
yöneticiler yeni kanalı kendiliğinden görür.

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
| `GET /api/hesaplar`, `POST /api/hesaplar/ekle`, `/api/hesaplar/sil` | Hesap yönetimi *(yönetici)* |
| `GET /api/hesap-loglari` | Hesap Logları *(yönetici)* |
| `POST /api/hesap/guncelle` | Kendi kullanıcı adı/şifre/Discord ID'sini değiştirme |
| `GET /api/status` | Discord bağlantı durumu |
| `POST /api/yoklama/tara` | Yoklama taraması |
| `POST /api/yoklama/al-onizleme`, `/api/yoklama/al-uygula` | Yoklamayı Al |
| `POST /api/yoklama/rol-ver`, `/rol-geri-al` | Tekli uyarı |
| `POST /api/yoklama/toplu-uyari-ver`, `/toplu-rol-geri-al` | Toplu uyarı |
| `POST /api/yoklama/acil-toplanti` | Acil toplantı |
| `GET /api/yoklama/katilim`, `POST /api/yoklama/katil` | Yoklamaya Katıl |
| `GET/POST /api/oto-yoklama`, `POST /api/oto-yoklama/simdi` | Otomatik günlük yoklamalar (liste) |
| `POST /api/hesaplar/discord-id` | Bir hesaba Discord ID bağlama *(yönetici)* |
| `POST /api/hesaplar/izinler`, `GET /api/izin-secenekleri` | Yetki düzenleme *(yönetici)* |
| `GET/POST /api/rol-komutlari` | Rol botu komut ID'leri, adları ve bot ID'si |
| `GET /api/surum` | Çalışan commit, dal, rol botu/komut ayarları (girişsiz) |
| `GET /api/loglar[?grup=tx\|mute\|felox]`, `/api/loglar/:key`, `POST /api/loglar/:key/yenile` | TX Logs + Mute Logları + Felox |
| `GET /api/aktiflik[?bas=&bit=]` | Aktiflik - seste geçirilen süre |
| `GET /api/etkinlik/:key/gunluk[?bas=&bit=]` | Etkinlik - kişi başına mesaj sayısı |
| `GET /api/uyari-gecmisi` | Uyarı geçmişi |
| `WS /ws` | Canlı durum, log ilerlemesi, toplu işlem ilerlemesi |
