'use strict';

// ============================================================================
// MD PvP Yoklama Botu - WEB SÜRÜMÜ (1. AŞAMA: temel altyapı + salt-okunur
// Yoklama taraması).
//
// Bu dosya, ../main.js'teki (Electron masaüstü uygulaması) iş mantığının
// BÜYÜK KISMINI birebir aynı şekilde içeriyor - sadece taşıma katmanı
// (Electron IPC yerine HTTP/WebSocket) farklı. main.js'te bir şey
// düzeltilirse/değişirse, burada da AYNI değişikliği yapmayı unutma (ör.
// GUILD_ID, kanal ID'leri, KÜTÜPHANE YAMASI, shard onarımı gibi kısımlar
// ikisinde de var).
//
// KAPSAM (1. aşama): giriş (aynı panel-auth.json), Discord bağlantı durumu,
// Yoklama taraması (SADECE görüntüleme - henüz rol verme/toplu uyarı/acil
// toplantı YOK). Yetkililer, Mute/Unmute/TX/Admin/Ban Logs, Uyarı Geçmişi,
// İD Sorgulama, Ayarlar sonraki aşamalarda eklenecek.
// ============================================================================

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const cookieParser = require('cookie-parser');
const { WebSocketServer } = require('ws');

const ROOT_DIR = path.join(__dirname, '..'); // resources/app - masaüstü sürümüyle PAYLAŞILAN dosyalar burada
require('dotenv').config({ path: path.join(ROOT_DIR, 'config.env') });

const PORT = process.env.WEB_PORT ? Number(process.env.WEB_PORT) : 3000;

// --- DEBUG LOG (main.js'teki ile aynı fikir - konsolsuz/arka planda
// çalışabildiği için dosyaya da yazıyoruz) ---
const DEBUG_LOG_PATH = path.join(__dirname, 'debug-web.log');
function writeDebugLog(line) {
    try {
        fs.appendFileSync(DEBUG_LOG_PATH, `[${new Date().toISOString()}] ${line}\n`);
    } catch (error) {
        // yazılamazsa sessizce geç
    }
}
// wsClients/wsBroadcast burada, dosyanın en başında tanımlanıyor (asıl
// WebSocket sunucusu kurulumu çok daha aşağıda) - çünkü console.log override'ı
// (hemen altta) her çağrıldığında wsBroadcast'i kullanıyor, modül yüklenirken
// (ör. az sonraki KÜTÜPHANE YAMASI adımında) çok erken bir console.log
// gelebiliyor. wsClients aşağıda tanımlansaydı o an henüz "temporal dead
// zone"da olur, ReferenceError fırlatırdı.
const wsClients = new Set();
function wsBroadcast(payload) {
    const json = JSON.stringify(payload);
    wsClients.forEach((ws) => {
        if (ws.readyState === ws.OPEN) ws.send(json);
    });
}

const originalConsoleLog = console.log;
console.log = (...args) => {
    originalConsoleLog(...args);
    const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    writeDebugLog(line);
    wsBroadcast({ type: 'log-entry', time: Date.now(), message: line });
};

process.on('unhandledRejection', (reason) => {
    console.log(`[Hata] Yakalanmamış promise reddi: ${reason && reason.stack ? reason.stack : reason}`);
});
// Acilis tamamlandi mi? Modul yuklenirken olusan bir hata surecin YARIM
// kurulmus halde calismaya devam etmesi demek - ayarlar eksik, zamanlayicilar
// kurulmamis olabiliyor ama Discord baglantisi canli. Bir kez boyle bir hata
// (TDZ) sessizce yutuldu ve bot bozuk halde ayakta kaldi. Acilista olumcul,
// sonrasinda tolere ediliyor: calisan bir botu tek bir kacak hata oldurmesin.
let baslangicTamam = false;
process.on('uncaughtException', (error) => {
    console.log(`[Hata] Yakalanmamış istisna: ${error && error.stack ? error.stack : error}`);
    if (!baslangicTamam) {
        console.log('[Hata] Bu hata acilis sirasinda olustu - surec yarim kurulmus'
            + ' halde calismasin diye kapaniyor.');
        process.exit(1);
    }
});

// ============================================================================
// --- PANEL GİRİŞİ (main.js ile AYNI panel-auth.json, aynı hesap) ---
// ============================================================================
const PANEL_AUTH_PATH = path.join(ROOT_DIR, 'panel-auth.json');

function hashPassword(password, saltHex) {
    return crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 64).toString('hex');
}

function newSalt() {
    return crypto.randomBytes(16).toString('hex');
}

// panel-auth.json artık ÇOK KULLANICILI:
//   { username, salt, hash,            <- ESKİ ALANLAR: ilk hesabın aynası.
//     users: [{ username, salt, hash, createdAt }, ...] }
// Eski alanlar bilerek korunuyor: masaüstü sürümü (main.js) hâlâ tek hesaplı
// okuma yapıyor ve o kod bu depoda yok. Böylece masaüstü, listedeki İLK
// hesapla sorunsuz çalışmaya devam eder; web paneli users[] dizisini kullanır.
function loadPanelUsers() {
    let data = null;
    try {
        data = JSON.parse(fs.readFileSync(PANEL_AUTH_PATH, 'utf8'));
    } catch (error) {
        return []; // hesap yok - masaüstünde "Hesap Oluştur" ekranı henüz geçilmemiş
    }
    if (!data || typeof data !== 'object') return [];

    if (Array.isArray(data.users) && data.users.length > 0) {
        return data.users.filter((u) => (
            u && typeof u.username === 'string' && typeof u.salt === 'string' && typeof u.hash === 'string'
        ));
    }
    // ESKİ TEK HESAPLI BİÇİM -> tek elemanlı listeye çevir (dosyaya dokunmadan).
    if (typeof data.username === 'string' && typeof data.salt === 'string' && typeof data.hash === 'string') {
        return [{ username: data.username, salt: data.salt, hash: data.hash, createdAt: null }];
    }
    return [];
}

// Panel hesabina bagli Discord ID'si - uyari duyurusunda "Uyari veren" olarak
// bot hesabi yerine islemi yapan yetkili gorunsun diye.
function panelUserDiscordId(username) {
    const u = findPanelUser(username);
    return (u && u.discordId) || null;
}

function savePanelUsers(users) {
    const first = users[0];
    const payload = {
        // masaüstü sürümünün okuduğu alanlar (ilk hesabın aynası)
        username: first ? first.username : '',
        salt: first ? first.salt : '',
        hash: first ? first.hash : '',
        users,
    };
    fs.writeFileSync(PANEL_AUTH_PATH, JSON.stringify(payload, null, 2));
}

function findPanelUser(username) {
    return loadPanelUsers().find((u) => u.username === username) || null;
}

function verifyPanelPassword(username, password) {
    const record = findPanelUser(username);
    if (!record) {
        // Kullanıcı yoksa bile bir scrypt turu çevirip zamanlama farkını kapatıyoruz -
        // aksi halde "kullanıcı var mı" bilgisi cevap süresinden sızar.
        hashPassword(password, '00000000000000000000000000000000');
        return false;
    }
    const candidateHash = hashPassword(password, record.salt);
    const a = Buffer.from(candidateHash, 'hex');
    const b = Buffer.from(record.hash, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

// --- Giriş denemesi sınırı (kaba kuvvete karşı) ---
const LOGIN_MAX_ATTEMPTS = 8;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const loginAttempts = new Map(); // ip -> { count, firstAt }

function loginThrottleCheck(ip) {
    const entry = loginAttempts.get(ip);
    if (!entry) return { blocked: false };
    if (Date.now() - entry.firstAt > LOGIN_WINDOW_MS) {
        loginAttempts.delete(ip);
        return { blocked: false };
    }
    if (entry.count >= LOGIN_MAX_ATTEMPTS) {
        const leftSec = Math.ceil((LOGIN_WINDOW_MS - (Date.now() - entry.firstAt)) / 1000);
        return { blocked: true, leftSec };
    }
    return { blocked: false };
}

function loginNoteFailure(ip) {
    const entry = loginAttempts.get(ip);
    if (!entry || Date.now() - entry.firstAt > LOGIN_WINDOW_MS) {
        loginAttempts.set(ip, { count: 1, firstAt: Date.now() });
    } else {
        entry.count += 1;
    }
}

function loginNoteSuccess(ip) {
    loginAttempts.delete(ip);
}

// Basit oturum deposu (bellekte) - token bir httpOnly cookie'de tutuluyor.
// Sunucu yeniden başlarsa herkes tekrar giriş yapmak zorunda kalır, bu
// ölçekte (birkaç yetkili) sorun değil.
const SESSION_COOKIE = 'ybsid';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 gün
const sessions = new Map(); // token -> { username, expiresAt }

function createSession(username) {
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { username, expiresAt: Date.now() + SESSION_TTL_MS });
    return token;
}

function getSession(req) {
    const token = req.cookies && req.cookies[SESSION_COOKIE];
    if (!token) return null;
    const session = sessions.get(token);
    if (!session) return null;
    if (Date.now() > session.expiresAt) {
        sessions.delete(token);
        return null;
    }
    return session;
}

function dropSessionsFor(username) {
    [...sessions.entries()].forEach(([token, session]) => {
        if (session.username === username) sessions.delete(token);
    });
}

function dropAllSessionsExcept(keepToken) {
    [...sessions.keys()].forEach((token) => {
        if (token !== keepToken) sessions.delete(token);
    });
}

function requireAuth(req, res, next) {
    const session = getSession(req);
    if (!session) return res.status(401).json({ ok: false, error: 'Giriş yapılmamış.' });
    req.session = session;
    return next();
}

// ============================================================================
// --- YETKILER ---
// Her hesabin gorebilecegi sekmeler ve log kanallari ayri ayri veriliyor.
// Kisit HEM sunucuda (uc bazinda 403) HEM arayuzde uygulanmali - arayuzu
// gizlemek tek basina yetmez, tarayici konsolundan uca istek atilabilir.
// ============================================================================
const IZIN_SEKMELERI = [
    { key: 'yoklama', label: 'Yoklama' },
    { key: 'yetkililer', label: 'Yetkililer' },
    { key: 'roller', label: 'Rol Ver/Al' },
    { key: 'aktiflik', label: 'Aktiflik' },
    { key: 'etkinlik', label: 'Etkinlik' },
    { key: 'loglar', label: 'TX Logs' },
    { key: 'mutelog', label: 'Mute Logları' },
    { key: 'felox', label: 'Felox' },
    { key: 'ayarlar', label: 'Ayarlar' },
];
const IZIN_SEKME_ANAHTARLARI = IZIN_SEKMELERI.map((x) => x.key);

// Log grubu -> o gruba karsilik gelen sekme izni. Grup sekmesi kapaliysa
// icindeki kanallara da erisilemiyor.
const GRUP_SEKMESI = { tx: 'loglar', mute: 'mutelog', felox: 'felox' };

// Bir hesabin etkin yetkileri. Alan yoksa "hepsi serbest" kabul ediliyor -
// yetki sistemi eklenmeden once acilmis hesaplar aniden kilitlenmesin.
function kullaniciYetkileri(username) {
    const users = loadPanelUsers();
    const index = users.findIndex((u) => u.username === username);
    if (index < 0) return { admin: false, sekmeler: [], loglar: [] };
    const u = users[index];
    // Listenin ilk kaydi HER ZAMAN yonetici: yoneticiligi elinden alinabilseydi
    // panelde hic yonetici kalmayabilir ve kimse geri veremezdi.
    const admin = index === 0 || u.admin === true;
    if (admin) {
        return {
            admin: true,
            sekmeler: IZIN_SEKME_ANAHTARLARI.slice(),
            loglar: LOG_CHANNELS.map((c) => c.key),
        };
    }
    return {
        admin: false,
        sekmeler: Array.isArray(u.sekmeler) ? u.sekmeler : IZIN_SEKME_ANAHTARLARI.slice(),
        loglar: Array.isArray(u.loglar) ? u.loglar : LOG_CHANNELS.map((c) => c.key),
    };
}

function sekmeIzniVar(username, ...sekmeler) {
    const y = kullaniciYetkileri(username);
    if (y.admin) return true;
    return sekmeler.some((s2) => y.sekmeler.includes(s2));
}

function logIzniVar(username, key) {
    const y = kullaniciYetkileri(username);
    if (y.admin) return true;
    const kanal = LOG_CHANNELS.find((c) => c.key === key);
    if (!kanal) return false;
    // Once grubun sekmesi acik mi, sonra kanalin kendisi izinli mi.
    if (!y.sekmeler.includes(GRUP_SEKMESI[kanal.group || 'tx'])) return false;
    return y.loglar.includes(key);
}

// Sekme izni gerektiren uclar icin ara katman. 403 donuyor (401 degil):
// istemci 401'i "oturum dustu" sayip kullaniciyi giris ekranina atiyor.
function requireIzin(...sekmeler) {
    return (req, res, next) => {
        const session = getSession(req);
        if (!session) return res.status(401).json({ ok: false, error: 'Giriş yapılmamış.' });
        if (!sekmeIzniVar(session.username, ...sekmeler)) {
            return res.status(403).json({ ok: false, error: 'Bu bölüm için yetkin yok.' });
        }
        req.session = session;
        return next();
    };
}

// Yonetici = hesap listesinin ILK kaydi (masaustu surumunun de kullandigi ana
// hesap). Hesap ekleme/silme ve hesap loglari yalnizca ona acik. Kullanici adi
// degisse bile sira degismedigi icin bu bag kopmuyor.
// Tek kaynak: kullaniciYetkileri. Burada ayri bir kural yazsaydik, yonetici
// yapilan bir hesap requireAdmin'den gecemez ama /api/me'de yonetici gorunurdu.
function isAdmin(username) {
    return kullaniciYetkileri(username).admin;
}

function requireAdmin(req, res, next) {
    const session = getSession(req);
    if (!session) return res.status(401).json({ ok: false, error: 'Giriş yapılmamış.' });
    if (!isAdmin(session.username)) {
        // 403: giris yapilmis ama yetki yok - istemci bunu 401'den ayirip
        // kullaniciyi giris ekranina atmasin.
        return res.status(403).json({ ok: false, error: 'Bu işlem için yönetici hesabı gerekiyor.' });
    }
    req.session = session;
    return next();
}

// ============================================================================
// --- DISCORD BAĞLANTISI (main.js'ten BİREBİR - bkz. oradaki yorumlar) ---
// ============================================================================
// Message: sendSlashCommand "message instanceof Message" kontrolu yapiyor,
// bu yuzden komutu ID ile kendimiz gonderirken ayni sinifi kullanmamiz gerek.
// Paketin disa actigi Message ile ic modulunki ayni referans (dogrulandi).
const { Client, Message: SlashMesaji } = require('discord.js-selfbot-v13');

try {
    // eslint-disable-next-line global-require
    const ClientUserSettingManager = require('discord.js-selfbot-v13/src/managers/ClientUserSettingManager');
    const originalSettingsPatch = ClientUserSettingManager.prototype._patch;
    ClientUserSettingManager.prototype._patch = function patchedSettingsPatch(data) {
        try {
            return originalSettingsPatch.call(this, data);
        } catch (error) {
            console.log(`[Yama] Kullanıcı ayarları işlenirken hata oluştu, atlanıp devam ediliyor: ${error.message}`);
            return this;
        }
    };
    console.log('[Yama] ClientUserSettingManager._patch çökmeye karşı korumaya alındı.');
} catch (error) {
    console.log(`[Yama] ClientUserSettingManager yaması uygulanamadı: ${error.message}`);
}

const GUILD_ID = '1469033815518482445';
const ATTENDANCE_ROLE_IDS = ['1470230322410160268', '1470230340621697257'];
const EXCUSE_CHANNEL_ID = '1483233161390587986';
const EXCUSE_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const LONG_EXCUSE_CHANNEL_ID = '1508912991930679407';
const LONG_EXCUSE_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const WARNING_ROLES = [
    { id: '1470230364021850194', label: 'Sözlü Uyarı' },
    { id: '1470230364940275793', label: '1x' },
    { id: '1470230365800235121', label: '2x' },
    { id: '1470230366769119354', label: '3x' },
];
// Rol botu ID'si. Bir kez yanlis girildi ve butun rol islemleri sessizce
// calismadi; bu yuzden artik panelden degistirilebiliyor (ayarda deger varsa
// o kullaniliyor).
const VARSAYILAN_ROLE_BOT_ID = '1538263121678827570';
// Slash komutlarinin kendi ID'leri. Ad ile arama ("rol-ver") botun komutu
// baska turlu adlandirmis olmasi durumunda tutmuyordu; ID kesin eslesme
// sagliyor ve komutun hangi uygulamaya ait oldugunu da soyluyor.
const VARSAYILAN_ROL_VER_KOMUT_ID = '1540707926023348274';
const VARSAYILAN_ROL_AL_KOMUT_ID = '1540632258694750208';
function rolBotId() {
    return (panelSettings && panelSettings.rolBotId) || VARSAYILAN_ROLE_BOT_ID;
}
function rolVerKomutId() {
    return (panelSettings && panelSettings.rolVerKomutId) || '';
}
function rolAlKomutId() {
    return (panelSettings && panelSettings.rolAlKomutId) || '';
}
const ROLE_COMMAND_CHANNEL_ID = '1504900865507463259';
const WARNING_ANNOUNCE_CHANNEL_ID = '1483232323674701835';
const BULK_WARNING_DELAY_MS = 1200;
const EMERGENCY_MEETING_DELAY_MS = 500;

// ============================================================================
// --- TX LOGS: log kanallari ---
// TX Logs, bu menuleri iceren ust sekmenin adi; kendi kanali yok.
// channelId'si bos olan menu arayuzde "kanal ID girilmemis" diye gorunur ve
// veri cekmez - ID'yi buraya yazman disinda kod degisikligi gerekmez.
// ============================================================================
// Etkinlik sayaclari: TX Logs ile AYNI cekme altyapisini kullaniyor (tum
// gecmis arka planda bellege aliniyor), ama ayri bir sekmede gosteriliyor ve
// icerik yerine KISI BASINA MESAJ SAYISI hesaplaniyor.
// personFrom: mesajin KIME sayilacagini belirler.
//   'author'  -> mesaji yazan kisi. Etkinlik kanalinda yetkili kendi yaziyor.
//   'mention' -> mesaj icindeki ILK kullanici etiketi. Ticket loglarini
//                genelde bot atiyor ve ilgilenen yetkili mesajin icinde
//                etiketleniyor; yazara gore saymak "Ticket Botu: 5000" verirdi.
// --- TICKET SAHIPLENME ---
// Ticket botu, bir yetkili ticket'i sahiplenince kanala su bicimde bir embed
// atiyor:  "Merhaba, ben <@ID>. Size nasil yardimci olabilirim?"
// Sahiplenen kisiyi buradan sayiyoruz - eski ticket logu kanalina bot mesaj
// atmadigi icin oradan sayim calismiyordu.
const TICKET_SAHIP_KATEGORI = '1470230378424832162';
// "ben <@ID>" kalibi. Yalnizca bu kalibi kabul ediyoruz: embed'deki ilk
// etiketi almak, metin degisirse sessizce yanlis kisiyi sayardi.
const TICKET_SAHIP_KALIP = /\bben\s*<@!?(\d{17,20})>/i;

const ACTIVITY_CHANNELS = [
    { key: 'etkinlik', label: 'Etkinlik', channelId: '1456032067325263965', personFrom: 'author' },
    // Ticket logunu bot atiyor ve embed'de IKI kisi geciyor:
    //   "Ticket sahibi: @X"        -> ticket'i acan kisi (SAYILMAZ)
    //   "Ticket'i silen kisi: @Y"  -> ticket'e bakan yetkili (SAYILAN BU)
    // Ayrica altta "Kapatilan ticket - ID" satirinda ticket sahibinin ham
    // ID'si de geciyor. Bu yuzden "ilk etiket" ya da "ham ID" gibi genel
    // yontemler YANLIS kisiyi bulur; etiketli satira bakiyoruz.
    {
        key: 'ticket',
        label: 'Ticket',
        channelId: '1472697988479582411',
        personFrom: 'label',
        botId: '1538263121678827570',              // yalnizca bu botun mesajlari sayilir
        personLabel: /silen|kapatan|kapat[ıi]ld[ıi]/i,
    },
    // Ticket SAHIPLENME sayaci. Ticket kanallari kategorinin altinda acilip
    // kapaniyor, yani "gecmisi cekilecek" tek bir kanal yok - bu yuzden
    // digerlerinden farkli olarak CANLI toplaniyor ve diske yaziliyor.
    // canliKaynak: acilista gecmis cekilmiyor, kayit dosyadan okunuyor.
    {
        key: 'sahiplenme',
        label: 'Ticket Sahiplenme',
        channelId: TICKET_SAHIP_KATEGORI, // "yapilandirilmis" sayilmasi icin
        personFrom: 'author',             // entry.authorId'yi sahiplenen olarak yaziyoruz
        canliKaynak: true,
    },
];

// group: hangi sekmede gorunecegi. 'tx' -> TX Logs, 'mute' -> Mute Logları.
// Ikisi de ayni cekme/saklama/arama makinesini kullaniyor; sadece menuleri
// ayri sekmelere bolunuyor.
const LOG_GROUPS = [
    { key: 'tx', label: 'TX Logs' },
    { key: 'mute', label: 'Mute Logları' },
    { key: 'felox', label: 'Felox' },
];
const LOG_CHANNELS = [
    { key: 'ban', label: 'Ban', channelId: '1514634711413293197', group: 'tx' },
    { key: 'unban', label: 'Unban', channelId: '1456027006964858901', group: 'tx' },
    { key: 'kick', label: 'Kick', channelId: '1514634723043836155', group: 'tx' },
    { key: 'warn', label: 'Warn', channelId: '1514634738915086560', group: 'tx' },
    { key: 'dm', label: 'DM', channelId: '1514634767033696387', group: 'tx' },
    { key: 'duyuru', label: 'Duyuru', channelId: '1514634800407904398', group: 'tx' },
    { key: 'revive', label: 'Revive', channelId: '1514633983160483901', group: 'tx' },
    // Bu kanalin ne logu oldugu soylenmedi - menu adi buradan degistirilebilir.
    // ilkCekimSiniri: bu kanalda TUM gecmis inmiyor, yalnizca en yeni N mesaj.
    // Sonrasinda kanala yeni mesaj geldikce canli ekleniyor.
    { key: 'ek', label: 'Ek Log', channelId: '1514634694917095614', group: 'tx', ilkCekimSiniri: 100 },
    { key: 'para', label: 'Para Verme', channelId: '1500941817242452020', group: 'tx' },
    { key: 'mute', label: 'Mute', channelId: '1456027009624051940', group: 'mute' },
    { key: 'unmute', label: 'Unmute', channelId: '1456027014036459663', group: 'mute' },
    { key: 'feloxlog', label: 'Felox', channelId: '1513234220011749607', group: 'felox' },
    // Supheli Log: bu kanalda gecmisin TAMAMI inmiyor, yalnizca en yeni 100
    // mesaj. Sonrasi canli ekleniyor (messageCreate). Ek Log ile ayni kalip.
    { key: 'supheli', label: 'Şüpheli Log', channelId: '1522577961558085742', group: 'felox', ilkCekimSiniri: 100, isaretTakibi: true },
];

// Discord sayfa basina en fazla 100 mesaj veriyor. Sayfalar arasinda kisa bir
// bekleme koyuyoruz - "tum gecmisi cek" binlerce istek demek, rate limit'e
// carpmadan ilerlemek icin.
const LOG_PAGE_DELAY_MS = 250;

// Kac kanal ayni anda cekilsin. Discord mesaj gecmisi kotasi kanal basina
// ayri islediginden farkli kanallar paralel cekilebiliyor. Selfbot oldugumuz
// icin bilerek olculu: 3 kanal x 250 ms ~ 12 istek/sn, hesabin supheli
// gorunmesini istemiyoruz.
const LOG_CONCURRENCY = 3;

// Cekilen gecmis diske yaziliyor; yeniden baslatmada bastan cekmek yerine
// yalnizca eksik kalan yeni mesajlar aliniyor. Asil bekleme buydu - her
// yeniden baslatmada butun kanallarin tum gecmisi tekrar iniyordu.
const LOG_CACHE_DIR = path.join(ROOT_DIR, 'log-cache');
const LOG_CACHE_SURUM = 1;
const LOG_CACHE_YAZMA_ARALIGI_MS = 5 * 60 * 1000;

// --- YOKLAMAYI AL: mazeret tepkileri ---
// Tepki adi hem unicode emoji (reaction.emoji.name === '✅') hem de ayni
// isimli ozel emoji olabildigi icin iki bicimi de tanimliyoruz.
const APPROVE_REACTIONS = new Set([
    '✅', '☑️', '☑', '✔️', '✔',
    'white_check_mark', 'heavy_check_mark', 'ballot_box_with_check',
    'onay', 'onaylandi', 'tik', 'kabul',
]);
const REJECT_REACTIONS = new Set([
    '❌', '❎', '✖️', '✖', '✗', '✘',
    'x', 'cross_mark', 'negative_squared_cross_mark', 'heavy_multiplication_x',
    'red_x', 'ret', 'reddedildi', 'iptal',
]);

function normalizeReactionName(name) {
    return String(name || '').trim().replace(/^:|:$/g, '').toLowerCase();
}

// Bir mazeretin tepkilerini "onay / ret / tepkisiz" diye siniflandirir.
function classifyReactions(reactions) {
    if (!reactions || reactions.length === 0) return 'none';
    let hasReject = false;
    for (const reaction of reactions) {
        const name = normalizeReactionName(reaction.emoji);
        if (APPROVE_REACTIONS.has(name)) return 'approved'; // onay her seyi ezer
        if (REJECT_REACTIONS.has(name)) hasReject = true;
    }
    return hasReject ? 'rejected' : 'none';
}

let discordStatus = 'bağlanıyor'; // 'bağlanıyor' | 'bağlı' | 'hata'
let discordStatusDetail = 'Bağlanıyor...';

function broadcastStatus() {
    wsBroadcast({ type: 'status', state: discordStatus, detail: discordStatusDetail });
}

const client = new Client({ checkUpdate: false });

let connectWatchdogTimer = null;
let connectStartedAt = null;
let gatewayDebugHandler = null;

function startGatewayDebugLogging() {
    if (gatewayDebugHandler) return;
    gatewayDebugHandler = (info) => console.log(`[Gateway] ${info}`);
    client.on('debug', gatewayDebugHandler);
}
function stopGatewayDebugLogging() {
    if (gatewayDebugHandler) {
        client.removeListener('debug', gatewayDebugHandler);
        gatewayDebugHandler = null;
    }
}
function stopConnectWatchdog() {
    if (connectWatchdogTimer) {
        clearInterval(connectWatchdogTimer);
        connectWatchdogTimer = null;
    }
}
function startConnectWatchdog() {
    stopConnectWatchdog();
    connectStartedAt = Date.now();
    startGatewayDebugLogging();
    connectWatchdogTimer = setInterval(() => {
        const elapsedSec = Math.round((Date.now() - connectStartedAt) / 1000);
        discordStatusDetail = elapsedSec < 60
            ? `Bağlanıyor... (${elapsedSec}sn)`
            : `Hâlâ bağlanıyor (${elapsedSec}sn)`;
        if (elapsedSec === 15 || elapsedSec === 30 || elapsedSec === 60 || elapsedSec === 120) {
            console.log(`[Bağlantı] ${elapsedSec} saniyedir "ready" olayı gelmedi.`);
        }
        broadcastStatus();
    }, 5000);
}

let readyPollTimer = null;

function markConnected(source) {
    if (discordStatus === 'bağlı') return;
    console.log(`[Bağlantı] Giriş yapıldı (${source}): ${client.user ? client.user.tag : 'bilinmiyor'}`);
    discordStatus = 'bağlı';
    discordStatusDetail = 'Bağlı';
    stopConnectWatchdog();
    stopGatewayDebugLogging();
    if (readyPollTimer) {
        clearInterval(readyPollTimer);
        readyPollTimer = null;
    }
    broadcastStatus();
    // Discord hazir. Once uye listesi (tarama bunu bekliyor), sonra TX Logs.
    // Sirali: ikisini ayni anda baslatmak Discord rate limit'ini daha hizli
    // tuketir ve uye listesini de geciktirirdi.
    primeMembers()
        .then(() => primeAllLogs())
        .catch((error) => console.log(`[Hazirlik] Arka plan yuklemesi hata verdi: ${error.message}`));
}

function startReadyPolling() {
    if (readyPollTimer) clearInterval(readyPollTimer);
    readyPollTimer = setInterval(() => {
        if (client.user && client.guilds.cache.has(GUILD_ID)) {
            markConnected('yedek kontrol - hedef sunucu önbellekte');
        }
    }, 1000);
}

client.on('ready', () => markConnected('ready olayı'));
client.on('error', (error) => {
    console.log(`[Hata] Discord client hatası: ${error.message}`);
    discordStatus = 'hata';
    discordStatusDetail = `Bağlantı hatası: ${error.message}`;
    stopConnectWatchdog();
    broadcastStatus();
});
client.on('disconnect', () => {
    console.log('[Bağlantı] Discord bağlantısı koptu.');
    discordStatus = 'hata';
    discordStatusDetail = 'Discord bağlantısı koptu.';
    stopConnectWatchdog();
    membersFetchPromise = null;
    broadcastStatus();
});

let membersFetchPromise = null;
// Uye listesi durumu - arayuze "hazirlaniyor" bilgisi verebilmek icin.
let membersState = { status: 'bekliyor', count: 0, ms: null }; // bekliyor | yukleniyor | hazir | hata

function broadcastMembersState() {
    wsBroadcast({ type: 'uye-durum', ...membersState });
}

// DIKKAT: guild.members.fetch() argumansiz cagrildiginda sunucudaki TUM
// uyeleri gateway uzerinden indiriyor. Buyuk bir sunucuda bu on binlerce uye
// demek ve dakikalar surebiliyor. Sonuc onbellege alindigi icin bedeli yalnizca
// ILK cagriya cikiyordu - yani "Taramayi Baslat"a ilk basan kisi bekliyordu.
// Artik bagalanti kurulur kurulmaz arka planda baslatiliyor; butona basildiginda
// liste cogu zaman hazir oluyor.
function ensureMembersFetched(guild) {
    if (!membersFetchPromise) {
        const basladi = Date.now();
        membersState = { status: 'yukleniyor', count: 0, ms: null };
        broadcastMembersState();
        membersFetchPromise = guild.members.fetch()
            .then((uyeler) => {
                const sure = Date.now() - basladi;
                membersState = { status: 'hazir', count: uyeler.size, ms: sure };
                broadcastMembersState();
                console.log(`[Uyeler] ${uyeler.size} uye ${(sure / 1000).toFixed(1)} sn'de cekildi.`);
                return uyeler;
            })
            .catch((error) => {
                membersFetchPromise = null;
                membersState = { status: 'hata', count: 0, ms: null };
                broadcastMembersState();
                throw error;
            });
    }
    return membersFetchPromise;
}

// Bagalanti kurulunca uye listesini onden hazirla.
async function primeMembers() {
    try {
        const guild = client.guilds.cache.get(GUILD_ID) || await client.guilds.fetch(GUILD_ID);
        if (!guild) return;
        if (!(await waitForGuildShard(guild))) return;
        console.log('[Uyeler] Uye listesi arka planda cekiliyor...');
        await ensureMembersFetched(guild);
    } catch (error) {
        console.log(`[Uyeler] Onden cekme basarisiz: ${error.message}`);
    }
}

function repairGuildShardId(guild) {
    if ((guild.shardId === undefined || guild.shardId === null) && client.ws.shards.size === 1) {
        guild.shardId = client.ws.shards.firstKey();
    }
}

async function waitForGuildShard(guild, timeoutMs = 20000, intervalMs = 500) {
    repairGuildShardId(guild);
    const deadline = Date.now() + timeoutMs;
    while (!guild.shard) {
        if (Date.now() >= deadline) return false;
        repairGuildShardId(guild);
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    return true;
}

// --- YOKLAMA MANTIĞI (main.js'ten birebir) ---
function getWarningTierIndex(member) {
    let highest = -1;
    WARNING_ROLES.forEach((role, index) => {
        if (member.roles.cache.has(role.id)) highest = Math.max(highest, index);
    });
    return highest;
}

function getNextWarningRole(member) {
    const currentIndex = getWarningTierIndex(member);
    if (currentIndex >= WARNING_ROLES.length - 1) return null;
    return WARNING_ROLES[currentIndex + 1];
}

async function fetchRecentExcusesFrom(channelId, lookbackMs, logLabel) {
    const excuseByAuthor = new Map();
    let channel;
    try {
        channel = await client.channels.fetch(channelId);
    } catch (error) {
        console.log(`[Yoklama] ${logLabel} kanalı alınamadı: ${error.message}`);
        return excuseByAuthor;
    }
    if (!channel) return excuseByAuthor;

    const cutoff = Date.now() - lookbackMs;
    let beforeId;
    const MAX_PAGES = 10;

    for (let page = 0; page < MAX_PAGES; page += 1) {
        const options = { limit: 100 };
        if (beforeId) options.before = beforeId;
        let batch;
        try {
            // eslint-disable-next-line no-await-in-loop
            batch = await channel.messages.fetch(options);
        } catch (error) {
            console.log(`[Yoklama] ${logLabel} kanalı mesajları alınamadı (sayfa ${page + 1}): ${error.message}`);
            break;
        }
        if (batch.size === 0) break;

        let reachedCutoff = false;
        for (const message of batch.values()) {
            if (message.createdTimestamp < cutoff) { reachedCutoff = true; break; }
            const existing = excuseByAuthor.get(message.author.id);
            if (!existing || message.createdTimestamp > existing.createdTimestamp) {
                excuseByAuthor.set(message.author.id, {
                    content: message.content,
                    createdTimestamp: message.createdTimestamp,
                    reactions: [...message.reactions.cache.values()].map((reaction) => ({
                        emoji: reaction.emoji.name || reaction.emoji.toString(),
                        count: reaction.count,
                    })),
                });
            }
        }
        beforeId = batch.last() ? batch.last().id : undefined;
        if (reachedCutoff || batch.size < 100) break;
    }
    return excuseByAuthor;
}

function fetchRecentExcuses() {
    return fetchRecentExcusesFrom(EXCUSE_CHANNEL_ID, EXCUSE_LOOKBACK_MS, 'Mazaret');
}
function fetchRecentLongExcuses() {
    return fetchRecentExcusesFrom(LONG_EXCUSE_CHANNEL_ID, LONG_EXCUSE_LOOKBACK_MS, 'Uzun mazeret');
}

async function runYoklamaScan() {
    const t0 = Date.now();
    const sureler = {};
    const asama = (ad) => wsBroadcast({ type: 'yoklama-asama', asama: ad });

    let guild = client.guilds.cache.get(GUILD_ID);
    if (!guild) {
        try {
            guild = await client.guilds.fetch(GUILD_ID);
        } catch (error) {
            throw new Error(`Sunucu alınamadı: ${error.message}`);
        }
    }
    if (!guild) throw new Error('Sunucu bulunamadı, GUILD_ID hatalı olabilir.');
    if (!(await waitForGuildShard(guild))) {
        throw new Error('Bu sunucu için gateway bağlantısı (shard) uzun süredir hazır değil. Sunucu sürecini yeniden başlatmayı dene.');
    }

    asama(membersState.status === 'hazir' ? 'Üye listesi hazır' : 'Üye listesi alınıyor (ilk seferde uzun sürebilir)...');
    const tUye = Date.now();
    try {
        await ensureMembersFetched(guild);
    } catch (error) {
        throw new Error(`Üye listesi alınamadı - "Missing Access" ise bu hesabın gerekli yetkisi yok olabilir: ${error.message}`);
    }
    sureler.uyeler = Date.now() - tUye;

    const inVoiceIds = new Set();
    guild.channels.cache.forEach((channel) => {
        if (channel.type === 'GUILD_VOICE' || channel.type === 'GUILD_STAGE_VOICE') {
            channel.members.forEach((member) => inVoiceIds.add(member.id));
        }
    });

    const attendanceMembers = guild.members.cache.filter((member) => (
        ATTENDANCE_ROLE_IDS.some((roleId) => member.roles.cache.has(roleId))
    ));

    asama('Mazeret kanalları taranıyor...');
    const tMazeret = Date.now();
    const [excuseByAuthor, longExcuseByAuthor] = await Promise.all([
        fetchRecentExcuses(),
        fetchRecentLongExcuses(),
    ]);
    sureler.mazeretler = Date.now() - tMazeret;

    const results = [...attendanceMembers.values()].map((member) => {
        const inVoice = inVoiceIds.has(member.id);
        const excuse = !inVoice ? (excuseByAuthor.get(member.id) || null) : null;
        const longExcuse = !inVoice ? (longExcuseByAuthor.get(member.id) || null) : null;
        const nextRole = getNextWarningRole(member);
        const currentTierIndex = getWarningTierIndex(member);
        return {
            id: member.id,
            displayName: member.displayName,
            tag: member.user.tag,
            avatarURL: member.displayAvatarURL({ size: 64 }),
            inVoice,
            excuseText: excuse ? excuse.content : null,
            excuseReactions: excuse ? excuse.reactions : [],
            excuseAt: excuse ? excuse.createdTimestamp : null,
            longExcuseText: longExcuse ? longExcuse.content : null,
            longExcuseReactions: longExcuse ? longExcuse.reactions : [],
            longExcuseAt: longExcuse ? longExcuse.createdTimestamp : null,
            currentTierLabel: currentTierIndex >= 0 ? WARNING_ROLES[currentTierIndex].label : null,
            nextTierLabel: nextRole ? nextRole.label : null,
            isMaxTier: !nextRole,
        };
    });

    results.sort((a, b) => {
        if (a.inVoice !== b.inVoice) return a.inVoice ? 1 : -1;
        return a.displayName.localeCompare(b.displayName, 'tr');
    });

    const totalInVoice = results.filter((m) => m.inVoice).length;
    sureler.toplam = Date.now() - t0;
    const mb = (n) => Math.round(n / 1024 / 1024);
    const bellek = process.memoryUsage();
    console.log(`[Yoklama] Tarama tamamlandi: ${results.length} yetkili, ${totalInVoice} sesde. `
        + `Sureler -> uyeler: ${(sureler.uyeler / 1000).toFixed(1)}sn, `
        + `mazeretler: ${(sureler.mazeretler / 1000).toFixed(1)}sn, `
        + `toplam: ${(sureler.toplam / 1000).toFixed(1)}sn. `
        + `Bellek -> heap ${mb(bellek.heapUsed)}/${mb(bellek.heapTotal)} MB, rss ${mb(bellek.rss)} MB.`);
    asama('');

    return {
        scannedAt: Date.now(),
        timings: sureler,
        totalChecked: results.length,
        totalInVoice,
        members: results,
    };
}

// --- ROL BOTU KOMUTLARI (main.js'ten birebir) ---
// ============================================================================
// --- SLASH KOMUT GONDERME (ID ile) ---
// Kutuphanenin sendSlash'i komutu YALNIZCA ADA gore buluyor; ad tutmayinca
// "SlashCommand X is not found" firlatiyor ve rol verme sessizce calismiyor.
// Bu yuzden komutu kendimiz cozuyoruz: komut ID'si hem komutu hem hangi
// uygulamaya ait oldugunu tek basina belirledigi icin ad tahmin etmeye gerek
// kalmiyor. Ad ile arama yalnizca ID bulunamazsa devreye giriyor.
// ============================================================================

// Komut dizinini kisa sure onbellege aliyoruz: her uyarida yeniden cekmek
// toplu yoklamada onlarca gereksiz istek demek.
let komutDiziniOnbellek = { at: 0, guildId: null, komutlar: [] };
const KOMUT_DIZINI_TTL_MS = 60 * 1000;

async function komutDizinileri(guild, tazele = false) {
    const simdi = Date.now();
    if (!tazele
        && komutDiziniOnbellek.guildId === guild.id
        && simdi - komutDiziniOnbellek.at < KOMUT_DIZINI_TTL_MS) {
        return komutDiziniOnbellek.komutlar;
    }
    const data = await client.api.guilds[guild.id]['application-command-index'].get();
    const komutlar = (data && data.application_commands) || [];
    komutDiziniOnbellek = { at: simdi, guildId: guild.id, komutlar };
    return komutlar;
}

// Ham komut kaydini kutuphanenin ApplicationCommand nesnesine cevirir.
// sendSlashCommand'i cagirabilmek icin komutun, sahibi olan uygulamanin
// komut onbelleginde durmasi gerekiyor - sendSlash da aynisini yapiyor.
async function komutNesnesi(hamKomut) {
    const user = await client.users.fetch(hamKomut.application_id).catch(() => null);
    if (!user || !user.bot || !user.application) {
        throw new Error(`Komutun sahibi ${hamKomut.application_id} bot olarak getirilemedi.`);
    }
    if (user._partial) await user.getProfile().catch(() => {});
    user.application.commands._add(hamKomut, true);
    const nesne = user.application.commands.cache.get(hamKomut.id);
    if (!nesne) throw new Error(`Komut ${hamKomut.name} (${hamKomut.id}) önbelleğe alınamadı.`);
    return nesne;
}

// Komutu once ID, sonra ad ile bulur. Bulamazsa NE OLDUGUNU soyleyen bir hata
// firlatiyor - eskiden sadece "is not found" yaziyordu ve elde bir sey yoktu.
async function rolKomutunuBul(guild, { komutId, komutAdi, botId }) {
    let komutlar = await komutDizinileri(guild);

    const idIle = (liste) => (komutId ? liste.find((c) => c.id === komutId && c.type === 1) : null);
    const adIle = (liste) => (komutAdi
        ? liste.find((c) => c.type === 1 && c.name === komutAdi && c.application_id === botId)
        : null);

    let bulunan = idIle(komutlar) || adIle(komutlar);
    if (!bulunan) {
        // Onbellek eski olabilir - bir kez taze dizinle dene.
        komutlar = await komutDizinileri(guild, true);
        bulunan = idIle(komutlar) || adIle(komutlar);
    }
    if (bulunan) return bulunan;

    const botunkiler = komutlar
        .filter((c) => c.type === 1 && c.application_id === botId)
        .map((c) => `/${c.name} (${c.id})`);
    const rolGecenler = komutlar
        .filter((c) => c.type === 1 && /rol|role/i.test(c.name))
        .map((c) => `/${c.name} (${c.id})`);

    const parcalar = [];
    if (komutId) {
        // En sik yapilan hata: komut ID'si yerine mesaj ID'si yapistirmak.
        parcalar.push(`"${komutId}" sunucunun slash komut dizininde yok. `
            + 'Bu bir MESAJ ID\'si olabilir - gereken sey KOMUT ID\'si '
            + '(Discord\'da komutu etiketlerken cikan </ad:ID> icindeki sayi).');
    }
    parcalar.push(botunkiler.length
        ? `Ayarli botun (${botId}) komutlari: ${botunkiler.join(', ')}`
        : `Ayarli botun (${botId}) dizinde hic slash komutu yok (toplam ${komutlar.length} komut tarandi).`);
    if (rolGecenler.length) {
        parcalar.push(`Adinda "rol" gecen komutlar: ${rolGecenler.join(', ')}`);
    }
    parcalar.push('Ayarlar > Rol Botu Komutlari > "Botun komutlarini listele" ile dogru ID\'yi secebilirsin.');

    throw new Error(`Rol komutu bulunamadi (ID: ${komutId || 'yok'}, ad: ${komutAdi || 'yok'}). ${parcalar.join(' ')}`);
}

// sendSlash'in yerine gecen gonderim. args, komutun secenek sirasina gore
// pozisyonel olarak gidiyor - sendSlash de aynisini yapiyor.
async function rolSlashGonder(guild, channel, secim, ...args) {
    const komut = await rolKomutunuBul(guild, secim);
    const nesne = await komutNesnesi(komut);
    const sahteMesaj = new SlashMesaji(client, {
        channel_id: channel.id,
        guild_id: guild.id,
        author: client.user,
        content: '',
        id: client.user.id,
    });
    await nesne.sendSlashCommand(sahteMesaj, [], args);
    return { name: komut.name, id: komut.id, applicationId: komut.application_id };
}

function waitForRoleBotReply(timeoutMs = 6000) {
    return new Promise((resolve) => {
        const onMessage = (message) => {
            if (message.channelId !== ROLE_COMMAND_CHANNEL_ID) return;
            if (message.author.id !== rolBotId()) return;
            cleanup();
            const embedText = message.embeds && message.embeds[0]
                ? (message.embeds[0].description || message.embeds[0].title || '')
                : '';
            resolve(message.content || embedText || null);
        };
        const timer = setTimeout(() => {
            cleanup();
            resolve(null);
        }, timeoutMs);
        function cleanup() {
            clearTimeout(timer);
            client.removeListener('messageCreate', onMessage);
        }
        client.on('messageCreate', onMessage);
    });
}

// Rol botuna komut gondermek, rolun VERILDIGI anlamina gelmiyor: bot komutu
// reddedebilir (yetki yok, hiyerarsi, komut adi degismis), sessizce
// dusurebilir ya da hic cevap vermeyebilir. Daha once gonderim basarili
// olunca "verildi" deniyordu; bu yuzden panel rol vermedigi halde verdim
// diyordu. Artik uyeyi taze cekip rolun gercekten olustugunu dogruluyoruz.
async function verifyRoleState(guild, memberId, roleId, beklenen) {
    const DENEME = 4;
    const ARALIK_MS = 800;
    for (let i = 0; i < DENEME; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, ARALIK_MS));
        try {
            // force: onbellegi atla, Discord'dan taze oku
            // eslint-disable-next-line no-await-in-loop
            const taze = await guild.members.fetch({ user: memberId, force: true });
            if (taze && taze.roles.cache.has(roleId) === beklenen) return true;
        } catch (error) {
            // uye cekilemedi - sonraki denemede tekrar bakilir
        }
    }
    return false;
}

// --- KALICI UYARI GEÇMİŞİ ---
// Masaüstü uygulamasıyla AYNI ../warning-history.json dosyasını kullanıyor -
// hangisinden uyarı verilirse verilsin tek bir ortak geçmiş/aktif-rol kaydı.
const WARNING_HISTORY_PATH = path.join(ROOT_DIR, 'warning-history.json');
const WARNING_HISTORY_CAP = 500;

function loadWarningState() {
    try {
        const data = JSON.parse(fs.readFileSync(WARNING_HISTORY_PATH, 'utf8'));
        return {
            active: (data && typeof data.active === 'object' && data.active) || {},
            history: Array.isArray(data && data.history) ? data.history : [],
        };
    } catch (error) {
        return { active: {}, history: [] };
    }
}

const loadedWarningState = loadWarningState();
const lastGivenRole = new Map(Object.entries(loadedWarningState.active));
const warningHistory = loadedWarningState.history;

function persistWarningState() {
    try {
        fs.writeFileSync(WARNING_HISTORY_PATH, JSON.stringify({
            active: Object.fromEntries(lastGivenRole),
            history: warningHistory,
        }));
    } catch (error) {
        console.log(`[UyarıGeçmişi] Kaydedilemedi: ${error.message}`);
    }
}

function addWarningHistoryEntry(entry) {
    const fullEntry = { at: Date.now(), ...entry };
    warningHistory.push(fullEntry);
    while (warningHistory.length > WARNING_HISTORY_CAP) warningHistory.shift();
    persistWarningState();
    wsBroadcast({ type: 'uyari-gecmisi-yeni', entry: fullEntry });
}

// reason: hem duyuru mesajinda hem uyari gecmisinde kullanilir.
// announceIndividually=false ise TEKLI duyuru mesaji atilmaz (toplu islemlerde
// duyuru en sonda tek mesaj olarak atiliyor) ama sebep yine de gecmise yazilir.
// ============================================================================
// --- HESAP (DENETIM) GUNLUGU ---
// Panelde kim ne yapti: girisler, basarisiz denemeler, hesap degisiklikleri ve
// Discord'u etkileyen islemler (rol ver/al, uyari, yoklama, acil toplanti).
// warning-history.json'dan ayri tutuluyor - o sadece uyari kayitlari icin.
// ============================================================================
const AUDIT_LOG_PATH = path.join(ROOT_DIR, 'panel-audit.json');
const AUDIT_CAP = 2000;

function loadAuditLog() {
    try {
        const data = JSON.parse(fs.readFileSync(AUDIT_LOG_PATH, 'utf8'));
        return Array.isArray(data) ? data : [];
    } catch (error) {
        return [];
    }
}

const auditLog = loadAuditLog();

function persistAuditLog() {
    try {
        fs.writeFileSync(AUDIT_LOG_PATH, JSON.stringify(auditLog));
    } catch (error) {
        console.log(`[HesapLog] Kaydedilemedi: ${error.message}`);
    }
}

// type: giris | giris-hata | cikis | hesap-ekle | hesap-sil | hesap-guncelle
//     | rol-ver | rol-al | uyari-ver | uyari-geri-al | yoklama-al | acil-toplanti
function addAudit(type, actor, detail, req) {
    const entry = {
        at: Date.now(),
        type,
        actor: actor || null,
        detail: detail || '',
        ip: req ? (req.ip || (req.socket && req.socket.remoteAddress) || null) : null,
    };
    auditLog.push(entry);
    while (auditLog.length > AUDIT_CAP) auditLog.shift();
    persistAuditLog();
    wsBroadcast({ type: 'hesap-log-yeni', entry });
    return entry;
}

async function giveNextWarningRole(memberId, reason, announceIndividually = true, verenId = null) {
    const guild = client.guilds.cache.get(GUILD_ID) || await client.guilds.fetch(GUILD_ID);
    if (!guild) throw new Error('Sunucu bulunamadı, GUILD_ID hatalı olabilir.');
    if (!(await waitForGuildShard(guild))) {
        throw new Error('Bu sunucu için gateway bağlantısı (shard) uzun süredir hazır değil.');
    }

    let member;
    try {
        member = await guild.members.fetch(memberId);
    } catch (error) {
        throw new Error(`Kişi bilgisi alınamadı: ${error.message}`);
    }

    const nextRole = getNextWarningRole(member);
    if (!nextRole) {
        return { ok: false, reason: 'max', currentTierLabel: WARNING_ROLES[WARNING_ROLES.length - 1].label };
    }

    let commandChannel;
    try {
        commandChannel = await client.channels.fetch(ROLE_COMMAND_CHANNEL_ID);
    } catch (error) {
        throw new Error(`Komut kanalı alınamadı: ${error.message}`);
    }
    if (!commandChannel) throw new Error('Komut kanalı bulunamadı, ROLE_COMMAND_CHANNEL_ID hatalı olabilir.');

    const replyPromise = waitForRoleBotReply();
    const gonderilen = await rolSlashGonder(
        guild, commandChannel,
        { komutId: rolVerKomutId(), komutAdi: panelSettings.rolVerKomutu, botId: rolBotId() },
        memberId, nextRole.id,
    );
    const botReply = await replyPromise;

    console.log(`[Yoklama] ${member.user.tag} (${memberId}) için "/${gonderilen.name}" (${gonderilen.id}) gönderildi: ${nextRole.label} (${nextRole.id}). Bot cevabı: ${botReply || '(yakalanamadı)'}`);

    // Rol gercekten olustu mu? Olusmadiysa basarili sayilmiyor ve gecmise de
    // yazilmiyor - yoksa "Geri Al" hic verilmemis bir rolu geri almaya calisir.
    const uygulandi = await verifyRoleState(guild, memberId, nextRole.id, true);
    if (!uygulandi) {
        console.log(`[Yoklama] DOGRULANAMADI: ${member.user.tag} kişisinde "${nextRole.label}" rolü oluşmadı.`
            + ` Rol botu komutu reddetmiş olabilir. Bot cevabı: ${botReply || '(yok)'}`);
        return {
            ok: false,
            reason: 'dogrulanamadi',
            attemptedLabel: nextRole.label,
            botReply,
            error: `Rol botu "${nextRole.label}" rolünü vermedi (komut gönderildi ama rol oluşmadı).`
                + (botReply ? ` Bot cevabı: ${botReply}` : ' Bot cevap vermedi.'),
        };
    }

    lastGivenRole.set(memberId, { roleId: nextRole.id, label: nextRole.label, tag: member.user.tag });

    let announceError = null;
    if (reason && announceIndividually) {
        try {
            const channel = await client.channels.fetch(WARNING_ANNOUNCE_CHANNEL_ID);
            if (!channel) throw new Error('Uyarı kanalı bulunamadı, WARNING_ANNOUNCE_CHANNEL_ID hatalı olabilir.');
            const announceMessage = await channel.send(buildSingleWarningAnnounceMessage(memberId, nextRole.id, reason, verenId));
            const record = lastGivenRole.get(memberId);
            if (record) {
                record.announceChannelId = WARNING_ANNOUNCE_CHANNEL_ID;
                record.announceMessageId = announceMessage.id;
                record.announceMemberCount = 1;
            }
        } catch (error) {
            announceError = error.message;
            console.log(`[Yoklama] Tekli uyarı duyuru mesajı gönderilemedi: ${error.message}`);
        }
    }

    addWarningHistoryEntry({
        type: 'given',
        memberId,
        memberTag: member.user.tag,
        label: nextRole.label,
        reason: reason || null,
        byTag: client.user ? client.user.tag : null,
        byDiscordId: verenId || null,
    });

    return { ok: true, givenLabel: nextRole.label, botReply, announceError };
}

function formatWarningEndDate() {
    const end = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const day = String(end.getDate()).padStart(2, '0');
    const month = String(end.getMonth() + 1).padStart(2, '0');
    const year = end.getFullYear();
    return `${day}.${month}.${year}`;
}

function buildSingleWarningAnnounceMessage(memberId, givenRoleId, reason, verenId) {
    const selfId = verenId || client.user.id;
    return [
        `# Uyarı alan :  <@${memberId}>`,
        `# Uyarı veren : <@${selfId}>`,
        `# Uyarı sebebi : ${reason}`,
        `# Uyarı :  <@&${givenRoleId}>`,
        `# Uyarı bitiş tarihi : ${formatWarningEndDate()}`,
    ].join('\n');
}

async function undoLastWarning(memberId) {
    const record = lastGivenRole.get(memberId);
    if (!record) {
        throw new Error('Bu kişi için geri alınacak, bu oturumda verilmiş bir uyarı bulunamadı.');
    }

    const guild = client.guilds.cache.get(GUILD_ID) || await client.guilds.fetch(GUILD_ID);
    if (!guild) throw new Error('Sunucu bulunamadı, GUILD_ID hatalı olabilir.');
    if (!(await waitForGuildShard(guild))) {
        throw new Error('Bu sunucu için gateway bağlantısı (shard) uzun süredir hazır değil.');
    }

    let commandChannel;
    try {
        commandChannel = await client.channels.fetch(ROLE_COMMAND_CHANNEL_ID);
    } catch (error) {
        throw new Error(`Komut kanalı alınamadı: ${error.message}`);
    }
    if (!commandChannel) throw new Error('Komut kanalı bulunamadı, ROLE_COMMAND_CHANNEL_ID hatalı olabilir.');

    const replyPromise = waitForRoleBotReply();
    const gonderilen = await rolSlashGonder(
        guild, commandChannel,
        { komutId: rolAlKomutId(), komutAdi: panelSettings.rolAlKomutu, botId: rolBotId() },
        memberId, record.roleId,
    );
    const botReply = await replyPromise;

    console.log(`[Yoklama] ${record.tag} (${memberId}) için "/${gonderilen.name}" (${gonderilen.id}) gönderildi (geri alma): ${record.label} (${record.roleId}). Bot cevabı: ${botReply || '(yakalanamadı)'}`);

    const kaldirildi = await verifyRoleState(guild, memberId, record.roleId, false);
    if (!kaldirildi) {
        console.log(`[Yoklama] DOGRULANAMADI: ${record.tag} kişisinden "${record.label}" rolü kaldırılmadı.`);
        // Kayit duruyor - tekrar denenebilsin diye siliyoruz degil.
        return {
            ok: false,
            reason: 'dogrulanamadi',
            botReply,
            error: `Rol botu "${record.label}" rolünü kaldırmadı (komut gönderildi ama rol duruyor).`
                + (botReply ? ` Bot cevabı: ${botReply}` : ' Bot cevap vermedi.'),
        };
    }

    lastGivenRole.delete(memberId);

    let announceError = null;
    let announceDeleted = false;
    let announceSkippedShared = false;

    if (record.announceMessageId) {
        const stillReferenced = [...lastGivenRole.values()]
            .some((r) => r.announceMessageId === record.announceMessageId);

        if (!stillReferenced) {
            try {
                const channel = await client.channels.fetch(record.announceChannelId);
                if (!channel) throw new Error('Uyarı kanalı bulunamadı.');
                const announceMessage = await channel.messages.fetch(record.announceMessageId);
                await announceMessage.delete();
                announceDeleted = true;
            } catch (error) {
                announceError = `Duyuru mesajı silinemedi: ${error.message}`;
                console.log(`[Yoklama] Geri alma - duyuru mesajı silinemedi: ${error.message}`);
            }
        } else {
            announceSkippedShared = true;
        }
    }

    addWarningHistoryEntry({
        type: 'undone',
        memberId,
        memberTag: record.tag,
        label: record.label,
        reason: null,
        byTag: client.user ? client.user.tag : null,
    });

    return { ok: true, removedLabel: record.label, botReply, announceError, announceDeleted, announceSkippedShared };
}

function buildWarningAnnounceMessage(warnedMemberIds, reason, verenId) {
    const warnedMentions = warnedMemberIds.map((id) => `<@${id}>`).join('  ');
    const ladderMentions = WARNING_ROLES.map((role) => `<@&${role.id}>`).join(' Olanlara ');
    const selfId = verenId || client.user.id;
    return [
        `# Uyarı alan :  ${warnedMentions}`,
        `# Uyarı veren : <@${selfId}>`,
        `# Uyarı sebebi : ${reason}`,
        `# Uyarı : ${ladderMentions}`,
        `# Uyarı bitiş tarihi : ${formatWarningEndDate()}`,
    ].join('\n');
}

// duyuruKanalId: uyari duyurusunun gidecegi kanal. Bos birakilirsa
// WARNING_ANNOUNCE_CHANNEL_ID kullaniliyor. Zamanlanmis yoklamalarin her biri
// kendi kanalina yazabilsin diye parametre.
async function giveBulkWarning(memberIds, reason, verenId = null, duyuruKanalId = null) {
    const guild = client.guilds.cache.get(GUILD_ID) || await client.guilds.fetch(GUILD_ID);
    if (!guild) throw new Error('Sunucu bulunamadı, GUILD_ID hatalı olabilir.');
    if (!(await waitForGuildShard(guild))) {
        throw new Error('Bu sunucu için gateway bağlantısı (shard) uzun süredir hazır değil.');
    }

    const warned = [];
    const skipped = [];
    const failed = [];

    for (let i = 0; i < memberIds.length; i += 1) {
        const memberId = memberIds[i];
        wsBroadcast({ type: 'yoklama-toplu-uyari-ilerleme', current: i + 1, total: memberIds.length });

        try {
            // eslint-disable-next-line no-await-in-loop
            const result = await giveNextWarningRole(memberId, reason, false, verenId);
            if (result.ok) {
                warned.push({ id: memberId, givenLabel: result.givenLabel, botReply: result.botReply });
            } else if (result.reason === 'dogrulanamadi') {
                failed.push({ id: memberId, error: result.error });
            } else if (result.reason === 'max') {
                let tag = memberId;
                try {
                    // eslint-disable-next-line no-await-in-loop
                    const member = await guild.members.fetch(memberId);
                    tag = member.user.tag;
                } catch (error) {
                    // tag alınamazsa ID ile devam
                }
                skipped.push({ id: memberId, tag });
            }
        } catch (error) {
            failed.push({ id: memberId, error: error.message });
        }

        if (i < memberIds.length - 1) {
            // eslint-disable-next-line no-await-in-loop
            await new Promise((resolve) => setTimeout(resolve, BULK_WARNING_DELAY_MS));
        }
    }

    let announceError = null;
    if (warned.length > 0) {
        const hedefKanal = duyuruKanalId || WARNING_ANNOUNCE_CHANNEL_ID;
        try {
            const channel = await client.channels.fetch(hedefKanal);
            if (!channel) throw new Error(`Uyarı kanalı bulunamadı (${hedefKanal}).`);
            const announceMessage = await channel.send(buildWarningAnnounceMessage(warned.map((w) => w.id), reason, verenId));
            warned.forEach(({ id }) => {
                const record = lastGivenRole.get(id);
                if (record) {
                    // Geri alirken duyuruyu silebilmek icin GERCEKTE yazilan
                    // kanali saklamak sart - sabiti yazsaydik farkli kanala
                    // giden duyurular silinemezdi.
                    record.announceChannelId = hedefKanal;
                    record.announceMessageId = announceMessage.id;
                    record.announceMemberCount = warned.length;
                }
            });
        } catch (error) {
            announceError = error.message;
        }
    }

    return { warned, skipped, failed, announceError };
}

async function bulkUndoWarning(memberIds) {
    const removed = [];
    const skipped = [];
    const failed = [];

    for (let i = 0; i < memberIds.length; i += 1) {
        const memberId = memberIds[i];
        wsBroadcast({ type: 'yoklama-toplu-geri-al-ilerleme', current: i + 1, total: memberIds.length });

        if (!lastGivenRole.has(memberId)) {
            skipped.push({ id: memberId });
        } else {
            try {
                // eslint-disable-next-line no-await-in-loop
                const result = await undoLastWarning(memberId);
                removed.push({
                    id: memberId,
                    removedLabel: result.removedLabel,
                    announceDeleted: result.announceDeleted,
                    announceSkippedShared: result.announceSkippedShared,
                    announceError: result.announceError,
                });
            } catch (error) {
                failed.push({ id: memberId, error: error.message });
            }
        }

        if (i < memberIds.length - 1) {
            // eslint-disable-next-line no-await-in-loop
            await new Promise((resolve) => setTimeout(resolve, BULK_WARNING_DELAY_MS));
        }
    }

    return { removed, skipped, failed };
}

async function pullEveryoneToMyVoiceChannel() {
    const guild = client.guilds.cache.get(GUILD_ID) || await client.guilds.fetch(GUILD_ID);
    if (!guild) throw new Error('Sunucu bulunamadı, GUILD_ID hatalı olabilir.');
    if (!(await waitForGuildShard(guild))) {
        throw new Error('Bu sunucu için gateway bağlantısı (shard) uzun süredir hazır değil.');
    }

    let myMember = guild.members.cache.get(client.user.id);
    if (!myMember) {
        myMember = await guild.members.fetch(client.user.id);
    }
    const targetChannelId = myMember.voice.channelId;
    if (!targetChannelId) {
        throw new Error('Önce kendi hesabınla bir ses kanalına gir, sonra acil toplantıyı başlat.');
    }

    try {
        await ensureMembersFetched(guild);
    } catch (error) {
        throw new Error(`Üye listesi alınamadı: ${error.message}`);
    }

    const targets = [...guild.members.cache.values()].filter((member) => (
        ATTENDANCE_ROLE_IDS.some((roleId) => member.roles.cache.has(roleId))
        && member.voice.channelId
        && member.voice.channelId !== targetChannelId
    ));

    const moved = [];
    const failed = [];

    for (let i = 0; i < targets.length; i += 1) {
        const member = targets[i];
        wsBroadcast({ type: 'yoklama-acil-toplanti-ilerleme', current: i + 1, total: targets.length });

        try {
            // eslint-disable-next-line no-await-in-loop
            await member.voice.setChannel(targetChannelId, 'Acil toplantı');
            moved.push({ id: member.id, tag: member.user.tag });
        } catch (error) {
            failed.push({ id: member.id, tag: member.user.tag, error: error.message });
        }

        if (i < targets.length - 1) {
            // eslint-disable-next-line no-await-in-loop
            await new Promise((resolve) => setTimeout(resolve, EMERGENCY_MEETING_DELAY_MS));
        }
    }

    console.log(`[Yoklama] Acil toplantı: ${moved.length} kişi çekildi, ${failed.length} kişi taşınamadı.`);

    return { targetChannelId, moved, failed };
}

// ============================================================================
// --- TX LOGS: tum gecmisi arka planda cekme ---
// Secilen yaklasim: sunucu Discord'a baglanir baglanmaz her log kanalinin TUM
// gecmisi arka planda cekilip bellekte tutuluyor. Panele girildiginde veri
// hazir oluyor; karsiliginda bellek kullanimi mesaj sayisiyla dogru orantili
// artiyor (kaba tahmin: 10.000 mesaj ~ 5-10 MB).
// ============================================================================
const logStore = new Map(); // key -> { ...meta, messages: [], status, loaded, error }
const logChannelIdToKey = new Map();

// Iki liste de ayni depoya giriyor; hangi sekmede gorunecegini "kind" belirliyor.
// SIRA ONEMLI: etkinlik/ticket kanallari ONCE cekiliyor. Bunlar gunluk takip
// icin kullaniliyor, TX Logs ise gerektiginde bakilan bir arsiv. Onceden log
// kanallari once cekildigi icin, buyuk log kanallari olan sunucularda etkinlik
// sayaclari yeniden baslatmadan sonra uzun sure bos gorunuyordu.
const ALL_CHANNELS = [
    ...ACTIVITY_CHANNELS.map((c) => ({ ...c, kind: 'aktivite' })),
    ...LOG_CHANNELS.map((c) => ({ ...c, kind: 'log' })),
];

ALL_CHANNELS.forEach((channel) => {
    logStore.set(channel.key, {
        kind: channel.kind,
        group: channel.group || 'tx',
        personFrom: channel.personFrom || 'author',
        // Bunlar depoya TASINMALI - yoksa resolvePersonDetailed icindeki
        // store.botId / store.personLabel undefined kalir ve bot filtresi
        // sessizce devre disi olur.
        botId: channel.botId || null,
        personLabel: channel.personLabel || null,
        dailyIndex: null,
        unmatched: 0,
        key: channel.key,
        label: channel.label,
        channelId: channel.channelId,
        ilkCekimSiniri: channel.ilkCekimSiniri || null,
        canliKaynak: Boolean(channel.canliKaynak),
        // Bu kanaldaki kayitlar panelden Ban/Supheli/Temiz diye
        // isaretlenebiliyor. Isaretleme YALNIZCA panelde durur -
        // Discord'a hicbir sey gonderilmez.
        // Ad 'durum' DEGIL: bu kod tabaninda durum = kanalin yuklenme durumu.
        isaretTakibi: Boolean(channel.isaretTakibi),
        status: channel.channelId ? 'bekliyor' : 'yapilandirilmamis',
        messages: [],
        loaded: 0,
        error: null,
        fetchedAt: null,
    });
    if (channel.channelId) logChannelIdToKey.set(channel.channelId, channel.key);
});

// --- GUNLUK SAYIM ---
// Gun siniri Turkiye saatine gore; sunucu UTC calisiyor olabilir, gun
// degisimi yanlis yerde olmasin diye sabit saat dilimi kullaniyoruz.
const SAAT_DILIMI = 'Europe/Istanbul';
const gunBicimi = new Intl.DateTimeFormat('en-CA', {
    timeZone: SAAT_DILIMI, year: 'numeric', month: '2-digit', day: '2-digit',
});
function dayKey(ts) {
    return gunBicimi.format(new Date(ts)); // YYYY-MM-DD
}
function bugununAnahtari() {
    return dayKey(Date.now());
}

// --- TARIH ARALIGI ---
// Gun anahtarlari "YYYY-MM-DD" metni. Aralik hesabini UTC uzerinden yapiyoruz:
// yerel saatle Date kurmak yaz saati gecislerinde bir gunu atlatabilir ya da
// iki kez saydirabilirdi. Anahtarlar zaten Turkiye saatine gore uretiliyor,
// burada sadece metin uzerinde gun sayiyoruz.
const GUN_BICIM = /^\d{4}-\d{2}-\d{2}$/;

function gunToUTC(gun) {
    const [y, a, g] = gun.split('-').map(Number);
    return Date.UTC(y, a - 1, g);
}
function utcToGun(ms) {
    return new Date(ms).toISOString().slice(0, 10);
}

// bas..bit arasindaki tum gunler (her iki uc dahil). Ters verilirse duzeltiyor.
function gunAraligi(bas, bit) {
    let b = gunToUTC(bas);
    let s = gunToUTC(bit);
    if (b > s) { const t = b; b = s; s = t; }
    const gunler = [];
    for (let ms = b; ms <= s; ms += 86400000) {
        gunler.push(utcToGun(ms));
        if (gunler.length > 400) break; // guvenlik freni
    }
    return gunler;
}

// Istekten aralik cikar. gun=... verilirse tek gun; bas/bit verilirse aralik.
// Hicbiri yoksa bugun.
function araligiCoz(query) {
    const bas = String((query && query.bas) || '').trim();
    const bit = String((query && query.bit) || '').trim();
    const gun = String((query && query.gun) || '').trim();

    if (bas || bit) {
        if (!GUN_BICIM.test(bas) || !GUN_BICIM.test(bit)) {
            throw new Error('Tarih biçimi YYYY-AA-GG olmalı (başlangıç ve bitiş birlikte verilmeli).');
        }
        const gunler = gunAraligi(bas, bit);
        return { gunler, bas: gunler[0], bit: gunler[gunler.length - 1], aralikMi: true };
    }
    if (gun) {
        if (!GUN_BICIM.test(gun)) throw new Error('Tarih biçimi YYYY-AA-GG olmalı.');
        return { gunler: [gun], bas: gun, bit: gun, aralikMi: false };
    }
    const bugun = bugununAnahtari();
    return { gunler: [bugun], bas: bugun, bit: bugun, aralikMi: false };
}

// Yazarin yetkili olup olmadigi - onbellekten. Uye listesi henuz cekilmediyse
// temkinli davranip false donuyor (yanlis kisiye saymaktansa saymamak yeg).
function isStaffId(id) {
    const guild = client.guilds.cache.get(GUILD_ID);
    if (!guild) return false;
    const member = guild.members.cache.get(id);
    if (!member) return false;
    return ATTENDANCE_ROLE_IDS.some((roleId) => member.roles.cache.has(roleId));
}

// Metin parcalarini SATIR SATIR verir - etiketli satiri bulabilmek icin.
function messageTextLines(entry) {
    const satirlar = [];
    messageTextParts(entry).forEach((parca) => {
        String(parca).split('\n').forEach((satir) => {
            const t = satir.trim();
            if (t) satirlar.push(t);
        });
    });
    return satirlar;
}

// Mesajin metin parcalari - icerik + embed baslik/aciklama/alanlar.
function messageTextParts(entry) {
    const parcalar = [entry.content];
    (entry.embeds || []).forEach((e) => {
        parcalar.push(e.title, e.description);
        (e.fields || []).forEach((f) => parcalar.push(f.name, f.value));
    });
    return parcalar.filter(Boolean).map(String);
}

// Mesajin hangi kisiye sayilacagini bulur ve HANGI yontemle bulundugunu da
// dondurur - bicim kontrolu ekraninda hangi stratejinin tuttugunu gostermek
// icin. Ticket botunun mesaj bicimini gormeden en genis kapsamli yol 'auto'.
function resolvePersonDetailed(store, entry) {
    const mod = store.personFrom || 'author';
    if (mod === 'author') return { id: entry.authorId, via: 'yazar' };

    // Belirli bir bot yapilandirilmissa baska yazarlarin mesajlari sayilmaz.
    if (store.botId && entry.authorId !== store.botId) {
        return { id: null, via: 'farklı yazar' };
    }

    // 'label': yalnizca etiketli satirdaki kisiyi al. Bilerek yedeksiz -
    // ayni mesajda baska kisiler de geciyor, tahmin yurutmek yanlis kisiye
    // sayardi. Etiket bulunamazsa "bulunamadi" deyip bicim kontrolunde
    // gorunur olmasi daha dogru.
    if (mod === 'label') {
        const desen = store.personLabel || /silen|kapatan/i;
        for (const satir of messageTextLines(entry)) {
            if (!desen.test(satir)) continue;
            const m = satir.match(/<@!?(\d+)>/);
            if (m) return { id: m[1], via: 'etiketli satır' };
        }
        return { id: null, via: 'etiket satırı bulunamadı' };
    }

    // 1) <@123> / <@!123> etiketi
    for (const parca of messageTextParts(entry)) {
        const m = parca.match(/<@!?(\d+)>/);
        if (m) return { id: m[1], via: 'etiket' };
    }
    // 2) Ciplak Discord ID'si (17-20 hane) - "Kapatan: 123456789012345678" gibi
    for (const parca of messageTextParts(entry)) {
        const m = parca.match(/(?:^|[^\d])(\d{17,20})(?!\d)/);
        if (m) return { id: m[1], via: 'ham ID' };
    }
    // 3) 'auto' ise son care yazara saymak - AMA yalnizca yazar yetkiliyse.
    //    Kosulsuz yedek tehlikeliydi: ticket loglarini bot attigi icin etiket
    //    bulunamayinca butun sayim sessizce bota gidiyordu ve sonuc "34/34
    //    eslesti" gibi saglikli gorunuyordu. Yetkili olmayan yazara asla
    //    sayilmiyor; boyle bir mesaj "bulunamadi" olarak isaretleniyor ve
    //    bicim kontrolunde hemen goze carpiyor.
    if (mod === 'auto' && entry.authorId && isStaffId(entry.authorId)) {
        return { id: entry.authorId, via: 'yazar (yetkili)' };
    }
    return { id: null, via: null };
}

function resolvePerson(store, entry) {
    return resolvePersonDetailed(store, entry).id;
}

// gun -> (kisi -> adet). Cekme bitince bir kez kuruluyor, yeni mesajlarda
// artiriliyor; her istekte tum gecmisi taramak yerine.
function buildDailyIndex(store) {
    const index = new Map();
    let eslesmeyen = 0;
    store.messages.forEach((entry) => {
        const kisi = resolvePerson(store, entry);
        if (!kisi) { eslesmeyen += 1; return; }
        const gun = dayKey(entry.createdTimestamp);
        if (!index.has(gun)) index.set(gun, new Map());
        const gunluk = index.get(gun);
        const onceki = gunluk.get(kisi);
        gunluk.set(kisi, {
            c: (onceki ? onceki.c : 0) + 1,
            last: Math.max(onceki ? onceki.last : 0, entry.createdTimestamp),
        });
    });
    store.dailyIndex = index;
    store.unmatched = eslesmeyen;
    return index;
}

function addToDailyIndex(store, entry) {
    if (!store.dailyIndex) return;
    const kisi = resolvePerson(store, entry);
    if (!kisi) { store.unmatched = (store.unmatched || 0) + 1; return null; }
    const gun = dayKey(entry.createdTimestamp);
    if (!store.dailyIndex.has(gun)) store.dailyIndex.set(gun, new Map());
    const gunluk = store.dailyIndex.get(gun);
    const onceki = gunluk.get(kisi);
    const yeni = {
        c: (onceki ? onceki.c : 0) + 1,
        last: Math.max(onceki ? onceki.last : 0, entry.createdTimestamp),
    };
    gunluk.set(kisi, yeni);
    return { gun, kisi, adet: yeni.c, last: yeni.last };
}

// ============================================================================
// --- LOG ONBELLEGI (disk) ---
// Kanal gecmisleri her acilista bastan cekiliyordu; 9 log kanali sirayla,
// sayfa basina beklemeyle, on binlerce mesaj -> dakikalarca surer. Artik
// gecmis diske yaziliyor ve yeniden baslatmada yalnizca "en son gordugumuz
// mesajdan sonrasi" cekiliyor.
//
// Discord snowflake ID'leri Number.MAX_SAFE_INTEGER'i astigi icin (19 hane)
// karsilastirmalar BigInt ile yapiliyor - Number'a cevirmek son hanelerde
// sessizce yanlis sonuc verirdi.
// ============================================================================
function idDahaYeni(a, b) {
    try {
        return BigInt(a) > BigInt(b);
    } catch (error) {
        return false;
    }
}

function logCacheYolu(key) {
    return path.join(LOG_CACHE_DIR, `${key}.json`);
}

function logCacheOku(key, channelId) {
    try {
        const ham = JSON.parse(fs.readFileSync(logCacheYolu(key), 'utf8'));
        if (!ham || ham.v !== LOG_CACHE_SURUM) return null;
        // Kanal ID'si degistiyse eski onbellek baska bir kanalin verisi -
        // kullanmak sessizce yanlis log gostermek olurdu.
        if (ham.channelId !== channelId) return null;
        if (!Array.isArray(ham.messages) || ham.messages.length === 0) return null;
        return ham;
    } catch (error) {
        return null; // yok ya da bozuk - tam cekime dusulur
    }
}

function logCacheYaz(store) {
    if (!store.channelId || !store.messages.length) return;
    try {
        fs.mkdirSync(LOG_CACHE_DIR, { recursive: true });
        // _s (arama metni) turetilmis veri - yazmiyoruz, dosyayi neredeyse
        // iki katina cikarirdi; okurken yeniden uretiliyor.
        const govde = JSON.stringify({
            v: LOG_CACHE_SURUM,
            channelId: store.channelId,
            fetchedAt: store.fetchedAt || Date.now(),
            messages: store.messages.map(stripInternal),
        });
        // Once gecici dosyaya yazip tasiyoruz: yazarken surec olurse yarim
        // dosya kalmasin, bir sonraki acilista bozuk onbellek okunmasin.
        const gecici = `${logCacheYolu(store.key)}.tmp`;
        fs.writeFileSync(gecici, govde);
        fs.renameSync(gecici, logCacheYolu(store.key));
        store.cacheKirli = false;
    } catch (error) {
        console.log(`[Loglar] ${store.label} onbellegi yazilamadi: ${error.message}`);
    }
}

// Canli gelen mesajlar da onbellege yansisin diye periyodik yazma. Her mesajda
// yazmak on binlerce satirlik dosyayi surekli yeniden yazmak demekti.
setInterval(() => {
    logStore.forEach((store) => {
        if (store.cacheKirli && store.status === 'hazir') logCacheYaz(store);
    });
}, LOG_CACHE_YAZMA_ARALIGI_MS);

// Kapanirken de yaz - aksi halde son 5 dakikanin mesajlari onbellekte olmaz
// ve bir sonraki acilista tekrar cekilir.
function logCacheHepsiniYaz() {
    logStore.forEach((store) => {
        if (store.cacheKirli && store.messages.length) logCacheYaz(store);
    });
}

// ============================================================================
// --- LOG İŞARETLERİ (Şüpheli Log) ---
// Bir log kaydı panelden "ban / şüpheli / temiz" diye işaretlenebiliyor.
// İşaretler mesaj ID'sine bağlı, mesajların kendisinden AYRI bir dosyada
// duruyor: log önbelleği silinip yeniden çekilse bile işaretler kaybolmuyor.
//
// Bu işaretler Discord'a HİÇBİR ŞEY göndermiyor - ne ban atıyor ne mesaj
// yazıyor. Yalnızca panelde "buna baktık, sonucu şu" kaydı.
// ============================================================================
const LOG_ISARETLERI = ['ban', 'supheli', 'temiz'];
const LOG_ISARET_PATH = path.join(ROOT_DIR, 'log-isaretleri.json');

function logIsaretleriniYukle() {
    try {
        const ham = JSON.parse(fs.readFileSync(LOG_ISARET_PATH, 'utf8'));
        return (ham && typeof ham === 'object' && !Array.isArray(ham)) ? ham : {};
    } catch (error) {
        return {};   // ilk calisma ya da bozuk dosya
    }
}

const logIsaretleri = logIsaretleriniYukle();

function logIsaretleriniYaz() {
    try {
        // Once gecici dosyaya, sonra rename: yazma sirasinda surec olurse
        // dosya yarim kalmasin.
        const gecici = `${LOG_ISARET_PATH}.tmp`;
        fs.writeFileSync(gecici, JSON.stringify(logIsaretleri));
        fs.renameSync(gecici, LOG_ISARET_PATH);
    } catch (error) {
        console.log(`[LogIsaret] Kaydedilemedi: ${error.message}`);
    }
}

// Kayitlara isaretini ekleyerek dondurur. Isareti olmayan kayit "durum: null".
function isaretEkle(entry) {
    const i = logIsaretleri[entry.id];
    return i ? { ...entry, isaret: i } : { ...entry, isaret: null };
}

function serializeLogMessage(message) {
    return {
        id: message.id,
        authorId: message.author ? message.author.id : null,
        authorTag: message.author ? message.author.tag : 'bilinmiyor',
        authorAvatar: message.author ? message.author.displayAvatarURL({ size: 32 }) : null,
        content: message.content || '',
        createdTimestamp: message.createdTimestamp,
        embeds: (message.embeds || []).map((embed) => ({
            title: embed.title || null,
            description: embed.description || null,
            fields: (embed.fields || []).map((f) => ({ name: f.name, value: f.value })),
        })),
        attachments: [...(message.attachments ? message.attachments.values() : [])]
            .map((a) => ({ name: a.name, url: a.url })),
    };
}

// Bir log satirini aranabilir tek bir metne indirger (icerik + embed basligi,
// aciklamasi, alanlari + yazar etiketi). Arama bunun uzerinden yapiliyor.
function logSearchText(entry) {
    const parts = [entry.content, entry.authorTag];
    entry.embeds.forEach((embed) => {
        parts.push(embed.title, embed.description);
        embed.fields.forEach((f) => parts.push(f.name, f.value));
    });
    return parts.filter(Boolean).join(' \n ').toLocaleLowerCase('tr');
}

function broadcastLogStatus(store) {
    wsBroadcast({
        type: 'log-durum',
        key: store.key,
        status: store.status,
        loaded: store.loaded,
        error: store.error,
        fetchedAt: store.fetchedAt,
    });
}

// tamCekim=true: onbellegi yoksay, kanalin tum gecmisini bastan cek.
// "Yenile" dugmesi bunu kullaniyor - silinmis/duzenlenmis mesajlar ancak
// boyle yakalanir, artimli cekim yalnizca YENI mesajlari gorur.
async function fetchAllChannelMessages(key, { tamCekim = false } = {}) {
    const store = logStore.get(key);
    if (!store) throw new Error(`Bilinmeyen log anahtari: ${key}`);
    if (!store.channelId) {
        store.status = 'yapilandirilmamis';
        broadcastLogStatus(store);
        return store;
    }
    if (store.status === 'yukleniyor') return store;

    store.status = 'yukleniyor';
    store.error = null;
    store.loaded = 0;
    broadcastLogStatus(store);

    let channel;
    try {
        channel = await client.channels.fetch(store.channelId);
    } catch (error) {
        store.status = 'hata';
        store.error = `Kanal alinamadi: ${error.message}`;
        console.log(`[Loglar] ${store.label} kanali alinamadi: ${error.message}`);
        broadcastLogStatus(store);
        return store;
    }
    if (!channel) {
        store.status = 'hata';
        store.error = 'Kanal bulunamadi, kanal ID hatali olabilir.';
        broadcastLogStatus(store);
        return store;
    }

    // --- Onbellek: varsa gecmisi diskten al, sadece eksigi cek ---
    let collected = [];
    let onbellekten = 0;
    if (!tamCekim) {
        const cache = logCacheOku(store.key, store.channelId);
        if (cache) {
            collected = cache.messages;
            onbellekten = collected.length;
            store.loaded = onbellekten;
            broadcastLogStatus(store);
        }
    }

    const basladi = Date.now();
    let yeniSayisi = 0;

    if (onbellekten > 0) {
        // Artimli: onbellekteki EN YENI mesajdan sonrasini al. Discord "after"
        // ile ileri dogru sayfaliyor; her turda gordugumuz en buyuk ID imlec
        // oluyor.
        let imlec = collected[0].id;
        collected.forEach((m) => { if (idDahaYeni(m.id, imlec)) imlec = m.id; });

        for (;;) {
            let batch;
            try {
                // eslint-disable-next-line no-await-in-loop
                batch = await channel.messages.fetch({ limit: 100, after: imlec });
            } catch (error) {
                store.error = `Yeni mesajlar alinirken durdu: ${error.message}`;
                console.log(`[Loglar] ${store.label}: ${store.error}`);
                break;
            }
            if (batch.size === 0) break;

            let enBuyuk = imlec;
            batch.forEach((message) => {
                collected.push(serializeLogMessage(message));
                if (idDahaYeni(message.id, enBuyuk)) enBuyuk = message.id;
            });
            yeniSayisi += batch.size;
            imlec = enBuyuk;

            store.loaded = collected.length;
            broadcastLogStatus(store);

            if (batch.size < 100) break;
            // eslint-disable-next-line no-await-in-loop
            await new Promise((resolve) => setTimeout(resolve, LOG_PAGE_DELAY_MS));
        }
    } else {
        // Ilk kez (ya da "Yenile"): kanalin en basina inene kadar 100'erli
        // sayfalarla geriye dogru gidiyoruz. ilkCekimSiniri tanimliysa o kadar
        // mesajda duruyoruz - bazi kanallarin tum gecmisine ihtiyac yok, son N
        // mesaj yetiyor ve gerisi bosuna indirilmis oluyor.
        const sinir = store.ilkCekimSiniri || 0;
        let beforeId;
        for (;;) {
            const kalan = sinir ? sinir - collected.length : 100;
            const options = { limit: Math.min(100, Math.max(1, kalan)) };
            if (beforeId) options.before = beforeId;
            let batch;
            try {
                // eslint-disable-next-line no-await-in-loop
                batch = await channel.messages.fetch(options);
            } catch (error) {
                store.error = `Mesajlar alinirken durdu (${collected.length} mesaj cekilmisti): ${error.message}`;
                console.log(`[Loglar] ${store.label}: ${store.error}`);
                break;
            }
            if (batch.size === 0) break;

            batch.forEach((message) => collected.push(serializeLogMessage(message)));
            beforeId = batch.last() ? batch.last().id : undefined;
            yeniSayisi = collected.length;

            store.loaded = collected.length;
            broadcastLogStatus(store);

            if (sinir && collected.length >= sinir) break;
            if (batch.size < options.limit || !beforeId) break;
            // eslint-disable-next-line no-await-in-loop
            await new Promise((resolve) => setTimeout(resolve, LOG_PAGE_DELAY_MS));
        }
    }

    // Ayni mesaj iki kez girmesin: canli 'messageCreate' ile onbellek arasinda
    // ortusme olabiliyor (mesaj hem canli eklenip hem onbellege yazilmis, sonra
    // "after" ile tekrar gelmis olabilir).
    const gorulen = new Set();
    collected = collected.filter((entry) => {
        if (gorulen.has(entry.id)) return false;
        gorulen.add(entry.id);
        return true;
    });

    collected.sort((a, b) => b.createdTimestamp - a.createdTimestamp); // en yeni ustte
    collected.forEach((entry) => { entry._s = logSearchText(entry); });

    store.messages = collected;
    store.loaded = collected.length;
    store.fetchedAt = Date.now();
    if (store.kind === 'aktivite') buildDailyIndex(store);
    store.status = store.error ? 'hata' : 'hazir';
    broadcastLogStatus(store);

    const saniye = ((Date.now() - basladi) / 1000).toFixed(1);
    if (onbellekten > 0) {
        console.log(`[Loglar] ${store.label}: ${onbellekten} mesaj onbellekten, `
            + `${yeniSayisi} yeni mesaj ${saniye} sn'de cekildi (toplam ${collected.length}).`);
    } else {
        console.log(`[Loglar] ${store.label}: ${collected.length} mesaj ${saniye} sn'de cekildi`
            + `${store.ilkCekimSiniri ? ` (son ${store.ilkCekimSiniri} ile sinirli)` : ''}.`);
    }

    // Onbellegi tazele - artimli cekimde bile yaziyoruz ki bir sonraki acilis
    // bu noktadan devam etsin.
    if (!store.error) logCacheYaz(store);
    return store;
}

// ============================================================================
// --- TICKET SAHIPLENME SAYACI ---
// Ticket kanallari kategorinin altinda acilip siliniyor; silinen kanalin
// gecmisi cekilemez. Bu yuzden sahiplenme mesajlari CANLI yakalanip diske
// yaziliyor, acilista oradan geri yukleniyor.
//
// Kayitlar log makinesinin anladigi bicimde (serializeLogMessage ciktisi gibi)
// tutuluyor: boylece gunluk indeks, tarih araligi, kisi basina liste ve
// Etkinlik sekmesi hicbir degisiklik olmadan calisiyor.
// ============================================================================
function canliKaynakYolu(key) {
    return path.join(ROOT_DIR, `canli-${key}.json`);
}

function canliKaynagiYukle(key) {
    const store = logStore.get(key);
    if (!store) return;
    let kayitlar = [];
    try {
        const ham = JSON.parse(fs.readFileSync(canliKaynakYolu(key), 'utf8'));
        if (Array.isArray(ham)) kayitlar = ham;
    } catch (error) {
        kayitlar = []; // ilk calisma ya da bozuk dosya - bostan basliyoruz
    }
    kayitlar.forEach((entry) => { entry._s = logSearchText(entry); });
    store.messages = kayitlar;
    store.loaded = kayitlar.length;
    store.fetchedAt = Date.now();
    buildDailyIndex(store);
    store.status = 'hazir';
    broadcastLogStatus(store);
    console.log(`[Sahiplenme] ${kayitlar.length} kayit diskten yuklendi.`);
}

function canliKaynagiYaz(key) {
    const store = logStore.get(key);
    if (!store) return;
    try {
        const gecici = `${canliKaynakYolu(key)}.tmp`;
        fs.writeFileSync(gecici, JSON.stringify(store.messages.map(stripInternal)));
        fs.renameSync(gecici, canliKaynakYolu(key));
    } catch (error) {
        console.log(`[Sahiplenme] Kaydedilemedi: ${error.message}`);
    }
}

// Eslesmeyen mesajlar: bot metni degistirirse sessizce sayim durmasin diye
// son birkacini teshis icin tutuyoruz.
const sahiplenmeEslesmeyen = [];

function sahiplenmeYakala(message) {
    const store = logStore.get('sahiplenme');
    if (!store) return;

    // Ayni mesaj iki kez sayilmasin
    if (store.messages.some((m) => m.id === message.id)) return;

    const embed = (message.embeds && message.embeds[0]) || null;
    const metinler = [
        embed ? (embed.description || '') : '',
        embed ? (embed.title || '') : '',
        message.content || '',
    ];
    let sahip = null;
    for (const metin of metinler) {
        const m = TICKET_SAHIP_KALIP.exec(metin || '');
        if (m) { sahip = m[1]; break; }
    }

    if (!sahip) {
        sahiplenmeEslesmeyen.unshift({
            at: Date.now(),
            channelName: message.channel ? message.channel.name : null,
            authorId: message.author ? message.author.id : null,
            baslik: embed ? embed.title : null,
            // Kategorideki HER mesaj buradan geciyor - ticket'taki siradan
            // sohbet de "eslesmeyen" oluyor. Sayimin bozuldugunu gosteren asil
            // isaret, EMBED'li (bot agzindan cikan) bir mesajin kaliba
            // uymamasi. Teshis ekrani ikisini bu alanla ayiriyor; embed'in
            // basligi olmayabilecegi icin baslik'a bakmak yeterli degil.
            embedli: Boolean(embed),
            metin: (metinler.find(Boolean) || '').slice(0, 200),
        });
        sahiplenmeEslesmeyen.length = Math.min(sahiplenmeEslesmeyen.length, 10);
        return;
    }

    const entry = serializeLogMessage(message);
    // personFrom 'author' oldugu icin sayim authorId uzerinden yapiliyor;
    // yazan bot degil SAHIPLENEN kisi sayilsin diye burayi degistiriyoruz.
    entry.authorId = sahip;
    entry.ticketKanali = message.channel ? message.channel.name : null;
    entry._s = logSearchText(entry);

    store.messages.unshift(entry);
    store.loaded = store.messages.length;
    const artis = addToDailyIndex(store, entry);
    canliKaynagiYaz('sahiplenme');

    console.log(`[Sahiplenme] ${entry.ticketKanali || 'ticket'} -> ${sahip} `
        + `(bugun ${artis ? artis.adet : '?'})`);
    wsBroadcast({ type: 'log-yeni', key: 'sahiplenme', entry: stripInternal(entry), loaded: store.loaded });
    if (artis) {
        wsBroadcast({
            type: 'etkinlik-artis',
            key: 'sahiplenme', gun: artis.gun, memberId: artis.kisi, count: artis.adet,
        });
    }
}

let logPrimingStarted = false;
async function primeAllLogs() {
    if (logPrimingStarted) return;
    logPrimingStarted = true;
    const basladi = Date.now();
    // Canli kaynaklar (ticket sahiplenme) cekilmiyor - kayitlari diskten
    // geliyor ve messageCreate ile buyuyor.
    ALL_CHANNELS.filter((c) => c.canliKaynak).forEach((c) => canliKaynagiYukle(c.key));
    const sira = ALL_CHANNELS.filter((c) => c.channelId && !c.canliKaynak);
    console.log(`[Loglar] ${sira.length} kanal arka planda cekiliyor `
        + `(${LOG_CONCURRENCY} paralel, once etkinlik/ticket)...`);

    // Eskiden hepsi TEK TEK cekiliyordu; 9 log kanaliyla bu dakikalar suruyordu.
    // Discord mesaj gecmisi kotasi kanal basina ayri isledigi icin birkac kanali
    // ayni anda cekmek guvenli. Sira korunuyor: etkinlik/ticket once basliyor.
    let sonraki = 0;
    async function isci() {
        for (;;) {
            const index = sonraki;
            sonraki += 1;
            if (index >= sira.length) return;
            const channel = sira[index];
            try {
                // eslint-disable-next-line no-await-in-loop
                await fetchAllChannelMessages(channel.key);
            } catch (error) {
                console.log(`[Loglar] ${channel.label} cekilemedi: ${error.message}`);
            }
        }
    }
    await Promise.all(Array.from({ length: Math.min(LOG_CONCURRENCY, sira.length) }, isci));

    const toplam = [...logStore.values()].reduce((t, st) => t + st.messages.length, 0);
    console.log(`[Loglar] Arka plan yuklemesi bitti: ${toplam} mesaj, `
        + `${((Date.now() - basladi) / 1000).toFixed(1)} sn.`);
}

// Ilk yukleme bittikten sonra yeni gelen log mesajlarini canli olarak ekliyoruz -
// boylece sekme acikken kanal yeniden cekilmeden guncel kaliyor.
client.on('messageCreate', (message) => {
    // Ticket sahiplenme: kanal ID'si sabit degil, KATEGORIYE bakiyoruz.
    try {
        if (message.channel && message.channel.parentId === TICKET_SAHIP_KATEGORI) {
            sahiplenmeYakala(message);
        }
    } catch (error) {
        console.log(`[Sahiplenme] Yakalama hatasi: ${error.message}`);
    }

    const key = logChannelIdToKey.get(message.channelId);
    if (!key) return;
    const store = logStore.get(key);
    if (!store || store.status !== 'hazir') return;
    const entry = serializeLogMessage(message);
    entry._s = logSearchText(entry);
    store.messages.unshift(entry);
    store.loaded = store.messages.length;
    store.cacheKirli = true; // periyodik yazma bunu diske gecirecek
    wsBroadcast({ type: 'log-yeni', key, entry: stripInternal(entry), loaded: store.loaded });

    // Etkinlik/ticket kanallarinda gunluk sayaci ANLIK guncelle ve yayinla.
    if (store.kind === 'aktivite') {
        const artis = addToDailyIndex(store, entry);
        if (artis) {
            wsBroadcast({
                type: 'etkinlik-artis',
                key, gun: artis.gun, memberId: artis.kisi, count: artis.adet,
            });
        }
    }
});

function stripInternal(entry) {
    const { _s, ...rest } = entry;
    return rest;
}

// ============================================================================
// --- YOKLAMAYI AL: kimin uyari alacagina karar verme ---
// Kural (kullanicinin belirledigi):
//   seste                          -> uyari yok
//   mazeret/uzun mazerette ✅      -> uyari yok
//   mazeret/uzun mazerette ❌      -> uyari
//   mazeret var ama tepki yok      -> uyari
//   hic mazeret yok                -> uyari
// Iki mazeretten BIRINDE bile ✅ varsa uyari yazilmaz (onay her seyi ezer) -
// aksi halde uzun mazereti onaylanmis biri gunluk mazereti tepkisiz diye
// haksiz yere uyari alirdi.
// ============================================================================
function decideAttendance(member, katilanlar) {
    if (member.inVoice) {
        return { decision: 'skip', reason: 'Seste' };
    }
    // Panelden "Yoklamaya Katıl" diyen kisiye uyari yazilmiyor.
    if (katilanlar && katilanlar[member.id]) {
        return { decision: 'excused', reason: 'Panelden yoklamaya katıldı' };
    }
    const daily = classifyReactions(member.excuseReactions);
    const long = classifyReactions(member.longExcuseReactions);
    const hasAnyExcuse = Boolean(member.excuseText) || Boolean(member.longExcuseText);

    if (daily === 'approved' || long === 'approved') {
        return { decision: 'excused', reason: 'Mazereti onaylanmis (✅)' };
    }
    if (daily === 'rejected' || long === 'rejected') {
        return { decision: 'warn', reason: 'Mazereti reddedilmis (❌)' };
    }
    if (hasAnyExcuse) {
        return { decision: 'warn', reason: 'Mazeretine tepki verilmemis' };
    }
    return { decision: 'warn', reason: 'Seste degil, mazereti yok' };
}

// ============================================================================
// --- YOKLAMAYA KATIL ---
// Panel hesabina Discord ID'si bagli yetkililer panelden "katildim"
// diyebiliyor. Katilan kisiye o gun uyari yazilmiyor.
// ============================================================================
const KATILIM_PATH = path.join(ROOT_DIR, 'yoklama-katilim.json');

function loadKatilim() {
    try {
        const d = JSON.parse(fs.readFileSync(KATILIM_PATH, 'utf8'));
        return (d && typeof d === 'object') ? d : {};
    } catch (error) {
        return {};
    }
}
const katilimVerisi = loadKatilim(); // { "YYYY-MM-DD": { discordId: {at, by} } }

function persistKatilim() {
    try {
        fs.writeFileSync(KATILIM_PATH, JSON.stringify(katilimVerisi, null, 2));
    } catch (error) {
        console.log(`[Katilim] Kaydedilemedi: ${error.message}`);
    }
}

function bugunKatilanlar() {
    return katilimVerisi[bugununAnahtari()] || {};
}

function katilimEkle(discordId, kim) {
    const gun = bugununAnahtari();
    if (!katilimVerisi[gun]) katilimVerisi[gun] = {};
    katilimVerisi[gun][discordId] = { at: Date.now(), by: kim || null };
    // 60 gunden eskiyi at
    const gunler = Object.keys(katilimVerisi).sort();
    while (gunler.length > 60) delete katilimVerisi[gunler.shift()];
    persistKatilim();
    wsBroadcast({ type: 'yoklama-katilim', gun, discordId });
}

// Onizleme: tarama yapar ve kimin ne alacagini dondurur - HICBIR rol vermez.
async function buildAttendancePreview() {
    const scan = await runYoklamaScan();
    const warn = [];
    const excused = [];
    const inVoice = [];
    const maxTier = [];

    const katilanlar = bugunKatilanlar();
    scan.members.forEach((member) => {
        const { decision, reason } = decideAttendance(member, katilanlar);
        const row = {
            id: member.id,
            displayName: member.displayName,
            tag: member.tag,
            avatarURL: member.avatarURL,
            currentTierLabel: member.currentTierLabel,
            nextTierLabel: member.nextTierLabel,
            isMaxTier: member.isMaxTier,
            reason,
        };
        if (decision === 'skip') inVoice.push(row);
        else if (decision === 'excused') excused.push(row);
        else if (member.isMaxTier) maxTier.push(row); // uyarilacakti ama merdivenin sonunda
        else warn.push(row);
    });

    return {
        scannedAt: scan.scannedAt,
        totalChecked: scan.totalChecked,
        totalInVoice: scan.totalInVoice,
        warn,
        excused,
        inVoice,
        maxTier,
    };
}

// ============================================================================
// --- YENI TICKET'A OTOMATIK MESAJ ---
// Belirtilen sunucudaki belirtilen KATEGORIDE yeni bir kanal acildiginda
// (= yeni ticket) hazir mesaji yazip ticket'i acan kisiyi etiketler.
// Discord'a kendiliginden mesaj attigi icin panelden acilip kapatilabiliyor
// ve her gonderim hesap loglarina yaziliyor.
// ============================================================================
const TICKET_AUTO_GUILD = '1476217696331890818';

// Otomatik mesaj yazilan kategoriler. Her birinin KENDI metni var; metin
// panelSettings'te hangi anahtarda durdugu burada yaziyor.
//
// Eslesme yalnizca KATEGORI ID'sine bakiyor, sunucuya degil. Discord ID'leri
// evrensel olarak benzersiz oldugu icin bu yeterli; ustelik AC kategorisi
// YT'ninkinden BASKA bir sunucuda ve eski sabit sunucu kontrolu onu
// engellerdi.
//
// Yeni bir kategori eklemek: buraya bir satir, panelSettings'e bir varsayilan,
// arayuze bir metin kutusu.
const TICKET_AUTO_KATEGORILER = [
    { key: 'yt', label: 'Yayıncı (YT)', kategori: '1476223556806512660', ayar: 'ticketAutoMessage' },
    { key: 'ac', label: 'AC',           kategori: '1470230380572573706', ayar: 'ticketAutoMessageAc' },
];

function ticketAutoKategoriBul(parentId) {
    return TICKET_AUTO_KATEGORILER.find((k) => k.kategori === parentId) || null;
}

const VARSAYILAN_TICKET_MESAJI = [
    '📢 **Yayıncı Sistemi Güncellendi**',
    '',
    '• Sunucumuzda 1 gün içerisinde minimum 2 saat yayın açan tüm yayıncılara Level 1 Panel verilecektir.',
    '',
    '• 3 farklı gün boyunca, her gün minimum 2 saat yayın yapan yayıncılar için kendilerine özel sınırsız yayıncı kanalı açılacaktır. Ve yayıncı paneli için belirli bir süre ve ya istatistiğe göre level 2 ye yükselme fırsatı doğacaktır',
    '',
    '• Yayıncı avantajlarından yararlanabilmek için belirtilen yayın sürelerinin eksiksiz tamamlanması gerekmektedir.',
    '',
    'Herkese bol şans ve iyi yayınlar! 🎥',
].join('\n');

// AC kategorisi icin varsayilan metin. Panelden degistirilebiliyor; burasi
// yalnizca ayar dosyasinda hic deger yokken kullanilan ilk hal.
const VARSAYILAN_AC_MESAJI = [
    '🛡️ **AC Başvuru / Destek**',
    '',
    'Merhaba! Talebini aldık, en kısa sürede bir yetkili seninle ilgilenecek.',
    '',
    'Beklerken aşağıdakileri yazarsan işlem hızlanır:',
    '• Sunucu adı ve IP',
    '• Kullandığın anticheat sürümü',
    '• Yaşadığın sorunun kısa açıklaması',
].join('\n');

const PANEL_SETTINGS_PATH = path.join(ROOT_DIR, 'panel-settings.json');

function loadPanelSettings() {
    try {
        const d = JSON.parse(fs.readFileSync(PANEL_SETTINGS_PATH, 'utf8'));
        return (d && typeof d === 'object') ? d : {};
    } catch (error) {
        return {};
    }
}
const panelSettings = loadPanelSettings();
if (typeof panelSettings.ticketAutoEnabled !== 'boolean') panelSettings.ticketAutoEnabled = true;
if (typeof panelSettings.ticketAutoMessage !== 'string') panelSettings.ticketAutoMessage = VARSAYILAN_TICKET_MESAJI;
if (typeof panelSettings.ticketAutoMessageAc !== 'string') {
    panelSettings.ticketAutoMessageAc = VARSAYILAN_AC_MESAJI;
}
// Ticket acildiktan sonra kac saniye beklenip yazilacak.
// DIKKAT: bu sabit, asagida panelSettings varsayilaninda kullanildigi icin
// ORADAN ONCE tanimli olmali - sonra tanimlaninca "Cannot access before
// initialization" ile acilista cokuyordu.
const TICKET_AUTO_VARSAYILAN_GECIKME_SN = 7;
if (typeof panelSettings.ticketAutoGecikmeSn !== 'number') {
    panelSettings.ticketAutoGecikmeSn = TICKET_AUTO_VARSAYILAN_GECIKME_SN;
}
// Rol botunun slash komut adlari. sendSlash birebir isim esleştirmesi yapiyor;
// bot komutu farkli adlandirmissa ("rol ver" gibi alt komut da olabilir)
// koda dokunmadan buradan degistirilebilsin diye ayarlarda tutuluyor.
if (typeof panelSettings.rolVerKomutu !== 'string') panelSettings.rolVerKomutu = 'rol-ver';
if (typeof panelSettings.rolAlKomutu !== 'string') panelSettings.rolAlKomutu = 'rol-al';
// Komut ID'si adi tamamen geciyor: ID hem komutu hem hangi uygulamaya ait
// oldugunu tek basina belirliyor, yani ad tahmin etmeye gerek kalmiyor.
// Prime saat hatirlatmasi. Sabitler asagida tanimli oldugu icin burada duz
// deger kullaniyoruz - sabit adi yazarsak "before initialization" ile cokuyor.
if (typeof panelSettings.primeAcik !== 'boolean') panelSettings.primeAcik = true;
if (!Array.isArray(panelSettings.primeSaatler)) panelSettings.primeSaatler = ['20:00', '21:00', '22:00'];
if (typeof panelSettings.primeKanal !== 'string') panelSettings.primeKanal = '1470230475485479097';
if (typeof panelSettings.primeMesaj !== 'string') {
    panelSettings.primeMesaj = 'Aktif görünüyorsun ama seste değilsin. '
        + 'Prime saatlerdeyiz, sese geçebilir misin?';
}
if (typeof panelSettings.primeDm !== 'boolean') panelSettings.primeDm = true;
if (!panelSettings.primeSonGunler || typeof panelSettings.primeSonGunler !== 'object') {
    panelSettings.primeSonGunler = {};
}

if (typeof panelSettings.rolVerKomutId !== 'string') panelSettings.rolVerKomutId = VARSAYILAN_ROL_VER_KOMUT_ID;
if (typeof panelSettings.rolAlKomutId !== 'string') panelSettings.rolAlKomutId = VARSAYILAN_ROL_AL_KOMUT_ID;
if (typeof panelSettings.rolBotId !== 'string') panelSettings.rolBotId = VARSAYILAN_ROLE_BOT_ID;
// Bir surum boyunca rol botu ID'si kodda yanlis yaziliydi ve butun rol
// islemleri sessizce calismiyordu. Ayar dosyasina o deger yazilmis olma
// ihtimaline karsi kendiliginden duzeltiyoruz - kullanicinin ayarlardan
// elle temizlemesini beklemeye gerek yok.
const HATALI_ESKI_ROLE_BOT_ID = '1472695273418522657';
if (panelSettings.rolBotId === HATALI_ESKI_ROLE_BOT_ID) {
    console.log(`[Rol] Ayarlardaki hatali rol botu ID'si (${HATALI_ESKI_ROLE_BOT_ID}) `
        + `duzeltildi: ${VARSAYILAN_ROLE_BOT_ID}`);
    panelSettings.rolBotId = VARSAYILAN_ROLE_BOT_ID;
    savePanelSettings();
}
if (typeof panelSettings.otoYoklamaAcik !== 'boolean') panelSettings.otoYoklamaAcik = true;
if (typeof panelSettings.otoYoklamaSaat !== 'string') panelSettings.otoYoklamaSaat = '20:30';

let otoGocGerekli = false;
// Birden fazla zamanlanmis yoklama. Once tek saat vardi; artik her satirin
// kendi saati, kendi duyuru kanali ve kendi ac/kapa anahtari var. Eski tek
// saatli ayar ilk acilista listeye tasiniyor - kullanicinin ayari kaybolmasin.
if (!Array.isArray(panelSettings.otoYoklamalar)) {
    panelSettings.otoYoklamalar = [
        {
            id: 'varsayilan',
            saat: panelSettings.otoYoklamaSaat || '20:30',
            kanal: null, // bos = varsayilan uyari kanali
            acik: panelSettings.otoYoklamaAcik !== false,
            sebep: panelSettings.otoYoklamaSebep || null,
        },
        {
            id: 'gece',
            saat: '22:30',
            kanal: '1470230485820112950',
            acik: true,
            sebep: null,
        },
    ];
    otoGocGerekli = true;
}
// Gunluk kilit artik satir basina: { "<id>": "YYYY-MM-DD" }
if (!panelSettings.otoYoklamaSonGunler || typeof panelSettings.otoYoklamaSonGunler !== 'object') {
    panelSettings.otoYoklamaSonGunler = {};
    if (panelSettings.otoYoklamaSonGun) {
        panelSettings.otoYoklamaSonGunler.varsayilan = panelSettings.otoYoklamaSonGun;
    }
    otoGocGerekli = true;
}
// Gocu HEMEN diske yaz: yoksa dosya eski bicimde kalir ve "ayarlarim nerede"
// sorusu dogar; ayrica sorun ararken dosyaya bakmak yaniltici olurdu.
if (otoGocGerekli) savePanelSettings();

function savePanelSettings() {
    try {
        fs.writeFileSync(PANEL_SETTINGS_PATH, JSON.stringify(panelSettings, null, 2));
    } catch (error) {
        console.log(`[Ayar] Kaydedilemedi: ${error.message}`);
    }
}

// Ayni kanala iki kez yazmamak icin - channelCreate bazen tekrar gelebiliyor.
const ticketAutoYazilan = new Set();
// Beklenmedik bir durumda kategori yanlis eslesirse spam olmasin diye tavan.
const TICKET_AUTO_DAKIKA_TAVANI = 12;
function ticketAutoGecikmeMs() {
    const sn = Number(panelSettings.ticketAutoGecikmeSn);
    if (!Number.isFinite(sn) || sn < 0) return TICKET_AUTO_VARSAYILAN_GECIKME_SN * 1000;
    return Math.min(sn, 120) * 1000; // ust sinir: kanal cok gec yazilmasin
}
let ticketAutoPencere = { dakika: 0, adet: 0 };
const ticketAutoSonGonderimler = [];

// Ticket'i acan kisi: kanala ozel olarak eklenen UYE izni. Ticket botu kanali
// olusturduktan HEMEN SONRA bu izni ekliyor, yani channelCreate geldiginde
// henuz orada olmayabiliyor.
//
// AYNI kanal nesnesini yokluyoruz, her denemede yeniden fetch etmiyoruz:
// discord.js izin degisiminde onbellekteki kanal nesnesini yerinde
// guncelliyor; yeniden fetch etmek gereksiz istek olmasinin yaninda baska
// bir nesne dondurup guncellemeyi kacirabiliyor.
function readOpenerFromOverwrites(channel) {
    try {
        const cache = channel.permissionOverwrites && channel.permissionOverwrites.cache;
        if (!cache) return null;
        const uye = [...cache.values()].find((o) => (
            (o.type === 'member' || o.type === 1)
            && o.id !== client.user.id
            && o.id !== (channel.guild && channel.guild.id)
        ));
        return uye ? uye.id : null;
    } catch (error) {
        return null;
    }
}

async function findTicketOpener(channel) {
    const TOPLAM_DENEME = 8;
    const ARALIK_MS = 1000;
    for (let i = 0; i < TOPLAM_DENEME; i += 1) {
        const id = readOpenerFromOverwrites(channel);
        if (id) return id;
        // Bazi ticket botlari acani kanal konusuna da yaziyor.
        if (channel.topic) {
            const m = String(channel.topic).match(/(\d{17,20})/);
            if (m) return m[1];
        }
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, ARALIK_MS));
    }
    return null;
}

client.on('channelCreate', async (channel) => {
    try {
        if (!panelSettings.ticketAutoEnabled) return;
        if (!channel || !channel.guild) return;
        // Sunucu kontrolu YOK: kategori ID'si zaten evrensel benzersiz ve iki
        // kategori ayri sunucularda.
        const kat = ticketAutoKategoriBul(channel.parentId);
        if (!kat) return;
        if (ticketAutoYazilan.has(channel.id)) return;
        ticketAutoYazilan.add(channel.id);

        // dakikalik tavan
        const dakika = Math.floor(Date.now() / 60000);
        if (ticketAutoPencere.dakika !== dakika) ticketAutoPencere = { dakika, adet: 0 };
        if (ticketAutoPencere.adet >= TICKET_AUTO_DAKIKA_TAVANI) {
            console.log('[TicketOtomatik] Dakikalik tavan asildi, bu kanal atlandi:'
                + ` #${channel.name}. Kategori dogru mu kontrol et.`);
            return;
        }
        ticketAutoPencere.adet += 1;

        // Ticket botu kanali actiktan sonra kendi karsilama mesajlarini,
        // butonlarini ve izinlerini yerlestiriyor. Hemen yazarsak mesajimiz
        // onlarin arasinda kayboluyor; birkac saniye bekleyip yaziyoruz.
        const bekleme = ticketAutoGecikmeMs();
        if (bekleme > 0) await new Promise((r) => setTimeout(r, bekleme));

        // Bekleme sirasinda ayar kapatilmis ya da kanal silinmis olabilir.
        if (!panelSettings.ticketAutoEnabled) {
            console.log(`[TicketOtomatik] Bekleme sirasinda kapatildi, atlandi: #${channel.name}`);
            return;
        }

        // Metin kategoriye ait: YT kategorisine YT metni, AC kategorisine AC
        // metni gidiyor.
        const kategoriMetni = panelSettings[kat.ayar];
        if (!kategoriMetni || !String(kategoriMetni).trim()) {
            console.log(`[TicketOtomatik] ${kat.label} metni boş, atlandı: #${channel.name}`);
            return;
        }

        const acan = await findTicketOpener(channel);
        const metin = (acan ? `<@${acan}>\n\n` : '') + kategoriMetni;
        await channel.send(metin);

        const kayit = {
            at: Date.now(),
            channelId: channel.id,
            channelName: channel.name,
            openerId: acan,
            kategori: kat.key,
            kategoriAd: kat.label,
        };
        ticketAutoSonGonderimler.unshift(kayit);
        while (ticketAutoSonGonderimler.length > 25) ticketAutoSonGonderimler.pop();

        console.log(`[TicketOtomatik] ${kat.label}: #${channel.name} kanalina mesaj`
            + ` yazildi (acan: ${acan || 'bulunamadi'}).`);
        addAudit('ticket-otomatik', 'sistem',
            `${kat.label} · #${channel.name} kanalına otomatik mesaj yazıldı`
            + `${acan ? ` (açan: ${acan})` : ' (açan bulunamadı)'}`, null);
        wsBroadcast({ type: 'ticket-otomatik', entry: kayit });
    } catch (error) {
        console.log(`[TicketOtomatik] Hata: ${error.message}`);
    }
});

// ============================================================================
// --- YETKILILER + ROL VER/AL ---
// Roller sunucudaki hiyerarsi sirasina gore (position buyukten kucuge)
// veriliyor. Rol vermek icin yine komut kanalindaki rol botuna /rol-ver ve
// /rol-al gonderiliyor - bot rolleri kendisi eklemiyor, mevcut tasarim boyle.
// ============================================================================
async function getReadyGuild() {
    const guild = client.guilds.cache.get(GUILD_ID) || await client.guilds.fetch(GUILD_ID);
    if (!guild) throw new Error('Sunucu bulunamadi, GUILD_ID hatali olabilir.');
    if (!(await waitForGuildShard(guild))) {
        throw new Error('Bu sunucu icin gateway baglantisi (shard) uzun suredir hazir degil.');
    }
    return guild;
}

// Hesabin kendi en ust rolunun konumu. Bunun ustundeki roller Discord'da
// verilemiyor; arayuzde gorunur ama "verilemez" diye isaretleniyor.
function getSelfHighestPosition(guild) {
    const me = guild.members.cache.get(client.user.id);
    if (!me) return 0;
    let highest = 0;
    me.roles.cache.forEach((role) => { const p = rolePos(role); if (p > highest) highest = p; });
    return highest;
}

// role.position discord.js'te hesaplanan bir getter; rol onbellegi tam
// dolmadan bazi rollerde undefined gelebiliyor. O durumda "b.position -
// a.position" NaN uretir, NaN donen karsilastirici ile V8 siralamayi HIC
// degistirmez - yani hiyerarsi sessizce bozulur. Sayiya zorluyoruz.
function rolePos(role) {
    if (typeof role.position === 'number' && Number.isFinite(role.position)) return role.position;
    if (typeof role.rawPosition === 'number' && Number.isFinite(role.rawPosition)) return role.rawPosition;
    return 0;
}

// Yuksekten dusuge (hiyerarside ustteki once). Esitlikte ada gore.
function byHierarchyDesc(a, b) {
    const fark = rolePos(b) - rolePos(a);
    if (fark !== 0) return fark;
    return String(a.name || '').localeCompare(String(b.name || ''), 'tr');
}

function serializeRole(role, selfTop) {
    return {
        id: role.id,
        name: role.name,
        color: role.hexColor && role.hexColor !== '#000000' ? role.hexColor : null,
        position: rolePos(role),
        memberCount: role.members ? role.members.size : 0,
        managed: Boolean(role.managed), // bot/entegrasyon rolu - kimseye verilemez
        assignable: !role.managed && role.position < selfTop,
        isAttendance: ATTENDANCE_ROLE_IDS.includes(role.id),
        isWarning: WARNING_ROLES.some((w) => w.id === role.id),
    };
}

async function listGuildRoles() {
    const guild = await getReadyGuild();
    try {
        await ensureMembersFetched(guild);
    } catch (error) {
        console.log(`[Roller] Uye listesi alinamadi: ${error.message}`);
    }
    const selfTop = getSelfHighestPosition(guild);
    const roles = [...guild.roles.cache.values()]
        .filter((role) => role.id !== guild.id) // @everyone haric
        .sort(byHierarchyDesc) // hiyerarsi: yuksekten dusuge
        .map((role) => serializeRole(role, selfTop));
    return { selfTopPosition: selfTop, roles };
}

function serializeStaffMember(member, guild) {
    const tierIndex = getWarningTierIndex(member);
    const roles = [...member.roles.cache.values()]
        .filter((role) => role.id !== guild.id)
        .sort(byHierarchyDesc)
        .map((role) => ({
            id: role.id,
            name: role.name,
            color: role.hexColor && role.hexColor !== '#000000' ? role.hexColor : null,
            position: rolePos(role),
        }));
    return {
        id: member.id,
        displayName: member.displayName,
        tag: member.user.tag,
        avatarURL: member.displayAvatarURL({ size: 64 }),
        joinedAt: member.joinedTimestamp || null,
        roles,
        currentTierLabel: tierIndex >= 0 ? WARNING_ROLES[tierIndex].label : null,
        inVoice: Boolean(member.voice && member.voice.channelId),
    };
}

// roleId verilirse o roldeki herkes, verilmezse yoklama rollerindeki herkes.
async function listStaff(roleId) {
    const guild = await getReadyGuild();
    try {
        await ensureMembersFetched(guild);
    } catch (error) {
        throw new Error(`Uye listesi alinamadi: ${error.message}`);
    }

    const matches = guild.members.cache.filter((member) => (
        roleId
            ? member.roles.cache.has(roleId)
            : ATTENDANCE_ROLE_IDS.some((id) => member.roles.cache.has(id))
    ));

    const members = [...matches.values()]
        .map((member) => serializeStaffMember(member, guild))
        .sort((a, b) => a.displayName.localeCompare(b.displayName, 'tr'));

    let roleName = null;
    if (roleId) {
        const role = guild.roles.cache.get(roleId);
        roleName = role ? role.name : roleId;
    }
    return { roleId: roleId || null, roleName, total: members.length, members };
}

// Tek bir rolu rol botu uzerinden verir ya da alir.
async function sendRoleCommand(kind, memberId, roleId) {
    if (kind !== 'rol-ver' && kind !== 'rol-al') throw new Error('Gecersiz komut.');
    const guild = await getReadyGuild();

    let member;
    try {
        member = await guild.members.fetch(memberId);
    } catch (error) {
        throw new Error(`Kisi bilgisi alinamadi: ${error.message}`);
    }

    const role = guild.roles.cache.get(roleId);
    if (!role) throw new Error('Rol bulunamadi.');
    if (role.managed) throw new Error(`"${role.name}" bir bot/entegrasyon rolu, elle verilemez.`);

    const selfTop = getSelfHighestPosition(guild);
    if (rolePos(role) >= selfTop) {
        throw new Error(`"${role.name}" senin en ust rolunun uzerinde ya da ayni seviyede - verilemez.`);
    }

    const has = member.roles.cache.has(roleId);
    if (kind === 'rol-ver' && has) return { ok: false, reason: 'zaten-var', roleName: role.name };
    if (kind === 'rol-al' && !has) return { ok: false, reason: 'yok', roleName: role.name };

    let commandChannel;
    try {
        commandChannel = await client.channels.fetch(ROLE_COMMAND_CHANNEL_ID);
    } catch (error) {
        throw new Error(`Komut kanali alinamadi: ${error.message}`);
    }
    if (!commandChannel) throw new Error('Komut kanali bulunamadi.');

    const replyPromise = waitForRoleBotReply();
    const verMi = kind === 'rol-ver';
    const gonderilen = await rolSlashGonder(
        guild, commandChannel,
        {
            komutId: verMi ? rolVerKomutId() : rolAlKomutId(),
            komutAdi: verMi ? panelSettings.rolVerKomutu : panelSettings.rolAlKomutu,
            botId: rolBotId(),
        },
        memberId, roleId,
    );
    const botReply = await replyPromise;

    console.log(`[Rol] ${member.user.tag} (${memberId}) icin "/${gonderilen.name}" (${gonderilen.id}) gonderildi: ${role.name} (${roleId}). Bot cevabi: ${botReply || '(yakalanamadi)'}`);

    const beklenen = kind === 'rol-ver';
    const dogrulandi = await verifyRoleState(guild, memberId, roleId, beklenen);
    if (!dogrulandi) {
        console.log(`[Rol] DOGRULANAMADI: ${member.user.tag} - "${role.name}" ${beklenen ? 'verilmedi' : 'kaldirilmadi'}.`);
        return {
            ok: false,
            reason: 'dogrulanamadi',
            roleName: role.name,
            memberTag: member.user.tag,
            botReply,
            error: `Rol botu "${role.name}" rolünü ${beklenen ? 'vermedi' : 'kaldırmadı'}`
                + ' (komut gönderildi ama rol değişmedi).'
                + (botReply ? ` Bot cevabı: ${botReply}` : ' Bot cevap vermedi.'),
        };
    }
    return { ok: true, roleName: role.name, memberTag: member.user.tag, botReply };
}

// ============================================================================
// --- HTTP + WEBSOCKET SUNUCUSU ---
// ============================================================================
const app = express();
// nginx gibi bir ters vekil arkasindaysak gercek istemci IP'sini ve HTTPS
// bilgisini X-Forwarded-* basliklarindan al - giris deneme siniri dogru IP'yi
// saysin ve cerez otomatik "secure" isaretlensin diye.
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
// Geliştirme sürecinde her güncellemede tarayıcının eski dosyaları
// önbellekten göstermemesi için (Ctrl+F5 zorunluluğu olmasın diye) statik
// dosyalarda önbelleklemeyi tamamen kapatıyoruz - bu ölçekte performans
// maliyeti önemsiz.
app.use(express.static(path.join(__dirname, 'public'), {
    etag: false,
    lastModified: false,
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-store'),
}));

// Surum/teshis ucu - GIRIS GEREKTIRMEZ ki tarayiciya yapistirip bakabilesin.
// Yalnizca sunucunun ne zaman baslatildigini ve server.js'in disk zamanini
// donduruyor; gizli bilgi icermiyor. "Guncelledim ama eski kod mu calisiyor?"
// sorusunu kesin cevaplamak icin.
const SUNUCU_BASLANGIC = Date.now();

// Calisan kodun hangi commit'ten geldigini soyler. Git ikilisini cagirmiyoruz
// (VDS'de PATH'te olmayabilir) - .git dosyalarini dogrudan okuyoruz. Depo
// degilse ya da okunamazsa null doner, uc yine calisir.
function calisanCommit() {
    try {
        const gitDizini = path.join(ROOT_DIR, '.git');
        const head = fs.readFileSync(path.join(gitDizini, 'HEAD'), 'utf8').trim();
        if (!head.startsWith('ref:')) return { commit: head.slice(0, 7), dal: null };
        const ref = head.slice(4).trim();
        const dal = ref.replace(/^refs\/heads\//, '');
        let tam = null;
        try {
            tam = fs.readFileSync(path.join(gitDizini, ref), 'utf8').trim();
        } catch (error) {
            // Ref paketlenmis olabilir (packed-refs)
            const paket = fs.readFileSync(path.join(gitDizini, 'packed-refs'), 'utf8');
            const satir = paket.split('\n').find((l) => l.endsWith(` ${ref}`));
            if (satir) tam = satir.split(' ')[0];
        }
        return { commit: tam ? tam.slice(0, 7) : null, dal };
    } catch (error) {
        return { commit: null, dal: null };
    }
}

// Istek sunucunun kendisinden mi geliyor? tani.ps1 / guncelle.ps1 hep
// localhost'tan calisiyor - onlar tam ayrinti gorsun, disaridan gelen
// gormesin.
function yerelIstekMi(req) {
    const ip = String((req.socket && req.socket.remoteAddress) || '');
    return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

app.get('/api/surum', (req, res) => {
    let dosyaZamani = null;
    try {
        dosyaZamani = fs.statSync(__filename).mtime.toISOString();
    } catch (error) { /* yoksay */ }
    const surum = calisanCommit();
    // Kanal/bot ID'leri ve komut ayarlari ayrinti sayiliyor: giris ekrani da bu
    // ucu cagirdigi icin, panel disariya acikken bunlar herkese gorunmesin.
    // Yerel istekler (tani.ps1, guncelle.ps1) ve giris yapmis kullanicilar
    // tam cikti aliyor.
    const ayrinti = yerelIstekMi(req) || Boolean(getSession(req));
    res.json({
        ok: true,
        baslatildi: new Date(SUNUCU_BASLANGIC).toISOString(),
        calismaSuresiSn: Math.round((Date.now() - SUNUCU_BASLANGIC) / 1000),
        serverJsTarihi: dosyaZamani,
        commit: surum.commit,
        dal: surum.dal,
        ayrintili: ayrinti,
        // Rol islemlerinde kullanilan bot - yanlis ID'de butun rol verme
        // sessizce calismiyordu, o yuzden burada gorunuyor.
        ...(ayrinti ? {
            rolBotId: rolBotId(),
            rolVerKomutId: rolVerKomutId() || null,
            rolAlKomutId: rolAlKomutId() || null,
            rolVerKomutu: panelSettings.rolVerKomutu,
            rolAlKomutu: panelSettings.rolAlKomutu,
        } : {}),
        otoYoklama: ayrinti
            ? (panelSettings.otoYoklamalar || [])
                .map((y) => `${y.saat}${y.acik ? '' : ' (kapalı)'}${y.kanal ? ` -> ${y.kanal}` : ''}`)
            : undefined,
        // Hangi log kanallari YUKLU koda kayitli ve durumlari ne. "Menu
        // gorunmuyor" derdinde tek bakista ayrisiyor: kanal listede yoksa kod
        // eski, listede ama 'hata' ise bot kanali goremiyor, 'hazir' ise sorun
        // yetkide.
        logKanallari: !ayrinti ? undefined : LOG_CHANNELS.map((c) => {
            const st = logStore.get(c.key);
            return {
                key: c.key,
                label: c.label,
                group: c.group || 'tx',
                channelId: c.channelId,
                durum: st ? st.status : 'yok',
                mesaj: st ? st.messages.length : 0,
                hata: st && st.error ? st.error : null,
            };
        }),
        // Bu listedeki uclar surumle birlikte gelir; eksikse kod eskidir.
        ucVar: {
            aktiflik: true,
            aktiflikTani: true,
            etkinlik: true,
            hesapLoglari: true,
            ticketOtomatik: true,
            yoklamayaKatil: true,
            otoYoklama: true,
        },
    });
});

app.post('/api/login', (req, res) => {
    const username = String((req.body && req.body.username) || '').trim();
    const password = String((req.body && req.body.password) || '');
    const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'bilinmiyor';

    const throttle = loginThrottleCheck(ip);
    if (throttle.blocked) {
        console.log(`[Giriş] Çok fazla başarısız deneme, engellendi: ${ip}`);
        addAudit('giris-hata', username || '(boş)', 'Çok fazla deneme - geçici engel', req);
        return res.status(429).json({
            ok: false,
            error: `Çok fazla başarısız deneme. ${Math.ceil(throttle.leftSec / 60)} dakika sonra tekrar dene.`,
        });
    }
    if (!verifyPanelPassword(username, password)) {
        loginNoteFailure(ip);
        addAudit('giris-hata', username || '(boş)', 'Kullanıcı adı ya da şifre yanlış', req);
        return res.status(401).json({ ok: false, error: 'Kullanıcı adı ya da şifre yanlış.' });
    }
    loginNoteSuccess(ip);
    const token = createSession(username);
    res.cookie(SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: req.secure, // HTTPS arkasındaysa (ör. nginx reverse proxy) otomatik güvenli cookie
        maxAge: SESSION_TTL_MS,
    });
    console.log(`[Giriş] Web panele giriş yapıldı: ${username}${isAdmin(username) ? ' (yönetici)' : ''}`);
    addAudit('giris', username, `Panele giriş yapıldı${isAdmin(username) ? ' (yönetici)' : ''}`, req);
    return res.json({ ok: true, username, isAdmin: isAdmin(username) });
});

app.post('/api/logout', (req, res) => {
    const token = req.cookies && req.cookies[SESSION_COOKIE];
    const session = token ? sessions.get(token) : null;
    if (session) addAudit('cikis', session.username, 'Panelden çıkış yapıldı', req);
    if (token) sessions.delete(token);
    res.clearCookie(SESSION_COOKIE);
    return res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
    const session = getSession(req);
    if (!session) return res.json({ ok: true, loggedIn: false, username: null, isAdmin: false });
    const yetki = kullaniciYetkileri(session.username);
    return res.json({
        ok: true,
        loggedIn: true,
        username: session.username,
        isAdmin: yetki.admin,
        sekmeler: yetki.sekmeler,
        loglar: yetki.loglar,
    });
});

app.get('/api/status', requireAuth, (req, res) => {
    res.json({ state: discordStatus, detail: discordStatusDetail });
});

app.post('/api/yoklama/tara', requireIzin('yoklama'), async (req, res) => {
    try {
        const data = await runYoklamaScan();
        res.json({ ok: true, data });
    } catch (error) {
        console.log(`[Yoklama] Tarama hatası: ${error.message}`);
        res.json({ ok: false, error: error.message });
    }
});

app.get('/api/uyari-gecmisi', requireIzin('yoklama'), (req, res) => {
    res.json(warningHistory);
});

app.post('/api/yoklama/rol-ver', requireIzin('yoklama'), async (req, res) => {
    const { memberId, reason } = req.body || {};
    try {
        const sonuc = await giveNextWarningRole(memberId, reason, true, panelUserDiscordId(req.session.username));
        if (sonuc.ok) addAudit('uyari-ver', req.session.username, `${memberId} -> "${sonuc.givenLabel}"${reason ? ` (${reason})` : ''}`, req);
        res.json(sonuc);
    } catch (error) {
        console.log(`[Yoklama] Rol verme hatası (${memberId}): ${error.message}`);
        res.json({ ok: false, error: error.message });
    }
});

app.post('/api/yoklama/rol-geri-al', requireIzin('yoklama'), async (req, res) => {
    const { memberId } = req.body || {};
    try {
        const sonuc = await undoLastWarning(memberId);
        if (sonuc.ok) addAudit('uyari-geri-al', req.session.username, `${memberId} <- "${sonuc.removedLabel}" geri alındı`, req);
        res.json(sonuc);
    } catch (error) {
        console.log(`[Yoklama] Geri alma hatası (${memberId}): ${error.message}`);
        res.json({ ok: false, error: error.message });
    }
});

app.post('/api/yoklama/toplu-uyari-ver', requireIzin('yoklama'), async (req, res) => {
    const { memberIds, reason } = req.body || {};
    try {
        const sonuc = await giveBulkWarning(memberIds || [], reason, panelUserDiscordId(req.session.username));
        addAudit('uyari-ver', req.session.username,
            `Toplu uyarı: ${sonuc.warned.length} kişiye verildi, ${sonuc.skipped.length} atlandı, ${sonuc.failed.length} hata${reason ? ` (${reason})` : ''}`, req);
        res.json(sonuc);
    } catch (error) {
        console.log(`[Yoklama] Toplu uyarı hatası: ${error.message}`);
        res.json({ ok: false, error: error.message });
    }
});

app.post('/api/yoklama/toplu-rol-geri-al', requireIzin('yoklama'), async (req, res) => {
    const { memberIds } = req.body || {};
    try {
        const sonuc = await bulkUndoWarning(memberIds || []);
        addAudit('uyari-geri-al', req.session.username,
            `Toplu geri alma: ${sonuc.removed.length} geri alındı, ${sonuc.skipped.length} atlandı, ${sonuc.failed.length} hata`, req);
        res.json(sonuc);
    } catch (error) {
        console.log(`[Yoklama] Toplu geri alma hatası: ${error.message}`);
        res.json({ ok: false, error: error.message });
    }
});

app.post('/api/yoklama/acil-toplanti', requireIzin('yoklama'), async (req, res) => {
    try {
        const veri = await pullEveryoneToMyVoiceChannel();
        addAudit('acil-toplanti', req.session.username,
            `${veri.moved.length} kişi çekildi, ${veri.failed.length} taşınamadı`, req);
        res.json({ ok: true, data: veri });
    } catch (error) {
        console.log(`[Yoklama] Acil toplantı hatası: ${error.message}`);
        res.json({ ok: false, error: error.message });
    }
});

// --- PANEL HESAPLARI (cok kullanicili) ---
const MIN_USERNAME_LEN = 3;
const MIN_PASSWORD_LEN = 6;

function validateCredentials(username, password, { requirePassword = true } = {}) {
    if (username !== null && username.length < MIN_USERNAME_LEN) {
        return `Kullanıcı adı en az ${MIN_USERNAME_LEN} karakter olmalı.`;
    }
    if (requirePassword || password) {
        if (!password || password.length < MIN_PASSWORD_LEN) {
            return `Şifre en az ${MIN_PASSWORD_LEN} karakter olmalı.`;
        }
    }
    return null;
}

app.get('/api/hesaplar', requireAdmin, (req, res) => {
    const users = loadPanelUsers().map((u, index) => {
        const yetki = kullaniciYetkileri(u.username);
        return {
            username: u.username,
            discordId: u.discordId || null,
            createdAt: u.createdAt || null,
            isPrimary: index === 0, // masaustu surumunun kullandigi hesap
            isSelf: u.username === req.session.username,
            admin: yetki.admin,
            sekmeler: yetki.sekmeler,
            loglar: yetki.loglar,
        };
    });
    res.json({ ok: true, users, self: req.session.username });
});

app.post('/api/hesaplar/ekle', requireAdmin, (req, res) => {
    const username = String((req.body && req.body.username) || '').trim();
    const password = String((req.body && req.body.password) || '');

    const invalid = validateCredentials(username, password);
    if (invalid) return res.json({ ok: false, error: invalid });

    const users = loadPanelUsers();
    if (users.some((u) => u.username === username)) {
        return res.json({ ok: false, error: 'Bu kullanıcı adı zaten var.' });
    }

    const discordId = String((req.body && req.body.discordId) || '').trim();
    if (discordId && !/^\d{17,20}$/.test(discordId)) {
        return res.json({ ok: false, error: 'Discord ID 17-20 haneli sayı olmalı.' });
    }
    const salt = newSalt();
    users.push({
        username, salt, hash: hashPassword(password, salt),
        discordId: discordId || null, createdAt: Date.now(),
    });
    try {
        savePanelUsers(users);
    } catch (error) {
        return res.json({ ok: false, error: `Kaydedilemedi: ${error.message}` });
    }
    console.log(`[Hesap] Yeni panel hesabı eklendi: ${username} (ekleyen: ${req.session.username})`);
    addAudit('hesap-ekle', req.session.username, `"${username}" hesabı eklendi`, req);
    return res.json({ ok: true });
});

app.post('/api/hesaplar/sil', requireAdmin, (req, res) => {
    const username = String((req.body && req.body.username) || '').trim();
    const users = loadPanelUsers();

    if (!users.some((u) => u.username === username)) {
        return res.json({ ok: false, error: 'Böyle bir hesap yok.' });
    }
    if (users.length <= 1) {
        return res.json({ ok: false, error: 'Son hesabı silemezsin - panele giriş yapılamaz hale gelir.' });
    }
    // Yonetici listenin ilk kaydi. Kendini silerse yoneticilik sessizce
    // siradaki hesaba geciyor ve kendisi de disari dusuyordu - engelliyoruz.
    if (username === users[0].username) {
        return res.json({
            ok: false,
            error: 'Yönetici hesabı silinemez - silinirse yöneticilik sıradaki hesaba geçer.',
        });
    }

    const remaining = users.filter((u) => u.username !== username);
    try {
        savePanelUsers(remaining);
    } catch (error) {
        return res.json({ ok: false, error: `Kaydedilemedi: ${error.message}` });
    }
    dropSessionsFor(username); // silinen hesabin acik oturumlari da dussun
    console.log(`[Hesap] Panel hesabı silindi: ${username} (silen: ${req.session.username})`);
    addAudit('hesap-sil', req.session.username, `"${username}" hesabı silindi`, req);
    return res.json({ ok: true, selfDeleted: username === req.session.username });
});

// Yonetici, mevcut bir hesabin Discord ID'sini atayabiliyor. Onceden ID
// yalnizca hesap OLUSTURULURKEN ya da kisinin kendisi tarafindan girilebiliyordu;
// once acilmis hesaplarda "Yoklamaya Katıl" bu yuzden kullanilamiyordu ve
// yoneticinin duzeltmek icin elinde bir yol yoktu.
app.post('/api/hesaplar/discord-id', requireAdmin, (req, res) => {
    const username = String((req.body && req.body.username) || '').trim();
    const ham = String((req.body && req.body.discordId) || '').trim();

    const users = loadPanelUsers();
    const kayit = users.find((u) => u.username === username);
    if (!kayit) return res.json({ ok: false, error: 'Böyle bir hesap yok.' });

    if (ham && !/^\d{17,20}$/.test(ham)) {
        return res.json({ ok: false, error: 'Discord ID 17-20 haneli sayı olmalı.' });
    }
    // Ayni Discord ID iki hesaba baglanirsa "Yoklamaya Katıl" ikisini birden
    // katilmis gosterir - bastan engelliyoruz.
    if (ham) {
        const cakisan = users.find((u) => u.username !== username && u.discordId === ham);
        if (cakisan) {
            return res.json({ ok: false, error: `Bu Discord ID zaten "${cakisan.username}" hesabına bağlı.` });
        }
    }

    kayit.discordId = ham || null;
    try {
        savePanelUsers(users);
    } catch (error) {
        return res.json({ ok: false, error: `Kaydedilemedi: ${error.message}` });
    }
    console.log(`[Hesap] ${username} icin Discord ID ${ham || '(kaldirildi)'} (yapan: ${req.session.username})`);
    addAudit('hesap-discord-id', req.session.username,
        ham ? `"${username}" hesabına Discord ID ${ham} bağlandı` : `"${username}" hesabının Discord ID bağı kaldırıldı`, req);
    return res.json({ ok: true, username, discordId: kayit.discordId });
});

// Yonetici bir hesabin yetkilerini duzenliyor: yoneticilik, gorebilecegi
// sekmeler ve log kanallari. Liste bicimini secmemizin sebebi, tek istekte
// tutarli bir durum kaydedilmesi - alan alan kaydetseydik yarim kalmis yetki
// birlesimleri olusabilirdi.
app.post('/api/hesaplar/izinler', requireAdmin, (req, res) => {
    const username = String((req.body && req.body.username) || '').trim();
    const users = loadPanelUsers();
    const index = users.findIndex((u) => u.username === username);
    if (index < 0) return res.json({ ok: false, error: 'Böyle bir hesap yok.' });

    if (index === 0) {
        return res.json({
            ok: false,
            error: 'Ana hesabın yetkileri kısıtlanamaz - panelde yönetici kalmazsa kimse geri veremez.',
        });
    }

    const govde = req.body || {};
    const kayit = users[index];

    if (typeof govde.admin === 'boolean') kayit.admin = govde.admin;

    if (Array.isArray(govde.sekmeler)) {
        const bilinmeyen = govde.sekmeler.filter((k) => !IZIN_SEKME_ANAHTARLARI.includes(k));
        if (bilinmeyen.length) {
            return res.json({ ok: false, error: `Bilinmeyen sekme: ${bilinmeyen.join(', ')}` });
        }
        kayit.sekmeler = [...new Set(govde.sekmeler)];
    }

    if (Array.isArray(govde.loglar)) {
        const gecerli = LOG_CHANNELS.map((c) => c.key);
        const bilinmeyen = govde.loglar.filter((k) => !gecerli.includes(k));
        if (bilinmeyen.length) {
            return res.json({ ok: false, error: `Bilinmeyen log kanalı: ${bilinmeyen.join(', ')}` });
        }
        kayit.loglar = [...new Set(govde.loglar)];
    }

    try {
        savePanelUsers(users);
    } catch (error) {
        return res.json({ ok: false, error: `Kaydedilemedi: ${error.message}` });
    }
    // Yetkisi degisen kisinin acik oturumlari dusuyor: aksi halde daralan
    // yetki, sayfa yenilenene kadar eski haliyle acik kalirdi.
    dropSessionsFor(username);

    const ozet = kayit.admin
        ? 'yönetici'
        : `${(kayit.sekmeler || []).length} sekme, ${(kayit.loglar || []).length} log kanalı`;
    console.log(`[Yetki] ${username} -> ${ozet} (yapan: ${req.session.username})`);
    addAudit('yetki-degistir', req.session.username, `"${username}" yetkileri: ${ozet}`, req);
    return res.json({ ok: true, username, ...kullaniciYetkileri(username) });
});

// Yetki ekraninin secenekleri - sekme ve log kanali listesi tek kaynaktan.
app.get('/api/izin-secenekleri', requireAdmin, (req, res) => {
    res.json({
        ok: true,
        sekmeler: IZIN_SEKMELERI,
        loglar: LOG_CHANNELS.map((c) => ({
            key: c.key,
            label: c.label,
            group: c.group || 'tx',
            grupSekmesi: GRUP_SEKMESI[c.group || 'tx'],
        })),
        gruplar: LOG_GROUPS,
    });
});

app.post('/api/hesap/guncelle', requireAuth, (req, res) => {
    const currentPassword = String((req.body && req.body.currentPassword) || '');
    const rawNewUsername = String((req.body && req.body.newUsername) || '').trim();
    const newPassword = String((req.body && req.body.newPassword) || '');
    const me = req.session.username;

    if (!verifyPanelPassword(me, currentPassword)) {
        return res.json({ ok: false, error: 'Mevcut şifren yanlış.' });
    }
    if (!rawNewUsername && !newPassword && !String((req.body && req.body.discordId) || '').trim()) {
        return res.json({ ok: false, error: 'Değiştirmek istediğin alanı doldur.' });
    }

    const rawDiscordId = String((req.body && req.body.discordId) || '').trim();
    if (rawDiscordId && rawDiscordId !== 'sil' && !/^\d{17,20}$/.test(rawDiscordId)) {
        return res.json({ ok: false, error: 'Discord ID 17-20 haneli sayı olmalı.' });
    }

    const newUsername = rawNewUsername || me;
    const invalid = validateCredentials(newUsername, newPassword, { requirePassword: false });
    if (invalid) return res.json({ ok: false, error: invalid });

    const users = loadPanelUsers();
    if (newUsername !== me && users.some((u) => u.username === newUsername)) {
        return res.json({ ok: false, error: 'Bu kullanıcı adı zaten var.' });
    }

    const record = users.find((u) => u.username === me);
    if (!record) return res.json({ ok: false, error: 'Hesabın bulunamadı.' });

    record.username = newUsername;
    if (rawDiscordId && rawDiscordId !== 'sil') {
        const cakisan = users.find((u) => u.username !== me && u.discordId === rawDiscordId);
        if (cakisan) {
            return res.json({ ok: false, error: `Bu Discord ID zaten "${cakisan.username}" hesabına bağlı.` });
        }
    }
    if (rawDiscordId) record.discordId = rawDiscordId === 'sil' ? null : rawDiscordId;
    if (newPassword) {
        record.salt = newSalt();
        record.hash = hashPassword(newPassword, record.salt);
    }
    try {
        savePanelUsers(users);
    } catch (error) {
        return res.json({ ok: false, error: `Kaydedilemedi: ${error.message}` });
    }

    // Bu hesabin TUM eski oturumlari dusuyor (sifre degistiyse calinmis bir
    // cerez ise yaramasin diye), sonra bu tarayiciya taze bir oturum veriyoruz.
    dropSessionsFor(me);
    const token = createSession(newUsername);
    res.cookie(SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: req.secure,
        maxAge: SESSION_TTL_MS,
    });
    console.log(`[Hesap] Hesap güncellendi: ${me} -> ${newUsername}${newPassword ? ' (şifre değişti)' : ''}`);
    addAudit('hesap-guncelle', me,
        me === newUsername
            ? `Şifre değiştirildi`
            : `Kullanıcı adı "${me}" -> "${newUsername}"${newPassword ? ' ve şifre değiştirildi' : ''}`, req);
    return res.json({ ok: true, username: newUsername });
});

// --- TX LOGS ---
app.get('/api/loglar', requireAuth, (req, res) => {
    // grup verilmezse hepsi doner - eski istemciler bozulmasin.
    const grup = String(req.query.grup || '').trim();
    // Yetkisi olmayan kanallar listeye hic girmiyor - menude gorunup
    // tiklayinca 403 almaktansa hic gorunmesin.
    const secilenler = (grup
        ? LOG_CHANNELS.filter((c) => (c.group || 'tx') === grup)
        : LOG_CHANNELS
    ).filter((c) => logIzniVar(req.session.username, c.key));
    res.json({
        ok: true,
        groups: LOG_GROUPS,
        channels: secilenler.map((channel) => {
            const store = logStore.get(channel.key);
            return {
                key: store.key,
                label: store.label,
                group: store.group,
                ilkCekimSiniri: store.ilkCekimSiniri || null,
                configured: Boolean(store.channelId),
                status: store.status,
                loaded: store.loaded,
                error: store.error,
                fetchedAt: store.fetchedAt,
            };
        }),
    });
});

app.get('/api/loglar/:key', requireAuth, (req, res) => {
    const store = logStore.get(req.params.key);
    if (!store) return res.status(404).json({ ok: false, error: 'Bilinmeyen log menüsü.' });
    if (!logIzniVar(req.session.username, req.params.key)) {
        return res.status(403).json({ ok: false, error: 'Bu log kanalı için yetkin yok.' });
    }

    const term = String(req.query.q || '').trim().toLocaleLowerCase('tr');
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));

    // Durum suzgeci: 'ban' | 'supheli' | 'temiz' | 'isaretsiz'.
    // Yalnizca durum takibi acik kanallarda anlamli; digerlerinde yoksayiliyor
    // ki suzgec yanlislikla gonderilse bile liste bosalmasin.
    const isaretSuzgeci = store.isaretTakibi ? String(req.query.isaret || '').trim() : '';

    let source = term
        ? store.messages.filter((entry) => entry._s.includes(term))
        : store.messages;

    if (isaretSuzgeci) {
        source = source.filter((entry) => {
            const i = logIsaretleri[entry.id];
            return isaretSuzgeci === 'isaretsiz' ? !i : (i && i.isaret === isaretSuzgeci);
        });
    }

    // Sayac: hangi durumda kac kayit var. Suzgec dugmelerinin yaninda
    // gosteriliyor - "temizler bitti mi?" sorusu listeye bakmadan cevaplaniyor.
    let sayilar = null;
    if (store.isaretTakibi) {
        sayilar = { ban: 0, supheli: 0, temiz: 0, isaretsiz: 0 };
        store.messages.forEach((entry) => {
            const i = logIsaretleri[entry.id];
            if (i && sayilar[i.isaret] !== undefined) sayilar[i.isaret] += 1;
            else if (!i) sayilar.isaretsiz += 1;
        });
    }

    res.json({
        ok: true,
        key: store.key,
        label: store.label,
        configured: Boolean(store.channelId),
        ilkCekimSiniri: store.ilkCekimSiniri || null,
        isaretTakibi: Boolean(store.isaretTakibi),
        isaretSayilari: sayilar,
        status: store.status,
        error: store.error,
        fetchedAt: store.fetchedAt,
        total: store.messages.length,
        matched: source.length,
        offset,
        messages: source.slice(offset, offset + limit)
            .map((entry) => (store.isaretTakibi ? isaretEkle(stripInternal(entry)) : stripInternal(entry))),
    });
});

// Bir log kaydini Ban / Supheli / Temiz diye isaretler, ya da isareti kaldirir.
// Discord'a hicbir sey gonderilmez - bu yalnizca panel tarafinda bir not.
app.post('/api/loglar/:key/isaret', requireAuth, (req, res) => {
    const store = logStore.get(req.params.key);
    if (!store) return res.status(404).json({ ok: false, error: 'Bilinmeyen log menüsü.' });
    if (!logIzniVar(req.session.username, req.params.key)) {
        return res.status(403).json({ ok: false, error: 'Bu log kanalı için yetkin yok.' });
    }
    if (!store.isaretTakibi) {
        return res.status(400).json({ ok: false, error: 'Bu menüde işaretleme yok.' });
    }

    const { id, isaret } = req.body || {};
    const mesajId = String(id || '').trim();
    if (!mesajId) return res.json({ ok: false, error: 'Mesaj ID yok.' });

    // Kayit gercekten bu kanalda mi? Olmayan bir ID'ye isaret birakmak,
    // dosyayi hicbir zaman temizlenmeyen olu kayitlarla sisirirdi.
    if (!store.messages.some((m) => m.id === mesajId)) {
        return res.json({ ok: false, error: 'Kayıt bu menüde bulunamadı.' });
    }

    if (isaret === null || isaret === '' || isaret === undefined) {
        delete logIsaretleri[mesajId];
    } else if (LOG_ISARETLERI.includes(isaret)) {
        logIsaretleri[mesajId] = { isaret, kisi: req.session.username, at: Date.now() };
    } else {
        return res.json({ ok: false, error: 'Geçersiz işaret.' });
    }
    logIsaretleriniYaz();

    const yeni = logIsaretleri[mesajId] || null;
    addAudit('log-isaret', req.session.username,
        `${store.label}: ${mesajId} -> ${yeni ? yeni.isaret : 'işaret kaldırıldı'}`, req);
    // DIKKAT: tur adi 'log-isaret'. 'log-durum' ZATEN KULLANILIYOR -
    // broadcastLogStatus onunla kanalin YUKLENME durumunu yayinliyor ve
    // istemci onu gorunce menuyu tazeliyor. Ayni adi kullansaydik istemci bu
    // mesaji yuklenme durumu sanip channel.status'u undefined yapardi.
    wsBroadcast({ type: 'log-isaret', key: store.key, id: mesajId, isaret: yeni });

    res.json({ ok: true, id: mesajId, isaret: yeni });
});

app.post('/api/loglar/:key/yenile', requireAuth, async (req, res) => {
    const store = logStore.get(req.params.key);
    if (!store) return res.status(404).json({ ok: false, error: 'Bilinmeyen log menüsü.' });
    if (!logIzniVar(req.session.username, req.params.key)) {
        return res.status(403).json({ ok: false, error: 'Bu log kanalı için yetkin yok.' });
    }
    if (!store.channelId) return res.json({ ok: false, error: 'Bu menü için kanal ID girilmemiş.' });
    // Cekme uzun surebilir - istegi hemen kapatiyoruz, ilerleme WebSocket'ten gelir.
    // Yenile = onbellegi yoksay, bastan cek. Artimli cekim yalnizca yeni
    // mesajlari gorur; silinen/duzenlenen mesajlar ancak tam cekimde yansir.
    fetchAllChannelMessages(store.key, { tamCekim: true })
        .catch((error) => console.log(`[Loglar] ${store.label} yenilenemedi: ${error.message}`));
    return res.json({ ok: true, started: true });
});

// --- YOKLAMAYI AL ---
app.post('/api/yoklama/al-onizleme', requireIzin('yoklama'), async (req, res) => {
    try {
        res.json({ ok: true, data: await buildAttendancePreview() });
    } catch (error) {
        console.log(`[Yoklama] Yoklamayı Al önizleme hatası: ${error.message}`);
        res.json({ ok: false, error: error.message });
    }
});

app.post('/api/yoklama/al-uygula', requireIzin('yoklama'), async (req, res) => {
    const { memberIds, reason } = req.body || {};
    if (!Array.isArray(memberIds) || memberIds.length === 0) {
        return res.json({ ok: false, error: 'Uyarı verilecek kimse seçilmemiş.' });
    }
    if (!reason || !String(reason).trim()) {
        return res.json({ ok: false, error: 'Uyarı sebebi boş bırakılamaz.' });
    }
    try {
        console.log(`[Yoklama] "Yoklamayı Al" uygulanıyor: ${memberIds.length} kişi (${req.session.username}).`);
        const sonuc = await giveBulkWarning(memberIds, String(reason).trim(), panelUserDiscordId(req.session.username));
        addAudit('yoklama-al', req.session.username,
            `${sonuc.warned.length} kişiye uyarı verildi, ${sonuc.skipped.length} atlandı, ${sonuc.failed.length} hata (${String(reason).trim()})`, req);
        return res.json(sonuc);
    } catch (error) {
        console.log(`[Yoklama] Yoklamayı Al hatası: ${error.message}`);
        return res.json({ ok: false, error: error.message });
    }
});

// --- YETKILILER + ROL VER/AL ---
app.get('/api/roller', requireIzin('roller', 'yetkililer'), async (req, res) => {
    try {
        res.json({ ok: true, ...(await listGuildRoles()) });
    } catch (error) {
        console.log(`[Roller] Liste hatasi: ${error.message}`);
        res.json({ ok: false, error: error.message });
    }
});

app.get('/api/yetkililer', requireIzin('yetkililer'), async (req, res) => {
    const roleId = req.query.roleId ? String(req.query.roleId) : null;
    try {
        res.json({ ok: true, ...(await listStaff(roleId)) });
    } catch (error) {
        console.log(`[Yetkililer] Liste hatasi: ${error.message}`);
        res.json({ ok: false, error: error.message });
    }
});

app.post('/api/rol/ver', requireIzin('roller', 'yetkililer'), async (req, res) => {
    const { memberId, roleId } = req.body || {};
    try {
        const sonuc = await sendRoleCommand('rol-ver', memberId, roleId);
        if (sonuc.ok) addAudit('rol-ver', req.session.username, `${sonuc.memberTag || memberId} -> "${sonuc.roleName}" verildi`, req);
        res.json(sonuc);
    } catch (error) {
        console.log(`[Rol] Verme hatasi (${memberId} / ${roleId}): ${error.message}`);
        res.json({ ok: false, error: error.message });
    }
});

app.post('/api/rol/al', requireIzin('roller', 'yetkililer'), async (req, res) => {
    const { memberId, roleId } = req.body || {};
    try {
        const sonuc = await sendRoleCommand('rol-al', memberId, roleId);
        if (sonuc.ok) addAudit('rol-al', req.session.username, `${sonuc.memberTag || memberId} <- "${sonuc.roleName}" alındı`, req);
        res.json(sonuc);
    } catch (error) {
        console.log(`[Rol] Alma hatasi (${memberId} / ${roleId}): ${error.message}`);
        res.json({ ok: false, error: error.message });
    }
});

// ============================================================================
// --- PANEL LOGOSU ---
// Dosya adiyla ugrasmamak icin logo sunucudan servis ediliyor: public/ icinde
// "logo.*" ne varsa o bulunuyor (buyuk/kucuk harf farketmez). Boylece
// logo.png / Logo.PNG / logo.jpg hepsi calisiyor. Panelden de yuklenebiliyor,
// o zaman dosyayi elle kopyalamak hic gerekmiyor.
// ============================================================================
const PUBLIC_DIR = path.join(__dirname, 'public');
const LOGO_TYPES = {
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif':  'image/gif',
};
const LOGO_MAX_BYTES = 3 * 1024 * 1024;

function findLogoFile() {
    let names;
    try {
        names = fs.readdirSync(PUBLIC_DIR);
    } catch (error) {
        return null;
    }
    // "logo.png.png" gibi cift uzantili dosyalari da yakalamak icin adin
    // "logo" ile baslamasi yeterli sayiliyor.
    const aday = names.find((name) => {
        const alt = name.toLowerCase();
        if (!alt.startsWith('logo')) return false;
        return Object.keys(LOGO_TYPES).some((ext) => alt.endsWith(ext));
    });
    if (!aday) return null;
    const ext = Object.keys(LOGO_TYPES).find((e) => aday.toLowerCase().endsWith(e));
    return { file: path.join(PUBLIC_DIR, aday), name: aday, mime: LOGO_TYPES[ext] };
}

// Yuklenen dosyanin gercekten resim oldugunu icerigine bakarak dogrula -
// uzantiya guvenmek yeterli degil.
function detectImageExt(buf) {
    if (buf.length < 12) return null;
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return '.png';
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return '.gif';
    if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return '.webp';
    return null;
}

app.get('/logo', (req, res) => {
    const logo = findLogoFile();
    if (!logo) return res.status(404).end();
    res.setHeader('Content-Type', logo.mime);
    res.setHeader('Cache-Control', 'no-store');
    return res.sendFile(logo.file);
});

app.get('/api/logo/durum', requireAuth, (req, res) => {
    const logo = findLogoFile();
    let boyut = null;
    if (logo) {
        try { boyut = fs.statSync(logo.file).size; } catch (error) { boyut = null; }
    }
    res.json({ ok: true, var: Boolean(logo), name: logo ? logo.name : null, size: boyut });
});

app.post('/api/logo', requireIzin('ayarlar'), express.raw({ type: '*/*', limit: '3mb' }), (req, res) => {
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || buf.length === 0) {
        return res.json({ ok: false, error: 'Dosya alınamadı.' });
    }
    if (buf.length > LOGO_MAX_BYTES) {
        return res.json({ ok: false, error: 'Dosya 3 MB üstü, daha küçük bir görsel seç.' });
    }
    const ext = detectImageExt(buf);
    if (!ext) {
        return res.json({ ok: false, error: 'Bu bir resim dosyası değil. PNG, JPG, WEBP ya da GIF olmalı.' });
    }

    try {
        // Once eski logo dosyalarini temizle - yoksa logo.png ve logo.jpg
        // birlikte kalir, hangisinin gosterildigi belirsiz olurdu.
        fs.readdirSync(PUBLIC_DIR)
            .filter((name) => name.toLowerCase().startsWith('logo')
                && Object.keys(LOGO_TYPES).some((e) => name.toLowerCase().endsWith(e)))
            .forEach((name) => {
                try { fs.unlinkSync(path.join(PUBLIC_DIR, name)); } catch (error) { /* yoksay */ }
            });
        fs.writeFileSync(path.join(PUBLIC_DIR, `logo${ext}`), buf);
    } catch (error) {
        return res.json({ ok: false, error: `Kaydedilemedi: ${error.message}` });
    }

    console.log(`[Logo] Panel logosu güncellendi (${req.session.username}, ${buf.length} bayt, logo${ext}).`);
    addAudit('logo-guncelle', req.session.username, `Panel logosu yüklendi (logo${ext}, ${Math.round(buf.length / 1024)} KB)`, req);
    return res.json({ ok: true, name: `logo${ext}`, size: buf.length });
});

app.post('/api/logo/sil', requireIzin('ayarlar'), (req, res) => {
    const logo = findLogoFile();
    if (!logo) return res.json({ ok: false, error: 'Zaten logo yok.' });
    try {
        fs.unlinkSync(logo.file);
    } catch (error) {
        return res.json({ ok: false, error: `Silinemedi: ${error.message}` });
    }
    addAudit('logo-guncelle', req.session.username, 'Panel logosu kaldırıldı', req);
    return res.json({ ok: true });
});

// ============================================================================
// --- ETKINLIK SAYACI ---
// Etkinlik/ticket kanalindaki mesajlari yazara gore sayiyor. Yetkililerin
// hepsi listeleniyor - hic mesaj atmayanlar da gorunsun diye (asil aranan
// bilgi cogu zaman "kim hic yazmamis").
// ============================================================================
// DIKKAT: yazara gore DEGIL, resolvePerson'a gore sayiyor. Ticket loglarini
// bot attigi icin yazara gore saymak butun sayimi bota yigardi; gunluk rapor
// zaten kisi cikarimini kullaniyordu, ikisi ayri sonuc veriyordu.
function countByPerson(store) {
    const sayac = new Map();
    const sonMesaj = new Map();
    let eslesmeyen = 0;
    store.messages.forEach((m) => {
        const kisi = resolvePerson(store, m);
        if (!kisi) { eslesmeyen += 1; return; }
        sayac.set(kisi, (sayac.get(kisi) || 0) + 1);
        const onceki = sonMesaj.get(kisi);
        if (!onceki || m.createdTimestamp > onceki) sonMesaj.set(kisi, m.createdTimestamp);
    });
    return { sayac, sonMesaj, eslesmeyen };
}

async function buildActivityReport(key) {
    const store = logStore.get(key);
    if (!store || store.kind !== 'aktivite') throw new Error('Bilinmeyen etkinlik menusu.');

    const temel = {
        key: store.key,
        label: store.label,
        configured: Boolean(store.channelId),
        status: store.status,
        loaded: store.loaded,
        error: store.error,
        fetchedAt: store.fetchedAt,
    };
    if (!store.channelId) {
        return { ...temel, totalMessages: 0, staffTotal: 0, otherTotal: 0, members: [] };
    }

    const { sayac, sonMesaj, eslesmeyen } = countByPerson(store);

    // Yetkilileri getir - hepsi listelensin, sayisi 0 olanlar dahil.
    let yetkililer = [];
    try {
        const guild = await getReadyGuild();
        await ensureMembersFetched(guild);
        yetkililer = [...guild.members.cache.values()].filter((member) => (
            ATTENDANCE_ROLE_IDS.some((roleId) => member.roles.cache.has(roleId))
        ));
    } catch (error) {
        console.log(`[Etkinlik] Yetkili listesi alinamadi: ${error.message}`);
    }

    const yetkiliIdleri = new Set(yetkililer.map((m) => m.id));
    const members = yetkililer.map((member) => ({
        id: member.id,
        displayName: member.displayName,
        tag: member.user.tag,
        avatarURL: member.displayAvatarURL({ size: 64 }),
        count: sayac.get(member.id) || 0,
        lastAt: sonMesaj.get(member.id) || null,
    }));

    // Cok yazandan az yazana; esitlikte ada gore.
    members.sort((a, b) => (b.count - a.count) || a.displayName.localeCompare(b.displayName, 'tr'));

    const staffTotal = members.reduce((t, m) => t + m.count, 0);
    return {
        ...temel,
        totalMessages: store.messages.length,
        staffTotal,
        // Yetkili olmayan kisilere sayilanlar + kisi cikarilamayanlar
        otherTotal: store.messages.length - staffTotal - eslesmeyen,
        unmatched: eslesmeyen,
        members,
    };
}

// Belirli bir GUNUN kisi basina sayilari. Varsayilan bugun (Turkiye saati).
async function buildDailyReport(key, aralik) {
    const store = logStore.get(key);
    if (!store || store.kind !== 'aktivite') throw new Error('Bilinmeyen etkinlik menusu.');

    const temel = {
        key: store.key,
        label: store.label,
        configured: Boolean(store.channelId),
        status: store.status,
        personFrom: store.personFrom,
        day: aralik.bas,          // tek gunde eski davranis
        bas: aralik.bas,
        bit: aralik.bit,
        gunSayisi: aralik.gunler.length,
        aralikMi: aralik.aralikMi,
        today: bugununAnahtari(),
    };
    if (!store.channelId) {
        return { ...temel, members: [], dayTotal: 0, unmatched: 0, availableDays: [] };
    }
    if (!store.dailyIndex) buildDailyIndex(store);

    // Araliktaki gunleri tek bir tabloda topluyoruz.
    const gunluk = new Map();
    aralik.gunler.forEach((g) => {
        const o = store.dailyIndex.get(g);
        if (!o) return;
        o.forEach((v, kisi) => {
            const onceki = gunluk.get(kisi);
            gunluk.set(kisi, {
                c: (onceki ? onceki.c : 0) + v.c,
                last: Math.max(onceki ? onceki.last : 0, v.last),
            });
        });
    });

    let yetkililer = [];
    try {
        const guild = await getReadyGuild();
        await ensureMembersFetched(guild);
        yetkililer = [...guild.members.cache.values()].filter((member) => (
            ATTENDANCE_ROLE_IDS.some((roleId) => member.roles.cache.has(roleId))
        ));
    } catch (error) {
        console.log(`[Etkinlik] Gunluk rapor - yetkili listesi alinamadi: ${error.message}`);
    }

    const members = yetkililer.map((member) => ({
        id: member.id,
        displayName: member.displayName,
        tag: member.user.tag,
        avatarURL: member.displayAvatarURL({ size: 64 }),
        count: (gunluk.get(member.id) || {}).c || 0,
        lastAt: (gunluk.get(member.id) || {}).last || null,
    }));
    members.sort((a, b) => (b.count - a.count) || a.displayName.localeCompare(b.displayName, 'tr'));

    const yetkiliIdleri = new Set(members.map((m) => m.id));
    let digerToplam = 0;
    gunluk.forEach((v, kisi) => { if (!yetkiliIdleri.has(kisi)) digerToplam += v.c; });

    // Son 14 gunun toplamlari - tarih secicide hangi gunlerde veri var gostersin
    const gunler = [...store.dailyIndex.keys()].sort().reverse().slice(0, 14).map((g) => {
        let toplam = 0;
        store.dailyIndex.get(g).forEach((v) => { toplam += v.c; });
        return { day: g, total: toplam };
    });

    return {
        ...temel,
        members,
        dayTotal: members.reduce((t, m) => t + m.count, 0) + digerToplam,
        staffTotal: members.reduce((t, m) => t + m.count, 0),
        otherTotal: digerToplam,
        unmatched: store.unmatched || 0,
        availableDays: gunler,
    };
}

// BICIM KONTROLU: ticket botunun mesaj bicimini gormeden kurulan cikarim
// dogru calisiyor mu? Hangi stratejinin ne kadar tuttugunu ve ornek mesajlari
// dondurur - ekran goruntusu beklemeden teshis edilebilsin diye.
app.get('/api/etkinlik/:key/bicim', requireIzin('etkinlik'), async (req, res) => {
    const store = logStore.get(req.params.key);
    if (!store || (store.kind !== 'aktivite' && store.kind !== 'aktiflik')) {
        return res.status(404).json({ ok: false, error: 'Bilinmeyen menü.' });
    }
    if (!store.channelId) return res.json({ ok: false, error: 'Bu menü için kanal ID girilmemiş.' });

    const yontemler = {};
    const yazarlar = new Map();
    let eslesen = 0;
    store.messages.forEach((entry) => {
        const { id, via } = resolvePersonDetailed(store, entry);
        yontemler[via || 'bulunamadı'] = (yontemler[via || 'bulunamadı'] || 0) + 1;
        if (id) eslesen += 1;
        if (entry.authorTag) yazarlar.set(entry.authorTag, (yazarlar.get(entry.authorTag) || 0) + 1);
    });

    // Kac farkli kisiye dagilmis? Tek kisiye yigiliyorsa cikarim yanlis
    // demektir (ornegin hepsi ticket botuna sayiliyordur).
    const dagilim = new Map();
    store.messages.forEach((entry) => {
        const id = resolvePerson(store, entry);
        if (id) dagilim.set(id, (dagilim.get(id) || 0) + 1);
    });

    let yetkiliEslesen = 0;
    try {
        const guild = await getReadyGuild();
        await ensureMembersFetched(guild);
        dagilim.forEach((adet, id) => {
            const member = guild.members.cache.get(id);
            if (member && ATTENDANCE_ROLE_IDS.some((r) => member.roles.cache.has(r))) yetkiliEslesen += adet;
        });
    } catch (error) { /* yetkili listesi yoksa bu satiri atla */ }

    return res.json({
        ok: true,
        key: store.key,
        label: store.label,
        personFrom: store.personFrom,
        total: store.messages.length,
        matched: eslesen,
        methods: yontemler,
        distinctPeople: dagilim.size,
        staffMatched: yetkiliEslesen,
        topAuthors: [...yazarlar.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
            .map(([tag, adet]) => ({ tag, count: adet })),
        samples: store.messages.slice(0, 5).map((entry) => ({
            ...stripInternal(entry),
            resolved: resolvePersonDetailed(store, entry),
        })),
    });
});

app.get('/api/etkinlik/:key/gunluk', requireIzin('etkinlik'), async (req, res) => {
    let aralik;
    try {
        aralik = araligiCoz(req.query);
    } catch (error) {
        return res.json({ ok: false, error: error.message });
    }
    try {
        return res.json({ ok: true, ...(await buildDailyReport(req.params.key, aralik)) });
    } catch (error) {
        console.log(`[Etkinlik] Gunluk rapor hatasi (${req.params.key}): ${error.message}`);
        return res.json({ ok: false, error: error.message });
    }
});

// ============================================================================
// --- AKTIFLIK: SESTE GECIRILEN SURE ---
// Her yetkilinin gunde ne kadar ses kanalinda kaldigini olcer.
//
// Yontem: katilma/ayrilma olaylarini saymak yerine belirli araliklarla
// "su an seste kim var" diye bakip gecen sureyi o gune ekliyoruz. Bunun uc
// avantaji var: bot yeniden baslatildiginda acik oturumlar kaybolmuyor,
// gece yarisi devreden sure kendiliginden dogru gune yaziliyor, ve
// kacirilan bir olay yuzunden birinin suresi sonsuza kadar sayilmiyor.
// ============================================================================
const VOICE_DATA_PATH = path.join(ROOT_DIR, 'voice-activity.json');
const VOICE_TICK_MS = 30 * 1000;
const VOICE_GUN_SINIRI = 90; // kac gunluk kayit tutulacak

function loadVoiceData() {
    try {
        const d = JSON.parse(fs.readFileSync(VOICE_DATA_PATH, 'utf8'));
        return (d && typeof d === 'object') ? d : {};
    } catch (error) {
        return {};
    }
}
const voiceData = loadVoiceData(); // { "YYYY-MM-DD": { uyeId: saniye } }
let voiceDirty = false;
let voiceLastTick = Date.now();
// Su an seste olanlarin bu oturuma ne zaman basladigi - "3 saattir seste"
// bilgisini gosterebilmek icin.
const voiceSessionStart = new Map();
// Teshis icin: son tick ne zaman calisti ve kac kisi sayildi.
let voiceSonTick = { at: null, sayilan: 0 };

function persistVoiceData() {
    if (!voiceDirty) return;
    try {
        fs.writeFileSync(VOICE_DATA_PATH, JSON.stringify(voiceData));
        voiceDirty = false;
    } catch (error) {
        console.log(`[Aktiflik] Kaydedilemedi: ${error.message}`);
    }
}

function trimVoiceData() {
    const gunler = Object.keys(voiceData).sort();
    while (gunler.length > VOICE_GUN_SINIRI) {
        delete voiceData[gunler.shift()];
        voiceDirty = true;
    }
}

function voiceTick() {
    const simdi = Date.now();
    // Uzun duraklamalarda (surec askida kaldi, bilgisayar uyudu) tek seferde
    // devasa sure eklenmesin diye tavan koyuyoruz.
    const gecen = Math.min(simdi - voiceLastTick, VOICE_TICK_MS * 3);
    voiceLastTick = simdi;
    if (gecen <= 0) return;

    const guild = client.guilds.cache.get(GUILD_ID);
    if (!guild) return;

    const gun = dayKey(simdi);
    if (!voiceData[gun]) voiceData[gun] = {};
    const bugun = voiceData[gun];
    const sesteOlanlar = new Set();

    // Ses kanallarini dolasmak yerine dogrudan ses durumlarina bakiyoruz.
    // channel.members bir getter ve uye onbellegine bagli; onbellek eksikse
    // sessizce bos donuyor ve kimse sayilmiyor. voiceStates gateway'den
    // dogrudan geliyor, daha guvenilir.
    const durumlar = guild.voiceStates && guild.voiceStates.cache ? guild.voiceStates.cache : null;
    if (durumlar && durumlar.size > 0) {
        durumlar.forEach((state) => {
            if (!state.channelId) return;
            const member = state.member || guild.members.cache.get(state.id);
            if (!member) return;
            if (!ATTENDANCE_ROLE_IDS.some((roleId) => member.roles.cache.has(roleId))) return;
            sesteOlanlar.add(member.id);
            bugun[member.id] = (bugun[member.id] || 0) + gecen / 1000;
            voiceDirty = true;
            if (!voiceSessionStart.has(member.id)) voiceSessionStart.set(member.id, simdi - gecen);
        });
    } else {
        // Yedek yol: ses durumlari bos gelirse kanallardan oku.
        guild.channels.cache.forEach((channel) => {
            if (channel.type !== 'GUILD_VOICE' && channel.type !== 'GUILD_STAGE_VOICE') return;
            channel.members.forEach((member) => {
                if (!ATTENDANCE_ROLE_IDS.some((roleId) => member.roles.cache.has(roleId))) return;
                sesteOlanlar.add(member.id);
                bugun[member.id] = (bugun[member.id] || 0) + gecen / 1000;
                voiceDirty = true;
                if (!voiceSessionStart.has(member.id)) voiceSessionStart.set(member.id, simdi - gecen);
            });
        });
    }
    voiceSonTick = { at: simdi, sayilan: sesteOlanlar.size };

    // Sesten cikanlarin oturum baslangicini temizle
    [...voiceSessionStart.keys()].forEach((id) => {
        if (!sesteOlanlar.has(id)) voiceSessionStart.delete(id);
    });
}

// Kayit her tick'te diske yaziliyor: surec beklenmedik sekilde olurse
// (kill -9, sunucu yeniden baslatma) en fazla bir tick'lik sure kaybolsun.
// Dosya kucuk oldugu icin bu yazma maliyeti onemsiz.
setInterval(() => { voiceTick(); persistVoiceData(); }, VOICE_TICK_MS);
setInterval(trimVoiceData, 60 * 60 * 1000);
process.on('exit', persistVoiceData);
// Log onbellegini de kapanirken yaz - aksi halde son periyodik yazmadan
// sonraki canli mesajlar diske gecmez ve bir sonraki acilista tekrar cekilir.
process.on('exit', logCacheHepsiniYaz);

// DIKKAT: 'exit' olayi SIGINT/SIGTERM'de CALISMIYOR (olculdu). pm2 restart
// SIGINT gonderdigi icin bu iki sinyali acikca yakalayip diske yazdiktan
// sonra cikiyoruz; yoksa her yeniden baslatmada son yazmadan sonraki mesajlar
// onbellege gecmez ve tekrar cekilirdi.
let kapaniyor = false;
['SIGINT', 'SIGTERM'].forEach((sinyal) => {
    process.on(sinyal, () => {
        if (kapaniyor) return; // ikinci sinyalde beklemeden cik
        kapaniyor = true;
        console.log(`[Kapanis] ${sinyal} alindi, veriler diske yaziliyor...`);
        try { persistVoiceData(); } catch (error) { /* yine de cikacagiz */ }
        try { logCacheHepsiniYaz(); } catch (error) { /* yine de cikacagiz */ }
        process.exit(0);
    });
});

async function buildVoiceReport(aralik) {
    const hedefGun = aralik.bas;
    // Araliktaki gunlerin sureleri kisi basina toplaniyor.
    const gunVerisi = {};
    aralik.gunler.forEach((g) => {
        const o = voiceData[g];
        if (!o) return;
        Object.entries(o).forEach(([id, sn]) => { gunVerisi[id] = (gunVerisi[id] || 0) + sn; });
    });
    const simdi = Date.now();

    let yetkililer = [];
    let guild = null;
    try {
        guild = await getReadyGuild();
        await ensureMembersFetched(guild);
        yetkililer = [...guild.members.cache.values()].filter((member) => (
            ATTENDANCE_ROLE_IDS.some((roleId) => member.roles.cache.has(roleId))
        ));
    } catch (error) {
        console.log(`[Aktiflik] Yetkili listesi alinamadi: ${error.message}`);
    }

    // "Su an seste" bilgisi yalnizca aralik BUGUNU kapsiyorsa anlamli.
    const bugunMu = aralik.gunler.includes(bugununAnahtari());
    const uyeler = yetkililer.map((member) => {
        // Kanali distaki guild uzerinden aliyoruz - member.guild her ortamda
        // dolu gelmiyor.
        const sesKanali = guild && member.voice && member.voice.channelId
            ? (guild.channels.cache.get(member.voice.channelId) || null)
            : null;
        const oturumBas = voiceSessionStart.get(member.id) || null;
        return {
            id: member.id,
            displayName: member.displayName,
            tag: member.user.tag,
            avatarURL: member.displayAvatarURL({ size: 64 }),
            seconds: Math.round(gunVerisi[member.id] || 0),
            inVoice: bugunMu && Boolean(sesKanali),
            channelName: sesKanali ? sesKanali.name : null,
            sessionSeconds: bugunMu && oturumBas ? Math.round((simdi - oturumBas) / 1000) : 0,
        };
    });

    // Cok kalandan az kalana; esitlikte ada gore.
    uyeler.sort((a, b) => (b.seconds - a.seconds) || a.displayName.localeCompare(b.displayName, 'tr'));

    const gunler = Object.keys(voiceData).sort().reverse().slice(0, 14).map((g) => ({
        day: g,
        total: Math.round(Object.values(voiceData[g]).reduce((t, v) => t + v, 0)),
    }));

    return {
        day: hedefGun,
        bas: aralik.bas,
        bit: aralik.bit,
        gunSayisi: aralik.gunler.length,
        aralikMi: aralik.aralikMi,
        today: bugununAnahtari(),
        trackingSince: Object.keys(voiceData).sort()[0] || null,
        members: uyeler,
        totalSeconds: uyeler.reduce((t, m) => t + m.seconds, 0),
        inVoiceCount: uyeler.filter((m) => m.inVoice).length,
        availableDays: gunler,
    };
}

// TESHIS: sayac su an neyi goruyor? "Hic veri yok" ile "sayac calismiyor"
// arasindaki farki ayirt etmek icin.
app.get('/api/aktiflik/tani', requireIzin('aktiflik'), (req, res) => {
    const guild = client.guilds.cache.get(GUILD_ID);
    const simdi = Date.now();
    const gun = bugununAnahtari();

    let sesKanaliSayisi = 0;
    let sestekiHerkes = 0;
    let sestekiYetkili = 0;
    const ornekler = [];

    if (guild) {
        guild.channels.cache.forEach((c) => {
            if (c.type === 'GUILD_VOICE' || c.type === 'GUILD_STAGE_VOICE') sesKanaliSayisi += 1;
        });
        const durumlar = guild.voiceStates && guild.voiceStates.cache;
        if (durumlar) {
            durumlar.forEach((state) => {
                if (!state.channelId) return;
                sestekiHerkes += 1;
                const member = state.member || guild.members.cache.get(state.id);
                const yetkili = member && ATTENDANCE_ROLE_IDS.some((r) => member.roles.cache.has(r));
                if (yetkili) sestekiYetkili += 1;
                if (ornekler.length < 8) {
                    ornekler.push({
                        id: state.id,
                        name: member ? member.displayName : '(üye önbellekte yok)',
                        yetkili: Boolean(yetkili),
                        kanal: guild.channels.cache.get(state.channelId)
                            ? guild.channels.cache.get(state.channelId).name : state.channelId,
                    });
                }
            });
        }
    }

    res.json({
        ok: true,
        discord: discordStatus,
        guildBulundu: Boolean(guild),
        uyeOnbellegi: guild ? guild.members.cache.size : 0,
        uyelerHazir: membersState.status,
        sesKanaliSayisi,
        sesDurumuSayisi: guild && guild.voiceStates && guild.voiceStates.cache ? guild.voiceStates.cache.size : 0,
        sestekiHerkes,
        sestekiYetkili,
        yetkiliRolleri: ATTENDANCE_ROLE_IDS,
        sonTick: voiceSonTick,
        tickAraligiSn: VOICE_TICK_MS / 1000,
        bugunKayitliKisi: Object.keys(voiceData[gun] || {}).length,
        bugunToplamSn: Math.round(Object.values(voiceData[gun] || {}).reduce((t, v) => t + v, 0)),
        kayitliGunler: Object.keys(voiceData).sort().reverse().slice(0, 7),
        ornekler,
        simdi,
    });
});

app.get('/api/aktiflik', requireIzin('aktiflik'), async (req, res) => {
    let aralik;
    try {
        aralik = araligiCoz(req.query);
    } catch (error) {
        return res.json({ ok: false, error: error.message });
    }
    try {
        return res.json({ ok: true, ...(await buildVoiceReport(aralik)) });
    } catch (error) {
        console.log(`[Aktiflik] Rapor hatasi: ${error.message}`);
        return res.json({ ok: false, error: error.message });
    }
});

app.get('/api/etkinlik', requireIzin('etkinlik'), (req, res) => {
    res.json({
        ok: true,
        channels: ACTIVITY_CHANNELS.map((channel) => {
            const store = logStore.get(channel.key);
            return {
                key: store.key,
                label: store.label,
                configured: Boolean(store.channelId),
                status: store.status,
                loaded: store.loaded,
            };
        }),
    });
});

app.get('/api/etkinlik/:key', requireIzin('etkinlik'), async (req, res) => {
    try {
        res.json({ ok: true, ...(await buildActivityReport(req.params.key)) });
    } catch (error) {
        console.log(`[Etkinlik] Rapor hatasi (${req.params.key}): ${error.message}`);
        res.json({ ok: false, error: error.message });
    }
});

// Bir kisinin o kanaldaki mesajlari - listede uzerine tiklayinca aciliyor.
app.get('/api/etkinlik/:key/mesajlar', requireIzin('etkinlik'), (req, res) => {
    const store = logStore.get(req.params.key);
    if (!store || (store.kind !== 'aktivite' && store.kind !== 'aktiflik')) {
        return res.status(404).json({ ok: false, error: 'Bilinmeyen menü.' });
    }
    const memberId = String(req.query.memberId || '');
    if (!memberId) return res.json({ ok: false, error: 'Kişi seçilmemiş.' });

    const offset = Math.max(0, Number(req.query.offset) || 0);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const kisininkiler = store.messages.filter((m) => m.authorId === memberId);

    return res.json({
        ok: true,
        memberId,
        total: kisininkiler.length,
        offset,
        messages: kisininkiler.slice(offset, offset + limit).map(stripInternal),
    });
});

// ============================================================================
// --- OTOMATIK GUNLUK YOKLAMA ---
// Her gun belirlenen saatte (Turkiye) taramayi yapip uyarilari uyguluyor.
// Kimse basinda olmadan rol verdigi icin panelden kapatilabiliyor ve her
// calisma hesap loglarina yaziliyor.
// ============================================================================
// ============================================================================
// --- PRIME SAAT HATIRLATMASI ---
// Prime saatlerde ONLINE olup seste OLMAYAN yetkililere "sese gecer misin"
// hatirlatmasi: hem bir duyuru kanalindan hem DM ile.
//
// "Aktif" = Discord'da online/idle/dnd. Presence bilgisi gelmemis kisiyi
// (presence null) BILEREK atliyoruz: emin olmadan DM atmaktansa atmamak yeg,
// aksi halde cevrimdisi insanlar her saat basi DM alirdi.
// ============================================================================
const PRIME_VARSAYILAN_KANAL = '1470230475485479097';
const PRIME_VARSAYILAN_SAATLER = ['20:00', '21:00', '22:00'];
const PRIME_VARSAYILAN_MESAJ = 'Aktif görünüyorsun ama seste değilsin. '
    + 'Prime saatlerdeyiz, sese geçebilir misin?';
// DM'ler arasi bekleme. Selfbot ile arka arkaya DM atmak hesabin
// isaretlenmesine yol aciyor: 1.5 saniyelik eski aralik Discord'un spam
// esigini tetikliyordu ve hesap ihlal aldikca oturum kapatiliyor, yani her
// seferinde TOKEN de sifirlaniyordu. 10 saniye o esigin belirgin sekilde
// altinda kaliyor.
//
// Bedeli: tavan dolu oldugunda tek bir prime turu
// 39 x 10 sn = ~6.5 dakika suruyor. Duyuru kanalina yazilan toplu etiket
// mesaji ANINDA gittigi icin kimse hatirlatmayi gec gormuyor - DM yalnizca
// ikinci bir dokunus.
const PRIME_DM_ARALIK_MS = 10000;
const PRIME_DM_TAVANI = 40;

let primeSonCalisma = null;

function primeSaatleri() {
    const a = panelSettings.primeSaatler;
    return Array.isArray(a) && a.length ? a : PRIME_VARSAYILAN_SAATLER;
}

// Presence "aktif" mi? Bilinmiyorsa false donuyoruz (yukarida aciklandi).
function uyeAktifMi(member) {
    const p = member.presence;
    if (!p || !p.status) return false;
    return p.status === 'online' || p.status === 'idle' || p.status === 'dnd';
}

async function primeHatirlatmaCalistir(tetikleyen) {
    console.log(`[Prime] Başlıyor (${tetikleyen})...`);
    const sonuc = {
        at: Date.now(),
        tetikleyen,
        yetkili: 0,
        seste: 0,
        cevrimdisi: 0,
        hedef: 0,
        dmGitti: 0,
        dmHata: 0,
        kanalHatasi: null,
        isimler: [],
    };
    try {
        const guild = await getReadyGuild();
        await ensureMembersFetched(guild);
        const yetkililer = [...guild.members.cache.values()].filter((m) => (
            ATTENDANCE_ROLE_IDS.some((roleId) => m.roles.cache.has(roleId))
        ));
        sonuc.yetkili = yetkililer.length;

        const hedefler = [];
        yetkililer.forEach((m) => {
            if (m.voice && m.voice.channelId) { sonuc.seste += 1; return; }
            if (!uyeAktifMi(m)) { sonuc.cevrimdisi += 1; return; }
            hedefler.push(m);
        });
        sonuc.hedef = hedefler.length;
        sonuc.isimler = hedefler.map((m) => m.displayName);

        if (hedefler.length === 0) {
            console.log('[Prime] Aktif olup seste olmayan yetkili yok, bir şey yazılmadı.');
            primeSonCalisma = sonuc;
            wsBroadcast({ type: 'prime', sonuc });
            return sonuc;
        }

        const metin = panelSettings.primeMesaj || PRIME_VARSAYILAN_MESAJ;

        // 1) Duyuru kanali - tek mesajda hepsini etiketle
        const kanalId = panelSettings.primeKanal || PRIME_VARSAYILAN_KANAL;
        try {
            const kanal = await client.channels.fetch(kanalId);
            if (!kanal) throw new Error(`Kanal bulunamadı (${kanalId}).`);
            await kanal.send(`${hedefler.map((m) => `<@${m.id}>`).join(' ')}\n\n${metin}`);
        } catch (error) {
            sonuc.kanalHatasi = error.message;
            console.log(`[Prime] Kanala yazılamadı: ${error.message}`);
        }

        // 2) DM - araliklarla, tavanla
        if (panelSettings.primeDm !== false) {
            for (let i = 0; i < hedefler.length && i < PRIME_DM_TAVANI; i += 1) {
                const m = hedefler[i];
                try {
                    // eslint-disable-next-line no-await-in-loop
                    await m.send(metin);
                    sonuc.dmGitti += 1;
                } catch (error) {
                    // DM'i kapali olanlar burada dusuyor - normal, hata sayilmaz.
                    sonuc.dmHata += 1;
                }
                // Bekleme yalnizca ARKASINDAN baska bir DM gelecekse.
                // Eski kosul (i < hedefler.length - 1) tavani gormezden
                // geliyordu: 100 hedef varken 40. DM'den sonra da uyuyor,
                // hicbir ise yaramayan bir bekleme ekliyordu.
                const sonIndeks = Math.min(hedefler.length, PRIME_DM_TAVANI) - 1;
                if (i < sonIndeks) {
                    // eslint-disable-next-line no-await-in-loop
                    await new Promise((r) => setTimeout(r, PRIME_DM_ARALIK_MS));
                }
            }
        }

        console.log(`[Prime] Bitti: ${sonuc.hedef} kişi hedeflendi, `
            + `${sonuc.dmGitti} DM gitti, ${sonuc.dmHata} DM kapalı/hata. `
            + `(${sonuc.seste} seste, ${sonuc.cevrimdisi} çevrimdışı)`);
        addAudit('prime-hatirlatma', 'sistem',
            `Prime hatırlatma (${tetikleyen}): ${sonuc.hedef} kişi, ${sonuc.dmGitti} DM`, null);
    } catch (error) {
        sonuc.hataMesaji = error.message;
        console.log(`[Prime] Hata: ${error.message}`);
        addAudit('prime-hatirlatma', 'sistem', `Prime hatırlatma hata verdi: ${error.message}`, null);
    }
    primeSonCalisma = sonuc;
    wsBroadcast({ type: 'prime', sonuc });
    return sonuc;
}

// Dakikada bir saate bakiyoruz - oto yoklamayla ayni desen. Gunluk kilit saat
// basina ayri, yoksa ilk calisan saat digerlerini o gun susturmus olurdu.
setInterval(() => {
    if (!panelSettings.primeAcik) return;
    if (discordStatus !== 'bağlı') return;
    const simdi = suankiSaat();
    const bugun = bugununAnahtari();
    if (!primeSaatleri().includes(simdi)) return;
    if (!panelSettings.primeSonGunler || typeof panelSettings.primeSonGunler !== 'object') {
        panelSettings.primeSonGunler = {};
    }
    if (panelSettings.primeSonGunler[simdi] === bugun) return; // bu saat bugün çalıştı
    panelSettings.primeSonGunler[simdi] = bugun;
    savePanelSettings();
    primeHatirlatmaCalistir(`zamanlanmış ${simdi}`);
}, 60 * 1000);

const OTO_YOKLAMA_VARSAYILAN_SAAT = '20:30';
const saatBicimi = new Intl.DateTimeFormat('en-GB', {
    timeZone: SAAT_DILIMI, hour: '2-digit', minute: '2-digit', hour12: false,
});
function suankiSaat() {
    return saatBicimi.format(new Date()); // "20:30"
}

let otoYoklamaSonCalisma = null; // { gun, at, sonuc }

// satir: { id, saat, kanal, acik, sebep } - tek bir zamanlanmis yoklama.
// Elle tetiklemede satir verilmezse ilk satirin ayarlariyla calisiyor.
async function otoYoklamaCalistir(tetikleyen, satir = null) {
    const gun = bugununAnahtari();
    const hedefSatir = satir || (panelSettings.otoYoklamalar || [])[0] || {};
    const kanal = hedefSatir.kanal || null;
    console.log(`[OtoYoklama] Başlıyor (${tetikleyen})`
        + `${kanal ? ` · duyuru kanalı ${kanal}` : ''}...`);
    try {
        const onizleme = await buildAttendancePreview();
        const hedefler = onizleme.warn.map((m) => m.id);
        const sebep = hedefSatir.sebep
            || panelSettings.otoYoklamaSebep
            || 'Otomatik yoklama - seste değil, mazereti yok';

        let sonuc = { warned: [], skipped: [], failed: [] };
        if (hedefler.length > 0) {
            sonuc = await giveBulkWarning(hedefler, sebep, null, kanal);
        }

        otoYoklamaSonCalisma = {
            gun,
            at: Date.now(),
            tetikleyen,
            saat: hedefSatir.saat || null,
            kanal,
            duyuruHatasi: sonuc.announceError || null,
            kontrol: onizleme.totalChecked,
            seste: onizleme.totalInVoice,
            mazeretli: onizleme.excused.length,
            maksKademe: onizleme.maxTier.length,
            uyarilan: sonuc.warned.length,
            atlanan: sonuc.skipped.length,
            hata: sonuc.failed.length,
            ilkHata: sonuc.failed.length ? sonuc.failed[0].error : null,
        };
        // Gunluk kilidi BILEREK burada kurmuyoruz: onu zamanlayici, kendisi
        // tetiklemeden once kuruyor. Boylece panelden "Şimdi çalıştır" ile
        // yapilan bir deneme, o gunun 20:30 calismasini yemiyor.
        console.log(`[OtoYoklama] Bitti: ${sonuc.warned.length} uyarı, `
            + `${onizleme.excused.length} mazeretli/katılan, ${sonuc.failed.length} hata.`);
        addAudit('oto-yoklama', 'sistem',
            `Otomatik yoklama (${tetikleyen}): ${sonuc.warned.length} uyarı verildi, `
            + `${onizleme.excused.length} mazeretli, ${sonuc.failed.length} hata`, null);
        wsBroadcast({ type: 'oto-yoklama', sonuc: otoYoklamaSonCalisma });
        return otoYoklamaSonCalisma;
    } catch (error) {
        console.log(`[OtoYoklama] Hata: ${error.message}`);
        otoYoklamaSonCalisma = { gun, at: Date.now(), tetikleyen, hataMesaji: error.message };
        addAudit('oto-yoklama', 'sistem', `Otomatik yoklama hata verdi: ${error.message}`, null);
        return otoYoklamaSonCalisma;
    }
}

// Dakikada bir saate bakiyoruz. setTimeout ile tek sefer planlamak yerine
// boyle: surec uzun sure askida kalsa ya da saat degisse bile kacirmiyor,
// ve ayni gun icinde iki kez calismasini otoYoklamaSonGun engelliyor.
setInterval(() => {
    if (discordStatus !== 'bağlı') return;
    const simdi = suankiSaat();
    const bugun = bugununAnahtari();
    (panelSettings.otoYoklamalar || []).forEach((satir) => {
        if (!satir.acik) return;
        if (satir.saat !== simdi) return;
        if (panelSettings.otoYoklamaSonGunler[satir.id] === bugun) return; // bugün çalıştı
        panelSettings.otoYoklamaSonGunler[satir.id] = bugun; // yarışı engelle
        savePanelSettings();
        otoYoklamaCalistir(`zamanlanmış ${satir.saat}`, satir);
    });
}, 60 * 1000);

const SAAT_BICIMI = /^([01]\d|2[0-3]):[0-5]\d$/;

app.get('/api/oto-yoklama', requireIzin('ayarlar'), (req, res) => {
    const bugun = bugununAnahtari();
    res.json({
        ok: true,
        sebep: panelSettings.otoYoklamaSebep || 'Otomatik yoklama - seste değil, mazereti yok',
        saatDilimi: SAAT_DILIMI,
        suanki: suankiSaat(),
        sonCalisma: otoYoklamaSonCalisma,
        varsayilanKanal: WARNING_ANNOUNCE_CHANNEL_ID,
        yoklamalar: (panelSettings.otoYoklamalar || []).map((satir) => ({
            ...satir,
            bugunCalisti: panelSettings.otoYoklamaSonGunler[satir.id] === bugun,
        })),
    });
});

// Tum listeyi birden kaydediyoruz: satir ekleme/silme/duzenleme tek istekte
// olsun, arayuzle sunucu arasinda yarim kalmis durum olusmasin.
app.post('/api/oto-yoklama', requireIzin('ayarlar'), (req, res) => {
    const { yoklamalar, sebep } = req.body || {};

    if (typeof sebep === 'string' && sebep.trim()) panelSettings.otoYoklamaSebep = sebep.trim();

    if (Array.isArray(yoklamalar)) {
        if (yoklamalar.length > 12) {
            return res.json({ ok: false, error: 'En fazla 12 zamanlanmış yoklama olabilir.' });
        }
        const temiz = [];
        const gorulenSaatler = new Set();
        for (const ham of yoklamalar) {
            const saat = String((ham && ham.saat) || '').trim();
            if (!SAAT_BICIMI.test(saat)) {
                return res.json({ ok: false, error: `Saat SS:DD biçiminde olmalı (örn. 20:30). Hatalı: "${saat}"` });
            }
            // Ayni saatte iki satir olursa ikincisi hicbir zaman calismaz
            // gibi gorunur (ikisi de ayni dakikada tetiklenir) - bastan engelle.
            if (gorulenSaatler.has(saat)) {
                return res.json({ ok: false, error: `Aynı saat iki kez girilmiş: ${saat}` });
            }
            gorulenSaatler.add(saat);

            const kanal = String((ham && ham.kanal) || '').trim();
            if (kanal && !/^\d{17,20}$/.test(kanal)) {
                return res.json({ ok: false, error: `Kanal ID 17-20 haneli sayı olmalı. Hatalı: "${kanal}"` });
            }
            const sebepSatir = String((ham && ham.sebep) || '').trim();
            temiz.push({
                id: String((ham && ham.id) || '').trim() || `y${Date.now()}${temiz.length}`,
                saat,
                kanal: kanal || null,
                acik: ham ? ham.acik !== false : true,
                sebep: sebepSatir || null,
            });
        }
        panelSettings.otoYoklamalar = temiz;

        // Silinen satirlarin gunluk kilitleri birikmesin
        const gecerliIdler = new Set(temiz.map((y) => y.id));
        Object.keys(panelSettings.otoYoklamaSonGunler).forEach((id) => {
            if (!gecerliIdler.has(id)) delete panelSettings.otoYoklamaSonGunler[id];
        });
    }

    savePanelSettings();
    const ozet = (panelSettings.otoYoklamalar || [])
        .map((y) => `${y.saat}${y.acik ? '' : ' (kapalı)'}${y.kanal ? ` -> ${y.kanal}` : ''}`)
        .join(', ') || 'yok';
    addAudit('oto-yoklama-ayar', req.session.username, `Otomatik yoklamalar: ${ozet}`, req);
    console.log(`[OtoYoklama] Ayarlar guncellendi: ${ozet}`);
    return res.json({ ok: true, yoklamalar: panelSettings.otoYoklamalar });
});

// Elle tetikleme - zamanlanmisi beklemeden denemek icin. id verilirse o satirin
// ayarlariyla (kendi duyuru kanaliyla) calisiyor.
app.post('/api/oto-yoklama/simdi', requireIzin('ayarlar'), async (req, res) => {
    const id = String((req.body && req.body.id) || '').trim();
    const satir = id
        ? (panelSettings.otoYoklamalar || []).find((y) => y.id === id)
        : null;
    if (id && !satir) return res.json({ ok: false, error: 'Bu zamanlanmış yoklama bulunamadı.' });
    try {
        res.json({
            ok: true,
            sonuc: await otoYoklamaCalistir(`elle (${req.session.username})`, satir),
        });
    } catch (error) {
        res.json({ ok: false, error: error.message });
    }
});

// Sahiplenme teshisi: sayim durduysa bot metni mi degisti, kategori mi yanlis?
app.get('/api/sahiplenme/tani', requireIzin('etkinlik'), (req, res) => {
    const store = logStore.get('sahiplenme');
    const bugun = store && store.dailyIndex ? (store.dailyIndex.get(bugununAnahtari()) || new Map()) : new Map();
    res.json({
        ok: true,
        kategori: TICKET_SAHIP_KATEGORI,
        kalip: String(TICKET_SAHIP_KALIP),
        toplamKayit: store ? store.messages.length : 0,
        bugun: [...bugun.entries()].map(([id, v]) => ({ id, adet: v.c })),
        sonKayitlar: store
            ? store.messages.slice(0, 5).map((m) => ({
                at: m.createdTimestamp, kisi: m.authorId, kanal: m.ticketKanali || null,
            }))
            : [],
        // Kategoride mesaj gorulup de kalip tutmazsa buraya dusuyor.
        eslesmeyenler: sahiplenmeEslesmeyen,
    });
});

// --- PRIME SAAT HATIRLATMASI ---
app.get('/api/prime', requireIzin('ayarlar'), (req, res) => {
    res.json({
        ok: true,
        acik: Boolean(panelSettings.primeAcik),
        saatler: primeSaatleri(),
        kanal: panelSettings.primeKanal || PRIME_VARSAYILAN_KANAL,
        mesaj: panelSettings.primeMesaj || PRIME_VARSAYILAN_MESAJ,
        dm: panelSettings.primeDm !== false,
        saatDilimi: SAAT_DILIMI,
        suanki: suankiSaat(),
        sonCalisma: primeSonCalisma,
    });
});

app.post('/api/prime', requireIzin('ayarlar'), (req, res) => {
    const { acik, saatler, kanal, mesaj, dm } = req.body || {};
    if (typeof acik === 'boolean') panelSettings.primeAcik = acik;
    if (typeof dm === 'boolean') panelSettings.primeDm = dm;

    if (Array.isArray(saatler)) {
        if (saatler.length > 24) return res.json({ ok: false, error: 'En fazla 24 saat girilebilir.' });
        const temiz = [];
        for (const ham of saatler) {
            const t = String(ham || '').trim();
            if (!SAAT_BICIMI.test(t)) {
                return res.json({ ok: false, error: `Saat SS:DD biçiminde olmalı. Hatalı: "${t}"` });
            }
            if (!temiz.includes(t)) temiz.push(t);
        }
        temiz.sort();
        panelSettings.primeSaatler = temiz;
    }
    if (typeof kanal === 'string' && kanal.trim()) {
        if (!/^\d{17,20}$/.test(kanal.trim())) {
            return res.json({ ok: false, error: 'Kanal ID 17-20 haneli sayı olmalı.' });
        }
        panelSettings.primeKanal = kanal.trim();
    }
    if (typeof mesaj === 'string' && mesaj.trim()) panelSettings.primeMesaj = mesaj.trim();

    savePanelSettings();
    addAudit('prime-ayar', req.session.username,
        `Prime hatırlatma ${panelSettings.primeAcik ? 'açık' : 'kapalı'} · `
        + `saatler ${primeSaatleri().join(', ')} · DM ${panelSettings.primeDm !== false ? 'açık' : 'kapalı'}`, req);
    return res.json({ ok: true, acik: Boolean(panelSettings.primeAcik), saatler: primeSaatleri() });
});

app.post('/api/prime/simdi', requireIzin('ayarlar'), async (req, res) => {
    try {
        res.json({ ok: true, sonuc: await primeHatirlatmaCalistir(`elle (${req.session.username})`) });
    } catch (error) {
        res.json({ ok: false, error: error.message });
    }
});

// --- YOKLAMAYA KATIL ---
app.get('/api/yoklama/katilim', requireIzin('yoklama'), (req, res) => {
    const benimId = panelUserDiscordId(req.session.username);
    const katilanlar = bugunKatilanlar();
    res.json({
        ok: true,
        gun: bugununAnahtari(),
        discordId: benimId,
        katildim: Boolean(benimId && katilanlar[benimId]),
        toplam: Object.keys(katilanlar).length,
        katilanlar: Object.entries(katilanlar).map(([id, v]) => ({ id, at: v.at })),
    });
});

app.post('/api/yoklama/katil', requireIzin('yoklama'), (req, res) => {
    const benimId = panelUserDiscordId(req.session.username);
    if (!benimId) {
        return res.json({
            ok: false,
            error: 'Hesabına Discord ID bağlı değil. Ayarlar > Kendi Hesabım bölümünden ekle.',
        });
    }
    katilimEkle(benimId, req.session.username);
    addAudit('yoklama-katilim', req.session.username, `Yoklamaya katıldı (${benimId})`, req);
    console.log(`[Katilim] ${req.session.username} yoklamaya katildi (${benimId}).`);
    return res.json({ ok: true, discordId: benimId, gun: bugununAnahtari() });
});

// --- ROL BOTU KOMUTLARI ---
// sendSlash komut adini BIREBIR esleştiriyor; ad tutmazsa "SlashCommand X is
// not found" hatasi geliyor. Botun gercekte hangi komutlari sundugunu
// listeleyip dogru adi secebilmek icin.
app.get('/api/rol-komutlari', requireIzin('ayarlar'), async (req, res) => {
    try {
        const guild = await getReadyGuild();
        // sendSlash ile AYNI kaynak: sunucunun komut dizini.
        const data = await client.api.guilds[guild.id]['application-command-index'].get();
        const hepsi = (data && data.application_commands) || [];
        const botunkiler = hepsi.filter((c) => c.type === 1 && c.application_id === rolBotId());

        const bicimle = (c) => ({
            id: c.id, // ID'ye gore gonderim yaptigimiz icin en onemli alan
            name: c.name,
            applicationId: c.application_id,
            description: c.description || '',
            // Alt komutlari da goster: /rol ver gibi kullanimlar icin
            subcommands: (c.options || [])
                .filter((o) => o.type === 1 || o.type === 2)
                .map((o) => o.name),
            options: (c.options || [])
                .filter((o) => o.type !== 1 && o.type !== 2)
                .map((o) => ({ name: o.name, type: o.type, required: Boolean(o.required) })),
        });

        // Ayarli ID'ler dizinde gercekten duruyor mu? "Kaydettim ama yine
        // calismiyor" durumunu tahmin etmeden cevaplayabilelim diye.
        const idDurumu = (id) => {
            if (!id) return { id: null, bulundu: false, not: 'ID girilmemiş - ada göre aranıyor' };
            const k = hepsi.find((c) => c.id === id && c.type === 1);
            return k
                ? { id, bulundu: true, name: k.name, applicationId: k.application_id }
                : { id, bulundu: false, not: 'Bu ID sunucunun komut dizininde yok' };
        };

        res.json({
            ok: true,
            botId: rolBotId(),
            channelId: ROLE_COMMAND_CHANNEL_ID,
            ayarli: {
                ver: panelSettings.rolVerKomutu,
                al: panelSettings.rolAlKomutu,
                verId: rolVerKomutId(),
                alId: rolAlKomutId(),
            },
            idKontrol: { ver: idDurumu(rolVerKomutId()), al: idDurumu(rolAlKomutId()) },
            botKomutlari: botunkiler.map(bicimle),
            toplamKomut: hepsi.length,
            // Ad benzerlerini one cikar - dogru komutu bulmak kolaylassin
            benzerler: hepsi
                .filter((c) => c.type === 1 && /rol|role/i.test(c.name))
                .map(bicimle),
        });
    } catch (error) {
        console.log(`[Rol] Komut listesi alinamadi: ${error.message}`);
        res.json({ ok: false, error: error.message });
    }
});

// --- YENI TICKET OTOMATIK MESAJI (ayarlar) ---
app.get('/api/ticket-otomatik', requireIzin('ayarlar'), (req, res) => {
    res.json({
        ok: true,
        enabled: panelSettings.ticketAutoEnabled,
        gecikmeSn: Math.round(ticketAutoGecikmeMs() / 1000),
        // Her kategori kendi metniyle donuyor; arayuz bunlari doner ve her
        // biri icin bir kutu cizer - kategori eklendiginde arayuz kendiliginden
        // buyusun diye.
        kategoriler: TICKET_AUTO_KATEGORILER.map((k) => ({
            key: k.key,
            label: k.label,
            categoryId: k.kategori,
            message: panelSettings[k.ayar] || '',
        })),
        guildId: TICKET_AUTO_GUILD,
        inGuild: client.guilds.cache.has(TICKET_AUTO_GUILD),
        recent: ticketAutoSonGonderimler,
        // Eski istemciler bozulmasin diye tek metin de donuyor.
        message: panelSettings.ticketAutoMessage,
    });
});

app.post('/api/rol-komutlari', requireIzin('ayarlar'), (req, res) => {
    const { ver, al } = req.body || {};
    const gecerli = (x) => typeof x === 'string' && x.trim() && x.trim().length <= 64;
    if (ver !== undefined) {
        if (!gecerli(ver)) return res.json({ ok: false, error: 'Rol verme komutu geçersiz.' });
        panelSettings.rolVerKomutu = ver.trim();
    }
    if (al !== undefined) {
        if (!gecerli(al)) return res.json({ ok: false, error: 'Rol alma komutu geçersiz.' });
        panelSettings.rolAlKomutu = al.trim();
    }
    const { botId, verId, alId } = req.body || {};
    if (botId !== undefined && String(botId).trim()) {
        if (!/^\d{17,20}$/.test(String(botId).trim())) {
            return res.json({ ok: false, error: 'Rol botu ID 17-20 haneli sayı olmalı.' });
        }
        panelSettings.rolBotId = String(botId).trim();
    }
    // Komut ID'leri: bos birakilirsa ada gore aramaya dusuluyor, "sil" ile
    // bilerek temizlenebiliyor.
    const komutIdAyarla = (deger, alan, etiket) => {
        if (deger === undefined) return null;
        const t = String(deger).trim();
        if (!t || t === 'sil') { panelSettings[alan] = ''; return null; }
        if (!/^\d{17,20}$/.test(t)) return `${etiket} 17-20 haneli sayı olmalı.`;
        panelSettings[alan] = t;
        return null;
    };
    const hata = komutIdAyarla(verId, 'rolVerKomutId', 'Rol verme komut ID')
        || komutIdAyarla(alId, 'rolAlKomutId', 'Rol alma komut ID');
    if (hata) return res.json({ ok: false, error: hata });

    savePanelSettings();
    komutDiziniOnbellek = { at: 0, guildId: null, komutlar: [] }; // ayar degisti, dizini tazele
    addAudit('rol-komut-ayar', req.session.username,
        `Rol komutları: ver="${panelSettings.rolVerKomutu}" (${rolVerKomutId() || 'ID yok'}) `
        + `al="${panelSettings.rolAlKomutu}" (${rolAlKomutId() || 'ID yok'}) bot=${rolBotId()}`, req);
    console.log(`[Rol] Komut ayarlari guncellendi: verId=${rolVerKomutId() || 'yok'} alId=${rolAlKomutId() || 'yok'} bot=${rolBotId()}`);
    return res.json({
        ok: true,
        ver: panelSettings.rolVerKomutu,
        al: panelSettings.rolAlKomutu,
        verId: rolVerKomutId(),
        alId: rolAlKomutId(),
        botId: rolBotId(),
    });
});

app.post('/api/ticket-otomatik', requireIzin('ayarlar'), (req, res) => {
    const { enabled, message, gecikmeSn, mesajlar } = req.body || {};
    if (typeof enabled === 'boolean') panelSettings.ticketAutoEnabled = enabled;
    if (gecikmeSn !== undefined && gecikmeSn !== null && gecikmeSn !== '') {
        const sn = Number(gecikmeSn);
        if (!Number.isFinite(sn) || sn < 0 || sn > 120) {
            return res.json({ ok: false, error: 'Gecikme 0-120 saniye arasında olmalı.' });
        }
        panelSettings.ticketAutoGecikmeSn = Math.round(sn);
    }
    // Metinler kategori bazli geliyor: { yt: "...", ac: "..." }
    // Once HEPSI dogrulaniyor, sonra hicbiri ya da hepsi yaziliyor - biri
    // gecerli digeri gecersizken yarim kaydetmek ayarlari tutarsiz birakirdi.
    const yazilacak = [];
    if (mesajlar && typeof mesajlar === 'object') {
        for (const kat of TICKET_AUTO_KATEGORILER) {
            const gelen = mesajlar[kat.key];
            if (typeof gelen !== 'string') continue;
            const kirpik = gelen.trim();
            if (!kirpik) {
                return res.json({ ok: false, error: `${kat.label} mesajı boş bırakılamaz.` });
            }
            if (kirpik.length > 1800) {
                return res.json({
                    ok: false,
                    error: `${kat.label} mesajı 1800 karakterden uzun olamaz (Discord sınırı).`,
                });
            }
            yazilacak.push([kat, kirpik]);
        }
    }
    // Eski istemci tek "message" gonderiyorsa o YT metnine yaziliyor.
    if (typeof message === 'string' && !mesajlar) {
        const kirpik = message.trim();
        if (!kirpik) return res.json({ ok: false, error: 'Mesaj boş bırakılamaz.' });
        if (kirpik.length > 1800) {
            return res.json({ ok: false, error: 'Mesaj 1800 karakterden uzun olamaz (Discord sınırı).' });
        }
        panelSettings.ticketAutoMessage = kirpik;
    }
    yazilacak.forEach(([kat, metin]) => { panelSettings[kat.ayar] = metin; });

    savePanelSettings();
    const degisenler = yazilacak.map(([kat]) => kat.label).join(', ');
    addAudit('ticket-otomatik-ayar', req.session.username,
        `Otomatik ticket mesajı ${panelSettings.ticketAutoEnabled ? 'açık' : 'kapalı'}`
        + (degisenler ? ` · metin güncellendi: ${degisenler}` : ''), req);
    console.log(`[TicketOtomatik] Ayar değişti (${req.session.username}): `
        + `${panelSettings.ticketAutoEnabled ? 'açık' : 'kapalı'}`
        + (degisenler ? ` · ${degisenler}` : ''));
    return res.json({
        ok: true,
        enabled: panelSettings.ticketAutoEnabled,
        kategoriler: TICKET_AUTO_KATEGORILER.map((k) => ({
            key: k.key, label: k.label, categoryId: k.kategori, message: panelSettings[k.ayar] || '',
        })),
        message: panelSettings.ticketAutoMessage,
    });
});

// --- HESAP LOGLARI ---
app.get('/api/hesap-loglari', requireAdmin, (req, res) => {
    const tur = String(req.query.type || '').trim();
    const terim = String(req.query.q || '').trim().toLocaleLowerCase('tr');
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));

    // en yeni ustte
    let kayitlar = [...auditLog].reverse();
    if (tur) kayitlar = kayitlar.filter((e) => e.type === tur);
    if (terim) {
        kayitlar = kayitlar.filter((e) => (
            (e.actor || '').toLocaleLowerCase('tr').includes(terim)
            || (e.detail || '').toLocaleLowerCase('tr').includes(terim)
            || (e.ip || '').includes(terim)
        ));
    }

    // tur basina sayac - arayuzdeki filtre cipleri icin
    const sayac = {};
    auditLog.forEach((e) => { sayac[e.type] = (sayac[e.type] || 0) + 1; });

    res.json({
        ok: true,
        total: auditLog.length,
        matched: kayitlar.length,
        offset,
        counts: sayac,
        entries: kayitlar.slice(offset, offset + limit),
    });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

// WebSocket bağlantısı da aynı oturum cookie'siyle doğrulanıyor - giriş
// yapmamış biri canlı Discord verisini WebSocket üzerinden de alamasın diye.
server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/ws') { socket.destroy(); return; }
    const cookies = Object.fromEntries(
        (req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((p) => p[0]),
    );
    const token = cookies[SESSION_COOKIE];
    const session = token ? sessions.get(token) : null;
    if (!session || Date.now() > session.expiresAt) { socket.destroy(); return; }

    wss.handleUpgrade(req, socket, head, (ws) => {
        wsClients.add(ws);
        ws.send(JSON.stringify({ type: 'status', state: discordStatus, detail: discordStatusDetail }));
        // Uye listesi durumunu da hemen gonder - kullanici sonradan baglandiginda
        // da "hazirlaniyor" bilgisini gorsun, yoksa yalnizca degisiklik aninda
        // yayinlandigi icin kaciriyordu.
        ws.send(JSON.stringify({ type: 'uye-durum', ...membersState }));
        ws.on('close', () => wsClients.delete(ws));
    });
});

// Portu alamiyorsak bu surec BASKA bir kopyanin yaninda calisiyor demektir.
// Eskiden uncaughtException yakalayicisi hatayi yutuyordu ve surec Discord
// baglantisi CANLI halde ayakta kaliyordu: her kopya ticket mesaji atiyor,
// 20:30 yoklamasinda ayri ayri rol veriyor, voice-activity.json'a birbirinin
// uzerine yaziyordu. "Ticket'a 5-6 mesaj gidiyor" sikayetinin sebebi buydu.
// Bir kopyanin fazlasi asla calismamali - hemen cikiyoruz.
server.on('error', (error) => {
    if (error && error.code === 'EADDRINUSE') {
        console.log(`[Sistem] ${PORT} portu zaten kullanimda - bu kopya kapaniyor.`);
        console.log('[Sistem] Bot zaten calisiyor olmali. Ikinci bir kopya acmak'
            + ' ticket mesajlarinin ve uyarilarin cift gitmesine yol acardi.');
        process.exit(1);
    }
    console.log(`[Sistem] HTTP sunucu hatasi: ${error && error.message}`);
    process.exit(1);
});

server.listen(PORT, () => {
    baslangicTamam = true;
    console.log(`[Sistem] Web paneli http://localhost:${PORT} adresinde dinliyor.`);
    // Bellek siniri: TX Logs tum gecmisi bellekte tuttugu icin buyuk log
    // kanallarinda onemli olabiliyor. Sinir dusukse --max-old-space-size ile
    // yukseltilebilir (bkz. README).
    const mb = (n) => Math.round(n / 1024 / 1024);
    const limitMB = Math.round(require('v8').getHeapStatistics().heap_size_limit / 1024 / 1024);
    console.log(`[Sistem] Node bellek siniri: ${limitMB} MB · su anki rss: ${mb(process.memoryUsage().rss)} MB`);
    try {
        console.log(`[Sistem] Calisan kod: ${__filename} (${fs.statSync(__filename).mtime.toISOString()})`);
    } catch (error) { /* yoksay */ }
    console.log('[Sistem] Surum kontrolu: http://localhost:' + PORT + '/api/surum');
});

// Bellek kullanimini periyodik olarak logla - yavaslamanin bellek baskisindan
// mi geldigini anlamak icin.
setInterval(() => {
    const b = process.memoryUsage();
    const mb = (n) => Math.round(n / 1024 / 1024);
    const logSayisi = [...logStore.values()].reduce((t, s2) => t + s2.messages.length, 0);
    console.log(`[Bellek] heap ${mb(b.heapUsed)}/${mb(b.heapTotal)} MB · rss ${mb(b.rss)} MB · bellekteki log kaydi: ${logSayisi}`);
}, 30 * 60 * 1000);

// --- DISCORD'A BAĞLAN ---
const token = process.env.USER_TOKEN;
if (!token) {
    console.log('[Kurulum] HATA: ../config.env içinde USER_TOKEN yok. Masaüstü uygulamasını en az bir kez çalıştırıp token girmiş olman gerekiyor (aynı config.env paylaşılıyor).');
    process.exit(1);
}
startConnectWatchdog();
startReadyPolling();
client.login(token).catch((error) => {
    console.log(`[Hata] Discord'a giriş yapılamadı: ${error.message}`);
    discordStatus = 'hata';
    discordStatusDetail = `Giriş hatası: ${error.message}`;
    broadcastStatus();
});
