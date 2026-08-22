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
process.on('uncaughtException', (error) => {
    console.log(`[Hata] Yakalanmamış istisna: ${error && error.stack ? error.stack : error}`);
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
// --- DISCORD BAĞLANTISI (main.js'ten BİREBİR - bkz. oradaki yorumlar) ---
// ============================================================================
const { Client } = require('discord.js-selfbot-v13');

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
const ROLE_BOT_ID = '1472695273418522657';
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
const LOG_CHANNELS = [
    { key: 'ban', label: 'Ban', channelId: '1514634711413293197' },
    { key: 'unban', label: 'Unban', channelId: '' }, // <-- kanal ID bekleniyor
    { key: 'kick', label: 'Kick', channelId: '1514634723043836155' },
    { key: 'warn', label: 'Warn', channelId: '1514634738915086560' },
    { key: 'dm', label: 'DM', channelId: '1514634767033696387' },
    { key: 'duyuru', label: 'Duyuru', channelId: '1514634800407904398' },
    { key: 'revive', label: 'Revive', channelId: '1514633983160483901' },
];

// Discord sayfa basina en fazla 100 mesaj veriyor. Sayfalar arasinda kisa bir
// bekleme koyuyoruz - "tum gecmisi cek" binlerce istek demek, rate limit'e
// carpmadan ilerlemek icin.
const LOG_PAGE_DELAY_MS = 350;

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
    // Discord hazir - TX Logs sekmesinin verisini arka planda hazirlamaya basla.
    primeAllLogs().catch((error) => console.log(`[Loglar] Arka plan yuklemesi hata verdi: ${error.message}`));
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
function ensureMembersFetched(guild) {
    if (!membersFetchPromise) {
        membersFetchPromise = guild.members.fetch().catch((error) => {
            membersFetchPromise = null;
            throw error;
        });
    }
    return membersFetchPromise;
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

    try {
        await ensureMembersFetched(guild);
    } catch (error) {
        throw new Error(`Üye listesi alınamadı - "Missing Access" ise bu hesabın gerekli yetkisi yok olabilir: ${error.message}`);
    }

    const inVoiceIds = new Set();
    guild.channels.cache.forEach((channel) => {
        if (channel.type === 'GUILD_VOICE' || channel.type === 'GUILD_STAGE_VOICE') {
            channel.members.forEach((member) => inVoiceIds.add(member.id));
        }
    });

    const attendanceMembers = guild.members.cache.filter((member) => (
        ATTENDANCE_ROLE_IDS.some((roleId) => member.roles.cache.has(roleId))
    ));

    const [excuseByAuthor, longExcuseByAuthor] = await Promise.all([
        fetchRecentExcuses(),
        fetchRecentLongExcuses(),
    ]);

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
    console.log(`[Yoklama] Tarama tamamlandı: ${results.length} yetkili kontrol edildi, ${totalInVoice} sesde.`);

    return {
        scannedAt: Date.now(),
        totalChecked: results.length,
        totalInVoice,
        members: results,
    };
}

// --- ROL BOTU KOMUTLARI (main.js'ten birebir) ---
function waitForRoleBotReply(timeoutMs = 6000) {
    return new Promise((resolve) => {
        const onMessage = (message) => {
            if (message.channelId !== ROLE_COMMAND_CHANNEL_ID) return;
            if (message.author.id !== ROLE_BOT_ID) return;
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
async function giveNextWarningRole(memberId, reason, announceIndividually = true) {
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
    await commandChannel.sendSlash(ROLE_BOT_ID, 'rol-ver', memberId, nextRole.id);
    const botReply = await replyPromise;

    console.log(`[Yoklama] ${member.user.tag} (${memberId}) için "/rol-ver" gönderildi: ${nextRole.label} (${nextRole.id}). Bot cevabı: ${botReply || '(yakalanamadı)'}`);

    lastGivenRole.set(memberId, { roleId: nextRole.id, label: nextRole.label, tag: member.user.tag });

    let announceError = null;
    if (reason && announceIndividually) {
        try {
            const channel = await client.channels.fetch(WARNING_ANNOUNCE_CHANNEL_ID);
            if (!channel) throw new Error('Uyarı kanalı bulunamadı, WARNING_ANNOUNCE_CHANNEL_ID hatalı olabilir.');
            const announceMessage = await channel.send(buildSingleWarningAnnounceMessage(memberId, nextRole.id, reason));
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

function buildSingleWarningAnnounceMessage(memberId, givenRoleId, reason) {
    const selfId = client.user.id;
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
    await commandChannel.sendSlash(ROLE_BOT_ID, 'rol-al', memberId, record.roleId);
    const botReply = await replyPromise;

    console.log(`[Yoklama] ${record.tag} (${memberId}) için "/rol-al" gönderildi (geri alma): ${record.label} (${record.roleId}). Bot cevabı: ${botReply || '(yakalanamadı)'}`);

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

function buildWarningAnnounceMessage(warnedMemberIds, reason) {
    const warnedMentions = warnedMemberIds.map((id) => `<@${id}>`).join('  ');
    const ladderMentions = WARNING_ROLES.map((role) => `<@&${role.id}>`).join(' Olanlara ');
    const selfId = client.user.id;
    return [
        `# Uyarı alan :  ${warnedMentions}`,
        `# Uyarı veren : <@${selfId}>`,
        `# Uyarı sebebi : ${reason}`,
        `# Uyarı : ${ladderMentions}`,
        `# Uyarı bitiş tarihi : ${formatWarningEndDate()}`,
    ].join('\n');
}

async function giveBulkWarning(memberIds, reason) {
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
            const result = await giveNextWarningRole(memberId, reason, false);
            if (result.ok) {
                warned.push({ id: memberId, givenLabel: result.givenLabel, botReply: result.botReply });
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
        try {
            const channel = await client.channels.fetch(WARNING_ANNOUNCE_CHANNEL_ID);
            if (!channel) throw new Error('Uyarı kanalı bulunamadı, WARNING_ANNOUNCE_CHANNEL_ID hatalı olabilir.');
            const announceMessage = await channel.send(buildWarningAnnounceMessage(warned.map((w) => w.id), reason));
            warned.forEach(({ id }) => {
                const record = lastGivenRole.get(id);
                if (record) {
                    record.announceChannelId = WARNING_ANNOUNCE_CHANNEL_ID;
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

LOG_CHANNELS.forEach((channel) => {
    logStore.set(channel.key, {
        key: channel.key,
        label: channel.label,
        channelId: channel.channelId,
        status: channel.channelId ? 'bekliyor' : 'yapilandirilmamis',
        messages: [],
        loaded: 0,
        error: null,
        fetchedAt: null,
    });
    if (channel.channelId) logChannelIdToKey.set(channel.channelId, channel.key);
});

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

async function fetchAllChannelMessages(key) {
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

    const collected = [];
    let beforeId;
    // Kanalin en basina inene kadar 100'erli sayfalarla geriye dogru gidiyoruz.
    for (;;) {
        const options = { limit: 100 };
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

        store.loaded = collected.length;
        broadcastLogStatus(store);

        if (batch.size < 100 || !beforeId) break;
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, LOG_PAGE_DELAY_MS));
    }

    collected.sort((a, b) => b.createdTimestamp - a.createdTimestamp); // en yeni ustte
    collected.forEach((entry) => { entry._s = logSearchText(entry); });

    store.messages = collected;
    store.loaded = collected.length;
    store.fetchedAt = Date.now();
    store.status = store.error ? 'hata' : 'hazir';
    broadcastLogStatus(store);
    console.log(`[Loglar] ${store.label}: ${collected.length} mesaj cekildi.`);
    return store;
}

let logPrimingStarted = false;
async function primeAllLogs() {
    if (logPrimingStarted) return;
    logPrimingStarted = true;
    console.log('[Loglar] Tum log kanallarinin gecmisi arka planda cekiliyor...');
    // Kanallari SIRAYLA cekiyoruz - hepsini ayni anda baslatmak Discord rate
    // limit'ini cok daha hizli tuketirdi.
    for (const channel of LOG_CHANNELS) {
        if (!channel.channelId) continue;
        try {
            // eslint-disable-next-line no-await-in-loop
            await fetchAllChannelMessages(channel.key);
        } catch (error) {
            console.log(`[Loglar] ${channel.label} cekilemedi: ${error.message}`);
        }
    }
    console.log('[Loglar] Arka plan yuklemesi bitti.');
}

// Ilk yukleme bittikten sonra yeni gelen log mesajlarini canli olarak ekliyoruz -
// boylece sekme acikken kanal yeniden cekilmeden guncel kaliyor.
client.on('messageCreate', (message) => {
    const key = logChannelIdToKey.get(message.channelId);
    if (!key) return;
    const store = logStore.get(key);
    if (!store || store.status !== 'hazir') return;
    const entry = serializeLogMessage(message);
    entry._s = logSearchText(entry);
    store.messages.unshift(entry);
    store.loaded = store.messages.length;
    wsBroadcast({ type: 'log-yeni', key, entry: stripInternal(entry), loaded: store.loaded });
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
function decideAttendance(member) {
    if (member.inVoice) {
        return { decision: 'skip', reason: 'Seste' };
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

// Onizleme: tarama yapar ve kimin ne alacagini dondurur - HICBIR rol vermez.
async function buildAttendancePreview() {
    const scan = await runYoklamaScan();
    const warn = [];
    const excused = [];
    const inVoice = [];
    const maxTier = [];

    scan.members.forEach((member) => {
        const { decision, reason } = decideAttendance(member);
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

app.post('/api/login', (req, res) => {
    const username = String((req.body && req.body.username) || '').trim();
    const password = String((req.body && req.body.password) || '');
    const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'bilinmiyor';

    const throttle = loginThrottleCheck(ip);
    if (throttle.blocked) {
        console.log(`[Giriş] Çok fazla başarısız deneme, engellendi: ${ip}`);
        return res.status(429).json({
            ok: false,
            error: `Çok fazla başarısız deneme. ${Math.ceil(throttle.leftSec / 60)} dakika sonra tekrar dene.`,
        });
    }
    if (!verifyPanelPassword(username, password)) {
        loginNoteFailure(ip);
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
    console.log(`[Giriş] Web panele giriş yapıldı: ${username}`);
    return res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
    const token = req.cookies && req.cookies[SESSION_COOKIE];
    if (token) sessions.delete(token);
    res.clearCookie(SESSION_COOKIE);
    return res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
    const session = getSession(req);
    return res.json({ ok: true, loggedIn: Boolean(session), username: session ? session.username : null });
});

app.get('/api/status', requireAuth, (req, res) => {
    res.json({ state: discordStatus, detail: discordStatusDetail });
});

app.post('/api/yoklama/tara', requireAuth, async (req, res) => {
    try {
        const data = await runYoklamaScan();
        res.json({ ok: true, data });
    } catch (error) {
        console.log(`[Yoklama] Tarama hatası: ${error.message}`);
        res.json({ ok: false, error: error.message });
    }
});

app.get('/api/uyari-gecmisi', requireAuth, (req, res) => {
    res.json(warningHistory);
});

app.post('/api/yoklama/rol-ver', requireAuth, async (req, res) => {
    const { memberId, reason } = req.body || {};
    try {
        res.json(await giveNextWarningRole(memberId, reason));
    } catch (error) {
        console.log(`[Yoklama] Rol verme hatası (${memberId}): ${error.message}`);
        res.json({ ok: false, error: error.message });
    }
});

app.post('/api/yoklama/rol-geri-al', requireAuth, async (req, res) => {
    const { memberId } = req.body || {};
    try {
        res.json(await undoLastWarning(memberId));
    } catch (error) {
        console.log(`[Yoklama] Geri alma hatası (${memberId}): ${error.message}`);
        res.json({ ok: false, error: error.message });
    }
});

app.post('/api/yoklama/toplu-uyari-ver', requireAuth, async (req, res) => {
    const { memberIds, reason } = req.body || {};
    try {
        res.json(await giveBulkWarning(memberIds || [], reason));
    } catch (error) {
        console.log(`[Yoklama] Toplu uyarı hatası: ${error.message}`);
        res.json({ ok: false, error: error.message });
    }
});

app.post('/api/yoklama/toplu-rol-geri-al', requireAuth, async (req, res) => {
    const { memberIds } = req.body || {};
    try {
        res.json(await bulkUndoWarning(memberIds || []));
    } catch (error) {
        console.log(`[Yoklama] Toplu geri alma hatası: ${error.message}`);
        res.json({ ok: false, error: error.message });
    }
});

app.post('/api/yoklama/acil-toplanti', requireAuth, async (req, res) => {
    try {
        res.json({ ok: true, data: await pullEveryoneToMyVoiceChannel() });
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

app.get('/api/hesaplar', requireAuth, (req, res) => {
    const users = loadPanelUsers().map((u, index) => ({
        username: u.username,
        createdAt: u.createdAt || null,
        isPrimary: index === 0, // masaustu surumunun kullandigi hesap
        isSelf: u.username === req.session.username,
    }));
    res.json({ ok: true, users, self: req.session.username });
});

app.post('/api/hesaplar/ekle', requireAuth, (req, res) => {
    const username = String((req.body && req.body.username) || '').trim();
    const password = String((req.body && req.body.password) || '');

    const invalid = validateCredentials(username, password);
    if (invalid) return res.json({ ok: false, error: invalid });

    const users = loadPanelUsers();
    if (users.some((u) => u.username === username)) {
        return res.json({ ok: false, error: 'Bu kullanıcı adı zaten var.' });
    }

    const salt = newSalt();
    users.push({ username, salt, hash: hashPassword(password, salt), createdAt: Date.now() });
    try {
        savePanelUsers(users);
    } catch (error) {
        return res.json({ ok: false, error: `Kaydedilemedi: ${error.message}` });
    }
    console.log(`[Hesap] Yeni panel hesabı eklendi: ${username} (ekleyen: ${req.session.username})`);
    return res.json({ ok: true });
});

app.post('/api/hesaplar/sil', requireAuth, (req, res) => {
    const username = String((req.body && req.body.username) || '').trim();
    const users = loadPanelUsers();

    if (!users.some((u) => u.username === username)) {
        return res.json({ ok: false, error: 'Böyle bir hesap yok.' });
    }
    if (users.length <= 1) {
        return res.json({ ok: false, error: 'Son hesabı silemezsin - panele giriş yapılamaz hale gelir.' });
    }

    const remaining = users.filter((u) => u.username !== username);
    try {
        savePanelUsers(remaining);
    } catch (error) {
        return res.json({ ok: false, error: `Kaydedilemedi: ${error.message}` });
    }
    dropSessionsFor(username); // silinen hesabin acik oturumlari da dussun
    console.log(`[Hesap] Panel hesabı silindi: ${username} (silen: ${req.session.username})`);
    return res.json({ ok: true, selfDeleted: username === req.session.username });
});

app.post('/api/hesap/guncelle', requireAuth, (req, res) => {
    const currentPassword = String((req.body && req.body.currentPassword) || '');
    const rawNewUsername = String((req.body && req.body.newUsername) || '').trim();
    const newPassword = String((req.body && req.body.newPassword) || '');
    const me = req.session.username;

    if (!verifyPanelPassword(me, currentPassword)) {
        return res.json({ ok: false, error: 'Mevcut şifren yanlış.' });
    }
    if (!rawNewUsername && !newPassword) {
        return res.json({ ok: false, error: 'Yeni kullanıcı adı ya da yeni şifreden en az birini doldur.' });
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
    return res.json({ ok: true, username: newUsername });
});

// --- TX LOGS ---
app.get('/api/loglar', requireAuth, (req, res) => {
    res.json({
        ok: true,
        channels: LOG_CHANNELS.map((channel) => {
            const store = logStore.get(channel.key);
            return {
                key: store.key,
                label: store.label,
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

    const term = String(req.query.q || '').trim().toLocaleLowerCase('tr');
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));

    const source = term
        ? store.messages.filter((entry) => entry._s.includes(term))
        : store.messages;

    res.json({
        ok: true,
        key: store.key,
        label: store.label,
        configured: Boolean(store.channelId),
        status: store.status,
        error: store.error,
        fetchedAt: store.fetchedAt,
        total: store.messages.length,
        matched: source.length,
        offset,
        messages: source.slice(offset, offset + limit).map(stripInternal),
    });
});

app.post('/api/loglar/:key/yenile', requireAuth, async (req, res) => {
    const store = logStore.get(req.params.key);
    if (!store) return res.status(404).json({ ok: false, error: 'Bilinmeyen log menüsü.' });
    if (!store.channelId) return res.json({ ok: false, error: 'Bu menü için kanal ID girilmemiş.' });
    // Cekme uzun surebilir - istegi hemen kapatiyoruz, ilerleme WebSocket'ten gelir.
    fetchAllChannelMessages(store.key)
        .catch((error) => console.log(`[Loglar] ${store.label} yenilenemedi: ${error.message}`));
    return res.json({ ok: true, started: true });
});

// --- YOKLAMAYI AL ---
app.post('/api/yoklama/al-onizleme', requireAuth, async (req, res) => {
    try {
        res.json({ ok: true, data: await buildAttendancePreview() });
    } catch (error) {
        console.log(`[Yoklama] Yoklamayı Al önizleme hatası: ${error.message}`);
        res.json({ ok: false, error: error.message });
    }
});

app.post('/api/yoklama/al-uygula', requireAuth, async (req, res) => {
    const { memberIds, reason } = req.body || {};
    if (!Array.isArray(memberIds) || memberIds.length === 0) {
        return res.json({ ok: false, error: 'Uyarı verilecek kimse seçilmemiş.' });
    }
    if (!reason || !String(reason).trim()) {
        return res.json({ ok: false, error: 'Uyarı sebebi boş bırakılamaz.' });
    }
    try {
        console.log(`[Yoklama] "Yoklamayı Al" uygulanıyor: ${memberIds.length} kişi (${req.session.username}).`);
        return res.json(await giveBulkWarning(memberIds, String(reason).trim()));
    } catch (error) {
        console.log(`[Yoklama] Yoklamayı Al hatası: ${error.message}`);
        return res.json({ ok: false, error: error.message });
    }
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
        ws.on('close', () => wsClients.delete(ws));
    });
});

server.listen(PORT, () => {
    console.log(`[Sistem] Web paneli http://localhost:${PORT} adresinde dinliyor.`);
});

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
