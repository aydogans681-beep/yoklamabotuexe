// Discord "public flags" (herkese açık rozetler) çözümleyici.
// user.flags.bitfield (ya da API'deki public_flags) bir bit maskesidir; her bit
// bir rozete karşılık gelir. Burada o bitleri okunur rozet listesine çeviriyoruz.
//
// Kaynak: Discord API "User Flags". SADECE public flags okunabilir; Nitro,
// boost, Quest, Orb, eski kullanıcı adı gibi rozetler public flags'te YOKTUR,
// hiçbir bot/hesap bunları API'den göremez.

// bit değeri: 1 << n
const ROZETLER = [
    { anahtar: 'STAFF',              bit: 1 << 0,  ad: 'Discord Çalışanı',            emoji: '🛡️', nadir: true },
    { anahtar: 'PARTNER',            bit: 1 << 1,  ad: 'Partner Sunucu Sahibi',        emoji: '🤝', nadir: true },
    { anahtar: 'HYPESQUAD_EVENTS',   bit: 1 << 2,  ad: 'HypeSquad Events',            emoji: '🎉', nadir: true },
    { anahtar: 'BUG_HUNTER_1',       bit: 1 << 3,  ad: 'Bug Hunter (1. Seviye)',       emoji: '🐛', nadir: true },
    { anahtar: 'HOUSE_BRAVERY',      bit: 1 << 6,  ad: 'HypeSquad Bravery',           emoji: '🟣', nadir: false },
    { anahtar: 'HOUSE_BRILLIANCE',   bit: 1 << 7,  ad: 'HypeSquad Brilliance',        emoji: '🔴', nadir: false },
    { anahtar: 'HOUSE_BALANCE',      bit: 1 << 8,  ad: 'HypeSquad Balance',           emoji: '🟢', nadir: false },
    { anahtar: 'EARLY_SUPPORTER',    bit: 1 << 9,  ad: 'Erken Destekçi',              emoji: '💎', nadir: true },
    { anahtar: 'BUG_HUNTER_2',       bit: 1 << 14, ad: 'Bug Hunter (2. Seviye)',       emoji: '🐞', nadir: true },
    { anahtar: 'VERIFIED_DEVELOPER', bit: 1 << 17, ad: 'Erken Doğrulanmış Bot Geliştirici', emoji: '⚙️', nadir: true },
    { anahtar: 'CERTIFIED_MOD',      bit: 1 << 18, ad: 'Moderatör Programı Mezunu',    emoji: '🎖️', nadir: true },
    { anahtar: 'ACTIVE_DEVELOPER',   bit: 1 << 22, ad: 'Aktif Geliştirici',           emoji: '🛠️', nadir: true },
];

// flags: sayı (bit maskesi) ya da { bitfield } / BigInt. Güvenli biçimde sayıya çeviriyoruz.
function bitAl(flags) {
    if (flags == null) return 0;
    if (typeof flags === 'number') return flags;
    if (typeof flags === 'bigint') return Number(flags);
    if (typeof flags.bitfield === 'number') return flags.bitfield;
    if (typeof flags.bitfield === 'bigint') return Number(flags.bitfield);
    const n = Number(flags);
    return Number.isFinite(n) ? n : 0;
}

// Bir kullanıcının TÜM public rozetlerini döndürür (ev rozetleri dahil).
function rozetleriCoz(flags) {
    const bit = bitAl(flags);
    return ROZETLER.filter((r) => (bit & r.bit) === r.bit);
}

// Yalnızca NADİR rozetler (ev rozetleri hariç).
function nadirRozetler(flags) {
    return rozetleriCoz(flags).filter((r) => r.nadir);
}

// Kişide en az bir nadir rozet var mı?
function nadirVarMi(flags) {
    return nadirRozetler(flags).length > 0;
}

// "💎 Erken Destekçi, 🐛 Bug Hunter" gibi kısa özet.
function ozet(rozetler) {
    return rozetler.map((r) => `${r.emoji} ${r.ad}`).join(', ');
}

module.exports = { ROZETLER, bitAl, rozetleriCoz, nadirRozetler, nadirVarMi, ozet };
