// Kullanıcı hesabı (selfbot) tarafı: davet linkini çöz, gerekiyorsa sunucuya
// GİR, üyeleri tara, nadir rozeti olanları topla, istenirse sunucudan çık.
//
// ⚠️ Bir kullanıcı hesabının otomatik davet kabul etmesi + üye taraması Discord
// ToS ihlalidir ve hesap banlanabilir. Bu dosya o riski bilerek uygular.

const { nadirRozetler, ozet } = require('./rozetler');

// 'https://discord.gg/abc', 'discord.gg/abc', '.../invite/abc', 'abc' -> 'abc'
function davetKoduCoz(girdi) {
    const s = String(girdi || '').trim();
    const m = s.match(/(?:https?:\/\/)?(?:www\.)?(?:discord(?:app)?\.com\/invite|discord\.gg)\/([A-Za-z0-9-]+)/i);
    if (m) return m[1];
    // Düz kod (link değil) yazıldıysa
    if (/^[A-Za-z0-9-]{2,}$/.test(s)) return s;
    return null;
}

function bekleGuild(userClient, guildId, zamanAsimiMs = 8000) {
    return new Promise((resolve) => {
        const bitis = Date.now() + zamanAsimiMs;
        const bak = () => {
            const g = userClient.guilds.cache.get(guildId);
            if (g) return resolve(g);
            if (Date.now() >= bitis) return resolve(null);
            setTimeout(bak, 300);
        };
        bak();
    });
}

async function taraVeGetir(userClient, davet, opts = {}) {
    const kod = davetKoduCoz(davet);
    if (!kod) throw new Error('Geçerli bir davet linki/kodu değil.');

    let invite;
    try {
        invite = await userClient.fetchInvite(kod);
    } catch (e) {
        throw new Error(`Davet çözülemedi (geçersiz ya da süresi dolmuş olabilir): ${e.message}`);
    }
    const guildId = invite.guild && invite.guild.id;
    if (!guildId) throw new Error('Bu davet bir sunucuya ait değil (grup DM daveti olabilir).');

    let guild = userClient.guilds.cache.get(guildId);
    let girdiMi = false;
    if (!guild) {
        // --- ToS-riskli kısım: kullanıcı hesabıyla sunucuya katıl ---
        if (typeof userClient.acceptInvite === 'function') {
            await userClient.acceptInvite(kod);
        } else if (invite && typeof invite.acceptInvite === 'function') {
            await invite.acceptInvite();
        } else {
            throw new Error('Bu discord.js-selfbot sürümünde davet kabul metodu bulunamadı.');
        }
        guild = await bekleGuild(userClient, guildId, 9000);
        girdiMi = true;
        if (!guild) throw new Error('Sunucuya girildi ama üye bilgisi yüklenemedi (çok büyük olabilir).');
    }

    // Üyeleri çek. Kullanıcı hesabında bu "üye listesi" op'u ile yapılır ve
    // ağırdır; büyük sunucuda takılmasın diye üst sınır uygulanıyor.
    let uyeler;
    try {
        const hepsi = await guild.members.fetch();
        uyeler = [...hepsi.values()];
    } catch (e) {
        uyeler = [...guild.members.cache.values()];
        if (uyeler.length === 0) throw new Error(`Üye listesi alınamadı: ${e.message}`);
    }

    const maxUye = Number(opts.maxUye) || 3000;
    const tamSayi = uyeler.length;
    if (uyeler.length > maxUye) uyeler = uyeler.slice(0, maxUye);

    const bulunanlar = [];
    for (const uye of uyeler) {
        const u = uye.user;
        if (!u || u.bot) continue;
        const nadir = nadirRozetler(u.flags);
        if (nadir.length) {
            bulunanlar.push({ id: u.id, tag: u.tag || u.username || u.id, rozetler: nadir });
        }
    }
    // En çok nadir rozeti olan üstte.
    bulunanlar.sort((a, b) => b.rozetler.length - a.rozetler.length);

    let ayrildi = false;
    if (girdiMi && opts.taramadanSonraAyril && guild) {
        try { await guild.leave(); ayrildi = true; } catch (e) { /* çıkılamadı - boşver */ }
    }

    return {
        sunucuAdi: (guild && guild.name) || (invite.guild && invite.guild.name) || guildId,
        guildId,
        taranan: uyeler.length,
        toplamUye: tamSayi,
        girdiMi,
        ayrildi,
        bulunanlar,
    };
}

// Sonucu Discord embed açıklamasına uygun metne çevirir (test edilebilir, saf).
function bulunanlariBicimle(bulunanlar, siniri = 60) {
    if (!bulunanlar.length) return '_Bu sunucuda nadir rozeti olan üye bulunamadı._';
    const gosterilecek = bulunanlar.slice(0, siniri);
    const satirlar = gosterilecek.map((b) => `• <@${b.id}> — ${ozet(b.rozetler)}`);
    if (bulunanlar.length > siniri) {
        satirlar.push(`… ve ${bulunanlar.length - siniri} kişi daha.`);
    }
    return satirlar.join('\n');
}

module.exports = { davetKoduCoz, bekleGuild, taraVeGetir, bulunanlariBicimle };
