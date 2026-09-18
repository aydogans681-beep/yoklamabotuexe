// Panel arayüzü tek bir HTML string (harici dosya yok -> pkg ile exe'ye sorunsuz gömülür).
module.exports = `<!DOCTYPE html>
<html lang="tr"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Rozet Tarayıcı</title>
<style>
  :root{ --bg:#0e0f13; --card:#171922; --line:#262a37; --ink:#e8e9ee; --ink2:#9aa0b4; --acc:#5865F2; --ok:#2fb86b; --err:#ff4d55; }
  *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 "Segoe UI",system-ui,sans-serif;padding:22px}
  .wrap{max-width:820px;margin:0 auto} h1{font-size:20px;margin:0 0 4px} .sub{color:var(--ink2);margin:0 0 18px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin-bottom:14px}
  .card h2{font-size:15px;margin:0 0 12px}
  label{display:block;color:var(--ink2);font-size:12px;margin:10px 0 4px}
  input[type=text],input[type=password]{width:100%;background:#0c0d11;border:1px solid var(--line);color:var(--ink);border-radius:8px;padding:9px 11px;font:inherit}
  .row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
  .row>div{flex:1;min-width:140px}
  button{background:linear-gradient(180deg,#6b76f7,var(--acc));color:#fff;border:0;border-radius:8px;padding:10px 16px;font:inherit;font-weight:650;cursor:pointer}
  button.sec{background:#20242f;color:var(--ink)}
  button:disabled{opacity:.5;cursor:default}
  .durum{font-size:12.5px;margin-top:10px}
  .dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#555;margin-right:6px;vertical-align:middle}
  .dot.on{background:var(--ok)} .msg{font-size:12.5px;color:var(--ink2);margin-left:8px}
  .uyari{background:#2a1416;border:1px solid #5b2327;color:#ffb4b8;border-radius:10px;padding:10px 12px;font-size:12.5px;margin-bottom:14px}
  table{width:100%;border-collapse:collapse;margin-top:10px} th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line);font-size:13px}
  th{color:var(--ink2);font-weight:600} .k{color:var(--ink2);font-size:12px}
  .foot{color:var(--ink2);font-size:12px;margin-top:8px}
  a{color:#8ea0ff}
</style></head><body><div class="wrap">
  <h1>🔎 Rozet Tarayıcı</h1>
  <p class="sub">Davet linkini gir → hesap o sunucuya girip üyelerin <b>nadir rozetlerini</b> listeler.</p>
  <div class="uyari">⚠️ Kullanıcı hesabının otomatik sunucuya girip üye taraması <b>Discord ToS ihlali</b>. Hesap banlanabilir — ana hesabını değil, gözden çıkarabileceğin bir hesabı kullan.</div>

  <div class="card">
    <h2>1) Token & Ayarlar</h2>
    <label>Hesap (kullanıcı) token'ı — <b>zorunlu</b>, taramayı bu yapar</label>
    <input type="password" id="userToken" placeholder="kullanıcı hesabı token'ı" spellcheck="false">
    <label>Bot token'ı — isteğe bağlı (Discord içinde /goster slash komutu istersen)</label>
    <input type="password" id="botToken" placeholder="resmi bot token'ı (boş bırakabilirsin)" spellcheck="false">
    <div class="row">
      <div><label>İzinli Discord ID'ler (virgülle) — /goster'ı kimler kullanabilir</label>
        <input type="text" id="izinli" placeholder="123..., 456..." spellcheck="false"></div>
      <div><label>En fazla taranacak üye</label><input type="text" id="maxUye" placeholder="3000"></div>
    </div>
    <label style="display:flex;align-items:center;gap:8px;margin-top:12px;cursor:pointer">
      <input type="checkbox" id="ayril" style="width:auto"> Tarama bitince sunucudan çık (iz bırakma)
    </label>
    <div class="row" style="margin-top:14px">
      <button id="kaydetBtn">Kaydet & Bağlan</button>
      <span class="msg" id="tokenMsg"></span>
    </div>
    <div class="durum">
      <span class="dot" id="hesapDot"></span><span id="hesapDurum">Hesap: bağlı değil</span>
      &nbsp;&nbsp; <span class="dot" id="botDot"></span><span id="botDurum">Bot: bağlı değil</span>
    </div>
  </div>

  <div class="card">
    <h2>2) Tara</h2>
    <div class="row">
      <div><input type="text" id="link" placeholder="discord.gg/xxxx  ya da  https://discord.com/invite/xxxx" spellcheck="false"></div>
      <button id="taraBtn">Tara</button>
    </div>
    <span class="msg" id="taraMsg"></span>
    <div id="sonuc"></div>
  </div>
</div>
<script>
const $ = (id) => document.getElementById(id);
async function durumYukle(){
  try{
    const d = await (await fetch('/api/durum')).json();
    $('hesapDot').className = 'dot' + (d.hesapBagli?' on':''); $('hesapDurum').textContent = 'Hesap: ' + (d.hesapBagli? d.hesapTag : 'bağlı değil');
    $('botDot').className = 'dot' + (d.botBagli?' on':''); $('botDurum').textContent = 'Bot: ' + (d.botBagli? d.botTag : 'bağlı değil');
    if(!$('izinli').value) $('izinli').value = (d.izinli||[]).join(', ');
    if(!$('maxUye').value) $('maxUye').value = d.maxUye || 3000;
    $('ayril').checked = d.taramadanSonraAyril !== false;
    if(d.tokenVar && d.tokenVar.hesap && !$('userToken').value) $('userToken').placeholder = '•••• (kayıtlı - değiştirmek için yaz)';
    if(d.tokenVar && d.tokenVar.bot && !$('botToken').value) $('botToken').placeholder = '•••• (kayıtlı)';
  }catch(e){}
}
$('kaydetBtn').onclick = async () => {
  $('kaydetBtn').disabled = true; $('tokenMsg').textContent = 'Bağlanıyor...';
  const govde = {
    izinliKullanicilar: $('izinli').value.split(',').map(s=>s.trim()).filter(Boolean),
    maxUye: Number($('maxUye').value)||3000,
    taramadanSonraAyril: $('ayril').checked,
  };
  if($('userToken').value.trim()) govde.userToken = $('userToken').value.trim();
  if($('botToken').value.trim()) govde.botToken = $('botToken').value.trim();
  try{
    const d = await (await fetch('/api/token',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(govde)})).json();
    $('tokenMsg').textContent = d.ok ? 'Kaydedildi, bağlandı ✓' : ('Hata: ' + (d.hatalar||[]).join(' | '));
    $('userToken').value=''; $('botToken').value='';
    setTimeout(durumYukle, 1500);
  }catch(e){ $('tokenMsg').textContent = 'Hata: ' + e.message; }
  finally{ $('kaydetBtn').disabled = false; }
};
$('taraBtn').onclick = async () => {
  const link = $('link').value.trim();
  if(!link){ $('taraMsg').textContent='Link boş.'; return; }
  $('taraBtn').disabled = true; $('taraMsg').textContent = 'Taranıyor... (girip üyeleri okuyor, biraz sürebilir)'; $('sonuc').innerHTML='';
  try{
    const d = await (await fetch('/api/tara',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({link})})).json();
    if(!d.ok){ $('taraMsg').textContent = 'Hata: ' + d.error; return; }
    const s = d.sonuc;
    $('taraMsg').textContent = s.sunucuAdi + ' — ' + s.taranan + '/' + s.toplamUye + ' üye tarandı';
    if(!s.bulunanlar.length){ $('sonuc').innerHTML = '<p class="k">Bu sunucuda nadir rozetli üye bulunamadı.</p>'; return; }
    const satir = s.bulunanlar.map(b => '<tr><td>'+esc(b.tag)+' <span class="k">('+b.id+')</span></td><td>'+b.rozetler.map(r=>r.emoji+' '+esc(r.ad)).join(', ')+'</td></tr>').join('');
    $('sonuc').innerHTML = '<table><tr><th>Kişi</th><th>Nadir rozetler</th></tr>'+satir+'</table>'
      + '<p class="foot">'+s.bulunanlar.length+' kişide nadir rozet' + (s.girdiMi ? (s.ayrildi?' · girip çıkıldı':' · sunucuya girildi') : ' · zaten üyeyiz') + '</p>';
  }catch(e){ $('taraMsg').textContent = 'Hata: ' + e.message; }
  finally{ $('taraBtn').disabled = false; }
};
function esc(s){ return String(s).replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
durumYukle(); setInterval(durumYukle, 5000);
</script></body></html>`;
