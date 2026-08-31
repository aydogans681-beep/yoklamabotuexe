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

Windows'ta bunu elle yapmak yerine `.\token.ps1` kullan - token'ı yazmadan
önce Discord'a sorup geçerli mi diye doğrular (aşağıya bak).

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
config.env.yedek      GİZLİ - token.ps1'in aldığı önceki hal (depoda yok)
panel-auth.json       GİZLİ - panel hesapları (depoda yok)
warning-history.json  Uyarı geçmişi (depoda yok, masaüstü sürümüyle paylaşılır)
panel-settings.json   Panel ayarları: otomatik yoklama, rol botu, ticket mesajı
panel-audit.json      Hesap Logları (kim ne yaptı)
voice-activity.json   Aktiflik sekmesi - günlük ses süreleri
yoklama-katilim.json  "Yoklamaya Katıl" kayıtları (gün gün)
canli-sahiplenme.json Ticket sahiplenme kayıtları (canlı toplanır)
log-isaretleri.json   Şüpheli Log işaretleri: Ban/Şüpheli/Temiz (depoda yok)
log-cache/            Log geçmişi önbelleği (silinebilir, yeniden üretilir)
server/
  server.js           Backend: Discord istemcisi + HTTP/WebSocket API
  public/             Ön yüz (index.html, app.js, style.css)
```

`server/server.js` içindeki `ROOT_DIR`, `server/`'ın **bir üstünü** işaret eder;
paylaşılan dosyalar (token, hesaplar, uyarı geçmişi) orada durur. Masaüstü
sürümü aynı dosyaları okur.

## Sorun giderme

```powershell
.\guncelle.ps1  # yeni surumu ceker, bagimliliklari kurar, botu yeniden baslatir
.\token.ps1     # Discord token'ini dogrulayip config.env'e yazar
.\temizle.ps1   # bot tek kopya mi? hayaletleri temizler ve yeniden baslatir
.\tani.ps1      # ne calisiyor, hangi kanallar okundu
```

### guncelle.ps1

Güncellemenin tek komutu. **Hangi dalı çeker: bulunduğun dalı.** Dal adı betikte
sabit yazılı değil, `git rev-parse --abbrev-ref HEAD` ile git'e soruluyor.

> Eskiden burada tek bir dal adı yazılıydı. Başka bir dala geçildiğinde betik
> hâlâ eski dalı çekiyor, yani çalışan kodu **sessizce geri alıyordu** -
> "güncelledim ama değişiklikler gitti" durumunun sebebi buydu ve hiçbir yerde
> hata görünmüyordu.

Ayrık HEAD (detached) durumunda dal adı çıkmaz; betik o zaman **durur** ve ne
yapılacağını yazar - yanlış bir dalı çekmektense hiç çekmemek daha güvenli.

`config.env`, `panel-auth.json` ve `warning-history.json` dosyalarına dokunmaz;
onlar `.gitignore`'da olduğu için token ve panel hesapları silinmez.

### token.ps1

Token'ı Not Defteri ile elle girmek beş ayrı yerde **sessizce** yanlış
gidebiliyor ve beşi de aynı sonucu veriyor: bot açılır, panel çalışır, ama
Discord girişi olmaz ve bütün log kanalları `bekliyor` durumunda kalır.

| Tuzak | Ne olur |
|---|---|
| `notepad config.env` komutu `server\` içinden çalıştırılır | Boş dosya açılır; gerçek dosya depo **kökündedir** |
| Yapıştırırken başa/sona karakter kaçar | Gateway `4004 TOKEN_INVALID` döner |
| Not Defteri UTF-8 **BOM** yazar | Dosyanın ilk anahtarı görünmez bir karakterle başlar, dotenv okuyamaz |
| Token'ın süresi dolmuştur | Ancak bot yeniden başlatılınca anlaşılır |
| Dosya düzeltilir ama bot yeniden başlatılmaz | `config.env` yalnızca açılışta okunur |

Token'ı yapıştırmak da ayrı bir dert: Windows konsolunda `Ctrl+V` genelde
çalışmaz (yapıştırma **sağ tık**tır) ve gizli girişte ekranda hiçbir şey
görünmediği için yapıştırma olmamış gibi hissettirir. Bu yüzden betik önce
**panoya** bakar - token'ı kopyalayıp `.\token.ps1` demen yeterli, konsola
hiçbir şey yapıştırmazsın. Panodakini maskeli gösterip onay ister. Doğrudan
vermek istersen `.\token.ps1 -Token "OTMy..."` da çalışır.

Betik beşini de kapatır: kendi klasörünü kendisi bulur, girdiyi temizler
(tırnak, boşluk, görünmez karakterler), ilk parçayı çözüp hesap ID'sine denk
geliyor mu bakar, **diske yazmadan önce** token'ı Discord'a sorar, dosyayı
BOM'suz yazar ve sonunda `temizle.ps1` ile botu yeniden başlatır.

Discord token'ı kabul etmezse **hiçbir şey yazılmaz** - bozuk bir token dosyaya
girip sorunu yeniden başlatmaya kadar saklamaz. `config.env`'deki diğer
satırlar (`WEB_PORT` vb.) korunur, önceki hal `config.env.yedek`'e alınır.
Token ekrana yazılmaz; yalnızca uzunluğu, parça boyları ve hesap adı görünür.

### temizle.ps1

Eski sürümlerde portu alamayan kopyalar ölmüyor, Discord bağlantısı **canlı
halde** ayakta kalıyordu. Bu "hayalet" kopyalar ticket'a ayrı mesaj atıyor,
yoklamada ayrı rol veriyor ve panele **eski kodla** cevap veriyordu -
güncelleme yapılmış gibi görünüp hiçbir şey değişmiyordu.

Yeni sürüm yeni hayalet oluşmasını engelliyor ama **hâlihazırda çalışanları
öldürmüyor**; bu betik onları temizler. pm2 daemon'una dokunmaz. Portu tutmayan
hayaletler için (pm2'de başka uygulaman olabileceğinden) listeleyip **onay
ister**.

### tani.ps1

Çalışan commit'i, rol botu ayarlarını, zamanlanmış yoklamaları ve **bütün log
kanallarını durumlarıyla** yazar. Giriş gerektirmez. Bir menü panelde
görünmüyorsa üç sebebi ayırt eder:

| Çıktı | Anlamı |
|---|---|
| Kanal listede **yok** | Kod eski - `guncelle.ps1` çalışmamış |
| Kanal var, durum **hata** | Bot o kanalı göremiyor - ID yanlış ya da izin yok |
| Kanal var, durum **hazır** | Sunucu tamam; sorun o hesabın **yetkisinde** |

Panele hiç ulaşılamıyorsa hangi komutlarla bakılacağını da yazar.

## Giriş ekranı

Çerçeveli bir kart değil, tam sayfa **hero** yerleşimi: solda içerik ve form,
sağda halkalarla çevrili logo. Yerleşim ve tarz bir referans açılış sayfasından
alındı; **renk MD PvP'nin kendi kırmızısı**, isim ve logo bizim.

Yukarıdan aşağı:

| Parça | Ne var |
|---|---|
| **Sürüm pili** | ● commit — Bot çalışıyor · çalışma süresi |
| **Rozet şeridi** | YOKLAMA · SES AKTİFLİĞİ · OTOMATİK UYARI |
| **Dev başlık** | MD PvP — / **Yoklama Paneli** (ikinci satır aksan renginde) |
| **Alt metin** | panelin ne yaptığı, iki cümle |
| **Form** | kullanıcı adı, şifre, tam genişlik Giriş Yap |

Sürüm pilindeki veri `/api/surum`'dan geliyor, **giriş gerektirmiyor** ve gizli
bilgi içermiyor. İki işi var: panelin açılmaması ile şifrenin yanlış olması
kullanıcının gözünde aynı görüntüyü veriyordu, artık şifreyi denemeden önce
botun ayakta olup olmadığı görülüyor; ve **commit yazdığı için "güncelleme
geldi mi?" sorusu giriş ekranından cevaplanıyor**.

### Canlı logo

Sağdaki logo fareyi izliyor ve üç şey aynı anda oluyor:

- **Logo eğiliyor** (3B, ±17°) ve öne geliyor.
- **Halkalar ters yönde kayıyor** - dıştaki 26px, ortadaki 16px, içteki 8px.
  Beynin derinlik olarak okuduğu şey bu fark (parallaks): logo ileride,
  halkalar geride.
- **Parıltı imlece doğru kayıyor**, ışık oradan geliyormuş gibi.

Değerler doğrudan stille değil `--fx` / `--fy` CSS değişkenleriyle veriliyor:
JS yalnızca "fare şu kadar sağda/aşağıda" diyor, o değeri her parçanın ne kadar
kullanacağına CSS karar veriyor. Hedefe yumuşatarak yaklaşılıyor, yani imleç ani
hareket edince logo zıplamıyor arkasından süzülüyor; güncelleme
`requestAnimationFrame` ile, yani `mousemove` kaç kez tetiklenirse tetiklensin
kare başına bir kez. İmleç durunca döngü kendini durduruyor.

Logoya **tıklayınca** halkalardan dışa doğru bir nabız geçiyor - dokunmatik
ekranda fare hareketi olmadığı için oradaki tek karşılık bu.

`prefers-reduced-motion: reduce` altında hiçbiri çalışmıyor: JS dinleyicileri
hiç bağlamıyor, CSS de dönüşümleri nötrlüyor.

Halkalar ve parıltı tamamen dekoratif (`aria-hidden`). Logo `/logo` ucundan
geliyor; sunucuya logo konmamışsa **MD/PvP** yazısına düşüyor.

> Logonun **şeffaf arka planlı** (PNG/SVG) olması gerekiyor. Kare ve dolu
> zeminli bir görsel halkaların üstünü örtüyor ve etki kayboluyor.

> Halka renkleri doğrudan alfayla veriliyor (`rgba(255,59,71,.13)` gibi), ayrı
> bir `opacity` ile değil. İlk denemede `var(--accent-line)` (kendisi zaten %28
> saydam) üstüne bir de `opacity` uygulanıyordu; ikisi çarpılınca halkalar %8'e
> düşüyor ve neredeyse görünmüyordu.

Dar ekranda (< 980px) sağdaki logo gizleniyor ve başlık küçülüyor - orada asıl
iş form.

Arka plandaki ışık lekeleri ve ızgara da dekoratif; `prefers-reduced-motion`
altında animasyon duruyor.

## Sayfa başlığı

Her sekmenin en üstünde ikon + başlık + bir cümlelik açıklama duruyor. Başlık
HTML'de on kez tekrarlanmıyor; `app.js` içindeki `SEKME_BASLIKLARI` haritasından
sürülüyor, yani yeni sekme eklemek oraya bir satır demek.

Öncesinde sekmeler doğrudan bir araç çubuğuyla başlıyordu ve "neye bakıyorum"
sorusunu cevaplayan bir seviye yoktu.

## Günlük sütun grafiği

Aktiflik ve Etkinlik sekmelerinin üstünde **son 14 günün** toplamını gösteren bir
sütun grafiği var. Veri iki ucun **zaten döndürdüğü** `availableDays`
(`[{day, total}]`) alanından geliyor - yeni uç yazılmadı. İki sekme aynı biçimi
paylaştığı için tek bir çizici (`gunlukGrafikCiz`) ikisine de hizmet ediyor;
birimi çağıran veriyor (mesaj sayısı / süre).

Tasarım kararları ve sebepleri:

- **Tek seri, gösterge kutusu yok.** Tek renk çizildiği için kartın başlığı neyin
  gösterildiğini zaten söylüyor; tek damgalı bir gösterge kutusu başlığı tekrar
  eder ve yer kaplar.
- **Değer yalnızca en yüksek sütunun üstünde.** Her sütuna sayı yazmak okunmayan
  bir kalabalık üretiyor; gerisini eksen ve ipucu balonu taşıyor.
- **Sütun en fazla 24px**, üstü 4px yuvarlak, tabanı düz. Hücrenin artanı bilerek
  boşluk kalıyor - sütunun hücreyi doldurması grafiği tıka basa gösteriyor.
- **Izgara düz ve geride** (kesikli değil): kesik çizgi "eşik/tahmin" gibi okunuyor.
- **İsabet alanı sütun değil, onu saran tam yükseklikteki hücre.** 3px'lik bir
  çubuğu fareyle yakalamaya çalışmak sinir bozucu olurdu.
- Her sütun klavyeyle odaklanabiliyor ve `aria-label`'ında gün + değer yazıyor,
  yani değerlere ulaşmak için fareyle üzerine gelmek şart değil.
- Renk marka aksanı; koyu yüzeye karşı açıklık/kroma/kontrast denetimlerinden
  geçirildi (kontrast ≥ 3:1).

> Bilinen eksik: grafiğin ayrı bir **tablo görünümü** yok. Değerler ipucu,
> tepe etiketi ve `aria-label` üzerinden ulaşılabiliyor ama kopyalanabilir bir
> tablo ikizi bulunmuyor.

## Nexora Panel (AC)

AC'lerin (içerik üreticiler) kendi Discord hesaplarından, `1470230380572573706`
kategorisindeki ticket'lara işlem yapması için. Otomatik hiçbir şey **kendi
başına** olmaz: her işlem bir butona basılarak tetiklenir.

Akış: AC kendi token'ını bir kez bağlar → sekmede kategorideki açık ticket'lar
listelenir ve **yeni bir ticket açıldığında liste anlık güncellenir** → AC bir
ticket'ı seçer → **Nexora At** menüsünden işlem yapar. Hepsi AC'nin **kendi
hesabından** gider:

- **⚡ Nexora At (/nexorapin)** - seçili ticket kanalında, AC'nin kendi
  hesabından `/nexorapin` slash komutunu (`1543548857529401404`) çalıştırır.
  Her AC kendi hesabıyla ayrı ayrı atar; panelin ana botu araya girmez.
- **📸 SS iste** - altındaki hazır mesajı (*"Uygulamayı çalıştırıp tam ekran ss
  atabilir misin?"*) tek tıkla seçili ticket'a AC'nin kendi hesabından gönderir.
- **🔎 Sonucu Getir** - seçili ticket'ı açan kişinin (ya da elle girilen bir
  Discord ID'nin) sonucunu **Nexora API**'sinden çeker ve **tüm cevabı** AC'nin
  ekranına basar (iç içe alanlar, linkler ve görsel URL'leri dahil). API adresi
  ve anahtarı `config.env`'de (`NEXORA_API_URL`, `NEXORA_API_KEY`); ayarlı
  değilse buton "API ayarlı değil" der. Anahtar **yalnızca sunucuda** kalır,
  istemciye asla gitmez.
- **Mesaj (isteğe bağlı)** - AC serbest bir metin yazıp **Gönder**'e basarsa, o
  metin ticket'a yine kendi hesabından düşer.

Kim ne zaman hangi ticket'a Nexora attı, SS istedi, sonuç sorguladı ya da mesaj
gönderdi, Hesap Logları'na yazılır.

> **Bu bir selfbot özelliğidir** (README başındaki uyarı burada da geçerli).
> Kendi kullanıcı hesabından otomatik/panel üzerinden mesaj atmak veya slash
> komut çalıştırmak Discord'un kullanım şartlarına aykırıdır ve hesap
> işaretlenebilir. AC bunu bilerek, kendi kararıyla bağlıyor.

### Güvenlik tasarımı

Token'lar hassas olduğu için özellik birkaç katman üzerine kuruldu:

| Katman | Ne yapar |
|---|---|
| **Şifreleme** | Token'lar `ac-tokenlari.json`'da AES-256-GCM ile şifreli durur. Anahtar **ilk açılışta otomatik üretilip** `ac-anahtar.key`'e yazılır - elle `config.env` düzenlemek gerekmez. (İstersen `config.env`'e `AC_ANAHTAR` yazabilirsin; o öncelikli olur.) Dosya tek başına sızsa bile içerik okunamaz. |
| **Sahiplik (ilk token kilitler)** | Bir AC'nin bağladığı **ilk** token, o panel hesabının kimliği olur ve kilitlenir. Sonrasında yalnızca aynı Discord hesabının token'ı kabul edilir - AC sonradan başkasının token'ına geçemez. Kilit token'dan ayrı `ac-kilit.json`'da durur; bağlantı kaldırılsa bile kimlik korunur. (Panel hesabına elle bir Discord ID bağlıysa o bağlayıcı olur; yoksa ilk token kilidi kurar.) |
| **Gateway istek üzerine** | Düz mesaj tek bir REST isteğiyle gider. Slash komut (`/nexorapin`) ise **canlı bir gateway oturumu** gerektirir; bu yüzden **Nexora At**'e basıldığında o AC için geçici bir selfbot bağlantısı açılır, komut atılır ve bağlantı **5 dk boşta kalınca kendiliğinden kapanır**. Aynı anda en çok 15 AC bağlantısı tutulur. Sürekli açık selfbot yok - kalıcı bağlantı yalnızca panelin kendi botunda. |
| **Hız sınırı** | AC başına işlemler arası 5 sn, saatte en fazla 30. Panelin kendi hesabı bu oturumda hızlı DM yüzünden defalarca kilitlendi; aynı hatayı tekrarlamıyoruz. |
| **Kategori kilidi** | Mesaj ve Nexora yalnızca gerçekten o kategorideki (`1470230380572573706`) bir kanala gidebilir - panel keyfi bir kanala işlem atmanın yolu değil. |

Token **bir daha ekrana yazılmaz**; panel yalnızca hangi hesabın bağlı olduğunu
ve ne zaman bağlandığını gösterir.

### Açmak için

Elle hiçbir dosya düzenlemek gerekmiyor. Şifreleme anahtarı ilk açılışta
kendiliğinden üretiliyor.

1. Ayarlar > Panel Hesapları'ndan yeni hesap açarken **tip olarak AC** seç.
   (Yetkili / AC anahtarı formda.) AC hesabı yalnızca **Nexora Panel** ve
   **Felox** sekmesini görür - yoklama, yetkililer, ayarlar, TX/Mute logları
   vb. hiçbirine erişemez, izin ayarlamana gerek yok. (Felox sekmesinde
   Connections/Ban/Unban/Weapons/Silent kanalları görünür; **Şüpheli Log dahil
   değildir**.)
   Her AC'nin **kendi ayrı hesabı** olur ve **kendi token'ını** girer.
2. AC bu hesapla giriş yapar ve **tam ekran bir "Token Gir" kapısıyla**
   karşılaşır. Token bağlamadan panelde **hiçbir şey yapamaz** - kenar çubuğu,
   ticket listesi, hiçbiri açılmaz; önünde yalnızca token bağlama ekranı durur.
3. AC kendi token'ını bağlar. **İlk bağladığı hesap o panel hesabına
   kilitlenir** - sonradan başkasının token'ına geçemez. Token bağlanınca kapı
   kapanır ve Nexora Panel açılır. Bağlantı kaldırılırsa kapı yeniden gelir.

> `ac-anahtar.key` silinirse ya da `config.env`'deki `AC_ANAHTAR` değişirse
> bağlı token'lar çözülemez; AC'ler hesaplarını yeniden bağlar (panel bunu
> otomatik algılar). Bu, kimlik kilidini bozmaz - AC yine yalnızca kendi
> hesabını bağlayabilir. Anahtar dosyasını yedeklemek istersen `ac-anahtar.key`'i
> saklaman yeterli.

## Kenar çubuğu

Sekmeler dört gruba ayrılmıştır: **Yoklama** (Yoklama, Yetkililer, Rol Ver/Al),
**Raporlar** (Aktiflik, Etkinlik), **Loglar** (TX Logs, Mute Logları, Felox),
**Sistem** (Hesap Logları, Ayarlar). Bir grubun bütün maddeleri yetkiyle
gizlenirse başlığı da gizlenir.

Aktif sekme, solda ince bir aksan çubuğu ve yumuşak bir dolguyla belirtilir.
İkonlar eşit boyutlu kare kutulardadır.

> Kenar çubuğundaki satırların altında bulanık kırmızı lekeler vardı. Tasarım
> değil kazaydı: genel `button` kuralı **her** düğmeye dış parıltı gölgesi
> veriyor (`0 6px 18px -8px var(--accent-glow)`); `.chip` ve `.selBtn` bunu
> kendi `box-shadow`'uyla eziyor ama gezinme düğmeleri, log menüsü ve logo
> düğmesi ezmiyordu. Üçü de sıfırlandı. Parıltı artık yalnızca birincil eylem
> düğmelerinde (`Taramayı Başlat`, `Yoklamayı Al!`, `Toplu Uyarı Ver`) ve aktif
> süzgeç `chip`'inde - yani kasıtlı olduğu yerlerde.

İkonlar **emoji değil, tek renkli SVG**'dir (`index.html` başındaki `.ikon-seti`
sprite'ı). Emojiler her işletim sisteminde farklı çiziliyor, farklı genişlikte
oluyor ve kendi renklerini dayatıyordu - koyu temada Windows'un renkli emoji
fontu tasarımın dışında duruyordu. SVG'ler `currentColor` ile çizildiği için
bulundukları yerin rengini alır: pasif sekmede gri, üzerine gelince açık,
aktif sekmede kırmızı. Yeni ikon eklemek sprite'a bir `<symbol>`, kullandığın
yere `<svg><use href="#i-ad"/></svg>` demektir.

> İstisna: `✅` ve `❌` legend'larda emoji olarak kalır. Bunlar Discord'daki
> gerçek tepki emojilerini gösteriyor - yetkili mazeret mesajına o emojiyle
> tepki veriyor, ikona çevirmek bağı koparırdı.

Altta **canlı özet** kartı: şu an kaç yetkilinin seste olduğunu ve bugünkü
toplam süreyi gösterir, tıklayınca Aktiflik sekmesine gider. 45 saniyede bir
tazelenir. Aktiflik yetkisi olmayan hesapta uç 403 döndüğü için kart gizlenir -
hata yazmaz. En altta bağlantı durumu ve kullanıcı (baş harf rozeti, kullanıcı
adı, Yönetici/Yetkili).

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

### Ticket Sahiplenme (Etkinlik sekmesinde)

Ticket botu, bir yetkili ticket'ı sahiplenince kanala şu embed'i atıyor:

```
Ticket Sistemi - Destek
Merhaba, ben @Yetkili. Size nasıl yardımcı olabilirim? 👋
```

Bu mesajlar **canlı** yakalanıp `canli-sahiplenme.json`'a yazılıyor; ticket
kanalları kategorinin (`1470230378424832162`) altında açılıp silindiği için
geçmişi sonradan çekilebilecek tek bir kanal yok. Açılışta kayıtlar diskten
geri yükleniyor, sonrası canlı büyüyor.

Yalnızca `ben <@ID>` kalıbı kabul edilir. Embed'deki ilk etiketi almak, bot
metni değişirse sessizce yanlış kişiyi sayardı. Kalıba uymayan mesajlar
sayılmaz ama Etkinlik sekmesindeki **Teşhis** düğmesinden görülebilir - sayım
durursa metin mi değişti, kategori mi yanlış, oradan anlaşılır. Aynı mesaj ID'si
iki kez sayılmaz.

#### Teşhis düğmesi

Etkinlik sekmesinde **Ticket Sahiplenme** kaynağı seçiliyken çıkar (kanal
geçmişi çekilebilen diğer kaynaklarda aynı soru zaten Biçim kontrolü'nden
görülüyor, bu yüzden orada gizli). Panelde "kimse ticket almamış" görünüyorsa
sebebini ayırt eder:

| Ekranda | Anlamı |
|---|---|
| Kategoride hiç mesaj görülmedi | Kategori ID'si yanlış - ya da o kategoride hiç yazışma olmamış |
| Mesaj var ama hiç sayım yok | Ticket botunun metni kalıba uymuyor |
| Sayım var + embed'li mesaj kaçmış | Bot ikinci bir metin kullanıyor, o sahiplenmeler sayılmıyor |

Ekran ayrıca kategori ID'sini, aranan kalıbı, toplam/bugünkü sayımı (kişi
adlarıyla), son sayılan kayıtları ve kalıba uymayan son mesajları gösterir.

> Kategorideki **her** mesaj kalıp denemesinden geçtiği için ticket'taki sıradan
> sohbet de "kalıba uymayan" listesine düşer - bu normaldir, liste dolu diye
> sayım bozuk değildir. Bozulmanın işareti **embed'li** (sarı) bir satırdır: bot
> sahiplenme mesajı atmış ama kalıba uymamış demektir. Liste bellekte tutulur,
> bot yeniden başlayınca sıfırlanır.

Aynı veri `GET /api/sahiplenme/tani` ucundan da alınabilir.

Kayıtlar log makinesinin anladığı biçimde tutulduğu için günlük indeks, tarih
aralığı ve kişi başına liste hiçbir ek kod olmadan çalışır.

> Not: eski **Ticket** menüsü ticket log kanalını okur ve "ticket'ı silen kişi"yi
> sayar. Bot o kanala mesaj atmadığı için orada sayım oluşmuyordu; Ticket
> Sahiplenme onun yerine geçer.

### Mute Logları ve Felox

TX Logs ile **aynı makine**, ayrı sekmeler: Mute Logları (Mute + Unmute) ve
Felox. Üç sekme de `createLogTab()` fabrikasından üretiliyor, yani
sayfalama/arama/canlı güncelleme tek yerde duruyor ve her sekme kendi seçimini
bağımsız koruyor. Yeni bir grup eklemek `LOG_GROUPS`'a bir satır, `LOG_CHANNELS`'a
kanal(lar) ve arayüzde bir sekme + bir `createLogTab()` çağrısı demek; **var olan
bir gruba** kanal eklemek yalnızca `LOG_CHANNELS`'a bir satır - menü kendiliğinden
çıkıyor.

**Felox alt sekmeleri:** Felox sekmesinde şu kanallar (menüde alt sekme olarak):

| Alt sekme | Kanal | Not |
|---|---|---|
| Felox Connections Log | `1513234125337919610` | tam geçmiş |
| Ban Webhook | `1513234198918598706` | tam geçmiş |
| Unban Webhook | `1513234220011749607` | tam geçmiş |
| Weapons Webhook | `1513234241658556702` | tam geçmiş |
| Silent Log | `1525840429843484802` | **hızlı çekim** (`ilkCekimSiniri: 200`) |
| Şüpheli Log | `1522577961558085742` | son 100 + işaretleme (AC görmez) |

Silent Log yüksek hacimli olabildiği için geçmişin tamamı inmez: **en yeni 200
mesaj** hemen gelir (sekme anında açılır), sonrası canlı eklenir. AC hesapları
Şüpheli Log dışındaki tüm Felox kanallarını görür.

#### Şüpheli Log (Felox sekmesinde)

Kanal `1522577961558085742`. Geçmişin tamamı inmiyor, yalnızca **son 100 mesaj**
(`ilkCekimSiniri: 100`, Ek Log ile aynı kalıp); sonrası canlı ekleniyor.

Her kaydın altında **Ban / Şüpheli / Temiz** düğmeleri var. Bu işaretler
**yalnızca panelde durur** - Discord'a hiçbir şey gönderilmez, kimse banlanmaz,
kanala mesaj yazılmaz. Panelin "buna baktık, sonucu şu" defteri.

- Aynı düğmeye ikinci kez basmak işareti **kaldırır**.
- Kim işaretledi ve ne zaman, satırın sağında yazar; ayrıca **Hesap Logları**'na
  `log-isaret` olarak düşer.
- Üstteki süzgeç: Hepsi / İşaretsiz / Ban / Şüpheli / Temiz, her birinin sayacı
  yanında. İnceleme kuyruğu gibi çalışır - işaretsizler bitince iş biter.
- Temiz işaretlenen kayıtlar hafifçe soluklaşır ki göz işaretsizlere gitsin.
- Aynı anda açık başka panellerde de anında güncellenir.

İşaretler `log-isaretleri.json`'da, mesajların kendisinden ayrı durur: log
önbelleği silinip yeniden çekilse bile işaretler kaybolmaz.

> Adlandırma: bu koda "durum" demiyoruz. `log-durum` WebSocket türü **zaten**
> kanalın yüklenme durumunu yayınlıyor (`broadcastLogStatus`); aynı adı
> kullansaydık istemci işaret mesajını yüklenme durumu sanıp `channel.status`'ü
> bozardı. İşaretlerin türü `log-isaret`, ucu `POST /api/loglar/:key/isaret`.

Başka bir kanala da işaretleme açmak için `LOG_CHANNELS`'daki satırına
`isaretTakibi: true` eklemek yeterli; arayüz gerisini kendi hallediyor.

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
- **Yeni Ticket'a Otomatik Mesaj** - belirtilen kategorilerde yeni bir ticket
  açıldığında hazır metin yazılır ve ticket'ı açan kişi etiketlenir.

  İki kategori var, **her birinin kendi metni**:

  | Sekme | Kategori | Kime | Mesajı kim atar |
  |---|---|---|---|
  | Yayıncı (YT) | `1476223556806512660` | yayıncı başvuruları | **panelin ana hesabı** |
  | AC | `1470230380572573706` | AC başvuru/destek | **tokenini giren AC'nin kendi hesabı** |

  **İki kademeli şalter:** üstteki "Açık (ana şalter)" hepsini birden açıp
  kapatır. Bunun altında **her kategorinin kendi aç/kapa anahtarı** olabilir.

  **YT** karşılamasını panelin ana hesabı atar (klasik davranış).
  **AC karşılamasını panelin ana hesabı DEĞİL, tokenini giren bir AC'nin KENDİ
  Discord hesabı atar** - varsayılan **açık**. Bu istendi: AC ticket'ına
  karşılamayı panel sahibinin hesabı değil, AC'nin kendisi atmalı.

  **Karşılayan AC hesabı** AC sekmesinden seçilir. Boş bırakılırsa: **tek bir
  AC token'ı bağlıysa otomatik o** kullanılır; **birden fazla AC** bağlıysa ve
  seçim yoksa karşılama atlanır (belirsizlik) - o zaman Ayarlar'dan bir AC
  hesabı seçmen gerekir. Slash komut gibi bu da AC'nin gateway'ini kısa süreli
  açar (bkz. güvenlik tablosu).

  Ayarlar'da üstteki sekmelerden kategori seçilir, altındaki kutuya o
  kategorinin metni yazılır. Kaydet ikisini birden gönderir. Metinlerden biri
  geçersizse (boş ya da 1800 karakterden uzun) **hiçbiri** kaydedilmez -
  yarım kaydetmek ayarları tutarsız bırakırdı.

  Eşleşme yalnızca **kategori ID'sine** bakar, sunucuya değil: Discord ID'leri
  evrensel benzersiz ve iki kategori ayrı sunucularda. Eski sürümdeki sabit
  sunucu kontrolü AC kategorisini engellerdi.

  Yeni kategori eklemek: `server.js`'teki `TICKET_AUTO_KATEGORILER` listesine
  bir satır (`acikAyar: null` ana şaltere uyar, bir anahtar adı yazılırsa o
  kategori kendi aç/kapa anahtarını alır; `gonderen: 'bot'` panelin ana hesabı,
  `gonderen: 'ac'` tokenini giren AC'nin kendi hesabı yazar) ve `panelSettings`'e
  bir varsayılan; arayüz kendiliğinden büyür.

- **Prime Saat Hatırlatması** - belirtilen saatlerde (varsayılan `20:00`,
  `21:00`, `22:00`) Discord'da **aktif olup seste olmayan** yetkililere
  "sese geçer misin" hatırlatması gider: duyuru kanalından tek mesajla ve DM
  ile. Seste olanlara ve çevrimdışı olanlara yazılmaz. Discord presence
  bilgisi gelmemiş kişilere de **bilerek yazılmaz** - emin olmadan DM atmamak
  için. DM'ler **10 sn aralıkla** ve en fazla 40 kişiye gider; DM'i kapalı
  olanlar hata değil, sayılıp geçilir.

  > Aralık neden 10 saniye: eski 1,5 sn'lik değer Discord'un spam eşiğini
  > tetikliyordu. Hesap ihlal aldıkça oturum kapatılıyor, oturum kapanınca
  > **token da sıfırlanıyor** - "token yine sıfırlandı" sorununun kaynağı
  > buydu. 10 saniye eşiğin belirgin şekilde altında kalıyor.
  >
  > Bedeli: tavan doluyken bir tur ~6,5 dakika sürüyor. Duyuru kanalına
  > yazılan toplu etiket mesajı **anında** gittiği için kimse hatırlatmayı
  > geç görmüyor; DM yalnızca ikinci bir dokunuş. Bekleme yalnızca arkasından
  > başka bir DM gelecekse yapılıyor - son DM'den sonra boşuna beklenmiyor.
  >
  > Değer `server.js` içindeki `PRIME_DM_ARALIK_MS`, tavan `PRIME_DM_TAVANI`.
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

## Tek kopya kuralı

Bot aynı anda **yalnızca bir kez** çalışmalı. İkinci bir kopya 3000 portunu
alamaz; eskiden `uncaughtException` yakalayıcısı bu hatayı yutuyordu ve süreç
Discord bağlantısı **canlı halde** ayakta kalıyordu. Sonuç: her kopya ticket'a
ayrı mesaj atıyor, 20:30 yoklamasında ayrı ayrı rol veriyor ve
`voice-activity.json`'a birbirinin üzerine yazıyordu. "Ticket'a 5-6 mesaj
gidiyor" şikâyetinin sebebi buydu.

Artık portu alamayan kopya hemen kapanıyor. Ayrıca **açılış sırasında** oluşan
her hata ölümcül: yarım kurulmuş bir süreç (ayarlar eksik, zamanlayıcılar
kurulmamış ama Discord bağlı) çalışmaya devam etmiyor. Açılıştan sonraki
hatalar tolere ediliyor, tek bir kaçak hata çalışan botu öldürmesin diye.

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
| `GET/POST /api/prime`, `POST /api/prime/simdi` | Prime saat hatırlatması |
| `POST /api/hesaplar/discord-id` | Bir hesaba Discord ID bağlama *(yönetici)* |
| `POST /api/hesaplar/izinler`, `GET /api/izin-secenekleri` | Yetki düzenleme *(yönetici)* |
| `GET/POST /api/rol-komutlari` | Rol botu komut ID'leri, adları ve bot ID'si |
| `GET /api/surum` | Çalışan commit, dal, rol botu/komut ayarları (girişsiz) |
| `GET /api/loglar[?grup=tx\|mute\|felox]`, `/api/loglar/:key`, `POST /api/loglar/:key/yenile` | TX Logs + Mute Logları + Felox |
| `GET /api/aktiflik[?bas=&bit=]` | Aktiflik - seste geçirilen süre |
| `GET /api/etkinlik/:key/gunluk[?bas=&bit=]` | Etkinlik - kişi başına mesaj sayısı |
| `GET /api/sahiplenme/tani` | Ticket sahiplenme teşhisi (eşleşmeyen mesajlar) |
| `GET /api/ac/durum`, `POST /api/ac/token` | AC token bağlama/durum (Nexora Panel) |
| `GET /api/ac/ticketlar` | AC kategorisindeki açık ticket'lar |
| `POST /api/ac/gonder` | Seçili ticket'a AC'nin kendi hesabından mesaj |
| `POST /api/ac/nexora` | Seçili ticket'ta AC'nin kendi hesabından `/nexorapin` slash komutu |
| `POST /api/loglar/:key/isaret` | Log kaydını Ban/Şüpheli/Temiz işaretler (yalnızca panelde) |
| `GET /api/uyari-gecmisi` | Uyarı geçmişi |
| `WS /ws` | Canlı durum, log ilerlemesi, toplu işlem ilerlemesi, AC ticket açılış/kapanış (`ac-ticket-degisti`) |
