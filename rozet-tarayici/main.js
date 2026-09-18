// Rozet Tarayıcı - Electron masaüstü uygulaması (kendi penceresi, tarayıcı yok).
//  - Hesap (kullanıcı) token'ı taramayı yapar (zorunlu).
//  - Bot token'ı isteğe bağlı (Discord içinde /goster slash komutu).
// ⚠️ Kullanıcı hesabıyla otomatik sunucuya girip üye taraması Discord ToS ihlali.

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { Client: UserClient, Options } = require('discord.js-selfbot-v13');
const {
    Client: BotClient, GatewayIntentBits, EmbedBuilder,
    ApplicationCommandOptionType, MessageFlags,
} = require('discord.js');
const { taraVeGetir, bulunanlariBicimle } = require('./tarayici');

let CONFIG_PATH = null;   // app hazır olunca ayarlanır (userData)
let cfg = {};
let userClient = null;
let botClient = null;
let win = null;

function ayarOku() { try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (e) { return {}; } }
function ayarYaz() { try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2)); } catch (e) { console.error('config yazılamadı:', e.message); } }
function taramaOpts() { return { maxUye: Number(cfg.maxUye) || 3000, taramadanSonraAyril: cfg.taramadanSonraAyril !== false }; }

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
                name: 'goster', description: 'Bir sunucuya girip üyelerin nadir rozetlerini listeler.',
                options: [{ name: 'link', description: 'Davet linki', type: ApplicationCommandOptionType.String, required: true }],
            }]);
        } catch (e) { console.error('Komut kaydı:', e.message); }
    });
    c.on('interactionCreate', async (interaction) => {
        if (!interaction.isChatInputCommand() || interaction.commandName !== 'goster') return;
        const izinli = (cfg.izinliKullanicilar || []).map(String);
        if (!izinli.includes(String(interaction.user.id))) return interaction.reply({ content: '⛔ Yetkin yok.', flags: MessageFlags.Ephemeral });
        if (!userClient || !userClient.user) return interaction.reply({ content: '⏳ Tarama hesabı bağlı değil.', flags: MessageFlags.Ephemeral });
        await interaction.deferReply();
        try {
            const s = await taraVeGetir(userClient, interaction.options.getString('link', true), taramaOpts());
            const embed = new EmbedBuilder().setTitle(`🔎 ${s.sunucuAdi}`).setColor(0x5865F2)
                .setDescription(bulunanlariBicimle(s.bulunanlar, Number(cfg.sonuctaKisiSiniri) || 60).slice(0, 4000))
                .setFooter({ text: `${s.taranan}/${s.toplamUye} üye · ${s.bulunanlar.length} nadir rozetli` });
            await interaction.editReply({ embeds: [embed] });
        } catch (e) { await interaction.editReply({ content: `❌ ${e.message}` }); }
    });
    botClient = c;
    await c.login(token);
}

function pencereAc() {
    win = new BrowserWindow({
        width: 900, height: 780, minWidth: 620, minHeight: 560,
        title: 'Rozet Tarayıcı', autoHideMenuBar: true, backgroundColor: '#0e0f13',
        webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
    });
    win.loadFile('renderer.html');
    // Dış linkler (profil vб.) varsayılan tarayıcıda açılsın.
    win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

app.whenReady().then(async () => {
    CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');
    cfg = ayarOku();
    pencereAc();
    if (cfg.userToken) { try { await hesabaGir(cfg.userToken); } catch (e) { console.error('Hesap:', e.message); } }
    if (cfg.botToken) { try { await botaGir(cfg.botToken); } catch (e) { console.error('Bot:', e.message); } }
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) pencereAc(); });
});
app.on('window-all-closed', () => app.quit());

// --- Renderer <-> Main köprüsü (IPC) ---
ipcMain.handle('durum', () => ({
    hesapBagli: Boolean(userClient && userClient.user),
    hesapTag: userClient && userClient.user ? userClient.user.tag : null,
    botBagli: Boolean(botClient && botClient.user),
    botTag: botClient && botClient.user ? botClient.user.tag : null,
    izinli: (cfg.izinliKullanicilar || []).map(String),
    tokenVar: { hesap: Boolean(cfg.userToken), bot: Boolean(cfg.botToken) },
    maxUye: Number(cfg.maxUye) || 3000,
    taramadanSonraAyril: cfg.taramadanSonraAyril !== false,
}));

ipcMain.handle('kaydet', async (e, b) => {
    b = b || {};
    if (typeof b.userToken === 'string' && b.userToken.trim()) cfg.userToken = b.userToken.trim();
    if (typeof b.botToken === 'string') cfg.botToken = b.botToken.trim() || undefined;
    if (Array.isArray(b.izinliKullanicilar)) cfg.izinliKullanicilar = b.izinliKullanicilar.map(String).filter(Boolean);
    if (b.maxUye != null) cfg.maxUye = Number(b.maxUye) || 3000;
    if (typeof b.taramadanSonraAyril === 'boolean') cfg.taramadanSonraAyril = b.taramadanSonraAyril;
    ayarYaz();
    const hatalar = [];
    try { await hesabaGir(cfg.userToken); } catch (err) { hatalar.push(`Hesap: ${err.message}`); }
    try { await botaGir(cfg.botToken); } catch (err) { hatalar.push(`Bot: ${err.message}`); }
    return { ok: hatalar.length === 0, hatalar };
});

ipcMain.handle('tara', async (e, link) => {
    if (!userClient || !userClient.user) return { ok: false, error: 'Hesap bağlı değil. Önce token gir.' };
    if (!link) return { ok: false, error: 'Davet linki boş.' };
    try { return { ok: true, sonuc: await taraVeGetir(userClient, String(link), taramaOpts()) }; }
    catch (err) { return { ok: false, error: err.message }; }
});
