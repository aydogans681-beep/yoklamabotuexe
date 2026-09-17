// ============================================================================
//  ILK PANEL HESABI - felaket kurtarma araci.
//
//  panel-auth.json kaybolursa panele girmenin HICBIR yolu kalmiyor: giris
//  ucu her denemeyi reddediyor, hesap ekleme ucu ise zaten giris yapmis bir
//  yonetici istiyor. Tavuk-yumurta. Bu betik o dugumu cozuyor.
//
//  GUVENLIK: dosyada ZATEN hesap varsa calismayi REDDEDIYOR. Aksi halde
//  sunucuya dosya yazabilen herkesin kendine yonetici acabilecegi bir arka
//  kapi olurdu.
//
//  Kullanim:
//    node ilk-hesap.js                 (kullanici adi ve sifreyi sorar)
//    node ilk-hesap.js admin S1fre123  (dogrudan verir)
// ============================================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');

const ROOT_DIR = __dirname;
const PANEL_AUTH_PATH = path.join(ROOT_DIR, 'panel-auth.json');
const EN_KISA_SIFRE = 6;

// server.js ile BIREBIR ayni: scrypt, 16 baytlik tuz, 64 baytlik hash.
// Farkli olsaydi uretilen hesapla giris yapilamazdi.
function newSalt() {
    return crypto.randomBytes(16).toString('hex');
}
function hashPassword(password, saltHex) {
    return crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 64).toString('hex');
}

function mevcutHesaplar() {
    try {
        const d = JSON.parse(fs.readFileSync(PANEL_AUTH_PATH, 'utf8'));
        if (d && Array.isArray(d.users)) return d.users.filter((u) => u && u.username);
        // Eski tek hesapli bicim de hesap sayilir.
        if (d && typeof d.username === 'string') return [{ username: d.username }];
        return [];
    } catch (error) {
        return [];
    }
}

function sor(soru, gizli) {
    return new Promise((cozumle) => {
        const arayuz = readline.createInterface({ input: process.stdin, output: process.stdout });
        if (!gizli) {
            arayuz.question(soru, (cevap) => { arayuz.close(); cozumle(cevap.trim()); });
            return;
        }
        // Sifre ekranda gorunmesin: yazilan her karakter icin satiri geri yaz.
        const yaz = (parca) => {
            if (arayuz.stdoutMuted) process.stdout.write('*');
            else process.stdout.write(parca);
        };
        arayuz._writeToOutput = yaz;
        arayuz.stdoutMuted = false;
        process.stdout.write(soru);
        arayuz.stdoutMuted = true;
        arayuz.question('', (cevap) => {
            arayuz.close();
            process.stdout.write('\n');
            cozumle(cevap.trim());
        });
    });
}

(async () => {
    const varOlan = mevcutHesaplar();
    if (varOlan.length > 0) {
        console.log('');
        console.log('  Bu kurulumda ZATEN hesap var:');
        varOlan.forEach((u) => console.log(`    - ${u.username}`));
        console.log('');
        console.log('  Bu betik yalnizca HIC hesap yokken calisir.');
        console.log('  Sifreni unuttuysan panel-auth.json dosyasini silip tekrar dene');
        console.log('  (dikkat: butun panel hesaplari ve yetkileri gider).');
        console.log('');
        process.exit(1);
    }

    let username = (process.argv[2] || '').trim();
    let password = process.argv[3] || '';

    if (!username) username = await sor('  Kullanici adi: ', false);
    if (!username) {
        console.log('  Kullanici adi bos olamaz.');
        process.exit(1);
    }
    if (!password) {
        password = await sor('  Sifre         : ', true);
        const tekrar = await sor('  Sifre (tekrar): ', true);
        if (password !== tekrar) {
            console.log('');
            console.log('  Sifreler ayni degil.');
            process.exit(1);
        }
    }
    if (password.length < EN_KISA_SIFRE) {
        console.log('');
        console.log(`  Sifre en az ${EN_KISA_SIFRE} karakter olmali.`);
        process.exit(1);
    }

    const salt = newSalt();
    const kayit = {
        users: [{
            username,
            salt,
            hash: hashPassword(password, salt),
            createdAt: Date.now(),
        }],
    };

    try {
        fs.writeFileSync(PANEL_AUTH_PATH, JSON.stringify(kayit, null, 2));
    } catch (error) {
        console.log('');
        console.log(`  Yazilamadi: ${error.message}`);
        process.exit(1);
    }

    console.log('');
    console.log(`  "${username}" hesabi olusturuldu ve YONETICI oldu.`);
    console.log('  (Listenin ilk kaydi her zaman yonetici sayiliyor.)');
    console.log('');
    console.log('  Simdi paneli acip bu bilgilerle girebilirsin.');
    console.log('');
})();
