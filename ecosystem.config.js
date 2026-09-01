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
module.exports = {
    apps: [{
        name: 'yoklama',
        script: 'server/server.js',
        cwd: __dirname,               // durum dosyaları depo köküne yazılıyor
        watch: false,                 // ASLA açma - yukarıdaki açıklamaya bak
        autorestart: true,            // GERÇEK çökmede tek sefer toparla
        max_restarts: 10,             // 20 sn içinde 10 kez çökerse pes et
        min_uptime: '20s',            // (sonsuz sıkı döngüyü engeller, sorunu görünür kılar)
        node_args: '--max-old-space-size=4096',
        env: { NODE_ENV: 'production' },
    }],
};
