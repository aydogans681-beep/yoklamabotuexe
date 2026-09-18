// Rozet Tarayıcı - masaüstü panel (.exe). Çift tıkla çalışır, tarayıcıda açılır.
//  - Token'ları panelden girersin (config.json'a yazılır, exe'nin yanına).
//  - Hesap (kullanıcı) token'ı ZORUNLU (tarama onu yapar).
//  - Bot token'ı İSTEĞE BAĞLI (Discord içinde /goster slash komutu istersen).
//
// ⚠️ Kullanıcı hesabının otomatik sunucuya girip üye taraması Discord ToS ihlali;
// hesap banlanabilir. Ana hesabını kullanma.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { exec } = require('child_process');
const {
    Client: BotClient, GatewayIntentBits, EmbedBuilder,
    ApplicationCommandOptionType, MessageFlags,
} = require('discord.js');
const { Client: UserClient, Options } = require('discord.js-selfbot-v13');
const { taraVeGetir, bulunanlariBicimle } = require('./tarayici');

// exe'nin yanına yazılabilir yer (pkg altında __dirname salt-okunur snapshot'tır).
const TABAN = process.pkg ? path.dirname(process.execPath) : __dirname;
const CONFIG_PATH = path.join(TABAN, 'config.json');
const PORT = 3000;

function ayarOku() {
    try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (e) { return {}; }
}
function ayarYaz(cfg) {
    try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2)); return true; }
    catch (e) { console.error('config.json yazılamadı:', e.message); return false; }
}
let cfg = ayarOku();

// --- Discord istemcileri (istek üzerine giriş) ---
let userClient = null;
let botClient = null;

function taramaOpts() {
    return {
        maxUye: Number(cfg.maxUye) || 3000,
        taramadanSonraAyril: cfg.taramadanSonraAyril !== false,
    };
}

async function hesabaGir(token) {
    if (userClient) { try { userClient.destroy(); } catch (e) { /* */ } userClient = null; }
    if (!token) return;
    userClient = new UserClient({
        checkUpdate: false,
        makeCache: Options.cacheWithLimits({ MessageManager: 0, PresenceManager: 0 }),
    });
    userClient.on('error', () => {});
    await userClient.login(token);
}

async function botaGir(token) {
    if (botClient) { try { botClient.destroy(); } catch (e) { /* */ } botClient = null; }
    if (!token) return;
    const c = new BotClient({ intents: [GatewayIntentBits.Guilds] });
    c.on('error', () => {});
    c.once('ready', async () => {
        try {
            await c.application.commands.set([{
                name: 'goster',
                description: 'Bir sunucuya girip üyelerin nadir rozetlerini listeler.',
                options: [{ name: 'link', description: 'Davet linki', type: ApplicationCommandOptionType.String, required: true }],
            }]);
        } catch (e) { console.error('Komut kaydı:', e.message); }
    });
    c.on('interactionCreate', async (interaction) => {
        if (!interaction.isChatInputCommand() || interaction.commandName !== 'goster') return;
        const izinli = (cfg.izinliKullanicilar || []).map(String);
        if (!izinli.includes(String(interaction.user.id))) {
            return interaction.reply({ content: '⛔ Yetkin yok.', flags: MessageFlags.Ephemeral });
        }
        if (!userClient || !userClient.user) {
            return interaction.reply({ content: '⏳ Tarama hesabı bağlı değil.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply();
        try {
            const sonuc = await taraVeGetir(userClient, interaction.options.getString('link', true), taramaOpts());
            const embed = new EmbedBuilder().setTitle(`🔎 ${sonuc.sunucuAdi}`).setColor(0x5865F2)
                .setDescription(bulunanlariBicimle(sonuc.bulunanlar, Number(cfg.sonuctaKisiSiniri) || 60).slice(0, 4000))
                .setFooter({ text: `${sonuc.taranan}/${sonuc.toplamUye} üye · ${sonuc.bulunanlar.length} nadir rozetli` });
            await interaction.editReply({ embeds: [embed] });
        } catch (e) {
            await interaction.editReply({ content: `❌ ${e.message}` });
        }
    });
    botClient = c;
    await c.login(token);
}

// Kayıtlı token varsa açılışta bağlan.
(async () => {
    if (cfg.userToken) { try { await hesabaGir(cfg.userToken); } catch (e) { console.error('Hesap girişi:', e.message); } }
    if (cfg.botToken) { try { await botaGir(cfg.botToken); } catch (e) { console.error('Bot girişi:', e.message); } }
})();

// --- Basit HTTP panel (harici bağımlılık yok, pkg dostu) ---
function gonderJson(res, obj, kod = 200) {
    res.writeHead(kod, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
}
function govdeOku(req) {
    return new Promise((resolve) => {
        let veri = '';
        req.on('data', (p) => { veri += p; if (veri.length > 1e6) req.destroy(); });
        req.on('end', () => { try { resolve(JSON.parse(veri || '{}')); } catch (e) { resolve({}); } });
    });
}

const PANEL_HTML = require('./panel-html');

const server = http.createServer(async (req, res) => {
    const yol = req.url.split('?')[0];

    if (yol === '/' || yol === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(PANEL_HTML);
    }

    if (yol === '/api/durum') {
        return gonderJson(res, {
            ok: true,
            hesapBagli: Boolean(userClient && userClient.user),
            hesapTag: userClient && userClient.user ? userClient.user.tag : null,
            botBagli: Boolean(botClient && botClient.user),
            botTag: botClient && botClient.user ? botClient.user.tag : null,
            izinli: (cfg.izinliKullanicilar || []).map(String),
            tokenVar: { hesap: Boolean(cfg.userToken), bot: Boolean(cfg.botToken) },
            maxUye: Number(cfg.maxUye) || 3000,
            taramadanSonraAyril: cfg.taramadanSonraAyril !== false,
        });
    }

    if (yol === '/api/token' && req.method === 'POST') {
        const b = await govdeOku(req);
        if (typeof b.userToken === 'string') cfg.userToken = b.userToken.trim() || undefined;
        if (typeof b.botToken === 'string') cfg.botToken = b.botToken.trim() || undefined;
        if (Array.isArray(b.izinliKullanicilar)) cfg.izinliKullanicilar = b.izinliKullanicilar.map(String).filter(Boolean);
        if (b.maxUye != null) cfg.maxUye = Number(b.maxUye) || 3000;
        if (typeof b.taramadanSonraAyril === 'boolean') cfg.taramadanSonraAyril = b.taramadanSonraAyril;
        ayarYaz(cfg);
        // Yeniden bağlan.
        const hatalar = [];
        try { await hesabaGir(cfg.userToken); } catch (e) { hatalar.push(`Hesap: ${e.message}`); }
        try { await botaGir(cfg.botToken); } catch (e) { hatalar.push(`Bot: ${e.message}`); }
        return gonderJson(res, { ok: hatalar.length === 0, hatalar });
    }

    if (yol === '/api/tara' && req.method === 'POST') {
        const b = await govdeOku(req);
        if (!userClient || !userClient.user) return gonderJson(res, { ok: false, error: 'Hesap bağlı değil. Önce token gir.' });
        if (!b.link) return gonderJson(res, { ok: false, error: 'Davet linki boş.' });
        try {
            const sonuc = await taraVeGetir(userClient, String(b.link), taramaOpts());
            return gonderJson(res, { ok: true, sonuc });
        } catch (e) {
            return gonderJson(res, { ok: false, error: e.message });
        }
    }

    res.writeHead(404); res.end('yok');
});

server.listen(PORT, '127.0.0.1', () => {
    const url = `http://localhost:${PORT}`;
    console.log(`\n  Rozet Tarayıcı paneli: ${url}\n  (kapatmak için bu pencereyi kapat)\n`);
    if (process.platform === 'win32') exec(`start "" ${url}`);
    else if (process.platform === 'darwin') exec(`open ${url}`);
});
