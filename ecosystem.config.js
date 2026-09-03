// pm2 yapılandırması.  `pm2 start ecosystem.config.js` ile başlat.
//
// EN ÖNEMLİ AYAR: watch=false.
// Bot çalışırken durum dosyalarına SÜREKLİ yazıyor: voice-activity.json,
// panel-audit.json (her AC işleminde!), yoklama-katilim.json, log-isaretleri.json,
// canli-sahiplenme.json, ac-*.json ve log-cache/ klasörü. pm2 "--watch" açıkken
// bu yazımların HER BİRİ bir dosya değişikliği sayılır ve pm2 botu yeniden
// başlatır -> "site durmadan düşüyor". Onun için watch burada AÇIKÇA kapalı.
//
// Ayrıca max_memory_restart BİLEREK yok: TX Logs 83 sunucunun tüm log geçmişini
// bellekte tuttuğu için normal kullanım bile yüksek RAM ister; düşük bir sınır
// koymak botu durup durup yeniden başlatırdı. Bellek node_args ile yükseltiliyor.
//
// cron_restart: bot 12 saatte bir kendini kapatıp açıyor (04:00 ve 16:00).
// Saatler bilerek seçildi: 20:00-22:30 arası yoklama ve prime hatırlatması var,
// gece 00:00'da ise gün anahtarı dönüyor ve günlük uyarı düşürme çalışıyor -
// ikisinin de üstüne yeniden başlatma denk gelmesin diye sakin saatler.
// Aynı gün iki kez yoklama alınmasından korkmaya gerek yok: hem otoYoklamaSonGunler
// hem uyariOtoDusurSonGun panel-settings.json'a yazılıyor, yani yeniden başlatma
// o günün korumasını sıfırlamıyor.
//
// DİKKAT: bu dosyadaki ayarlar ancak süreç BU DOSYADAN başlatılırsa geçerli olur.
// "pm2 restart yoklama" sürecin eski kayıtlı ayarlarıyla açar ve buradaki
// değişikliği görmez (pm2 7.0.4 ile denendi: cron_restart undefined kalıyor).
// Doğrusu: pm2 startOrRestart ecosystem.config.js --update-env
// guncelle.ps1 zaten bunu kullanıyor.
module.exports = {
    apps: [{
        name: 'yoklama',
        script: 'server/server.js',
        cwd: __dirname,               // durum dosyaları depo köküne yazılıyor
        watch: false,                 // ASLA açma - yukarıdaki açıklamaya bak
        autorestart: true,            // GERÇEK çökmede tek sefer toparla
        max_restarts: 10,             // 20 sn içinde 10 kez çökerse pes et
        min_uptime: '20s',            // (sonsuz sıkı döngüyü engeller, sorunu görünür kılar)
        cron_restart: '0 4,16 * * *', // 12 saatte bir yeniden başlat (sunucu saati)
        node_args: '--max-old-space-size=4096',
        env: { NODE_ENV: 'production' },
    }],
};
