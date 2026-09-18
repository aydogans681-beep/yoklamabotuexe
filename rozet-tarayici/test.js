// Saf mantık testleri (Discord bağlantısı gerektirmeyen): rozet çözümleme,
// davet kodu ayrıştırma, sonuç biçimleme.
const { rozetleriCoz, nadirRozetler, nadirVarMi, bitAl } = require('./rozetler');
const { davetKoduCoz, bulunanlariBicimle } = require('./tarayici');

const sonuc = [];
function k(ad, ok, ek = '') { sonuc.push(ok); console.log(`${ok ? '  ✓' : '  ✗ BAŞARISIZ'} ${ad}${ok || !ek ? '' : ` -> ${ek}`}`); }

console.log('[Rozet çözümleme]');
// Early Supporter (512) + Bug Hunter 1 (8) = 520
k('nadir rozetler doğru okunuyor (520 -> Erken Destekçi + Bug Hunter)',
  nadirRozetler(520).map((r) => r.anahtar).sort().join(',') === 'BUG_HUNTER_1,EARLY_SUPPORTER',
  JSON.stringify(nadirRozetler(520).map((r) => r.anahtar)));
k('Active Developer (1<<22) nadir', nadirRozetler(1 << 22).some((r) => r.anahtar === 'ACTIVE_DEVELOPER'));
k('Staff (1) nadir', nadirVarMi(1));
k('sadece ev rozeti (Bravery 64) NADİR değil', nadirVarMi(64) === false && rozetleriCoz(64).length === 1);
k('rozetsiz (0) -> nadir yok', nadirVarMi(0) === false && rozetleriCoz(0).length === 0);
k('bitAl: {bitfield} nesnesini de okur', bitAl({ bitfield: 512 }) === 512 && bitAl(512) === 512 && bitAl(null) === 0);
k('birden çok rozet: Staff+Partner+ActiveDev', nadirRozetler(1 | 2 | (1 << 22)).length === 3);

console.log('\n[Davet kodu ayrıştırma]');
k('https://discord.gg/abc123 -> abc123', davetKoduCoz('https://discord.gg/abc123') === 'abc123');
k('discord.gg/abc123 -> abc123', davetKoduCoz('discord.gg/abc123') === 'abc123');
k('discord.com/invite/xyz -> xyz', davetKoduCoz('https://discord.com/invite/xyz') === 'xyz');
k('düz kod "kod-123" -> kod-123', davetKoduCoz('kod-123') === 'kod-123');
k('boş/geçersiz -> null', davetKoduCoz('') === null && davetKoduCoz('   ') === null);

console.log('\n[Sonuç biçimleme]');
const ornek = [
  { id: '111', tag: 'a#1', rozetler: nadirRozetler(1 | 2) },
  { id: '222', tag: 'b#2', rozetler: nadirRozetler(512) },
];
const metin = bulunanlariBicimle(ornek, 60);
k('mention + rozet satırı içeriyor', metin.includes('<@111>') && metin.includes('<@222>'));
k('boş liste -> anlamlı mesaj', /bulunamadı/i.test(bulunanlariBicimle([], 60)));
k('sınır aşınca "… ve N kişi daha"', /ve 1 kişi daha/.test(bulunanlariBicimle(ornek, 1)));

const kaldi = sonuc.filter((x) => !x).length;
console.log(`\n${sonuc.length - kaldi}/${sonuc.length} kontrol geçti`);
process.exit(kaldi ? 1 : 0);
