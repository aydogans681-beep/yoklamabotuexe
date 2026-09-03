// ============================================================================
// MD PvP AC Paneli - masaustu surumu.
//
// NE YAPAR: web panelinin TA KENDISINI bir uygulama penceresinde acar. Ayri
// bir arayuz yok, ayri bir API yok - AC tarayicidan ne goruyorsa burada da
// onu gorur. "Isteyen webden, isteyen exe'den" ayni panel.
//
// SEKME KISITI BURADA DEGIL: AC hesaplarinin yalnizca Nexora Panel ve Felox
// gormesini sunucu belirliyor (server.js -> kullaniciYetkileri, tip 'ac' ->
// sekmeler: ['ticketmesaj','felox']). Kisiti istemciye koymak guvenlik degil
// susleme olurdu; burada bilerek tekrarlanmiyor. Yetki degisirse exe'yi
// yeniden derlemek de gerekmiyor.
//
// OTURUM: panelin giris cerezi 7 gun omurlu (SESSION_TTL_MS) ve Electron
// varsayilan oturumu cerezleri diske yaziyor - AC her acilista yeniden giris
// yapmak zorunda kalmiyor.
// ============================================================================
const { app, BrowserWindow, ipcMain, shell, Menu, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

// Ayni exe'nin iki kopyasi acilirsa ikincisi kapanip birincisini one getiriyor.
// Iki pencere ayni panele ayni hesapla baglanip birbirinin ustune yazardi.
if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
}

const AYAR_ADI = 'ayar.json';

// Panelin adresi KODA GOMULU. Boylece exe hicbir sey sormadan aciliyor -
// AC'nin IP/port bilmesi gerekmiyor, "baglanti adresi" ekrani hic gelmiyor.
// Yine de son soz kullanicinin: menuden baska bir adres girilirse o kazaniyor
// (bkz. gecerliAdres). Panel tasinirsa burayi degistirip yeniden derlemek
// ya da menuden yeni adresi girmek yeterli.
const YERLESIK_ADRES = 'http://185.211.100.117:3000';

let anaPencere = null;
let adresPenceresi = null;

// --- Adres yonetimi -------------------------------------------------------
// Adresin iki kaynagi var:
//   1. adres.json - exe derlenirken exe-yap.ps1'in yazdigi VARSAYILAN.
//   2. ayar.json  - AC'nin kendi girdigi adres (userData altinda).
// Kullanicininki her zaman one geciyor: panel baska bir adrese tasindiginda
// herkesin exe'yi yeniden indirmesi gerekmesin diye.

function varsayilanAdres() {
    try {
        const d = JSON.parse(fs.readFileSync(path.join(__dirname, 'adres.json'), 'utf8'));
        return adresDuzelt(d && d.adres) || '';
    } catch (error) {
        return '';
    }
}

function ayarYolu() {
    return path.join(app.getPath('userData'), AYAR_ADI);
}

function kayitliAdres() {
    try {
        const d = JSON.parse(fs.readFileSync(ayarYolu(), 'utf8'));
        return adresDuzelt(d && d.adres) || '';
    } catch (error) {
        return '';
    }
}

function adresKaydet(adres) {
    try {
        fs.mkdirSync(app.getPath('userData'), { recursive: true });
        fs.writeFileSync(ayarYolu(), JSON.stringify({ adres }, null, 2));
        return true;
    } catch (error) {
        return false;
    }
}

// Elle yazilan adresi kullanilabilir hale getiriyor. AC'nin "panel.site.com"
// ya da "192.168.1.5:3000" yazmasi normal; basina http:// koymadan
// loadURL'e verirsek Electron dosya yolu sanip sessizce bos sayfa aciyordu.
// Donen deger ya gecerli bir http(s) adresi ya da bos dize.
function adresDuzelt(ham) {
    if (typeof ham !== 'string') return '';
    let a = ham.trim();
    if (!a) return '';
    // Sema kontrolu "://" arayarak yapiliyor, yalnizca ":" ile DEGIL:
    // "localhost:3000" ve "1.2.3.4:3000" sema degil, host:port. Sadece ":"
    // arasaydik ikisini de sema sanip reddederdik.
    const semali = /^([a-z][a-z0-9+.-]*):\/\//i.exec(a);
    if (semali) {
        const sema = semali[1].toLowerCase();
        // file:// ve ftp:// gibi seylerin basina http:// eklemek onlari
        // "http://file///C:/gizli.txt" gibi anlamsiz bir adrese ceviriyordu -
        // hata vermek yerine sessizce yanlis yere baglanmaya calisirdi.
        if (sema !== 'http' && sema !== 'https') return '';
    } else {
        a = `http://${a}`;
    }
    try {
        const u = new URL(a);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
        if (!u.hostname) return '';
        // Sondaki "/" atiliyor: "adres/" + "/api/..." iki bolu uretiyordu.
        return u.origin + (u.pathname === '/' ? '' : u.pathname.replace(/\/$/, ''));
    } catch (error) {
        return '';
    }
}

// Oncelik: kullanicinin girdigi > derlerken gomulen (adres.json) > koda
// gomulu varsayilan. Ucu de bostan donerse adres ekrani aciliyor.
function gecerliAdres() {
    return kayitliAdres() || varsayilanAdres() || adresDuzelt(YERLESIK_ADRES);
}

// --- Pencereler -----------------------------------------------------------

function menuKur() {
    // Varsayilan menu Ingilizce ve isimize yaramayan bir suru madde iceriyor.
    // Yenile ve Adresi Degistir gercekten lazim: panel yeniden baslarken
    // (12 saatte bir) sayfa bir sure cevap vermiyor, AC'nin elinde bir
    // "tekrar dene" olmali.
    Menu.setApplicationMenu(Menu.buildFromTemplate([
        {
            label: 'Panel',
            submenu: [
                { label: 'Yenile', accelerator: 'CmdOrCtrl+R', click: () => anaPencere && anaPencere.reload() },
                { label: 'Sunucu adresini değiştir', click: () => adresEkraniAc('') },
                { type: 'separator' },
                { label: 'Tam ekran', accelerator: 'F11', role: 'togglefullscreen' },
                { label: 'Geliştirici araçları', accelerator: 'CmdOrCtrl+Shift+I', role: 'toggleDevTools' },
                { type: 'separator' },
                { label: 'Çıkış', accelerator: 'CmdOrCtrl+Q', role: 'quit' },
            ],
        },
    ]));
}

function anaPencereAc(adres) {
    if (anaPencere && !anaPencere.isDestroyed()) {
        anaPencere.loadURL(adres);
        anaPencere.show();
        return;
    }
    anaPencere = new BrowserWindow({
        width: 1280,
        height: 860,
        minWidth: 900,
        minHeight: 600,
        backgroundColor: '#0e0809',   // panelin zemini - acilista beyaz parlama olmasin
        title: 'MD AC Paneli',
        show: false,
        webPreferences: {
            // Panel UZAK bir sayfa. preload BILEREK yok: adres ekraninin
            // IPC koprusu buraya sizsaydi, sunucudan gelen sayfa uygulamanin
            // ayar dosyasina erisebilirdi.
            contextIsolation: true,
            nodeIntegration: false,
            spellcheck: false,
        },
    });

    anaPencere.once('ready-to-show', () => anaPencere.show());
    anaPencere.on('closed', () => { anaPencere = null; });

    // Panelden disari acilan baglantilar (Discord linkleri vb.) uygulamanin
    // icinde degil, kisinin kendi tarayicisinda acilsin.
    anaPencere.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:\/\//i.test(url)) shell.openExternal(url);
        return { action: 'deny' };
    });

    // Sunucuya ulasilamiyor: sessiz bos ekran yerine adres ekranina donuyoruz.
    // -3 (ABORTED) atlaniyor - bir yonlendirme sirasinda da geliyor ve
    // gercek bir hata degil.
    anaPencere.webContents.on('did-fail-load', (olay, kod, aciklama, hataliUrl, anaCerceve) => {
        if (!anaCerceve || kod === -3) return;
        adresEkraniAc(`Panele ulaşılamadı (${aciklama || kod}). Adres doğru mu, panel açık mı?`);
    });

    anaPencere.loadURL(adres);
}

function adresEkraniAc(hata) {
    if (adresPenceresi && !adresPenceresi.isDestroyed()) {
        adresPenceresi.focus();
        return;
    }
    adresPenceresi = new BrowserWindow({
        width: 560,
        height: 420,
        resizable: false,
        backgroundColor: '#0e0809',
        title: 'Sunucu adresi',
        autoHideMenuBar: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });
    adresPenceresi.setMenuBarVisibility(false);
    adresPenceresi.on('closed', () => {
        adresPenceresi = null;
        // Hic adres yoksa ve kisi pencereyi kapattiysa yapacak bir sey kalmiyor.
        if (!gecerliAdres() && !anaPencere) app.quit();
    });
    adresPenceresi.loadFile(path.join(__dirname, 'adres.html'), {
        query: { adres: gecerliAdres(), hata: hata || '' },
    });
}

// --- IPC: adres ekraniyla konusma ----------------------------------------

ipcMain.handle('adres-kaydet', (olay, ham) => {
    const adres = adresDuzelt(ham);
    if (!adres) return { ok: false, hata: 'Geçerli bir adres yaz (örnek: panel.site.com veya 1.2.3.4:3000).' };
    if (!adresKaydet(adres)) return { ok: false, hata: 'Adres kaydedilemedi - diskte yazma izni yok olabilir.' };
    if (adresPenceresi && !adresPenceresi.isDestroyed()) {
        const p = adresPenceresi;
        adresPenceresi = null;   // 'closed' icindeki app.quit() tetiklenmesin
        p.close();
    }
    anaPencereAc(adres);
    return { ok: true, adres };
});

// --- Baslangic ------------------------------------------------------------

app.on('second-instance', () => {
    const p = anaPencere || adresPenceresi;
    if (p && !p.isDestroyed()) {
        if (p.isMinimized()) p.restore();
        p.focus();
    }
});

app.whenReady().then(() => {
    menuKur();
    const adres = gecerliAdres();
    if (adres) anaPencereAc(adres);
    else adresEkraniAc('');
});

app.on('window-all-closed', () => app.quit());

// Beklenmeyen bir hatada sessizce olmek yerine ne oldugunu soyluyoruz -
// AC'nin "acmiyor" demesiyle log gondermesi arasindaki fark.
process.on('uncaughtException', (hata) => {
    try {
        dialog.showErrorBox('MD AC Paneli', `Beklenmeyen hata:\n\n${hata && hata.message ? hata.message : hata}`);
    } catch (e) { /* dialog bile acilamiyorsa yapacak bir sey yok */ }
});
