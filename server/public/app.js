// MD PvP Yoklama Botu - web paneli, ön yüz mantığı.
// Electron sürümündeki yoklama-renderer.js'nin karşılığı - ipcRenderer yerine
// fetch()/WebSocket kullanıyor.
// Sekmeler: Yoklama (tarama + uyarı + Yoklamayı Al), TX Logs (log kanalları),
// Ayarlar (panel hesapları).

const loginWrap = document.getElementById('loginWrap');
const appWrap = document.getElementById('appWrap');
const loginUsername = document.getElementById('loginUsername');
const loginPassword = document.getElementById('loginPassword');
const loginBtn = document.getElementById('loginBtn');
const loginError = document.getElementById('loginError');
const logoutBtn = document.getElementById('logoutBtn');

const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const errorBox = document.getElementById('errorBox');

const scanBtn = document.getElementById('scanBtn');
const scanStatus = document.getElementById('scanStatus');
const kpiRow = document.getElementById('kpiRow');
const kpiChecked = document.getElementById('kpiChecked');
const kpiInVoice = document.getElementById('kpiInVoice');
const kpiOut = document.getElementById('kpiOut');
const listEl = document.getElementById('list');
const emptyState = document.getElementById('emptyState');
const searchInput = document.getElementById('searchInput');
const filterChips = document.querySelectorAll('.chip');
const emergencyBtn = document.getElementById('emergencyBtn');
const emergencyStatus = document.getElementById('emergencyStatus');
const selectedCountEl = document.getElementById('selectedCount');
const selectVisibleBtn = document.getElementById('selectVisibleBtn');
const clearSelectionBtn = document.getElementById('clearSelectionBtn');
const bulkReasonEl = document.getElementById('bulkReason');
const bulkWarnBtn = document.getElementById('bulkWarnBtn');
const bulkUndoBtn = document.getElementById('bulkUndoBtn');
const bulkProgress = document.getElementById('bulkProgress');

function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}

// Sunucu JSON yerine HTML dondurdugunde ("<!DOCTYPE ...") ham bir ayristirma
// hatasi yerine ne yapilmasi gerektigini soyleyen bir mesaj veriyoruz. Bu
// pratikte tek bir anlama geliyor: dosyalar guncellendi ama Node sureci hala
// eski kodu calistiriyor, yani cagrilan uc o surecte henuz yok.
async function okuJson(res) {
    const metin = await res.text();
    try {
        return JSON.parse(metin);
    } catch (error) {
        const html = metin.trim().startsWith('<');
        // Hangi ucun eksik oldugunu da yaziyoruz - yeniden baslatmaya ragmen
        // devam ederse hangi surumun calistigi buradan anlasilir.
        let yol = '';
        try { yol = new URL(res.url).pathname; } catch (e) { yol = res.url || ''; }
        throw new Error(html
            ? `Sunucu "${yol}" isteğini tanımıyor. Güncelleme sonrası bot yeniden başlatılmamış olabilir - sunucuda botu kapatıp yeniden başlat.`
            : `Sunucudan beklenmeyen cevap geldi (HTTP ${res.status}, ${yol}).`);
    }
}

function showError(message) {
    errorBox.textContent = message;
    errorBox.style.display = 'block';
}
function hideError() {
    errorBox.style.display = 'none';
}

// --- GİRİŞ / OTURUM ---
let currentUsername = null;
let currentIsAdmin = false;
let currentSekmeler = null; // null = kisit yok (yetki bilgisi henuz gelmedi)
let currentTip = 'yetkili'; // 'ac' -> yalnizca Ticket'a Mesaj

// Yonetici olmayan hesaplarda hesap yonetimi ve hesap loglari gizleniyor.
// Sunucu tarafinda da kapali (requireAdmin) - burasi sadece gorunum.
function applyAdminVisibility() {
    document.querySelectorAll('.admin-only').forEach((el) => {
        el.style.display = currentIsAdmin ? '' : 'none';
    });

    // Sekme izinleri: izinsiz sekmeler menuden kalkiyor. Sunucu da ayni
    // kisiti uyguluyor - burasi yalnizca gorunum.
    let ilkAcik = null;
    document.querySelectorAll('.side-nav .tab-btn').forEach((btn) => {
        const sekme = btn.dataset.tab;
        if (sekme === 'hesaploglari') return; // .admin-only ile yonetiliyor
        const izinli = currentIsAdmin
            || !Array.isArray(currentSekmeler)
            || currentSekmeler.includes(sekme);
        btn.style.display = izinli ? '' : 'none';
        if (izinli && !ilkAcik) ilkAcik = btn;
    });

    // Butun maddeleri gizlenen grubun basligi tek basina kalmasin.
    document.querySelectorAll('.nav-grup').forEach((grup) => {
        const gorunen = [...grup.querySelectorAll('.tab-btn')]
            .some((b) => b.style.display !== 'none');
        grup.style.display = gorunen ? '' : 'none';
    });

    // Acik sekme artik izinli degilse bos ekranda kalmasin - izinli ilk
    // sekmeye geciyoruz.
    const acik = document.querySelector('.tab-panel.active');
    if (acik) {
        const acikSekme = acik.id.replace(/^tab-/, '');
        const dugme = document.querySelector(`.side-nav .tab-btn[data-tab="${acikSekme}"]`);
        if (dugme && dugme.style.display === 'none' && ilkAcik) ilkAcik.click();
    }
}

async function checkSession() {
    const res = await fetch('/api/me');
    const data = await okuJson(res);
    if (data.loggedIn) {
        currentUsername = data.username;
        currentIsAdmin = Boolean(data.isAdmin);
        currentTip = data.tip || 'yetkili';
        currentSekmeler = Array.isArray(data.sekmeler) ? data.sekmeler : null;
        showApp();
    } else {
        showLogin();
    }
}

function showLogin() {
    loginWrap.style.display = 'flex';
    appWrap.style.display = 'none';
    loginUsername.focus();
}

function showApp() {
    loginWrap.style.display = 'none';
    appWrap.style.display = 'flex';
    document.getElementById('whoAmI').textContent = currentUsername || '';
    document.getElementById('whoAvatar').textContent = (currentUsername || '?').slice(0, 1);
    document.getElementById('whoRol').textContent =
        currentIsAdmin ? 'Yönetici' : (currentTip === 'ac' ? 'AC' : 'Yetkili');
    applyAdminVisibility();
    sideCanliTazele();
    connectWebSocket();
    refreshLogMenu();
    if (currentIsAdmin) refreshAccounts();
    loadKatilim();

    // AC hesabi girince: token bağlamadan HİÇBİR ŞEY yapamasın diye hemen tam
    // ekran kapıyı göster (panel arkada bir an bile görünmesin). Durum gelince
    // (acDurumYukle) bağlıysa kapı kapanır, değilse token ekranı önünde kalır.
    if (currentTip === 'ac') {
        acGateGoster('token');
        const acDugme = document.querySelector('.side-nav .tab-btn[data-tab="ticketmesaj"]');
        if (acDugme) acDugme.click();   // acDurumYukle'yi tetikler
    }
}

async function doLogin() {
    const username = loginUsername.value.trim();
    const password = loginPassword.value;
    loginError.style.display = 'none';
    loginBtn.disabled = true;
    loginBtn.textContent = 'Giriş yapılıyor...';
    try {
        const res = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password }),
        });
        const data = await okuJson(res);
        if (!data.ok) {
            loginError.textContent = data.error || 'Giriş başarısız.';
            loginError.style.display = 'block';
            return;
        }
        currentUsername = username;
        // Yetkiyi tahmin etmiyoruz - /api/me'den okuyoruz ki sunucuyla ayni
        // kaynaktan gelsin (sekme listesi yalnizca orada donuyor).
        try {
            const me = await okuJson(await fetch('/api/me'));
            currentIsAdmin = Boolean(me.isAdmin);
            currentTip = me.tip || 'yetkili';
            currentSekmeler = Array.isArray(me.sekmeler) ? me.sekmeler : null;
        } catch (hata) {
            currentIsAdmin = Boolean(data.isAdmin);
            currentSekmeler = null;
        }
        showApp();
    } catch (error) {
        loginError.textContent = `Hata: ${error.message}`;
        loginError.style.display = 'block';
    } finally {
        loginBtn.disabled = false;
        loginBtn.textContent = 'Giriş Yap';
    }
}

// --- Giris ekrani kucuk davranislari ---

// Sifre goster/gizle
const sifreGoster = document.getElementById('sifreGoster');
if (sifreGoster) {
    sifreGoster.addEventListener('click', () => {
        const gizli = loginPassword.type === 'password';
        loginPassword.type = gizli ? 'text' : 'password';
        sifreGoster.textContent = gizli ? 'Gizle' : 'Göster';
        sifreGoster.setAttribute('aria-label', gizli ? 'Şifreyi gizle' : 'Şifreyi göster');
        loginPassword.focus();
    });
}

// Caps Lock uyarisi - "sifre yanlis" sanip ugrasmasin diye.
const capsUyari = document.getElementById('capsUyari');
if (capsUyari) {
    const capsBak = (evt) => {
        // getModifierState bazi ortamlarda yok; yoksa uyariyi hic gostermiyoruz.
        if (typeof evt.getModifierState !== 'function') return;
        capsUyari.style.display = evt.getModifierState('CapsLock') ? 'block' : 'none';
    };
    [loginUsername, loginPassword].forEach((el) => {
        el.addEventListener('keyup', capsBak);
        el.addEventListener('keydown', capsBak);
    });
    loginPassword.addEventListener('blur', () => { capsUyari.style.display = 'none'; });
}

// Bot ayakta mi? /api/surum giris gerektirmiyor. Panelin acilmamasi ile
// sifrenin yanlis olmasi kullanicinin gozunde ayni goruntuyu veriyordu.
async function loginDurumGoster() {
    const nokta = document.getElementById('mdNokta');
    const durum = document.getElementById('mdDurum');
    const sureEl = document.getElementById('mdSure');
    const surumEl = document.getElementById('mdSurum');
    if (!durum) return;
    try {
        const res = await fetch('/api/surum');
        const d = await res.json();
        if (!d.ok) throw new Error('yanit yok');
        const sn = Number(d.calismaSuresiSn) || 0;
        const saat = Math.floor(sn / 3600);
        const dk = Math.floor((sn % 3600) / 60);
        nokta.className = 'md-nokta ok';
        durum.textContent = 'Bot çalışıyor';
        sureEl.textContent = `· ${saat ? `${saat} sa ${dk} dk` : `${dk} dk`}`;
        surumEl.textContent = d.commit || '—';
    } catch (error) {
        // Panelin acilmamasi ile sifrenin yanlis olmasi kullanicinin gozunde
        // ayni goruntuyu veriyordu; bu satir ikisini ayiriyor.
        nokta.className = 'md-nokta bad';
        durum.textContent = 'Bota ulaşılamıyor';
        sureEl.textContent = '';
        surumEl.textContent = '—';
    }
}
loginDurumGoster();
setInterval(() => {
    // Yalnizca giris ekrani acikken - panel acikken bosuna istek atmayalim.
    if (loginWrap.style.display !== 'none') loginDurumGoster();
}, 30000);

loginBtn.addEventListener('click', doLogin);
[loginUsername, loginPassword].forEach((el) => {
    el.addEventListener('keydown', (evt) => { if (evt.key === 'Enter') doLogin(); });
});

logoutBtn.addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' });
    if (ws) ws.close();
    showLogin();
});

// --- CANLI BAĞLANTI (WebSocket) ---
let ws = null;
function connectWebSocket() {
    if (ws) return;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${location.host}/ws`);
    ws.addEventListener('message', (evt) => {
        try {
            const msg = JSON.parse(evt.data);
            if (msg.type === 'status') applyStatus(msg);
            else if (msg.type === 'yoklama-toplu-uyari-ilerleme') {
                bulkProgress.textContent = `Toplu uyarı gönderiliyor: ${msg.current}/${msg.total}`;
            } else if (msg.type === 'yoklama-toplu-geri-al-ilerleme') {
                bulkProgress.textContent = `Toplu geri alma: ${msg.current}/${msg.total}`;
            } else if (msg.type === 'yoklama-acil-toplanti-ilerleme') {
                emergencyStatus.textContent = `Taşınıyor: ${msg.current}/${msg.total}`;
            } else if (msg.type === 'yoklama-asama') {
                if (msg.asama) scanStatus.textContent = msg.asama;
            } else if (msg.type === 'uye-durum') {
                uyeDurumGoster(msg);
            } else if (msg.type === 'ticket-otomatik') {
                loadTicketAuto();
            } else if (msg.type === 'etkinlik-artis') {
                onActivityIncrement(msg);
            } else if (msg.type === 'log-durum') {
                onLogStatusUpdate(msg);
            } else if (msg.type === 'log-yeni') {
                onLogNewMessage(msg);
            } else if (msg.type === 'log-isaret') {
                // DİKKAT: 'log-durum' DEĞİL - o kanalın yüklenme durumu.
                logTabs.forEach((t) => t.onIsaret(msg));
            } else if (msg.type === 'ac-ticket-degisti') {
                // AC ticket kategorisinde ticket açıldı/kapandı - liste canlı
                // güncellensin (yalnızca sekme açık ve bağlıysa).
                if (typeof acCanliGuncelle === 'function') acCanliGuncelle(msg);
            } else if (msg.type === 'yoklama-katilim') {
                // Baska bir panel kullanicisi katildi - sayac anlik guncellensin.
                loadKatilim();
            } else if (msg.type === 'prime') {
                // Zamanlanmis prime hatirlatmasi calisti - Ayarlar acikken gorunsun.
                loadPrime();
            } else if (msg.type === 'oto-yoklama') {
                // Zamanlanmis yoklama calisti - Ayarlar acikken sonucu hemen goster.
                loadOtoYoklama();
            }
            // "Yoklamayı Al" uygulanırken ilerleme önizleme penceresinde de görünsün.
            if (msg.type === 'yoklama-toplu-uyari-ilerleme' && previewModal.style.display !== 'none') {
                previewProgress.textContent = `Uyarı veriliyor: ${msg.current}/${msg.total}`;
            }
        } catch (error) {
            // yoksay
        }
    });
    ws.addEventListener('close', () => {
        ws = null;
        // Oturum hâlâ geçerliyse birkaç saniye sonra tekrar dene.
        setTimeout(() => { if (appWrap.style.display !== 'none') connectWebSocket(); }, 3000);
    });
}

function applyStatus(status) {
    statusDot.classList.remove('warn', 'ok', 'danger');
    if (status.state === 'bağlı') {
        statusDot.classList.add('ok');
        statusText.textContent = status.detail || 'Bağlı';
    } else if (status.state === 'hata') {
        statusDot.classList.add('danger');
        statusText.textContent = status.detail || 'Bağlantı hatası';
    } else {
        statusDot.classList.add('warn');
        statusText.textContent = status.detail || 'Bağlanıyor...';
    }
}

// Üye listesi arka planda çekiliyor. Hazır değilken taramanın uzun süreceğini
// önceden söylüyoruz - buton donmuş gibi görünmesin.
function uyeDurumGoster(durum) {
    if (durum.status === 'yukleniyor') {
        scanStatus.textContent = 'Üye listesi hazırlanıyor... (ilk taramadan önce bitmesi beklenir)';
    } else if (durum.status === 'hazir' && !lastResults.length) {
        const sn = durum.ms ? ` (${(durum.ms / 1000).toFixed(0)} sn)` : '';
        scanStatus.textContent = `Üye listesi hazır: ${durum.count} üye${sn}. Taramayı başlatabilirsin.`;
    } else if (durum.status === 'hata') {
        scanStatus.textContent = 'Üye listesi alınamadı - Discord bağlantısını kontrol et.';
    }
}

// --- YOKLAMA TARAMASI ---
let lastResults = [];
let currentSearch = '';
let currentFilter = 'all';

function formatDate(ts) {
    if (!ts) return '';
    return new Date(ts).toLocaleString('tr-TR');
}

function renderReactions(reactions) {
    if (!reactions || reactions.length === 0) return '<span class="pill muted">Tepki yok</span>';
    return reactions.map((r) => `<span class="pill">${escapeHtml(r.emoji)} ${r.count}</span>`).join('');
}

function tierLevelOf(label) {
    const ladder = ['Sözlü Uyarı', '1x', '2x', '3x'];
    const idx = ladder.indexOf(label);
    return idx >= 0 ? idx + 1 : 0;
}

const selectedIds = new Set();
const roleMsgState = new Map(); // memberId -> { html, className } - filtre/arama yeniden çizince kaybolmasın

function roleButtonLabel(member) {
    return member.isMaxTier ? `${member.currentTierLabel} (Maks)` : `${member.nextTierLabel} Ver`;
}

function setRoleMsg(memberId, html, className) {
    roleMsgState.set(memberId, { html, className: className || '' });
    const msgEl = listEl.querySelector(`.roleMsg[data-id="${memberId}"]`);
    if (msgEl) {
        msgEl.innerHTML = html;
        msgEl.className = `roleMsg ${className || ''}`.trim();
    }
}

function updateSelectedCount() {
    selectedCountEl.textContent = `${selectedIds.size} kişi seçili`;
    bulkWarnBtn.disabled = selectedIds.size === 0 || !bulkReasonEl.value.trim();
    bulkUndoBtn.disabled = selectedIds.size === 0;
}

function renderRow(member) {
    const row = document.createElement('div');
    row.className = `row ${member.inVoice ? 'status-in' : 'status-out'}${selectedIds.has(member.id) ? ' selected' : ''}`;
    row.dataset.id = member.id;
    const voiceClass = member.inVoice ? 'in' : 'out';
    const voiceLabel = member.inVoice ? 'Sesde ✅' : 'Sesde Değil ❌';

    const longExcuseHtml = member.longExcuseText
        ? `<div class="excuse-block">
            <div class="excuse-label muted">Uzun Mazeret (7g)</div>
            <div class="excuse">${escapeHtml(member.longExcuseText)}</div>
            <div class="reactions">${renderReactions(member.longExcuseReactions)}</div>
        </div>` : '';
    const excuseHtml = member.inVoice ? '' : `
        <div class="excuse-block">
            <div class="excuse-label muted">Günlük Mazeret</div>
            <div class="excuse">${member.excuseText ? escapeHtml(member.excuseText) : '<span class="muted">Yok</span>'}</div>
            <div class="reactions">${renderReactions(member.excuseReactions)}</div>
        </div>
        ${longExcuseHtml}`;

    row.innerHTML = `
        <span class="voiceDot ${voiceClass}"></span>
        <img class="avatar" src="${member.avatarURL}" alt="">
        <div class="info">
            <div class="name">${escapeHtml(member.displayName)} <span class="tag">${escapeHtml(member.tag)}</span></div>
            <div class="voiceLabel ${voiceClass}">${voiceLabel}</div>
            ${excuseHtml}
            <div class="tier" data-tier-level="${tierLevelOf(member.currentTierLabel)}">
                <span class="tier-static-label">Kademe:</span>
                <span class="tier-badge">${escapeHtml(member.currentTierLabel || 'Yok')}</span>
            </div>
        </div>
        <div class="action">
            <div class="selectBtns">
                <button class="small selBtn selPlus${selectedIds.has(member.id) ? ' active' : ''}" data-id="${member.id}" title="Toplu uyarı için seç">+</button>
                <button class="small selBtn selMinus" data-id="${member.id}" title="Seçimden çıkar">-</button>
            </div>
            <button class="roleBtn small" data-id="${member.id}">${roleButtonLabel(member)}</button>
            <button class="secondary small" data-id="${member.id}" data-undo-btn>Geri Al</button>
            <div class="roleMsg" data-id="${member.id}"></div>
        </div>
    `;

    const savedMsg = roleMsgState.get(member.id);
    if (savedMsg) {
        const msgEl = row.querySelector('.roleMsg');
        msgEl.innerHTML = savedMsg.html;
        msgEl.className = `roleMsg ${savedMsg.className}`.trim();
    }

    return row;
}

function getFilteredMembers() {
    const term = currentSearch.trim().toLocaleLowerCase('tr');
    return lastResults.filter((member) => {
        if (currentFilter === 'in' && !member.inVoice) return false;
        if (currentFilter === 'out' && member.inVoice) return false;
        if (!term) return true;
        return member.displayName.toLocaleLowerCase('tr').includes(term)
            || member.tag.toLocaleLowerCase('tr').includes(term);
    });
}

function applyFilters() {
    listEl.innerHTML = '';
    if (lastResults.length === 0) {
        emptyState.textContent = 'Kontrol edilecek rollerde kimse bulunamadı.';
        // 'block' DEGIL: satir ici stil, .empty-hint'in flex ortalamasini
        // ezip metni kutunun tepesine yapistiriyordu. Bos birakinca CSS'teki
        // kural gecerli oluyor.
        emptyState.style.display = '';
        return;
    }
    const filtered = getFilteredMembers();
    if (filtered.length === 0) {
        emptyState.textContent = 'Aramaya/filtreye uyan kimse yok.';
        emptyState.style.display = '';
        return;
    }
    emptyState.style.display = 'none';
    filtered.forEach((member) => listEl.appendChild(renderRow(member)));

    listEl.querySelectorAll('.roleBtn').forEach((btn) => btn.addEventListener('click', onRoleButtonClick));
    listEl.querySelectorAll('[data-undo-btn]').forEach((btn) => btn.addEventListener('click', onUndoButtonClick));
    listEl.querySelectorAll('.selPlus').forEach((btn) => btn.addEventListener('click', () => selectMember(btn.dataset.id)));
    listEl.querySelectorAll('.selMinus').forEach((btn) => btn.addEventListener('click', () => deselectMember(btn.dataset.id)));
    updateSelectedCount();
}

function selectMember(memberId) {
    selectedIds.add(memberId);
    const row = listEl.querySelector(`.row[data-id="${memberId}"]`);
    if (row) {
        row.classList.add('selected');
        const plusBtn = row.querySelector('.selPlus');
        if (plusBtn) plusBtn.classList.add('active');
    }
    updateSelectedCount();
}
function deselectMember(memberId) {
    selectedIds.delete(memberId);
    const row = listEl.querySelector(`.row[data-id="${memberId}"]`);
    if (row) {
        row.classList.remove('selected');
        const plusBtn = row.querySelector('.selPlus');
        if (plusBtn) plusBtn.classList.remove('active');
    }
    updateSelectedCount();
}

selectVisibleBtn.addEventListener('click', () => {
    getFilteredMembers().forEach((m) => selectMember(m.id));
});
clearSelectionBtn.addEventListener('click', () => {
    [...selectedIds].forEach((id) => deselectMember(id));
});
bulkReasonEl.addEventListener('input', updateSelectedCount);

async function onRoleButtonClick(evt) {
    const btn = evt.currentTarget;
    const memberId = btn.dataset.id;
    const member = lastResults.find((m) => m.id === memberId);

    let reason = null;
    if (member && !member.isMaxTier) {
        reason = window.prompt(`${member.displayName} kişisine "${member.nextTierLabel}" verilecek. Sebebini yaz:`, '');
        if (reason === null) return; // iptal
        if (!reason.trim()) { setRoleMsg(memberId, 'Sebep boş bırakılamaz.', 'error'); return; }
    }

    btn.disabled = true;
    setRoleMsg(memberId, 'Gönderiliyor...', '');
    try {
        const res = await fetch('/api/yoklama/rol-ver', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ memberId, reason }),
        });
        const result = await okuJson(res);
        if (!result.ok) {
            const text = result.reason === 'max' ? 'Zaten en üst kademede.'
                : result.reason === 'dogrulanamadi' ? `⚠ ${result.error}`
                : `Hata: ${result.error || 'bilinmeyen hata'}`;
            setRoleMsg(memberId, escapeHtml(text), 'error');
            return;
        }
        setRoleMsg(memberId, `"${escapeHtml(result.givenLabel)}" verildi.`, 'ok');
    } catch (error) {
        setRoleMsg(memberId, escapeHtml(`Hata: ${error.message}`), 'error');
    } finally {
        btn.disabled = false;
    }
}

async function onUndoButtonClick(evt) {
    const btn = evt.currentTarget;
    const memberId = btn.dataset.id;
    btn.disabled = true;
    setRoleMsg(memberId, 'Geri alınıyor...', '');
    try {
        const res = await fetch('/api/yoklama/rol-geri-al', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ memberId }),
        });
        const result = await okuJson(res);
        if (!result.ok) {
            setRoleMsg(memberId, escapeHtml(`Hata: ${result.error || 'bilinmeyen hata'}`), 'error');
            return;
        }
        setRoleMsg(memberId, `"${escapeHtml(result.removedLabel)}" geri alındı.`, 'ok');
    } catch (error) {
        setRoleMsg(memberId, escapeHtml(`Hata: ${error.message}`), 'error');
    } finally {
        btn.disabled = false;
    }
}

bulkWarnBtn.addEventListener('click', async () => {
    const reason = bulkReasonEl.value.trim();
    if (!reason || selectedIds.size === 0) return;
    bulkWarnBtn.disabled = true;
    bulkProgress.textContent = 'Başlıyor...';
    try {
        const res = await fetch('/api/yoklama/toplu-uyari-ver', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ memberIds: [...selectedIds], reason }),
        });
        const result = await okuJson(res);
        if (!result.ok && result.error) {
            bulkProgress.textContent = `Hata: ${result.error}`;
            return;
        }
        bulkProgress.innerHTML = `Tamamlandı: ${result.warned.length} kişiye verildi, `
            + `${result.skipped.length} atlandı (maks kademe), `
            + `<b${result.failed.length ? ' style="color:var(--accent)"' : ''}>${result.failed.length} hata</b>.`
            + (result.failed.length
                ? `<br><span style="color:var(--attn)">${escapeHtml(result.failed[0].error || '')}</span>`
                : '');
        [...selectedIds].forEach((id) => deselectMember(id));
        bulkReasonEl.value = '';
    } catch (error) {
        bulkProgress.textContent = `Hata: ${error.message}`;
    } finally {
        updateSelectedCount();
    }
});

bulkUndoBtn.addEventListener('click', async () => {
    if (selectedIds.size === 0) return;
    bulkUndoBtn.disabled = true;
    bulkProgress.textContent = 'Başlıyor...';
    try {
        const res = await fetch('/api/yoklama/toplu-rol-geri-al', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ memberIds: [...selectedIds] }),
        });
        const result = await okuJson(res);
        if (!result.ok && result.error) {
            bulkProgress.textContent = `Hata: ${result.error}`;
            return;
        }
        bulkProgress.textContent = `Tamamlandı: ${result.removed.length} geri alındı, ${result.skipped.length} atlandı (kayıt yok), ${result.failed.length} hata.`;
        [...selectedIds].forEach((id) => deselectMember(id));
    } catch (error) {
        bulkProgress.textContent = `Hata: ${error.message}`;
    } finally {
        updateSelectedCount();
    }
});

emergencyBtn.addEventListener('click', async () => {
    emergencyBtn.disabled = true;
    emergencyStatus.textContent = 'Başlıyor...';
    try {
        const res = await fetch('/api/yoklama/acil-toplanti', { method: 'POST' });
        const result = await okuJson(res);
        if (!result.ok) {
            emergencyStatus.textContent = `Hata: ${result.error}`;
            return;
        }
        emergencyStatus.textContent = `${result.data.moved.length} kişi çekildi, ${result.data.failed.length} taşınamadı.`;
    } catch (error) {
        emergencyStatus.textContent = `Hata: ${error.message}`;
    } finally {
        emergencyBtn.disabled = false;
    }
});

function renderResults(data) {
    lastResults = data.members;
    copyReportBtn.disabled = data.members.length === 0;
    // Ozet sayilar: grafik degil, KPI kutucuklari - uc basligin isi tek bir
    // sayiyi okutmak. Renkler durum paleti (yesil "sesde", amber "sesde
    // degil"), her biri yazili etiketiyle birlikte.
    kpiChecked.textContent = data.totalChecked;
    kpiInVoice.textContent = data.totalInVoice;
    kpiOut.textContent = data.totalChecked - data.totalInVoice;
    kpiRow.style.display = 'flex';
    applyFilters();
}

searchInput.addEventListener('input', () => {
    currentSearch = searchInput.value;
    applyFilters();
});
filterChips.forEach((chip) => {
    chip.addEventListener('click', () => {
        filterChips.forEach((c) => c.classList.remove('active'));
        chip.classList.add('active');
        currentFilter = chip.dataset.filter;
        applyFilters();
    });
});

scanBtn.addEventListener('click', async () => {
    hideError();
    scanBtn.disabled = true;
    scanBtn.textContent = 'Taranıyor...';
    scanStatus.textContent = 'Tarama başlatıldı...';
    try {
        const res = await fetch('/api/yoklama/tara', { method: 'POST' });
        const result = await okuJson(res);
        if (res.status === 401) { showLogin(); return; }
        if (!result.ok) {
            showError(`Tarama başarısız: ${result.error}`);
            return;
        }
        const sr = result.data.timings;
        scanStatus.textContent = `Son tarama: ${formatDate(result.data.scannedAt)}`
            + (sr ? ` · ${(sr.toplam / 1000).toFixed(1)} sn (üyeler ${(sr.uyeler / 1000).toFixed(1)} sn, mazeretler ${(sr.mazeretler / 1000).toFixed(1)} sn)` : '');
        renderResults(result.data);
    } catch (error) {
        showError(`Tarama sırasında beklenmeyen hata: ${error.message}`);
    } finally {
        scanBtn.disabled = false;
        scanBtn.textContent = 'Taramayı Başlat';
    }
});


// ============================================================================
// --- KENAR CUBUGU: CANLI "SU AN SESTE" OZETI ---
// Bos duran alani dolduruyor ve sekmeye girmeden kac kisinin seste oldugunu
// gosteriyor. Aktiflik yetkisi olmayan hesapta uc 403 donuyor - kart o zaman
// gizli kaliyor, hata yazmiyor.
// ============================================================================
const sideCanli = document.getElementById('sideCanli');
let sideCanliTimer = null;

async function sideCanliTazele() {
    if (!sideCanli) return;
    try {
        const res = await fetch('/api/aktiflik');
        if (res.status === 403 || res.status === 401) {
            sideCanli.style.display = 'none';
            if (sideCanliTimer) { clearInterval(sideCanliTimer); sideCanliTimer = null; }
            return;
        }
        const d = await res.json();
        if (!d.ok) { sideCanli.style.display = 'none'; return; }
        document.getElementById('sideSeste').textContent = d.inVoiceCount;
        document.getElementById('sideToplam').textContent = `/ ${d.members.length} yetkili`;
        const sure = typeof sureBicimle === 'function' ? sureBicimle(d.totalSeconds) : '';
        document.getElementById('sideCanliAlt').textContent = sure && sure !== '—'
            ? `bugün toplam ${sure}`
            : 'bugün henüz ses kaydı yok';
        sideCanli.style.display = 'flex';
    } catch (error) {
        sideCanli.style.display = 'none';
    }
}

if (sideCanli) {
    sideCanli.addEventListener('click', () => {
        const btn = document.querySelector('.side-nav .tab-btn[data-tab="aktiflik"]');
        if (btn) btn.click();
    });
    // 45 sn: ses sayaci zaten 30 sn'de bir isliyor, daha sik sormanin karsiligi yok.
    sideCanliTimer = setInterval(() => {
        if (appWrap.style.display !== 'none') sideCanliTazele();
    }, 45000);
}

// ============================================================================
// --- GÜNLÜK SÜTUN GRAFİĞİ ---
// Aktiflik ve Etkinlik sekmelerinin ikisi de aynı biçimde veri döndürüyor
// (availableDays: [{day, total}]), farkları yalnızca birim: biri mesaj sayısı,
// biri saniye. O yüzden tek bir çizici ikisine de hizmet ediyor; birimi
// çağıran veriyor.
//
// TEK SERİ olduğu için gösterge kutusu yok - başlık zaten neyin çizildiğini
// söylüyor. Renk sekans işi: tek renk (marka aksanı), "daha çok = daha koyu"
// değil "daha çok = daha uzun" ile okunuyor.
//
// Ölçüler bilerek sabit: sütun en fazla 24px, üstü 4px yuvarlak, tabanı düz,
// sütunlar arasında 2px yüzey boşluğu, ızgara çizgisi 1px ve geride. Değer
// SADECE en yüksek sütunun üstünde yazıyor - her sütuna sayı yazmak okunmaz
// bir kalabalık yaratıyor, gerisini ipucu balonu taşıyor.
// ============================================================================
const GRAFIK_YUKSEKLIK = 132;   // çizim alanı (eksen yazısı hariç)
const GRAFIK_SUTUN_MAKS = 24;
const GRAFIK_BOSLUK = 2;

function gunEtiketi(gun) {
    // 2026-08-26 -> 26.08
    const p = String(gun).split('-');
    return p.length === 3 ? `${p[2]}.${p[1]}` : gun;
}

function gunlukGrafikCiz(kap, gunler, bicimle) {
    if (!kap) return false;
    // Uç son 14 günü YENİDEN ESKİYE döndürüyor; grafikte zaman soldan sağa
    // aktığı için ters çeviriyoruz.
    const veri = (gunler || []).slice().reverse();
    if (veri.length === 0) { kap.innerHTML = ''; return false; }

    const enYuksek = Math.max(...veri.map((g) => g.total), 0);
    if (enYuksek === 0) {
        kap.innerHTML = '<div class="grafik-bos">Bu aralıkta kayıt yok.</div>';
        return true;
    }
    const enYuksekIndeks = veri.findIndex((g) => g.total === enYuksek);
    const cizimYuksekligi = GRAFIK_YUKSEKLIK - 20;   // tepe etiketine yer

    // Yerleşim FLEX. Önceki hâli sütunları yüzdeyle konumlandırıp piksel
    // boşluk ekliyordu; iki birim karışınca sütunlar kıl gibi inceliyordu.
    // Flex'te her günün kendi eşit hücresi var, sütun hücrenin ortasında ve
    // 24px'de kapanıyor - artan yer bilerek boşluk kalıyor.
    const sutunlar = veri.map((g, i) => {
        const yukseklik = g.total > 0
            ? Math.max((g.total / enYuksek) * cizimYuksekligi, 3)
            : 0;
        const tepe = i === enYuksekIndeks
            ? `<span class="grafik-tepe">${escapeHtml(bicimle(g.total))}</span>`
            : '';
        return `<div class="grafik-sutun${i === enYuksekIndeks ? ' en-yuksek' : ''}"
            data-gun="${escapeHtml(g.day)}" data-deger="${escapeHtml(bicimle(g.total))}"
            tabindex="0" role="img"
            aria-label="${escapeHtml(gunEtiketi(g.day))}: ${escapeHtml(bicimle(g.total))}">
            ${tepe}<span class="gs-dolgu" style="height:${yukseklik.toFixed(1)}px;"></span>
        </div>`;
    }).join('');

    // 14 gün için her etiketi yazmak sıkışıyor - birer atlanıyor.
    const eksen = veri.map((g, i) => {
        const goster = veri.length <= 8 || i % 2 === 1 || i === veri.length - 1;
        return `<span class="grafik-eksen-gun">${goster ? escapeHtml(gunEtiketi(g.day)) : ''}</span>`;
    }).join('');

    kap.innerHTML = `
        <div class="grafik-alan" style="height:${GRAFIK_YUKSEKLIK}px;">
            <span class="grafik-izgara" style="bottom:${cizimYuksekligi}px;"></span>
            <span class="grafik-izgara" style="bottom:${cizimYuksekligi / 2}px;"></span>
            <span class="grafik-taban"></span>
            <div class="grafik-sutunlar">${sutunlar}</div>
        </div>
        <div class="grafik-eksen">${eksen}</div>
        <div class="grafik-ipucu" hidden></div>`;

    // İpucu: sütun ince olduğu için isabet alanı sütunun kendisi değil, onu
    // saran tam yükseklikteki hücre - 3px'lik bir çubuğu yakalamaya çalışmak
    // sinir bozucu olurdu.
    const ipucu = kap.querySelector('.grafik-ipucu');
    kap.querySelectorAll('.grafik-sutun').forEach((sutun) => {
        const goster = () => {
            ipucu.textContent = `${gunEtiketi(sutun.dataset.gun)} · ${sutun.dataset.deger}`;
            ipucu.hidden = false;
            const kapGen = kap.getBoundingClientRect().width;
            const x = sutun.offsetLeft + sutun.offsetWidth / 2;
            ipucu.style.left = `${Math.min(Math.max(x, 52), kapGen - 52)}px`;
        };
        const gizle = () => { ipucu.hidden = true; };
        sutun.addEventListener('mouseenter', goster);
        sutun.addEventListener('focus', goster);
        sutun.addEventListener('mouseleave', gizle);
        sutun.addEventListener('blur', gizle);
    });
    return true;
}

// ============================================================================
// --- SEKMELER ---
// ============================================================================
// Her sekmenin basligi ve bir cumlelik ne ise yaradigi. Baslik HTML'de 10 kez
// tekrarlanmiyor, buradan suruluyor - yeni sekme eklemek bir satir.
const SEKME_BASLIKLARI = {
    yoklama:      ['i-yoklama',      'Yoklama',        'Yetkili taraması, uyarı merdiveni ve acil toplantı.'],
    yetkililer:   ['i-yetkililer',   'Yetkililer',     'Rol bazlı yetkili listesi ve satır içi rol işlemleri.'],
    roller:       ['i-roller',       'Rol Ver / Al',   'Seçtiğin kişiye rol ver ya da geri al.'],
    aktiflik:     ['i-aktiflik',     'Aktiflik',       'Kim ne kadar süre seste kaldı, gün gün.'],
    etkinlik:     ['i-etkinlik',     'Etkinlik',       'Kanal bazlı mesaj sayıları ve ticket sahiplenme.'],
    loglar:       ['i-loglar',       'TX Logs',        'Ban, unban, kick, warn, DM ve diğer log kanalları.'],
    mutelog:      ['i-mutelog',      'Mute Logları',   'Mute ve unmute kayıtları.'],
    felox:        ['i-felox',        'Felox',          'Felox kayıtları ve şüpheli log incelemesi.'],
    ticketmesaj:  ['i-ticketmesaj',  'Nexora Panel',   'Kategorideki ticket\'ları canlı gör, seçip Nexora at.'],
    hesaploglari: ['i-hesaploglari', 'Hesap Logları',  'Panelde kim ne yaptı.'],
    ayarlar:      ['i-ayarlar',      'Ayarlar',        'Otomatik yoklama, rol botu, ticket mesajı ve panel hesapları.'],
};

const sayfaIkon = document.getElementById('sayfaIkon');
const sayfaAd = document.getElementById('sayfaAd');
const sayfaAciklama = document.getElementById('sayfaAciklama');

function sayfaBasliginiAyarla(sekme) {
    const b = SEKME_BASLIKLARI[sekme];
    if (!b) return;
    sayfaIkon.innerHTML = `<svg><use href="#${b[0]}"/></svg>`;
    sayfaAd.textContent = b[1];
    sayfaAciklama.textContent = b[2];
}
sayfaBasliginiAyarla('yoklama');

const tabButtons = document.querySelectorAll('.tab-btn');
tabButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
        tabButtons.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        document.querySelectorAll('.tab-panel').forEach((panel) => panel.classList.remove('active'));
        document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
        sayfaBasliginiAyarla(btn.dataset.tab);
        if (btn.dataset.tab === 'yoklama') loadKatilim();
        if (btn.dataset.tab === 'loglar') txLogTab.refreshMenu();
        if (btn.dataset.tab === 'mutelog') muteLogTab.refreshMenu();
        if (btn.dataset.tab === 'felox') feloxLogTab.refreshMenu();
        if (btn.dataset.tab === 'ticketmesaj') acDurumYukle();
        if (btn.dataset.tab === 'ayarlar') {
            if (currentIsAdmin) refreshAccounts();
            loadTicketAuto(); loadRolKomutlari(false); loadOtoYoklama(); loadPrime();
        }
        if (btn.dataset.tab === 'yetkililer') initStaffTab();
        if (btn.dataset.tab === 'roller') loadGuildRoles().then(renderRoleList);
        if (btn.dataset.tab === 'hesaploglari') { auditOffset = 0; loadAudit(); }
        if (btn.dataset.tab === 'etkinlik') initActivityTab();
        if (btn.dataset.tab === 'aktiflik') initPresenceTab(); else stopPresenceTimer();
    });
});

// ============================================================================
// --- LOG SEKMELERI (TX Logs + Mute Logları) ---
// Iki sekme de ayni islevi goruyor; tek fark hangi kanal grubunu listeledikleri.
// Ayni kodu ikinci kez yazmak yerine fabrika: her sekme kendi DOM'unu ve kendi
// sayfa/arama durumunu tutuyor, sunucudan grubuna ait kanallari cekiyor.
// ============================================================================
const LOG_PAGE_SIZE = 100;

function statusLabel(channel) {
    if (!channel.configured) return 'ID yok';
    if (channel.status === 'yukleniyor') return `${channel.loaded}...`;
    if (channel.status === 'hata') return 'hata';
    if (channel.status === 'bekliyor') return 'bekliyor';
    return String(channel.loaded);
}

// Discord mesajlari markdown iceriyor (**kalin**, *egik*, `kod`, ~~ustu cizili~~).
// Ham haliyle basinca log satirlarinda yildizlar gorunuyordu. Once HTML kacisi
// yapiliyor, SONRA markdown uygulaniyor - sira onemli, tersi XSS acardi.
function renderDiscordMarkdown(text) {
    let out = escapeHtml(text);
    out = out.replace(/```([\s\S]*?)```/g, (m, kod) => `<code class="md-block">${kod.trim()}</code>`);
    out = out.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    out = out.replace(/\*\*\*([^*\n]+)\*\*\*/g, '<b><i>$1</i></b>');
    out = out.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
    out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>');
    out = out.replace(/__([^_\n]+)__/g, '<u>$1</u>');
    out = out.replace(/~~([^~\n]+)~~/g, '<s>$1</s>');
    out = out.replace(/&lt;@!?(\d+)&gt;/g, '<span class="md-mention">@$1</span>');
    out = out.replace(/&lt;@&amp;(\d+)&gt;/g, '<span class="md-mention">@rol</span>');
    out = out.replace(/&lt;#(\d+)&gt;/g, '<span class="md-mention">#kanal</span>');
    out = out.replace(/\n/g, '<br>');
    return out;
}

function renderEmbed(embed) {
    // Alanlar eskiden alt alta iki satir kapliyordu (ad, sonra deger); yan yana
    // tek satira alindi - 180 mesajlik bir logda ekrana sigan satir sayisi
    // bunu dogrudan belirliyor.
    const fields = embed.fields.length
        ? `<div class="embed-fields">${embed.fields
            .map((f) => `<span class="embed-field"><b>${escapeHtml(f.name)}:</b> ${renderDiscordMarkdown(f.value)}</span>`)
            .join('')}</div>`
        : '';
    return `<div class="log-embed">
        ${embed.title ? `<div class="embed-title">${escapeHtml(embed.title)}</div>` : ''}
        ${embed.description ? `<div class="embed-desc">${renderDiscordMarkdown(embed.description)}</div>` : ''}
        ${fields}
    </div>`;
}

function renderLogEntry(entry) {
    const embeds = entry.embeds.map(renderEmbed).join('');
    const attachments = entry.attachments.length
        ? `<div class="log-attach">${entry.attachments
            .map((a) => `<a href="${encodeURI(a.url)}" target="_blank" rel="noopener noreferrer">📎 ${escapeHtml(a.name)}</a>`)
            .join(' · ')}</div>`
        : '';
    const div = document.createElement('div');
    div.className = 'log-entry';
    div.innerHTML = `
        ${entry.authorAvatar ? `<img class="log-avatar" src="${encodeURI(entry.authorAvatar)}" alt="">` : '<div class="log-avatar"></div>'}
        <div class="log-body">
            <div class="log-meta">
                <span class="log-author">${escapeHtml(entry.authorTag)}</span>
                <span class="log-time">${formatDate(entry.createdTimestamp)}</span>
            </div>
            ${entry.content ? `<div class="log-content">${renderDiscordMarkdown(entry.content)}</div>` : ''}
            ${embeds}
            ${attachments}
        </div>`;
    return div;
}


function createLogTab({ grup, menuId, listId, titleId, statusId, searchId, refreshId,
    pagerId, pageInfoId, prevId, nextId }) {
    const menu = document.getElementById(menuId);
    const list = document.getElementById(listId);
    const title = document.getElementById(titleId);
    const status = document.getElementById(statusId);
    const search = document.getElementById(searchId);
    const refreshBtn = document.getElementById(refreshId);
    const pager = document.getElementById(pagerId);
    const pageInfo = document.getElementById(pageInfoId);
    const prevBtn = document.getElementById(prevId);
    const nextBtn = document.getElementById(nextId);

    let channels = [];
    let activeKey = null;
    let offset = 0;
    let term = '';
    let searchTimer = null;

    // --- İşaretleme (yalnızca isaretTakibi açık kanallarda) ---
    // Bayrak kapalıyken bu satırların hiçbiri devreye girmiyor, yani TX Logs
    // ve Mute Logları sekmeleri aynen eskisi gibi çalışıyor.
    const ISARETLER = [
        { key: 'ban',      etiket: 'Ban' },
        { key: 'supheli',  etiket: 'Şüpheli' },
        { key: 'temiz',    etiket: 'Temiz' },
    ];
    let isaretTakibi = false;
    let isaretSuzgeci = '';      // '' = hepsi
    let isaretSayilari = null;

    // Süzgeç satırı HTML'de değil, burada üretiliyor: üç log sekmesi aynı
    // işaretlemeyi kullanmıyor ve kullanmayanların DOM'una boş bir satır
    // eklemek istemiyoruz.
    const suzgecSatiri = document.createElement('div');
    suzgecSatiri.className = 'toolbar isaret-suzgec';
    suzgecSatiri.style.display = 'none';
    list.parentNode.insertBefore(suzgecSatiri, list);

    function renderSuzgec() {
        if (!isaretTakibi) { suzgecSatiri.style.display = 'none'; return; }
        const say = isaretSayilari || {};
        const kutular = [{ key: '', etiket: 'Hepsi' }, { key: 'isaretsiz', etiket: 'İşaretsiz' }]
            .concat(ISARETLER);
        suzgecSatiri.innerHTML = '<div class="filter-chips">'
            + kutular.map((k) => {
                const adet = k.key === '' ? null : (say[k.key] ?? 0);
                return `<button class="chip${k.key === isaretSuzgeci ? ' active' : ''}"`
                    + ` data-suzgec="${k.key}">${escapeHtml(k.etiket)}`
                    + (adet === null ? '' : ` <b>${adet}</b>`) + '</button>';
            }).join('')
            + '</div>';
        suzgecSatiri.querySelectorAll('[data-suzgec]').forEach((btn) => {
            btn.addEventListener('click', () => {
                isaretSuzgeci = btn.dataset.suzgec;
                offset = 0;
                loadPage();
            });
        });
        suzgecSatiri.style.display = 'flex';
    }

    // Bir log satırını, altında Ban/Şüpheli/Temiz düğmeleriyle sarar.
    // Düğmeler Discord'a hiçbir şey göndermez - işaret yalnızca panelde durur.
    function isaretliSatir(entry) {
        const kutu = document.createElement('div');
        kutu.className = 'isaret-kutu';
        kutu.dataset.id = entry.id;
        kutu.appendChild(renderLogEntry(entry));

        const bar = document.createElement('div');
        bar.className = 'isaret-bar';
        ISARETLER.forEach((i) => {
            const btn = document.createElement('button');
            btn.className = `isaret-btn is-${i.key}`;
            btn.dataset.isaret = i.key;
            btn.textContent = i.etiket;
            btn.addEventListener('click', () => isaretle(entry.id, i.key, kutu));
            bar.appendChild(btn);
        });
        const bilgi = document.createElement('span');
        bilgi.className = 'isaret-bilgi';
        bar.appendChild(bilgi);
        kutu.appendChild(bar);

        isaretiUygula(kutu, entry.isaret);
        return kutu;
    }

    // Kutunun görünümünü işarete göre günceller. Tek yerden yapılıyor ki
    // tıklama, WebSocket ve ilk çizim aynı sonucu versin.
    function isaretiUygula(kutu, isaret) {
        ISARETLER.forEach((i) => {
            const btn = kutu.querySelector(`[data-isaret="${i.key}"]`);
            if (btn) btn.classList.toggle('secili', Boolean(isaret) && isaret.isaret === i.key);
        });
        kutu.className = 'isaret-kutu' + (isaret ? ` isaretli-${isaret.isaret}` : '');
        const bilgi = kutu.querySelector('.isaret-bilgi');
        if (bilgi) {
            bilgi.textContent = isaret
                ? `${isaret.kisi} · ${formatDate(isaret.at)}`
                : '';
        }
    }

    // Aynı düğmeye ikinci kez basmak işareti KALDIRIR - yanlış tıklamayı geri
    // almanın en kısa yolu. Sunucu son sözü söylüyor: ekran, sunucunun
    // döndürdüğü değere göre güncelleniyor.
    async function isaretle(id, isaret, kutu) {
        const suanki = kutu.className.match(/isaretli-(\w+)/);
        const yeniIsaret = (suanki && suanki[1] === isaret) ? null : isaret;
        try {
            const res = await fetch(`/api/loglar/${activeKey}/isaret`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id, isaret: yeniIsaret }),
            });
            if (res.status === 401) { showLogin(); return; }
            const d = await okuJson(res);
            if (!d.ok) { status.textContent = `İşaretlenemedi: ${d.error}`; return; }
            isaretiUygula(kutu, d.isaret);
            // Sayaçlar değişti; süzgeç açıksa satır listeden düşebilir.
            if (isaretSuzgeci) loadPage(); else tazeleSayaclar();
        } catch (error) {
            status.textContent = `İşaretlenemedi: ${error.message}`;
        }
    }

    // Yalnızca sayaçları tazelemek için hafif bir istek - listeyi yeniden
    // çizmiyoruz ki kullanıcının kaydırma yeri kaybolmasın.
    async function tazeleSayaclar() {
        try {
            const res = await fetch(`/api/loglar/${activeKey}?offset=0&limit=1`);
            const d = await okuJson(res);
            if (d.ok && d.isaretSayilari) { isaretSayilari = d.isaretSayilari; renderSuzgec(); }
        } catch (error) { /* sayaç kozmetik - sessizce geç */ }
    }

    function renderMenu() {
        menu.innerHTML = '';
        channels.forEach((channel) => {
            const btn = document.createElement('button');
            let cls = 'log-menu-item';
            if (channel.key === activeKey) cls += ' active';
            if (!channel.configured) cls += ' missing';
            else if (channel.status === 'yukleniyor' || channel.status === 'bekliyor') cls += ' pending';
            btn.className = cls;
            btn.innerHTML = `<span>${escapeHtml(channel.label)}</span><span class="count">${escapeHtml(statusLabel(channel))}</span>`;
            btn.title = channel.configured
                ? `${channel.label} - ${channel.loaded} mesaj`
                  + (channel.ilkCekimSiniri ? ` (geçmişten son ${channel.ilkCekimSiniri} mesaj)` : '')
                : `${channel.label} için kanal ID'si girilmemiş (server.js içindeki LOG_CHANNELS)`;
            btn.addEventListener('click', () => select(channel.key));
            menu.appendChild(btn);
        });
    }

    async function refreshMenu() {
        try {
            const res = await fetch(`/api/loglar?grup=${encodeURIComponent(grup)}`);
            if (res.status === 401) { showLogin(); return; }
            const data = await okuJson(res);
            if (!data.ok) return;
            channels = data.channels;
            renderMenu();
        } catch (error) {
            // sessizce geç - WebSocket'ten gelen durum güncellemeleri menüyü zaten tazeleyecek
        }
    }

    function select(key) {
        activeKey = key;
        offset = 0;
        term = '';
        search.value = '';
        // Süzgeç kanala ait: başka menüye geçince taşınmamalı, yoksa yeni
        // menü boş görünür ve sebebi görünmez.
        isaretSuzgeci = '';
        isaretTakibi = false;
        isaretSayilari = null;
        renderSuzgec();
        const channel = channels.find((c) => c.key === key);
        // Etiket zaten "Log" ile bitiyorsa tekrar ekleme - "Ek Log Logu" oluyordu.
        title.textContent = channel
            ? (/log(u|ları)?$/i.test(channel.label) ? channel.label : `${channel.label} Logu`)
            : key;
        search.disabled = false;
        refreshBtn.disabled = !(channel && channel.configured);
        renderMenu();
        loadPage();
    }

    async function loadPage() {
        if (!activeKey) return;
        list.innerHTML = '<div class="iskelet">' + '<div class="iskelet-satir"></div>'.repeat(6) + '</div>';
        try {
            const params = new URLSearchParams({ offset: String(offset), limit: String(LOG_PAGE_SIZE) });
            if (term) params.set('q', term);
            if (isaretSuzgeci) params.set('isaret', isaretSuzgeci);
            const res = await fetch(`/api/loglar/${activeKey}?${params.toString()}`);
            if (res.status === 401) { showLogin(); return; }
            const data = await okuJson(res);
            if (!data.ok) {
                list.innerHTML = `<div class="empty-hint">Hata: ${escapeHtml(data.error || 'bilinmeyen')}</div>`;
                return;
            }

            if (!data.configured) {
                list.innerHTML = '<div class="empty-hint">Bu menü için kanal ID\'si girilmemiş.<br>server.js içindeki <b>LOG_CHANNELS</b> listesine ID\'yi ekle.</div>';
                pager.style.display = 'none';
                status.textContent = '';
                isaretTakibi = false;
                renderSuzgec();
                return;
            }

            isaretTakibi = Boolean(data.isaretTakibi);
            isaretSayilari = data.isaretSayilari || null;
            renderSuzgec();
            if (data.status === 'yukleniyor' || data.status === 'bekliyor') {
                status.textContent = data.status === 'bekliyor'
                    ? 'Sıradaki kanal - geçmiş henüz çekilmedi.'
                    : 'Geçmiş çekiliyor...';
            } else if (data.status === 'hata') {
                status.textContent = `Hata: ${data.error || 'bilinmeyen'}`;
            } else {
                // Sinirli kanallarda "neden az mesaj var?" sorusu dogmasin.
                status.textContent = `${data.total} mesaj · son güncelleme ${formatDate(data.fetchedAt)}`
                    + (data.ilkCekimSiniri
                        ? ` · geçmişten son ${data.ilkCekimSiniri} mesaj çekiliyor, yenileri canlı ekleniyor`
                        : '');
            }

            list.innerHTML = '';
            if (data.messages.length === 0) {
                // Bos liste her zaman "mesaj yok" demek degil - kanalin gecmisi
                // henuz cekilmemis de olabilir; ikisini ayirt ediyoruz.
                let hint;
                if (isaretSuzgeci) hint = 'Bu işarete uyan kayıt yok.';
                else if (term) hint = 'Aramaya uyan mesaj yok.';
                else if (data.status === 'bekliyor') hint = 'Bu kanalın geçmişi henüz çekilmedi - sırada bekliyor.';
                else if (data.status === 'yukleniyor') hint = 'Geçmiş çekiliyor, birazdan burada görünecek...';
                else if (data.status === 'hata') hint = `Çekilemedi: ${escapeHtml(data.error || 'bilinmeyen hata')}`;
                else hint = 'Bu kanalda mesaj yok.';
                list.innerHTML = `<div class="empty-hint">${hint}</div>`;
                pager.style.display = 'none';
                return;
            }
            data.messages.forEach((entry) => list.appendChild(
                isaretTakibi ? isaretliSatir(entry) : renderLogEntry(entry)));
            list.scrollTop = 0;

            const from = data.offset + 1;
            const to = data.offset + data.messages.length;
            pageInfo.textContent = `${from}-${to} / ${data.matched}${term ? ` (toplam ${data.total})` : ''}`;
            prevBtn.disabled = data.offset === 0;
            nextBtn.disabled = to >= data.matched;
            pager.style.display = 'flex';
        } catch (error) {
            list.innerHTML = `<div class="empty-hint">Hata: ${escapeHtml(error.message)}</div>`;
        }
    }

    // WebSocket olaylari her iki sekmeye de geliyor; kendi grubunda olmayan
    // anahtari gorunce hicbir sey yapmiyor.
    function onStatus(msg) {
        const channel = channels.find((c) => c.key === msg.key);
        if (channel) {
            channel.status = msg.status;
            channel.loaded = msg.loaded;
            channel.error = msg.error;
            renderMenu();
        }
        if (msg.key !== activeKey) return;
        if (msg.status === 'yukleniyor') {
            status.textContent = `Geçmiş çekiliyor: ${msg.loaded} mesaj...`;
        } else if (msg.status === 'hazir') {
            status.textContent = `${msg.loaded} mesaj hazır.`;
            loadPage();
        } else if (msg.status === 'hata') {
            status.textContent = `Hata: ${msg.error || 'bilinmeyen'}`;
        }
    }

    // Başka bir panel kullanıcısı işaret koyduğunda/kaldırdığında ekrandaki
    // satır anında güncellensin. Sayfayı yeniden çizmiyoruz - sadece o kutu.
    function onIsaret(msg) {
        if (msg.key !== activeKey || !isaretTakibi) return;
        const kutu = list.querySelector(`.isaret-kutu[data-id="${msg.id}"]`);
        if (kutu) isaretiUygula(kutu, msg.isaret);
        tazeleSayaclar();
    }

    // Yeni bir log mesajı geldiğinde: ilk sayfadaysak ve arama yoksa listeyi tazele.
    function onNewMessage(msg) {
        const channel = channels.find((c) => c.key === msg.key);
        if (channel) { channel.loaded = msg.loaded; renderMenu(); }
        if (msg.key === activeKey && offset === 0 && !term) loadPage();
    }

    search.addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
            term = search.value.trim();
            offset = 0;
            loadPage();
        }, 250);
    });
    prevBtn.addEventListener('click', () => { offset = Math.max(0, offset - LOG_PAGE_SIZE); loadPage(); });
    nextBtn.addEventListener('click', () => { offset += LOG_PAGE_SIZE; loadPage(); });
    refreshBtn.addEventListener('click', async () => {
        if (!activeKey) return;
        refreshBtn.disabled = true;
        status.textContent = 'Yenileme başlatıldı...';
        try {
            await fetch(`/api/loglar/${activeKey}/yenile`, { method: 'POST' });
        } catch (error) {
            status.textContent = `Hata: ${error.message}`;
        } finally {
            refreshBtn.disabled = false;
        }
    });

    return { refreshMenu, onStatus, onNewMessage, onIsaret };
}

const txLogTab = createLogTab({
    grup: 'tx',
    menuId: 'logsMenu', listId: 'logsList', titleId: 'logTitle', statusId: 'logStatus',
    searchId: 'logSearch', refreshId: 'logRefreshBtn', pagerId: 'logPager',
    pageInfoId: 'logPageInfo', prevId: 'logPrevBtn', nextId: 'logNextBtn',
});
const muteLogTab = createLogTab({
    grup: 'mute',
    menuId: 'muteMenu', listId: 'muteList', titleId: 'muteTitle', statusId: 'muteStatus',
    searchId: 'muteSearch', refreshId: 'muteRefreshBtn', pagerId: 'mutePager',
    pageInfoId: 'mutePageInfo', prevId: 'mutePrevBtn', nextId: 'muteNextBtn',
});
const feloxLogTab = createLogTab({
    grup: 'felox',
    menuId: 'feloxMenu', listId: 'feloxList', titleId: 'feloxTitle', statusId: 'feloxStatus',
    searchId: 'feloxSearch', refreshId: 'feloxRefreshBtn', pagerId: 'feloxPager',
    pageInfoId: 'feloxPageInfo', prevId: 'feloxPrevBtn', nextId: 'feloxNextBtn',
});
const logTabs = [txLogTab, muteLogTab, feloxLogTab];

function refreshLogMenu() { logTabs.forEach((t) => t.refreshMenu()); }

function onLogStatusUpdate(msg) {
    // Etkinlik/ticket kanali hazir olunca acik olan Etkinlik sekmesini
    // kendiliginden tazele - kullanici "veri yok" ekranina bakip kalmasin.
    if (msg.key === actChannelKey && document.getElementById('tab-etkinlik').classList.contains('active')) {
        if (msg.status === 'hazir') {
            loadActivityReport();
        } else if (msg.status === 'yukleniyor') {
            activityStatus.textContent = `Geçmiş çekiliyor: ${msg.loaded} mesaj...`;
        }
    }
    logTabs.forEach((t) => t.onStatus(msg));
}

function onLogNewMessage(msg) {
    logTabs.forEach((t) => t.onNewMessage(msg));
}

// ============================================================================
// --- AYARLAR: panel hesapları ---
// ============================================================================
const accountList = document.getElementById('accountList');
const accountMsg = document.getElementById('accountMsg');
const addAccountMsg = document.getElementById('addAccountMsg');
const curPassword = document.getElementById('curPassword');
const newUsernameEl = document.getElementById('newUsername');
const newPasswordEl = document.getElementById('newPassword');
const addUsername = document.getElementById('addUsername');
const addPassword = document.getElementById('addPassword');

async function refreshAccounts() {
    try {
        const res = await fetch('/api/hesaplar');
        if (res.status === 401) { showLogin(); return; }
        const data = await okuJson(res);
        if (!data.ok) return;
        accountList.innerHTML = '';
        data.users.forEach((user) => {
            const row = document.createElement('div');
            row.className = 'account-row';
            row.innerHTML = `
                <span class="acc-name">${escapeHtml(user.username)}</span>
                ${user.discordId
                    ? `<span class="acc-badge" title="Bağlı Discord ID">🔗 ${escapeHtml(user.discordId)}</span>`
                    : '<span class="acc-badge" style="opacity:.6">Discord ID yok</span>'}
                ${user.isPrimary ? '<span class="acc-badge">Ana hesap</span>' : ''}
                ${user.isSelf ? '<span class="acc-badge">Sen</span>' : ''}
                ${user.admin
                    ? '<span class="acc-badge ok">Yönetici</span>'
                    : (user.tip === 'ac'
                        ? '<span class="acc-badge" style="color:var(--accent);border-color:var(--accent)" title="AC hesabı: girişte token kapısı, yalnızca Nexora Panel">AC</span>'
                        : `<span class="acc-badge" title="Görebildiği sekmeler">${user.sekmeler.length}/${IZIN_TOPLAM_SEKME} sekme · ${user.loglar.length} log</span>`)}
                <span class="acc-spacer"></span>
                ${user.isPrimary ? '' : `<button class="secondary small" data-izin="${escapeHtml(user.username)}">Yetkiler</button>`}
                <button class="secondary small" data-dcid="${escapeHtml(user.username)}"
                        data-dcidval="${escapeHtml(user.discordId || '')}"
                        title="Bu hesaba Discord ID bağla - 'Yoklamaya Katıl' için gerekli">Discord ID</button>
                <button class="secondary small" data-del="${escapeHtml(user.username)}">Sil</button>`;
            accountList.appendChild(row);
        });
        accountList.querySelectorAll('[data-del]').forEach((btn) => {
            btn.addEventListener('click', () => deleteAccount(btn.dataset.del));
        });
        accountList.querySelectorAll('[data-dcid]').forEach((btn) => {
            btn.addEventListener('click', () => setAccountDiscordId(btn.dataset.dcid, btn.dataset.dcidval));
        });
        accountList.querySelectorAll('[data-izin]').forEach((btn) => {
            const kullanici = data.users.find((u) => u.username === btn.dataset.izin);
            btn.addEventListener('click', () => izinAc(kullanici));
        });
    } catch (error) {
        accountList.innerHTML = `<div class="empty-hint">Hesaplar alınamadı: ${escapeHtml(error.message)}</div>`;
    }
}

// Yonetici, once acilmis hesaplara Discord ID atayabilsin diye - o hesaplarda
// "Yoklamaya Katıl" ID olmadan calismiyordu ve duzeltmenin yolu yoktu.
async function setAccountDiscordId(username, mevcut) {
    const girilen = window.prompt(
        [
            `"${username}" hesabının Discord ID'si`,
            "",
            "Kullanıcının Discord ID'sini yapıştır (17-20 hane).",
            "Bağı kaldırmak için boş bırak.",
        ].join("\n"),
        mevcut || "",
    );
    if (girilen === null) return; // iptal
    try {
        const res = await fetch('/api/hesaplar/discord-id', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, discordId: girilen.trim() }),
        });
        const d = await okuJson(res);
        if (!d.ok) { addAccountMsg.textContent = `Hata: ${d.error}`; return; }
        addAccountMsg.textContent = d.discordId
            ? `${username} → ${d.discordId} bağlandı.`
            : `${username} hesabının Discord ID bağı kaldırıldı.`;
        refreshAccounts();
        loadKatilim(); // kendi hesabimizsa buton hemen guncellensin
    } catch (error) {
        addAccountMsg.textContent = `Hata: ${error.message}`;
    }
}

// ============================================================================
// --- YETKİ DÜZENLEME (yalnızca yönetici) ---
// Bir hesabın yöneticiliği, görebileceği sekmeler ve log kanalları.
// ============================================================================
let IZIN_TOPLAM_SEKME = 9;
let izinSecenekleri = null;
let izinHedef = null;

const izinModal = document.getElementById('izinModal');
const izinBody = document.getElementById('izinBody');
const izinMsg = document.getElementById('izinMsg');

async function izinSecenekleriniAl() {
    if (izinSecenekleri) return izinSecenekleri;
    const res = await fetch('/api/izin-secenekleri');
    const d = await okuJson(res);
    if (!d.ok) throw new Error(d.error || 'Seçenekler alınamadı.');
    izinSecenekleri = d;
    IZIN_TOPLAM_SEKME = d.sekmeler.length;
    return d;
}

function izinCiz() {
    const { sekmeler, loglar, gruplar } = izinSecenekleri;
    const secSekme = new Set(izinHedef.sekmeler || []);
    const secLog = new Set(izinHedef.loglar || []);
    const admin = Boolean(izinHedef.admin);

    // Log kanallarını grubuna göre topluyoruz - grup sekmesi kapalıysa
    // içindeki kanalların bir hükmü kalmadığını göstermek için.
    const grupBloklari = gruplar.map((g) => {
        const kanallar = loglar.filter((l) => l.group === g.key);
        if (!kanallar.length) return '';
        const grupAcik = secSekme.has(kanallar[0].grupSekmesi);
        return `
            <div class="izin-grup${grupAcik ? '' : ' pasif'}">
                <div class="izin-grup-bas">
                    ${escapeHtml(g.label)}
                    ${grupAcik ? '' : '<span class="muted"> — sekme kapalı, kanallar geçersiz</span>'}
                </div>
                <div class="izin-kutular">
                    ${kanallar.map((l) => `
                        <label class="check-inline">
                            <input type="checkbox" data-log="${escapeHtml(l.key)}"
                                   ${secLog.has(l.key) ? 'checked' : ''} ${admin ? 'disabled' : ''}>
                            ${escapeHtml(l.label)}
                        </label>`).join('')}
                </div>
            </div>`;
    }).join('');

    izinBody.innerHTML = `
        <label class="check-inline izin-admin">
            <input type="checkbox" id="izinAdmin" ${admin ? 'checked' : ''}>
            <b>Yönetici</b> — her şeyi görür, hesap açar/siler, yetki verir
        </label>
        <div class="izin-bolum${admin ? ' pasif' : ''}" id="izinAyrinti">
            <div class="izin-grup-bas" style="margin-top:14px;">Görebileceği sekmeler</div>
            <div class="izin-kutular">
                ${sekmeler.map((sk) => `
                    <label class="check-inline">
                        <input type="checkbox" data-sekme="${escapeHtml(sk.key)}"
                               ${secSekme.has(sk.key) ? 'checked' : ''} ${admin ? 'disabled' : ''}>
                        ${escapeHtml(sk.label)}
                    </label>`).join('')}
            </div>
            <div class="izin-grup-bas" style="margin-top:16px;">Görebileceği log kanalları</div>
            ${grupBloklari}
        </div>`;

    // Yönetici işaretlenince ayrıntılar anlamsızlaşıyor - kapatıyoruz.
    document.getElementById('izinAdmin').addEventListener('change', (evt) => {
        izinHedef.admin = evt.target.checked;
        izinToplaVeCiz();
    });
    izinBody.querySelectorAll('[data-sekme],[data-log]').forEach((el) => {
        el.addEventListener('change', () => izinToplaVeCiz());
    });
}

// Ekrandaki kutuları modele yazıp yeniden çiziyoruz - grup sekmesi
// kapatıldığında altındaki kanalların "geçersiz" görünmesi için gerekli.
function izinToplaVeCiz() {
    izinHedef.admin = document.getElementById('izinAdmin').checked;
    if (!izinHedef.admin) {
        izinHedef.sekmeler = [...izinBody.querySelectorAll('[data-sekme]:checked')].map((e) => e.dataset.sekme);
        izinHedef.loglar = [...izinBody.querySelectorAll('[data-log]:checked')].map((e) => e.dataset.log);
    }
    izinCiz();
}

async function izinAc(kullanici) {
    izinMsg.textContent = '';
    try {
        await izinSecenekleriniAl();
    } catch (error) {
        addAccountMsg.textContent = `Hata: ${error.message}`;
        return;
    }
    izinHedef = {
        username: kullanici.username,
        admin: Boolean(kullanici.admin),
        sekmeler: [...(kullanici.sekmeler || [])],
        loglar: [...(kullanici.loglar || [])],
    };
    document.getElementById('izinBaslik').textContent = `${kullanici.username} — Yetkiler`;
    izinCiz();
    izinModal.style.display = 'flex';
}

document.getElementById('izinKapat').addEventListener('click', () => { izinModal.style.display = 'none'; });
izinModal.addEventListener('click', (evt) => {
    if (evt.target === izinModal) izinModal.style.display = 'none';
});

document.getElementById('izinKaydet').addEventListener('click', async () => {
    if (!izinHedef) return;
    izinMsg.textContent = 'Kaydediliyor...';
    try {
        const res = await fetch('/api/hesaplar/izinler', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(izinHedef),
        });
        const d = await okuJson(res);
        if (!d.ok) { izinMsg.textContent = `Hata: ${d.error}`; return; }
        izinModal.style.display = 'none';
        addAccountMsg.textContent = `${d.username} yetkileri kaydedildi`
            + ' — o hesabın açık oturumları düşürüldü.';
        refreshAccounts();
    } catch (error) {
        izinMsg.textContent = `Hata: ${error.message}`;
    }
});

async function deleteAccount(username) {
    if (!window.confirm(`"${username}" hesabı silinsin mi? Bu hesapla artık panele girilemez.`)) return;
    try {
        const res = await fetch('/api/hesaplar/sil', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username }),
        });
        const data = await okuJson(res);
        if (!data.ok) { addAccountMsg.textContent = `Hata: ${data.error}`; return; }
        if (data.selfDeleted) { showLogin(); return; } // kendini sildi
        addAccountMsg.textContent = `"${username}" silindi.`;
        refreshAccounts();
    } catch (error) {
        addAccountMsg.textContent = `Hata: ${error.message}`;
    }
}

// Hesap tipi secimi (Yetkili / AC). AC seciliyse Discord ID alani gereksiz -
// zaten ilk token kimligi kuruyor; ve tip aciklamasi gorunur oluyor.
let addTip = 'yetkili';
const addTipSecim = document.getElementById('addTipSecim');
const addTipAciklama = document.getElementById('addTipAciklama');
if (addTipSecim) {
    addTipSecim.querySelectorAll('[data-tip]').forEach((btn) => {
        btn.addEventListener('click', () => {
            addTip = btn.dataset.tip;
            addTipSecim.querySelectorAll('[data-tip]').forEach((b) =>
                b.classList.toggle('active', b === btn));
            addTipAciklama.style.display = addTip === 'ac' ? '' : 'none';
            const idAlani = document.getElementById('addDiscordId');
            idAlani.style.display = addTip === 'ac' ? 'none' : '';
        });
    });
}

document.getElementById('addAccountBtn').addEventListener('click', async () => {
    addAccountMsg.textContent = 'Ekleniyor...';
    try {
        const res = await fetch('/api/hesaplar/ekle', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username: addUsername.value.trim(),
                password: addPassword.value,
                discordId: document.getElementById('addDiscordId').value.trim(),
                tip: addTip,
            }),
        });
        const data = await okuJson(res);
        if (!data.ok) { addAccountMsg.textContent = `Hata: ${data.error}`; return; }
        addAccountMsg.textContent = 'Hesap eklendi.';
        addUsername.value = '';
        addPassword.value = '';
        document.getElementById('addDiscordId').value = '';
        refreshAccounts();
    } catch (error) {
        addAccountMsg.textContent = `Hata: ${error.message}`;
    }
});

document.getElementById('updateAccountBtn').addEventListener('click', async () => {
    accountMsg.textContent = 'Kaydediliyor...';
    try {
        const res = await fetch('/api/hesap/guncelle', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                currentPassword: curPassword.value,
                newUsername: newUsernameEl.value.trim(),
                newPassword: newPasswordEl.value,
                discordId: document.getElementById('myDiscordId').value.trim(),
            }),
        });
        const data = await okuJson(res);
        if (!data.ok) { accountMsg.textContent = `Hata: ${data.error}`; return; }
        currentUsername = data.username;
        document.getElementById('whoAmI').textContent = `· ${currentUsername}`;
        accountMsg.textContent = 'Kaydedildi. Diğer oturumlar düşürüldü.';
        curPassword.value = '';
        newUsernameEl.value = '';
        newPasswordEl.value = '';
        refreshAccounts();
        loadKatilim(); // Discord ID degismis olabilir - "Yoklamaya Katıl" butonu guncellensin
    } catch (error) {
        accountMsg.textContent = `Hata: ${error.message}`;
    }
});

// ============================================================================
// --- YOKLAMAYI AL (önizleme + uygula) ---
// ============================================================================
const attendanceBtn = document.getElementById('attendanceBtn');
const attendanceReason = document.getElementById('attendanceReason');
const attendanceStatus = document.getElementById('attendanceStatus');
const previewModal = document.getElementById('previewModal');
const previewSummary = document.getElementById('previewSummary');
const previewBody = document.getElementById('previewBody');
const previewProgress = document.getElementById('previewProgress');
const previewApplyBtn = document.getElementById('previewApplyBtn');

let previewWarnIds = [];

function previewRow(member, showNext) {
    return `<div class="preview-row">
        <img src="${encodeURI(member.avatarURL)}" alt="">
        <span class="p-name">${escapeHtml(member.displayName)}</span>
        <span class="p-tag">${escapeHtml(member.tag)}</span>
        <span class="p-spacer"></span>
        <span class="p-reason">${escapeHtml(member.reason)}</span>
        ${showNext && member.nextTierLabel ? `<span class="p-next">${escapeHtml(member.nextTierLabel)}</span>` : ''}
    </div>`;
}

function previewGroup(cls, title, rows, showNext) {
    if (rows.length === 0) return '';
    return `<div class="preview-group ${cls}">
        <h3>${escapeHtml(title)} (${rows.length})</h3>
        ${rows.map((m) => previewRow(m, showNext)).join('')}
    </div>`;
}

function closePreview() {
    previewModal.style.display = 'none';
    previewProgress.textContent = '';
}
document.getElementById('previewCloseBtn').addEventListener('click', closePreview);
document.getElementById('previewCancelBtn').addEventListener('click', closePreview);
previewModal.addEventListener('click', (evt) => { if (evt.target === previewModal) closePreview(); });

attendanceBtn.addEventListener('click', async () => {
    const reason = attendanceReason.value.trim();
    if (!reason) {
        attendanceStatus.textContent = 'Önce uyarı sebebini yaz.';
        attendanceReason.focus();
        return;
    }
    attendanceBtn.disabled = true;
    attendanceStatus.textContent = 'Tarama yapılıyor...';
    try {
        const res = await fetch('/api/yoklama/al-onizleme', { method: 'POST' });
        if (res.status === 401) { showLogin(); return; }
        const result = await okuJson(res);
        if (!result.ok) { attendanceStatus.textContent = `Hata: ${result.error}`; return; }

        const data = result.data;
        previewWarnIds = data.warn.map((m) => m.id);

        previewSummary.innerHTML = `
            Kontrol edilen: <b>${data.totalChecked}</b> ·
            Sesde: <span class="green-num">${data.totalInVoice}</span> ·
            <b style="color:#ff6b6b;">Uyarı alacak: ${data.warn.length}</b> ·
            Mazereti onaylı: ${data.excused.length} ·
            En üst kademede (atlanacak): ${data.maxTier.length}
            <br>Sebep: <b>${escapeHtml(reason)}</b>`;

        previewBody.innerHTML = [
            previewGroup('warn', 'Uyarı Alacaklar', data.warn, true),
            previewGroup('excused', 'Mazereti Onaylı - Uyarı Yok', data.excused, false),
            previewGroup('info', 'En Üst Kademede - Uyarı Verilemez', data.maxTier, false),
            previewGroup('info', 'Seste - Uyarı Yok', data.inVoice, false),
        ].join('') || '<div class="empty-hint">Kimse bulunamadı.</div>';

        previewApplyBtn.disabled = previewWarnIds.length === 0;
        previewApplyBtn.textContent = previewWarnIds.length === 0
            ? 'Uyarılacak kimse yok'
            : `${previewWarnIds.length} Kişiye Uyarı Ver`;
        previewProgress.textContent = '';
        previewModal.style.display = 'flex';
        attendanceStatus.textContent = `Önizleme hazır: ${formatDate(data.scannedAt)}`;
    } catch (error) {
        attendanceStatus.textContent = `Hata: ${error.message}`;
    } finally {
        attendanceBtn.disabled = false;
    }
});

previewApplyBtn.addEventListener('click', async () => {
    if (previewWarnIds.length === 0) return;
    if (!window.confirm(`${previewWarnIds.length} kişiye uyarı verilecek. Onaylıyor musun?`)) return;
    previewApplyBtn.disabled = true;
    previewProgress.textContent = 'Başlıyor...';
    try {
        const res = await fetch('/api/yoklama/al-uygula', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ memberIds: previewWarnIds, reason: attendanceReason.value.trim() }),
        });
        const result = await okuJson(res);
        if (result.ok === false && result.error) {
            previewProgress.textContent = `Hata: ${result.error}`;
            previewApplyBtn.disabled = false;
            return;
        }
        const summary = `Tamamlandı: ${result.warned.length} uyarı verildi, ${result.skipped.length} atlandı, ${result.failed.length} hata.`;
        // Hata varsa sebebini de göster - "verildi" deyip vermemesi en can
        // sıkıcı durumdu, sebebi görünür olsun.
        previewProgress.innerHTML = escapeHtml(summary)
            + (result.failed.length
                ? `<br><span style="color:var(--attn)">${escapeHtml(result.failed[0].error || '')}</span>`
                : '');
        attendanceStatus.textContent = summary;
        attendanceReason.value = '';
        setTimeout(closePreview, 2500);
    } catch (error) {
        previewProgress.textContent = `Hata: ${error.message}`;
        previewApplyBtn.disabled = false;
    }
});

// ============================================================================
// --- PANOYA KOPYALA (tarama raporu) ---
// ============================================================================
const copyReportBtn = document.getElementById('copyReportBtn');

function buildReportText() {
    const out = lastResults.filter((m) => !m.inVoice);
    const inV = lastResults.filter((m) => m.inVoice);
    const lines = [
        `MD PvP Yoklama Raporu - ${new Date().toLocaleString('tr-TR')}`,
        `Kontrol edilen: ${lastResults.length} · Sesde: ${inV.length} · Sesde değil: ${out.length}`,
        '',
        `--- SESDE DEĞİL (${out.length}) ---`,
    ];
    out.forEach((m) => {
        const parts = [`${m.displayName} (${m.tag})`];
        if (m.currentTierLabel) parts.push(`kademe: ${m.currentTierLabel}`);
        if (m.excuseText) parts.push(`mazeret: ${m.excuseText.replace(/\s+/g, ' ').slice(0, 120)}`);
        if (m.longExcuseText) parts.push(`uzun mazeret: ${m.longExcuseText.replace(/\s+/g, ' ').slice(0, 120)}`);
        if (!m.excuseText && !m.longExcuseText) parts.push('mazeret yok');
        lines.push(`- ${parts.join(' | ')}`);
    });
    lines.push('', `--- SESDE (${inV.length}) ---`);
    inV.forEach((m) => lines.push(`- ${m.displayName} (${m.tag})`));
    return lines.join('\n');
}

copyReportBtn.addEventListener('click', async () => {
    if (lastResults.length === 0) return;
    const text = buildReportText();
    try {
        await navigator.clipboard.writeText(text);
        scanStatus.textContent = 'Rapor panoya kopyalandı.';
    } catch (error) {
        // HTTPS olmayan bağlantılarda clipboard API kapalı olabiliyor - yedek yol.
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try {
            document.execCommand('copy');
            scanStatus.textContent = 'Rapor panoya kopyalandı.';
        } catch (fallbackError) {
            scanStatus.textContent = `Kopyalanamadı: ${fallbackError.message}`;
        }
        document.body.removeChild(ta);
    }
});

checkSession();

// ============================================================================
// --- YETKİLİLER ---
// Solda hiyerarşi sıralı roller, sağda seçilen roldeki kişiler.
// ============================================================================
const staffRoleMenu = document.getElementById('staffRoleMenu');
const staffList = document.getElementById('staffList');
const staffTitle = document.getElementById('staffTitle');
const staffStatus = document.getElementById('staffStatus');
const staffSearch = document.getElementById('staffSearch');
const staffRefreshBtn = document.getElementById('staffRefreshBtn');

let guildRoles = [];          // hiyerarşi sırasında (üstten alta)
let selfTopPosition = 0;
let staffMembers = [];
let activeStaffRoleId = null;
let staffLoaded = false;
let staffSearchTimer = null;

function roleDot(color) {
    return `<span class="role-dot" style="background:${color ? escapeHtml(color) : 'var(--ink-3)'}"></span>`;
}

async function loadGuildRoles(force) {
    if (guildRoles.length && !force) return true;
    try {
        const res = await fetch('/api/roller');
        if (res.status === 401) { showLogin(); return false; }
        const data = await okuJson(res);
        if (!data.ok) { staffStatus.textContent = `Roller alınamadı: ${data.error}`; return false; }
        guildRoles = data.roles;
        selfTopPosition = data.selfTopPosition;
        return true;
    } catch (error) {
        staffStatus.textContent = `Hata: ${error.message}`;
        return false;
    }
}

function renderStaffRoleMenu() {
    staffRoleMenu.innerHTML = '';
    const hepsi = document.createElement('button');
    hepsi.className = `log-menu-item${activeStaffRoleId === null ? ' active' : ''}`;
    hepsi.innerHTML = '<span>Tüm Yetkililer</span>';
    hepsi.addEventListener('click', () => selectStaffRole(null));
    staffRoleMenu.appendChild(hepsi);

    guildRoles.forEach((role) => {
        if (role.memberCount === 0) return; // boş rolleri listede taşımanın anlamı yok
        const btn = document.createElement('button');
        btn.className = `log-menu-item${role.id === activeStaffRoleId ? ' active' : ''}`;
        btn.innerHTML = `<span class="role-name">${roleDot(role.color)}${escapeHtml(role.name)}</span>`
            + `<span class="count">${role.memberCount}</span>`;
        btn.title = `${role.name} · ${role.memberCount} kişi · hiyerarşi ${role.position}`;
        btn.addEventListener('click', () => selectStaffRole(role.id));
        staffRoleMenu.appendChild(btn);
    });
}

// Rol listesi uzun olan kisilerde (bazi yetkililerde 14 rol var) ilk 8 rol
// gosterilip gerisi "+N" ile gizleniyor; rolu SILMEK icin once gormek
// gerektiginden "+N" tiklanabilir ve o kisi icin listeyi aciyor.
const expandedStaff = new Set();
const CHIP_LIMIT = 8;

function isRoleRemovable(roleId) {
    const role = guildRoles.find((r) => r.id === roleId);
    return Boolean(role && role.assignable);
}

function roleChipHtml(member, role) {
    const silinebilir = isRoleRemovable(role.id);
    return `<span class="role-chip${silinebilir ? '' : ' fixed'}">`
        + roleDot(role.color)
        + escapeHtml(role.name)
        + (silinebilir
            ? `<button class="chip-x" data-rm-member="${member.id}" data-rm-role="${role.id}" title="&quot;${escapeHtml(role.name)}&quot; rolünü al">×</button>`
            : '')
        + '</span>';
}

function staffRowHtml(member) {
    const acik = expandedStaff.has(member.id);
    const gosterilen = acik ? member.roles : member.roles.slice(0, CHIP_LIMIT);
    let roller = gosterilen.map((r) => roleChipHtml(member, r)).join('');
    if (!member.roles.length) {
        roller = '<span class="role-chip muted">Rol yok</span>';
    } else if (!acik && member.roles.length > CHIP_LIMIT) {
        roller += `<button class="role-chip more" data-expand="${member.id}">+${member.roles.length - CHIP_LIMIT} daha</button>`;
    } else if (acik && member.roles.length > CHIP_LIMIT) {
        roller += `<button class="role-chip more" data-collapse="${member.id}">gizle</button>`;
    }

    return `
        <img class="log-avatar staff-avatar" src="${encodeURI(member.avatarURL)}" alt="">
        <div class="log-body">
            <div class="log-meta">
                <span class="staff-name">${escapeHtml(member.displayName)}</span>
                <span class="log-time">${escapeHtml(member.tag)}</span>
                <span class="voiceLabel ${member.inVoice ? 'in' : 'out'}">${member.inVoice ? 'Sesde ✅' : 'Sesde Değil ❌'}</span>
                ${member.currentTierLabel ? `<span class="tier-badge">${escapeHtml(member.currentTierLabel)}</span>` : ''}
                <select class="role-add" data-add-member="${member.id}" title="Bu kişiye rol ver">
                    <option value="">+ Rol ver…</option>
                </select>
                <span class="staff-msg" data-msg="${member.id}"></span>
            </div>
            <div class="role-chips">${roller}</div>
            ${member.joinedAt ? `<div class="staff-joined">Katılım: ${formatDate(member.joinedAt)}</div>` : ''}
        </div>
        <div class="staff-actions">
            <button class="secondary small" data-role-target="${member.id}">Tüm Roller</button>
        </div>`;
}

function setStaffMsg(memberId, metin, sinif) {
    const el = staffList.querySelector(`[data-msg="${memberId}"]`);
    if (el) {
        el.textContent = metin || '';
        el.className = `staff-msg ${sinif || ''}`.trim();
    }
}

// Secim kutusu ILK ACILDIGINDA dolduruluyor. 46 kisi x ~40 rol = 1800'den
// fazla <option> demek; hepsini pesinen basmak listeyi gereksiz agirlastirirdi.
function fillRoleSelect(select, member) {
    if (select.dataset.dolu === '1') return;
    const sahip = new Set(member.roles.map((r) => r.id));
    const secenekler = guildRoles
        .filter((role) => role.assignable && !sahip.has(role.id))
        .map((role) => `<option value="${role.id}">${escapeHtml(role.name)}</option>`)
        .join('');
    select.innerHTML = `<option value="">+ Rol ver…</option>${secenekler}`;
    select.dataset.dolu = '1';
}

async function staffRoleAction(kind, member, roleId, roleName) {
    const soru = kind === 'ver'
        ? `"${roleName}" rolü ${member.displayName} kişisine verilecek. Onaylıyor musun?`
        : `"${roleName}" rolü ${member.displayName} kişisinden alınacak. Onaylıyor musun?`;
    if (!window.confirm(soru)) return false;

    setStaffMsg(member.id, 'Gönderiliyor...', '');
    try {
        const res = await fetch(kind === 'ver' ? '/api/rol/ver' : '/api/rol/al', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ memberId: member.id, roleId }),
        });
        const result = await okuJson(res);
        if (!result.ok) {
            setStaffMsg(member.id, result.reason === 'zaten-var' ? 'Bu rol zaten var.'
                : result.reason === 'yok' ? 'Bu rol kişide yok.'
                : result.reason === 'dogrulanamadi' ? `⚠ ${result.error}`
                : `Hata: ${result.error || 'bilinmeyen'}`, 'error');
            return false;
        }
        // Yerel listeyi guncelle - rol sirasi hiyerarsiye gore korunuyor
        if (kind === 'ver') {
            const role = guildRoles.find((r) => r.id === roleId);
            member.roles.push({ id: role.id, name: role.name, color: role.color, position: role.position });
            // Sunucudan gelen sıra hiyerarşik; yeni rolü de doğru yere koy.
            member.roles.sort((a, b) => {
                const pa = a.position ?? (guildRoles.find((r) => r.id === a.id) || {}).position ?? 0;
                const pb = b.position ?? (guildRoles.find((r) => r.id === b.id) || {}).position ?? 0;
                return pb - pa;
            });
        } else {
            member.roles = member.roles.filter((r) => r.id !== roleId);
        }
        renderStaffList();
        setStaffMsg(member.id, kind === 'ver' ? `"${roleName}" verildi.` : `"${roleName}" alındı.`, 'ok');
        return true;
    } catch (error) {
        setStaffMsg(member.id, `Hata: ${error.message}`, 'error');
        return false;
    }
}

function renderStaffList() {
    const term = staffSearch.value.trim().toLocaleLowerCase('tr');
    const filtered = term
        ? staffMembers.filter((m) => m.displayName.toLocaleLowerCase('tr').includes(term)
            || m.tag.toLocaleLowerCase('tr').includes(term)
            || m.id.includes(term))
        : staffMembers;

    staffList.innerHTML = '';
    if (filtered.length === 0) {
        staffList.innerHTML = `<div class="empty-hint">${term ? 'Aramaya uyan kimse yok.' : 'Bu rolde kimse yok.'}</div>`;
        return;
    }
    filtered.forEach((member) => {
        const div = document.createElement('div');
        div.className = 'log-entry staff-entry';
        div.innerHTML = staffRowHtml(member);
        staffList.appendChild(div);
    });

    // rolü al (çarpı)
    staffList.querySelectorAll('[data-rm-role]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const member = staffMembers.find((m) => m.id === btn.dataset.rmMember);
            const role = member && member.roles.find((r) => r.id === btn.dataset.rmRole);
            if (member && role) {
                btn.disabled = true;
                staffRoleAction('al', member, role.id, role.name);
            }
        });
    });
    // rol ver (seçim kutusu)
    staffList.querySelectorAll('[data-add-member]').forEach((sel) => {
        const member = staffMembers.find((m) => m.id === sel.dataset.addMember);
        if (!member) return;
        sel.addEventListener('focus', () => fillRoleSelect(sel, member));
        sel.addEventListener('mousedown', () => fillRoleSelect(sel, member));
        sel.addEventListener('change', async () => {
            const roleId = sel.value;
            if (!roleId) return;
            const roleName = sel.options[sel.selectedIndex].textContent;
            sel.disabled = true;
            const ok = await staffRoleAction('ver', member, roleId, roleName);
            if (!ok) { sel.disabled = false; sel.value = ''; }
        });
    });
    // rol listesini aç / gizle
    staffList.querySelectorAll('[data-expand]').forEach((btn) => {
        btn.addEventListener('click', () => { expandedStaff.add(btn.dataset.expand); renderStaffList(); });
    });
    staffList.querySelectorAll('[data-collapse]').forEach((btn) => {
        btn.addEventListener('click', () => { expandedStaff.delete(btn.dataset.collapse); renderStaffList(); });
    });
    // hiyerarşik görünüme geç
    staffList.querySelectorAll('[data-role-target]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const member = staffMembers.find((m) => m.id === btn.dataset.roleTarget);
            if (member) openRoleTabFor(member);
        });
    });

    staffStatus.textContent = term
        ? `${filtered.length} / ${staffMembers.length} kişi`
        : `${staffMembers.length} kişi`;
}

async function loadStaff(roleId) {
    staffList.innerHTML = '<div class="iskelet">' + '<div class="iskelet-satir"></div>'.repeat(6) + '</div>';
    staffStatus.textContent = '';
    try {
        const url = roleId ? `/api/yetkililer?roleId=${encodeURIComponent(roleId)}` : '/api/yetkililer';
        const res = await fetch(url);
        if (res.status === 401) { showLogin(); return; }
        const data = await okuJson(res);
        if (!data.ok) {
            staffList.innerHTML = `<div class="empty-hint">Hata: ${escapeHtml(data.error)}</div>`;
            return;
        }
        staffMembers = data.members;
        staffTitle.textContent = data.roleName ? `${data.roleName}` : 'Tüm Yetkililer';
        renderStaffList();
    } catch (error) {
        staffList.innerHTML = `<div class="empty-hint">Hata: ${escapeHtml(error.message)}</div>`;
    }
}

function selectStaffRole(roleId) {
    activeStaffRoleId = roleId;
    renderStaffRoleMenu();
    loadStaff(roleId);
}

async function initStaffTab(force) {
    if (staffLoaded && !force) return;
    staffLoaded = true;
    if (!(await loadGuildRoles(force))) return;
    renderStaffRoleMenu();
    await loadStaff(activeStaffRoleId);
}

staffSearch.addEventListener('input', () => {
    clearTimeout(staffSearchTimer);
    staffSearchTimer = setTimeout(renderStaffList, 200);
});
staffRefreshBtn.addEventListener('click', () => initStaffTab(true));

// ============================================================================
// --- ROL VER / AL ---
// Sunucudaki tüm roller hiyerarşi sırasında. Hesabın kendi en üst rolünün
// üstündeki roller görünür ama verilemez olarak işaretlenir.
// ============================================================================
const roleTarget = document.getElementById('roleTarget');
const roleTargetHint = document.getElementById('roleTargetHint');
const roleList = document.getElementById('roleList');
const roleEmpty = document.getElementById('roleEmpty');
const roleSearch = document.getElementById('roleSearch');
const roleStatus = document.getElementById('roleStatus');
const roleOnlyAssignable = document.getElementById('roleOnlyAssignable');

let roleTargetMember = null;
let roleSearchTimer = null;

function openRoleTabFor(member) {
    roleTargetMember = member;
    document.querySelector('.tab-btn[data-tab="roller"]').click();
    renderRoleTarget();
    renderRoleList();
}

function renderRoleTarget() {
    if (!roleTargetMember) {
        roleTarget.style.display = 'none';
        roleTargetHint.style.display = 'block';
        roleSearch.disabled = true;
        return;
    }
    roleTargetHint.style.display = 'none';
    roleSearch.disabled = false;
    roleTarget.style.display = 'flex';
    roleTarget.innerHTML = `
        <img src="${encodeURI(roleTargetMember.avatarURL)}" alt="">
        <div>
            <div class="staff-name">${escapeHtml(roleTargetMember.displayName)}</div>
            <div class="log-time">${escapeHtml(roleTargetMember.tag)} · ${escapeHtml(roleTargetMember.id)}</div>
        </div>
        <span class="p-spacer"></span>
        <span class="scanStatus">${roleTargetMember.roles.length} rolü var</span>
        <button class="ghost small" id="roleClearTargetBtn">Seçimi bırak</button>`;
    document.getElementById('roleClearTargetBtn').addEventListener('click', () => {
        roleTargetMember = null;
        renderRoleTarget();
        renderRoleList();
    });
}

function renderRoleList() {
    roleList.innerHTML = '';
    if (!roleTargetMember) {
        roleEmpty.textContent = 'Önce Yetkililer sekmesinden bir kişi seç.';
        roleEmpty.style.display = 'block';
        roleStatus.textContent = '';
        return;
    }
    const term = roleSearch.value.trim().toLocaleLowerCase('tr');
    const sahipOlunan = new Set(roleTargetMember.roles.map((r) => r.id));

    const gorunecek = guildRoles.filter((role) => {
        if (roleOnlyAssignable.checked && !role.assignable) return false;
        if (term && !role.name.toLocaleLowerCase('tr').includes(term)) return false;
        return true;
    });

    if (gorunecek.length === 0) {
        roleEmpty.textContent = term ? 'Aramaya uyan rol yok.' : 'Gösterilecek rol yok.';
        roleEmpty.style.display = 'block';
        return;
    }
    roleEmpty.style.display = 'none';

    gorunecek.forEach((role) => {
        const var_ = sahipOlunan.has(role.id);
        const row = document.createElement('div');
        row.className = `role-row${var_ ? ' has-role' : ''}${role.assignable ? '' : ' locked'}`;
        row.dataset.roleId = role.id;

        let neden = '';
        if (role.managed) neden = 'Bot/entegrasyon rolü — elle verilemez';
        else if (!role.assignable) neden = 'Senin en üst rolünün üzerinde — verilemez';

        row.innerHTML = `
            ${roleDot(role.color)}
            <span class="role-row-name">${escapeHtml(role.name)}</span>
            ${role.isAttendance ? '<span class="role-tag">yoklama</span>' : ''}
            ${role.isWarning ? '<span class="role-tag">uyarı</span>' : ''}
            ${var_ ? '<span class="role-tag has">bu kişide var</span>' : ''}
            <span class="p-spacer"></span>
            <span class="scanStatus role-row-msg"></span>
            ${neden ? `<span class="role-locked-msg">🔒 ${escapeHtml(neden)}</span>`
                    : `<button class="${var_ ? 'secondary' : ''} small" data-act="${var_ ? 'al' : 'ver'}">${var_ ? 'Rolü Al' : 'Rolü Ver'}</button>`}`;
        roleList.appendChild(row);
    });

    roleList.querySelectorAll('button[data-act]').forEach((btn) => {
        btn.addEventListener('click', () => onRoleAction(btn));
    });
    roleStatus.textContent = `${gorunecek.length} rol gösteriliyor`;
}

async function onRoleAction(btn) {
    const row = btn.closest('.role-row');
    const roleId = row.dataset.roleId;
    const act = btn.dataset.act;
    const role = guildRoles.find((r) => r.id === roleId);
    const msgEl = row.querySelector('.role-row-msg');

    const soru = act === 'ver'
        ? `"${role.name}" rolü ${roleTargetMember.displayName} kişisine verilecek. Onaylıyor musun?`
        : `"${role.name}" rolü ${roleTargetMember.displayName} kişisinden alınacak. Onaylıyor musun?`;
    if (!window.confirm(soru)) return;

    btn.disabled = true;
    msgEl.textContent = 'Gönderiliyor...';
    try {
        const res = await fetch(act === 'ver' ? '/api/rol/ver' : '/api/rol/al', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ memberId: roleTargetMember.id, roleId }),
        });
        const result = await okuJson(res);
        if (!result.ok) {
            const metin = result.reason === 'zaten-var' ? 'Bu kişide zaten var.'
                : result.reason === 'yok' ? 'Bu kişide bu rol yok.'
                : result.reason === 'dogrulanamadi' ? `⚠ ${result.error}`
                : `Hata: ${result.error || 'bilinmeyen'}`;
            msgEl.textContent = metin;
            btn.disabled = false;
            return;
        }
        // Yerel durumu güncelle ki düğme "Ver" <-> "Al" arasında dönsün
        if (act === 'ver') {
            roleTargetMember.roles.push({ id: role.id, name: role.name, color: role.color });
        } else {
            roleTargetMember.roles = roleTargetMember.roles.filter((r) => r.id !== roleId);
        }
        renderRoleTarget();
        renderRoleList();
        const yeni = roleList.querySelector(`.role-row[data-role-id="${roleId}"] .role-row-msg`);
        if (yeni) yeni.textContent = act === 'ver' ? 'Verildi.' : 'Alındı.';
    } catch (error) {
        msgEl.textContent = `Hata: ${error.message}`;
        btn.disabled = false;
    }
}

roleSearch.addEventListener('input', () => {
    clearTimeout(roleSearchTimer);
    roleSearchTimer = setTimeout(renderRoleList, 200);
});
roleOnlyAssignable.addEventListener('change', renderRoleList);

// ============================================================================
// --- HESAP LOGLARI ---
// Panelde kim ne yaptı: girişler, başarısız denemeler, hesap değişiklikleri ve
// Discord'u etkileyen işlemler.
// ============================================================================
const auditList = document.getElementById('auditList');
const auditEmpty = document.getElementById('auditEmpty');
const auditStatus = document.getElementById('auditStatus');
const auditSearch = document.getElementById('auditSearch');
const auditFilters = document.getElementById('auditFilters');
const auditRefreshBtn = document.getElementById('auditRefreshBtn');
const auditPager = document.getElementById('auditPager');
const auditPageInfo = document.getElementById('auditPageInfo');
const auditPrevBtn = document.getElementById('auditPrevBtn');
const auditNextBtn = document.getElementById('auditNextBtn');

const AUDIT_PAGE = 100;
const AUDIT_TYPES = {
    'giris':          { label: 'Giriş',          sinif: 't-giris' },
    'giris-hata':     { label: 'Başarısız Giriş', sinif: 't-girishata' },
    'cikis':          { label: 'Çıkış',          sinif: 't-giris' },
    'hesap-ekle':     { label: 'Hesap Ekleme',   sinif: 't-hesap' },
    'hesap-sil':      { label: 'Hesap Silme',    sinif: 't-hesap' },
    'hesap-guncelle': { label: 'Hesap Değişikliği', sinif: 't-hesap' },
    'rol-ver':        { label: 'Rol Verme',      sinif: 't-islem' },
    'rol-al':         { label: 'Rol Alma',       sinif: 't-islem' },
    'uyari-ver':      { label: 'Uyarı',          sinif: 't-islem' },
    'uyari-geri-al':  { label: 'Uyarı Geri Alma', sinif: 't-islem' },
    'yoklama-al':     { label: 'Yoklamayı Al',   sinif: 't-islem' },
    'acil-toplanti':  { label: 'Acil Toplantı',  sinif: 't-islem' },
};

let auditOffset = 0;
let auditType = '';
let auditSearchTimer = null;

function renderAuditFilters(counts) {
    const toplam = Object.values(counts).reduce((a, b) => a + b, 0);
    let html = `<button class="chip${auditType === '' ? ' active' : ''}" data-atype="">Tümü ${toplam}</button>`;
    Object.entries(AUDIT_TYPES).forEach(([key, bilgi]) => {
        if (!counts[key]) return; // hiç yaşanmamış olay türünü göstermenin anlamı yok
        html += `<button class="chip${auditType === key ? ' active' : ''}" data-atype="${key}">`
            + `${escapeHtml(bilgi.label)} ${counts[key]}</button>`;
    });
    auditFilters.innerHTML = html;
    auditFilters.querySelectorAll('[data-atype]').forEach((btn) => {
        btn.addEventListener('click', () => {
            auditType = btn.dataset.atype;
            auditOffset = 0;
            loadAudit();
        });
    });
}

async function loadAudit() {
    try {
        const params = new URLSearchParams({ offset: String(auditOffset), limit: String(AUDIT_PAGE) });
        if (auditType) params.set('type', auditType);
        if (auditSearch.value.trim()) params.set('q', auditSearch.value.trim());
        const res = await fetch(`/api/hesap-loglari?${params.toString()}`);
        if (res.status === 401) { showLogin(); return; }
        const data = await okuJson(res);
        if (!data.ok) { auditStatus.textContent = `Hata: ${data.error}`; return; }

        renderAuditFilters(data.counts);
        auditList.innerHTML = '';

        if (data.entries.length === 0) {
            auditEmpty.textContent = data.total === 0
                ? 'Henüz kayıt yok. Girişler ve panelden yapılan işlemler burada birikecek.'
                : 'Aramaya/filtreye uyan kayıt yok.';
            auditEmpty.style.display = 'block';
            auditPager.style.display = 'none';
            auditStatus.textContent = `${data.total} kayıt`;
            return;
        }
        auditEmpty.style.display = 'none';

        data.entries.forEach((e) => {
            const bilgi = AUDIT_TYPES[e.type] || { label: e.type, sinif: '' };
            const div = document.createElement('div');
            div.className = `audit-row ${bilgi.sinif}`;
            div.innerHTML = `
                <span class="audit-time">${formatDate(e.at)}</span>
                <span class="audit-type">${escapeHtml(bilgi.label)}</span>
                <span class="audit-actor">${escapeHtml(e.actor || '—')}</span>
                <span class="audit-detail">${escapeHtml(e.detail || '')}</span>
                <span class="p-spacer"></span>
                ${e.ip ? `<span class="audit-ip">${escapeHtml(e.ip)}</span>` : ''}`;
            auditList.appendChild(div);
        });

        const bas = data.offset + 1;
        const son = data.offset + data.entries.length;
        auditPageInfo.textContent = `${bas}-${son} / ${data.matched}`;
        auditPrevBtn.disabled = data.offset === 0;
        auditNextBtn.disabled = son >= data.matched;
        auditPager.style.display = 'flex';
        auditStatus.textContent = `toplam ${data.total} kayıt`;
    } catch (error) {
        auditStatus.textContent = `Hata: ${error.message}`;
    }
}

auditSearch.addEventListener('input', () => {
    clearTimeout(auditSearchTimer);
    auditSearchTimer = setTimeout(() => { auditOffset = 0; loadAudit(); }, 250);
});
auditRefreshBtn.addEventListener('click', () => loadAudit());
auditPrevBtn.addEventListener('click', () => { auditOffset = Math.max(0, auditOffset - AUDIT_PAGE); loadAudit(); });
auditNextBtn.addEventListener('click', () => { auditOffset += AUDIT_PAGE; loadAudit(); });

// ============================================================================
// --- LOGO ETKİLEŞİMİ ---
// ============================================================================
// Kenar çubuğundaki logo: Yoklama sekmesine döner.
document.getElementById('sideBrand').addEventListener('click', () => {
    document.querySelector('.tab-btn[data-tab="yoklama"]').click();
});

// Giriş ekranındaki logo: fareyi izleyerek hafifçe eğilir.
// Kap olarak logonun KENDI bolumunu aliyoruz; ".login-card" yaziliyordu ve
// duzen degisince logo baska bir kapsayiciya tasindigi icin null donup
// sayfanin geri kalan betigini de dusuruyordu.
// ============================================================================
// --- GİRİŞ EKRANI: CANLI LOGO ---
// Logo fareyi izliyor: kendisi eğiliyor, halkalar ters yönde kayıyor
// (parallaks), parıltı imlecin olduğu tarafa doğru kayıyor. Üçü birlikte
// derinlik hissi veriyor - logo halkaların ÖNÜNDE duruyormuş gibi.
//
// Değerler doğrudan stille değil CSS değişkeniyle (--fx / --fy) veriliyor:
// her parçanın o değeri ne kadar kullanacağına CSS karar veriyor, JS yalnızca
// "fare şu kadar sağda/aşağıda" diyor.
//
// Hedefe yumuşatarak yaklaşıyoruz (lerp): imleci ani hareket ettirince logo
// zıplamıyor, arkasından süzülüyor. Güncelleme requestAnimationFrame ile,
// yani mousemove kaç kez tetiklenirse tetiklensin kare başına bir kez.
//
// NOT: eskiden buradaki kod .login-brand / .login-shell kaplarını arıyordu.
// Giriş ekranı hero yerleşimine geçince o iki sınıf kalktı ve efekt sessizce
// devre dışı kaldı - hata vermediği için fark edilmiyordu.
// ============================================================================
const heroSag = document.querySelector('.hero-sag');
const heroAlan = document.getElementById('loginWrap');
const hareketAzalt = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

if (heroSag && heroAlan && !hareketAzalt) {
    let hedefX = 0;
    let hedefY = 0;
    let suanX = 0;
    let suanY = 0;
    let kare = null;

    function adim() {
        // Yumuşatma katsayısı: 1'e yaklaştıkça daha ani.
        suanX += (hedefX - suanX) * 0.09;
        suanY += (hedefY - suanY) * 0.09;
        heroSag.style.setProperty('--fx', suanX.toFixed(4));
        heroSag.style.setProperty('--fy', suanY.toFixed(4));
        // Hedefe yeterince yaklaştıysak döngüyü durduruyoruz - imleç
        // durduğunda boşuna kare harcamasın.
        if (Math.abs(hedefX - suanX) > 0.0008 || Math.abs(hedefY - suanY) > 0.0008) {
            kare = requestAnimationFrame(adim);
        } else {
            kare = null;
        }
    }
    function tetikle() { if (!kare) kare = requestAnimationFrame(adim); }

    heroAlan.addEventListener('mousemove', (evt) => {
        const k = heroAlan.getBoundingClientRect();
        hedefX = (evt.clientX - k.left) / k.width - 0.5;
        hedefY = (evt.clientY - k.top) / k.height - 0.5;
        tetikle();
    });
    heroAlan.addEventListener('mouseleave', () => { hedefX = 0; hedefY = 0; tetikle(); });

    // Logoya tıklayınca kısa bir nabız - dokunmatik ekranda da bir karşılık
    // olsun diye (orada fare hareketi yok).
    heroSag.addEventListener('click', () => {
        heroSag.classList.remove('nabiz');
        // Sınıfı hemen geri eklemek animasyonu yeniden başlatmıyor; tarayıcının
        // yerleşimi yeniden hesaplaması gerekiyor.
        void heroSag.offsetWidth;
        heroSag.classList.add('nabiz');
    });
}

// ============================================================================
// --- PANEL LOGOSU (Ayarlar) ---
// Logo sunucudan /logo ucuyla geliyor; dosya adı ve uzantısı ne olursa olsun
// sunucu buluyor. Buradan yüklenince elle dosya kopyalamak gerekmiyor.
// ============================================================================
const logoFile = document.getElementById('logoFile');
const logoMsg = document.getElementById('logoMsg');

// Yükleme/silme sonrası tarayıcının eski görseli göstermemesi için tüm logo
// kaynaklarını yeni bir sorgu parametresiyle tazeliyoruz.
function refreshLogoImages() {
    const v = Date.now();
    document.querySelectorAll('.brand-img, #logoPreview img').forEach((img) => {
        img.style.display = '';
        const yedek = img.nextElementSibling;
        if (yedek && yedek.classList.contains('brand-fallback')) yedek.style.display = 'none';
        img.src = `/logo?v=${v}`;
    });
}

document.getElementById('logoPickBtn').addEventListener('click', () => logoFile.click());

logoFile.addEventListener('change', async () => {
    const dosya = logoFile.files && logoFile.files[0];
    if (!dosya) return;
    if (dosya.size > 3 * 1024 * 1024) {
        logoMsg.textContent = 'Dosya 3 MB üstü, daha küçük bir görsel seç.';
        logoFile.value = '';
        return;
    }
    logoMsg.textContent = `Yükleniyor... (${Math.round(dosya.size / 1024)} KB)`;
    try {
        const res = await fetch('/api/logo', {
            method: 'POST',
            headers: { 'Content-Type': dosya.type || 'application/octet-stream' },
            body: dosya,
        });
        const data = await okuJson(res);
        if (!data.ok) { logoMsg.textContent = `Hata: ${data.error}`; return; }
        logoMsg.textContent = `Yüklendi: ${data.name} (${Math.round(data.size / 1024)} KB)`;
        refreshLogoImages();
    } catch (error) {
        logoMsg.textContent = `Hata: ${error.message}`;
    } finally {
        logoFile.value = '';
    }
});

document.getElementById('logoRemoveBtn').addEventListener('click', async () => {
    if (!window.confirm('Panel logosu kaldırılsın mı? Yerine yazı logosu görünecek.')) return;
    try {
        const res = await fetch('/api/logo/sil', { method: 'POST' });
        const data = await okuJson(res);
        if (!data.ok) { logoMsg.textContent = `Hata: ${data.error}`; return; }
        logoMsg.textContent = 'Logo kaldırıldı.';
        // 404 dönecek, onerror yedek yazı logosunu gösterecek
        refreshLogoImages();
    } catch (error) {
        logoMsg.textContent = `Hata: ${error.message}`;
    }
});

// ============================================================================
// --- ETKİNLİK SAYACI ---
// Etkinlik/ticket kanalında kim kaç mesaj atmış. Tıklanınca o kişinin
// mesajları sağda açılıyor.
// ============================================================================
const activityChannels = document.getElementById('activityChannels');
const activityList = document.getElementById('activityList');
const activitySearch = document.getElementById('activitySearch');
const activityStatus = document.getElementById('activityStatus');
const activityRefreshBtn = document.getElementById('activityRefreshBtn');
const activityKpis = document.getElementById('activityKpis');
const activityWho = document.getElementById('activityWho');
const activityWhoInfo = document.getElementById('activityWhoInfo');
const activityMessages = document.getElementById('activityMessages');
const activityPager = document.getElementById('activityPager');
const actPageInfo = document.getElementById('actPageInfo');

const activityDiagBtn = document.getElementById('activityDiagBtn');

let actChannels = [];   // /api/etkinlik'ten gelen kaynak listesi

const actGrafikKart = document.getElementById('actGrafikKart');
const actGrafik = document.getElementById('actGrafik');
const actGrafikAlt = document.getElementById('actGrafikAlt');
const presGrafikKart = document.getElementById('presGrafikKart');
const presGrafik = document.getElementById('presGrafik');
const presGrafikAlt = document.getElementById('presGrafikAlt');

// Grafiğin altına hangi kaynağın çizildiği yazılıyor - Etkinlik'te üç ayrı
// kaynak var, grafik hangisine ait başka türlü anlaşılmıyor.
function aktifKanalEtiketi() {
    const k = actChannels.find((c) => c.key === actChannelKey);
    return k ? k.label : (actChannelKey || '');
}

const ACT_PAGE = 50;
let actChannelKey = null;
let actReport = null;
let actMemberId = null;
let actOffset = 0;
let actSearchTimer = null;

// Teşhis ekranı olan Etkinlik kaynakları: kaynak anahtarı -> uç.
// Yalnızca CANLI toplanan kaynakların buna ihtiyacı var. Kanal geçmişi
// çekilebilen kaynaklarda "kim sayıldı" sorusu Biçim kontrolü'nden görülüyor;
// sahiplenmede ise kanallar silindiği için geriye dönüp bakılacak bir şey yok,
// sayım sessizce durursa panelde "kimse ticket almamış" gibi görünüyor.
// Uç kaynağa özel olduğu için düğme de kaynağa özel: yeni bir canlı kaynak
// eklenirse kendi ucuyla birlikte buraya bir satır eklenir - böylece yanlış
// kaynağın teşhisi gösterilemez.
const ACT_TANI_UCLARI = { sahiplenme: '/api/sahiplenme/tani' };

function taniDugmesiniGuncelle() {
    activityDiagBtn.style.display = ACT_TANI_UCLARI[actChannelKey] ? '' : 'none';
}

function renderActivityChannels(kanallar) {
    // Grafik altyazisi hangi kaynagin cizildigini yaziyor; liste burada
    // saklanmazsa o bilgiye ulasilamiyor.
    actChannels = kanallar;
    activityChannels.innerHTML = kanallar.map((c) => {
        const etiket = c.configured ? escapeHtml(c.label) : `${escapeHtml(c.label)} (ID yok)`;
        return `<button class="chip${c.key === actChannelKey ? ' active' : ''}" data-actch="${c.key}">${etiket}</button>`;
    }).join('');
    activityChannels.querySelectorAll('[data-actch]').forEach((btn) => {
        btn.addEventListener('click', () => {
            actChannelKey = btn.dataset.actch;
            actMemberId = null;
            taniDugmesiniGuncelle();
            loadActivityReport();
        });
    });
    taniDugmesiniGuncelle();
}

function renderActivityList() {
    if (!actReport) return;
    const terim = activitySearch.value.trim().toLocaleLowerCase('tr');
    const liste = terim
        ? actReport.members.filter((m) => m.displayName.toLocaleLowerCase('tr').includes(terim)
            || m.tag.toLocaleLowerCase('tr').includes(terim))
        : actReport.members;

    activityList.innerHTML = '';
    if (liste.length === 0) {
        activityList.innerHTML = `<div class="empty-hint">${terim ? 'Aramaya uyan yetkili yok.' : 'Yetkili bulunamadı.'}</div>`;
        return;
    }

    const enYuksek = actReport.members.length ? actReport.members[0].count : 0;
    liste.forEach((m) => {
        const btn = document.createElement('button');
        let sinif = 'act-row';
        if (m.count === 0) sinif += ' zero';
        else if (m.count === enYuksek && enYuksek > 0) sinif += ' top';
        if (m.id === actMemberId) sinif += ' active';
        btn.className = sinif;
        btn.innerHTML = `
            <img src="${encodeURI(m.avatarURL)}" alt="">
            <span class="act-body">
                <span class="act-name">${escapeHtml(m.displayName)}</span>
                <span class="act-last">${m.lastAt
                    ? `son: ${formatDate(m.lastAt)}`
                    : (actMode === 'gunluk' ? 'bu gün hiç yok' : 'hiç mesaj yok')}</span>
            </span>
            <span class="act-count">${m.count}</span>`;
        btn.addEventListener('click', () => {
            actMemberId = m.id;
            actOffset = 0;
            renderActivityList();
            loadActivityMessages(m);
        });
        activityList.appendChild(btn);
    });
}

async function loadActivityReport() {
    if (!actChannelKey) return;
    if (actMode === 'gunluk') return loadDailyReport();
    // Tüm zamanlar modunda günlük döküm gelmiyor - grafik kartı kapalı.
    actGrafikKart.style.display = 'none';
    activityList.innerHTML = '<div class="iskelet">' + '<div class="iskelet-satir"></div>'.repeat(6) + '</div>';
    activityStatus.textContent = '';
    try {
        const res = await fetch(`/api/etkinlik/${actChannelKey}`);
        if (res.status === 401) { showLogin(); return; }
        const data = await okuJson(res);
        if (!data.ok) { activityStatus.textContent = `Hata: ${data.error}`; return; }
        actReport = data;

        if (!data.configured) {
            activityList.innerHTML = '<div class="empty-hint">Bu menü için kanal ID\'si girilmemiş.<br>server.js içindeki <b>ACTIVITY_CHANNELS</b> listesine ekle.</div>';
            activityKpis.style.display = 'none';
            activityStatus.textContent = '';
            return;
        }
        if (data.status === 'bekliyor' || data.status === 'yukleniyor') {
            activityStatus.textContent = data.status === 'bekliyor'
                ? 'Kanal geçmişi henüz çekilmedi - sırada bekliyor.'
                : `Geçmiş çekiliyor: ${data.loaded} mesaj...`;
        } else {
            activityStatus.textContent = `${data.totalMessages} mesaj · son güncelleme ${formatDate(data.fetchedAt)}`;
        }

        const yazan = data.members.filter((m) => m.count > 0).length;
        document.getElementById('actTotal').textContent = data.totalMessages;
        document.getElementById('actActive').textContent = yazan;
        document.getElementById('actSilent').textContent = data.members.length - yazan;
        activityKpis.style.display = 'flex';

        renderActivityList();
    } catch (error) {
        activityList.innerHTML = `<div class="empty-hint">Hata: ${escapeHtml(error.message)}</div>`;
    }
}

async function loadActivityMessages(member) {
    activityWho.textContent = member.displayName;
    activityMessages.innerHTML = '<div class="empty-hint">Yükleniyor...</div>';
    try {
        const params = new URLSearchParams({ memberId: member.id, offset: String(actOffset), limit: String(ACT_PAGE) });
        const res = await fetch(`/api/etkinlik/${actChannelKey}/mesajlar?${params.toString()}`);
        if (res.status === 401) { showLogin(); return; }
        const data = await okuJson(res);
        if (!data.ok) {
            activityMessages.innerHTML = `<div class="empty-hint">Hata: ${escapeHtml(data.error)}</div>`;
            return;
        }
        activityWhoInfo.textContent = `${data.total} mesaj`;

        if (data.messages.length === 0) {
            activityMessages.innerHTML = '<div class="empty-hint">Bu kişinin bu kanalda hiç mesajı yok.</div>';
            activityPager.style.display = 'none';
            return;
        }
        activityMessages.innerHTML = '';
        data.messages.forEach((entry) => activityMessages.appendChild(renderLogEntry(entry)));
        activityMessages.scrollTop = 0;

        const bas = data.offset + 1;
        const son = data.offset + data.messages.length;
        actPageInfo.textContent = `${bas}-${son} / ${data.total}`;
        document.getElementById('actPrevBtn').disabled = data.offset === 0;
        document.getElementById('actNextBtn').disabled = son >= data.total;
        activityPager.style.display = 'flex';
    } catch (error) {
        activityMessages.innerHTML = `<div class="empty-hint">Hata: ${escapeHtml(error.message)}</div>`;
    }
}

function actSelectedMember() {
    return actReport && actReport.members.find((m) => m.id === actMemberId);
}
document.getElementById('actPrevBtn').addEventListener('click', () => {
    actOffset = Math.max(0, actOffset - ACT_PAGE);
    const m = actSelectedMember(); if (m) loadActivityMessages(m);
});
document.getElementById('actNextBtn').addEventListener('click', () => {
    actOffset += ACT_PAGE;
    const m = actSelectedMember(); if (m) loadActivityMessages(m);
});
activitySearch.addEventListener('input', () => {
    clearTimeout(actSearchTimer);
    actSearchTimer = setTimeout(renderActivityList, 200);
});
activityRefreshBtn.addEventListener('click', () => loadActivityReport());

async function initActivityTab() {
    try {
        const res = await fetch('/api/etkinlik');
        if (res.status === 401) { showLogin(); return; }
        const data = await okuJson(res);
        if (!data.ok) return;
        if (!actChannelKey) {
            // Varsayilan: ID'si girilmis ilk menu
            const ilk = data.channels.find((c) => c.configured) || data.channels[0];
            actChannelKey = ilk ? ilk.key : null;
        }
        renderActivityChannels(data.channels);
        await loadActivityReport();
    } catch (error) {
        activityStatus.textContent = `Hata: ${error.message}`;
    }
}

// ============================================================================
// --- ETKİNLİK: GÜNLÜK GÖRÜNÜM + CANLI SAYAÇ ---
// ============================================================================
const actDayControls = document.getElementById('actDayControls');
const actPresetRow = document.getElementById('actPresetRow');
const actDayInput = document.getElementById('actDay');
const actDayBitInput = document.getElementById('actDayBit');
const actPresets = document.getElementById('actPresets');
const actRangeInfo = document.getElementById('actRangeInfo');
let actMode = 'toplam';   // 'toplam' | 'gunluk'
let actDay = null;        // aralik baslangici (YYYY-MM-DD)
let actDayBit = null;     // aralik bitisi
let actToday = null;

function bugunIso() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function gunKaydir(gun, adim) {
    const [y, a, g] = gun.split('-').map(Number);
    const d = new Date(Date.UTC(y, a - 1, g));
    d.setUTCDate(d.getUTCDate() + adim);
    return d.toISOString().slice(0, 10);
}

// İki gün arası kaç gün (her iki uç dahil).
function gunFarki(bas, bit) {
    const ms = (g) => { const [y, a, d] = g.split('-').map(Number); return Date.UTC(y, a - 1, d); };
    return Math.round((ms(bit) - ms(bas)) / 86400000) + 1;
}

// "Cumadan cumaya" dönem: Cuma günü başlayan 7 günlük dilim (Cuma..Perşembe).
// Örnek: ayın 15'i Cuma ise dönem 15-21. offset=-1 bir önceki dönem.
function cumaDonemi(bugun, offset = 0) {
    const [y, a, g] = bugun.split('-').map(Number);
    const d = new Date(Date.UTC(y, a - 1, g));
    // getUTCDay: 0=Paz, 5=Cuma. Bugünden geriye en yakın Cuma'ya kaç gün var?
    const geri = (d.getUTCDay() - 5 + 7) % 7;
    const bas = gunKaydir(bugun, -geri + offset * 7);
    return { bas, bit: gunKaydir(bas, 6) };
}

// Hazır dönem düğmelerinin karşılığı.
function hazirAralik(ad, bugun) {
    switch (ad) {
        case 'bugun': return { bas: bugun, bit: bugun };
        case 'son7': return { bas: gunKaydir(bugun, -6), bit: bugun };
        case 'son30': return { bas: gunKaydir(bugun, -29), bit: bugun };
        case 'hafta': return cumaDonemi(bugun, 0);
        case 'oncekiHafta': return cumaDonemi(bugun, -1);
        default: return { bas: bugun, bit: bugun };
    }
}

// Seçili aralığı okunur biçimde yazar.
function aralikMetni(bas, bit, bugun) {
    if (bas === bit) return bas === bugun ? 'Bugün' : bas;
    return `${bas} → ${bit} (${gunFarki(bas, bit)} gün)`;
}

// Hangi hazır düğme seçili aralığa denk geliyorsa onu işaretler.
function presetIsaretle(kap, bas, bit, bugun) {
    kap.querySelectorAll('[data-preset]').forEach((btn) => {
        const a = hazirAralik(btn.dataset.preset, bugun);
        btn.classList.toggle('active', a.bas === bas && a.bit === bit);
    });
}

document.querySelectorAll('[data-actmode]').forEach((btn) => {
    btn.addEventListener('click', () => {
        actMode = btn.dataset.actmode;
        document.querySelectorAll('[data-actmode]').forEach((b) => b.classList.toggle('active', b === btn));
        actDayControls.style.display = actMode === 'gunluk' ? 'flex' : 'none';
        actPresetRow.style.display = actMode === 'gunluk' ? 'flex' : 'none';
        actMemberId = null;
        loadActivityReport();
    });
});
// ← / → aralığın UZUNLUĞU kadar kaydırıyor: 7 günlük dönemdeyken bir önceki
// 7 güne gidiyor, tek gündeyken bir önceki güne. Tek gün adımı atsaydı
// haftalık dönemler örtüşürdü.
function actAralikKaydir(yon) {
    if (!actDay || !actDayBit) return;
    const uzunluk = gunFarki(actDay, actDayBit);
    actDay = gunKaydir(actDay, yon * uzunluk);
    actDayBit = gunKaydir(actDayBit, yon * uzunluk);
    loadActivityReport();
}
document.getElementById('actDayPrev').addEventListener('click', () => actAralikKaydir(-1));
document.getElementById('actDayNext').addEventListener('click', () => actAralikKaydir(1));

actPresets.addEventListener('click', (evt) => {
    const btn = evt.target.closest('[data-preset]');
    if (!btn) return;
    const a = hazirAralik(btn.dataset.preset, actToday || bugunIso());
    actDay = a.bas; actDayBit = a.bit;
    loadActivityReport();
});

[actDayInput, actDayBitInput].forEach((girdi) => {
    girdi.addEventListener('change', () => {
        if (!actDayInput.value || !actDayBitInput.value) return;
        actDay = actDayInput.value;
        actDayBit = actDayBitInput.value;
        loadActivityReport();
    });
});

// Günlük moddaki raporu çeker. Tüm zamanlar modu mevcut loadActivityReport'u
// kullanmaya devam ediyor - ikisi aynı listeyi besliyor.
async function loadDailyReport() {
    if (!actChannelKey) return;
    activityList.innerHTML = '<div class="iskelet">' + '<div class="iskelet-satir"></div>'.repeat(6) + '</div>';
    try {
        const params = actDay
            ? `?bas=${encodeURIComponent(actDay)}&bit=${encodeURIComponent(actDayBit || actDay)}`
            : '';
        const res = await fetch(`/api/etkinlik/${actChannelKey}/gunluk${params}`);
        if (res.status === 401) { showLogin(); return; }
        const data = await okuJson(res);
        if (!data.ok) { activityStatus.textContent = `Hata: ${data.error}`; return; }

        actToday = data.today;
        actDay = data.bas;
        actDayBit = data.bit;
        actDayInput.value = actDay;
        actDayBitInput.value = actDayBit;
        actDayInput.max = actToday;
        // Bitise ust sinir koymuyoruz: suren donem (or. Cuma-Persembe) bugunden
        // sonra bitiyor ve max=bugun degeri kendi sinirinin disinda birakirdi.
        actRangeInfo.textContent = aralikMetni(actDay, actDayBit, actToday);
        presetIsaretle(actPresets, actDay, actDayBit, actToday);
        actReport = data;

        if (!data.configured) {
            activityList.innerHTML = '<div class="empty-hint">Bu menü için kanal ID\'si girilmemiş.<br>server.js içindeki <b>ACTIVITY_CHANNELS</b> listesine ekle.</div>';
            activityKpis.style.display = 'none';
            return;
        }

        const yazan = data.members.filter((m) => m.count > 0).length;
        document.getElementById('actTotal').textContent = data.dayTotal;
        document.getElementById('actActive').textContent = yazan;
        document.getElementById('actSilent').textContent = data.members.length - yazan;
        activityKpis.style.display = 'flex';

        // Son 14 gün grafiği. Yalnızca uç availableDays döndürdüğünde çiziliyor;
        // "Tüm zamanlar" modunda o alan gelmiyor ve kart gizleniyor - boş bir
        // grafik iskeleti göstermektense hiç göstermemek daha dürüst.
        actGrafikKart.style.display =
            gunlukGrafikCiz(actGrafik, data.availableDays, (n) => `${n} mesaj`) ? '' : 'none';
        actGrafikAlt.textContent = `${aktifKanalEtiketi()} · günlük toplam mesaj`;

        const gunAdi = aralikMetni(actDay, actDayBit, actToday);
        activityStatus.textContent = `${gunAdi}: ${data.dayTotal} kayıt`
            + (data.otherTotal ? ` (${data.otherTotal} yetkili dışı)` : '')
            + (data.unmatched ? ` · ${data.unmatched} mesajda kişi bulunamadı` : '');

        renderActivityList();

        // O gün hiç kayıt yoksa liste sıfırlarla dolu kalıyor ve veri
        // silinmiş gibi görünüyor. Durumu açıkça yazıp veri olan son güne
        // atlama kısayolu veriyoruz.
        if (data.dayTotal === 0) {
            const doluGunler = (data.availableDays || []).filter((g) => g.total > 0);
            const sonGun = doluGunler.find((g) => g.day !== actDay);
            const kutu = document.createElement('div');
            kutu.className = 'empty-hint';
            kutu.style.marginBottom = '8px';
            kutu.innerHTML = doluGunler.length === 0
                ? 'Bu kanalda hiç kayıt yok.'
                : `<b>${escapeHtml(gunAdi)}</b> için henüz kayıt yok.<br>`
                  + `Veri olan günler: ${doluGunler.slice(0, 5).map((g) => `${escapeHtml(g.day)} (${g.total})`).join(' · ')}`
                  + (sonGun ? `<br><button class="secondary small" id="actJump" style="margin-top:9px;">${escapeHtml(sonGun.day)} gününe git</button>` : '');
            activityList.prepend(kutu);
            const atla = document.getElementById('actJump');
            if (atla) {
                atla.addEventListener('click', () => {
                    actDay = sonGun.day;
                    actDayBit = sonGun.day;
                    loadActivityReport();
                });
            }
        }
    } catch (error) {
        activityList.innerHTML = `<div class="empty-hint">Hata: ${escapeHtml(error.message)}</div>`;
    }
}

// Günlük modda sayaçlar anlık artsın - kullanıcı yenilemeyi beklemesin.
function onActivityIncrement(msg) {
    if (msg.key !== actChannelKey || !actReport) return;
    if (actMode === 'gunluk' && msg.gun !== actDay) return;

    const uye = actReport.members.find((m) => m.id === msg.memberId);
    if (!uye) { loadActivityReport(); return; } // listede yoksa tazele
    uye.count = actMode === 'gunluk' ? msg.count : uye.count + 1;
    if (msg.last) uye.lastAt = msg.last;

    const eskiSira = actReport.members.indexOf(uye);
    actReport.members.sort((a, b) => (b.count - a.count) || a.displayName.localeCompare(b.displayName, 'tr'));
    if (actReport.dayTotal !== undefined) actReport.dayTotal += 1;
    if (actReport.totalMessages !== undefined) actReport.totalMessages += 1;

    renderActivityList();
    const satir = [...activityList.querySelectorAll('.act-row')]
        .find((el) => el.querySelector('.act-name').textContent.trim() === uye.displayName);
    if (satir) {
        satir.classList.add('flash');
        setTimeout(() => satir.classList.remove('flash'), 1500);
    }
    const yazan = actReport.members.filter((m) => m.count > 0).length;
    document.getElementById('actTotal').textContent = actReport.dayTotal ?? actReport.totalMessages;
    document.getElementById('actActive').textContent = yazan;
    document.getElementById('actSilent').textContent = actReport.members.length - yazan;
    void eskiSira;
}

// ============================================================================
// --- BİÇİM KONTROLÜ ---
// Ticket botunun mesaj biçimini görmeden kurulan kişi çıkarımı doğru mu?
// Hangi yöntemin ne kadar tuttuğunu ve örnek mesajları gösterir.
// ============================================================================
document.getElementById('activityFormatBtn').addEventListener('click', async () => {
    if (!actChannelKey) return;
    activityWho.textContent = 'Biçim kontrolü';
    activityWhoInfo.textContent = '';
    activityMessages.innerHTML = '<div class="empty-hint">Kontrol ediliyor...</div>';
    activityPager.style.display = 'none';
    try {
        const res = await fetch(`/api/etkinlik/${actChannelKey}/bicim`);
        if (res.status === 401) { showLogin(); return; }
        const d = await okuJson(res);
        if (!d.ok) {
            activityMessages.innerHTML = `<div class="empty-hint">${escapeHtml(d.error)}</div>`;
            return;
        }

        const oran = d.total ? Math.round((d.matched / d.total) * 100) : 0;
        const yetkiliOran = d.total ? Math.round((d.staffMatched / d.total) * 100) : 0;
        // Tek kişiye yığılma, çıkarımın yanlış olduğunun en net işareti.
        const supheli = d.distinctPeople <= 1 || yetkiliOran < 40;

        const yontemler = Object.entries(d.methods)
            .map(([ad, adet]) => `<span class="legend">${escapeHtml(ad)}: ${adet}</span>`).join('');
        const yazarlar = d.topAuthors
            .map((a) => `<span class="legend">${escapeHtml(a.tag)}: ${a.count}</span>`).join('');

        activityMessages.innerHTML = `
            <div class="card" style="margin:0 0 10px;">
                <h2>${escapeHtml(d.label)} — kişi çıkarımı</h2>
                <p class="card-desc" style="margin-bottom:9px;">
                    Yöntem: <b>${escapeHtml(d.personFrom)}</b> ·
                    ${d.total} mesajın <b>${d.matched}</b>'inde kişi bulundu (%${oran}) ·
                    <b>${d.distinctPeople}</b> farklı kişiye dağıldı ·
                    yetkililere denk gelen: <b>%${yetkiliOran}</b>
                </p>
                <div class="legend-row">${yontemler}</div>
                <p class="card-desc" style="margin:8px 0 4px;">Kanala en çok yazanlar (mesaj sahibi):</p>
                <div class="legend-row">${yazarlar}</div>
                <div class="${supheli ? 'legend bad' : 'legend ok'}" style="margin-top:10px;">
                    ${supheli
                        ? '⚠ Çıkarım şüpheli — sayımlar yanlış kişilere gidiyor olabilir. Aşağıdaki örnek mesajları Claude\'a gönder.'
                        : '✓ Çıkarım sağlıklı görünüyor.'}
                </div>
            </div>
            <p class="card-desc" style="margin:0 0 8px;">Örnek mesajlar (kime sayıldığı yanında):</p>`;

        d.samples.forEach((entry) => {
            const kutu = document.createElement('div');
            kutu.style.marginBottom = '8px';
            const bilgi = document.createElement('div');
            bilgi.className = 'scanStatus';
            bilgi.style.margin = '0 0 3px 4px';
            bilgi.textContent = entry.resolved.id
                ? `→ ${entry.resolved.id} (${entry.resolved.via})`
                : '→ kişi bulunamadı';
            kutu.appendChild(bilgi);
            kutu.appendChild(renderLogEntry(entry));
            activityMessages.appendChild(kutu);
        });
    } catch (error) {
        activityMessages.innerHTML = `<div class="empty-hint">Hata: ${escapeHtml(error.message)}</div>`;
    }
});

// ============================================================================
// --- TICKET SAHİPLENME TEŞHİSİ ---
// Sahiplenme CANLI toplanıyor; ticket kanalları silindiği için geriye dönüp
// bakılacak bir geçmiş yok. Yani sayım durursa panel bunu "kimse ticket
// almamış" diye gösterir - veri kaybıyla bozuk kurulum aynı görünür.
// Bu ekran ikisini ayırır:
//   kategoride mesaj görülüyor + hiç sayım yok -> botun metni değişmiş
//   kategoride hiç mesaj görülmedi            -> kategori ID'si yanlış
// ============================================================================
activityDiagBtn.addEventListener('click', async () => {
    const uc = ACT_TANI_UCLARI[actChannelKey];
    if (!uc) return;

    activityWho.textContent = 'Sahiplenme teşhisi';
    activityWhoInfo.textContent = '';
    activityPager.style.display = 'none';
    activityMessages.innerHTML = '<div class="empty-hint">Kontrol ediliyor...</div>';
    try {
        const res = await fetch(uc);
        if (res.status === 401) { showLogin(); return; }
        const d = await okuJson(res);
        if (!d.ok) {
            activityMessages.innerHTML = `<div class="empty-hint">Hata: ${escapeHtml(d.error)}</div>`;
            return;
        }

        // Uç ham Discord ID'si döndürüyor. Yetkili listesi zaten yüklü olduğu
        // için isme çevirebiliyoruz; listede olmayan (ticket açan sıradan
        // üye, bot) için ID'nin kendisi kalıyor.
        const isimler = new Map(((actReport && actReport.members) || []).map((m) => [m.id, m.displayName]));
        const kisiAdi = (id) => (id ? (isimler.get(id) || id) : 'bilinmiyor');

        const eslesmeyenler = d.eslesmeyenler || [];
        const bugun = d.bugun || [];
        const sonKayitlar = d.sonKayitlar || [];
        // Sıradan ticket sohbeti de kalıba uymaz; "eşleşmeyen var" tek başına
        // sorun DEĞİL. Bakılacak olan, embed'li bir mesajın uymaması.
        const botUymayan = eslesmeyenler.filter((m) => m.embedli);

        const sorunlar = [];
        const bilgiler = [];
        if (d.toplamKayit === 0 && eslesmeyenler.length === 0) {
            sorunlar.push('Kategoride hiç mesaj görülmedi. Kategori ID\'si yanlış olabilir; '
                + 'ya da bot açıldığından beri o kategoride hiç yazışma olmamıştır.');
        } else if (d.toplamKayit === 0) {
            sorunlar.push('Kategoride mesaj görülüyor ama hiç sahiplenme sayılmadı - '
                + 'ticket botunun metni aranan kalıba uymuyor.');
        } else if (botUymayan.length) {
            bilgiler.push(`${botUymayan.length} embed'li mesaj kalıba uymadı. Bot ikinci bir metin `
                + 'kullanıyorsa o sahiplenmeler sayılmıyor - aşağıdaki listeden bak.');
        }
        // Kayıt var ama uzun süredir yeni yok: sayım son zamanlarda durmuş
        // olabilir. Sunucu sakin de olabileceği için sorun değil, bilgi.
        const sonAt = sonKayitlar.length ? sonKayitlar[0].at : null;
        if (sonAt && Date.now() - sonAt > 7 * 86400000) {
            bilgiler.push(`En son sahiplenme ${Math.floor((Date.now() - sonAt) / 86400000)} gün önce sayıldı.`);
        }
        // Eşleşmeyen tamponu bellekte; yeniden başlatmada sıfırlanıyor.
        if (d.toplamKayit > 0 && eslesmeyenler.length === 0) {
            bilgiler.push('Yeniden başlatmadan bu yana kalıba uymayan mesaj görülmedi.');
        }

        const satir = (ad, deger) => `<div class="tani-satir"><span>${escapeHtml(ad)}</span><b>${escapeHtml(String(deger))}</b></div>`;
        const bugunToplam = bugun.reduce((t, k) => t + k.adet, 0);

        const bugunChips = bugun.length
            ? bugun.slice().sort((a, b) => b.adet - a.adet)
                .map((k) => `<span class="legend ok">${escapeHtml(kisiAdi(k.id))} · ${escapeHtml(String(k.adet))}</span>`).join('')
            : '<span class="scanStatus">Bugün henüz sahiplenme sayılmadı.</span>';

        const sonListe = sonKayitlar.length
            ? sonKayitlar.map((k) => `<div class="tani-satir"><span>${escapeHtml(formatDate(k.at))}`
                + `${k.kanal ? ` · ${escapeHtml(k.kanal)}` : ''}</span>`
                + `<b>${escapeHtml(kisiAdi(k.kisi))}</b></div>`).join('')
            : '<p class="card-desc" style="margin:0;">Henüz kayıt yok.</p>';

        const uymayanListe = eslesmeyenler.length
            ? eslesmeyenler.map((m) => {
                const stil = 'margin:0 0 7px; padding:7px 9px; border-radius:var(--radius-s); '
                    + `border:1px solid ${m.embedli ? 'var(--attn-line)' : 'var(--border)'};`
                    + (m.embedli ? ' background:var(--attn-soft);' : '');
                const metin = m.metin
                    ? escapeHtml(m.metin)
                    : '<span class="scanStatus">(metin yok)</span>';
                return `<div style="${stil}">
                    <div class="scanStatus" style="margin-bottom:3px;">
                        ${escapeHtml(formatDate(m.at))}${m.channelName ? ` · ${escapeHtml(m.channelName)}` : ''}
                        · yazan: ${escapeHtml(kisiAdi(m.authorId))}${m.embedli ? ' · <b>embed</b>' : ''}
                    </div>
                    ${m.baslik ? `<div style="margin-bottom:2px;"><b>${escapeHtml(m.baslik)}</b></div>` : ''}
                    <div style="font-size:12px; word-break:break-word;">${metin}</div>
                </div>`;
            }).join('')
            : '<p class="card-desc" style="margin:0;">Kalıba uymayan mesaj görülmedi.</p>';

        activityMessages.innerHTML = `
            <div class="card" style="margin:0 0 10px;">
                <h2>Ticket sahiplenme teşhisi</h2>
                <div class="${sorunlar.length ? 'legend bad' : 'legend ok'}" style="margin-bottom:12px;">
                    ${sorunlar.length ? `⚠ ${escapeHtml(sorunlar[0])}` : '✓ Sayım çalışıyor'}
                </div>
                ${sorunlar.length > 1 ? `<p class="card-desc">${sorunlar.slice(1).map(escapeHtml).join('<br>')}</p>` : ''}
                ${bilgiler.length ? `<p class="card-desc">${bilgiler.map(escapeHtml).join('<br>')}</p>` : ''}
                ${satir('Kategori ID', d.kategori)}
                ${satir('Aranan kalıp', d.kalip)}
                ${satir('Toplam sayılan', d.toplamKayit)}
                ${satir('Bugün sayılan', `${bugunToplam} kayıt · ${bugun.length} kişi`)}
                ${satir('En son sahiplenme', sonAt ? formatDate(sonAt) : 'yok')}
                ${satir('Kalıba uymayan (son)', `${eslesmeyenler.length} mesaj · ${botUymayan.length} embed'li`)}
                <p class="card-desc" style="margin:12px 0 6px;">Bugün sahiplenenler:</p>
                <div class="legend-row">${bugunChips}</div>
                <p class="card-desc" style="margin:12px 0 2px;">Son sayılan kayıtlar:</p>
                ${sonListe}
            </div>
            <div class="card" style="margin:0;">
                <h2>Kalıba uymayan son mesajlar</h2>
                <p class="card-desc" style="margin-bottom:9px;">
                    Ticket kategorisindeki <b>her</b> mesaj kalıp denemesinden geçiyor, yani
                    buradaki sıradan sohbet <b>normal</b> - liste dolu diye sayım bozuk değil.
                    Asıl bakılacak olan <b>embed'li</b> (sarı) satırlar: bot bir sahiplenme
                    mesajı atmış ama kalıba uymamışsa metin değişmiş demektir.
                    Liste yalnızca en son mesajları tutar ve bot yeniden başlayınca sıfırlanır.
                </p>
                ${uymayanListe}
            </div>`;
    } catch (error) {
        activityMessages.innerHTML = `<div class="empty-hint">Hata: ${escapeHtml(error.message)}</div>`;
    }
});

// ============================================================================
// --- YENİ TICKET'A OTOMATİK MESAJ (Ayarlar) ---
// ============================================================================
const ticketAutoEnabled = document.getElementById('ticketAutoEnabled');
const ticketAutoMsg = document.getElementById('ticketAutoMsg');
const ticketAutoTarget = document.getElementById('ticketAutoTarget');
const ticketAutoRecent = document.getElementById('ticketAutoRecent');
const ticketAutoSekmeler = document.getElementById('ticketAutoSekmeler');
const ticketAutoKutular = document.getElementById('ticketAutoKutular');
const ticketAutoKatAcikSatiri = document.getElementById('ticketAutoKatAcikSatiri');
const ticketAutoKatAcik = document.getElementById('ticketAutoKatAcik');
const ticketAutoKatAcikEtiket = document.getElementById('ticketAutoKatAcikEtiket');
const acKarsilamaAyar = document.getElementById('acKarsilamaAyar');
const acKarsilamaHesapSec = document.getElementById('acKarsilamaHesapSec');
const acKarsilamaDurum = document.getElementById('acKarsilamaDurum');

// AC karşılama ayarı sunucudan gelir: { acik, hesap, etkin, hesaplar[] }.
let acKarsilamaVeri = { acik: true, hesap: '', etkin: null, hesaplar: [] };

// Kategori bazlı metin kutuları. Her kategori için bir <textarea>, ama aynı
// anda yalnızca biri görünür - üstteki sekmelerden seçiliyor. Metinler burada
// tutuluyor ki sekme değiştirince yazılan kaybolmasın.
let ticketAutoKategoriler = [];
let ticketAutoAktifKat = null;
// Kategori bazlı aç/kapa durumları (yalnızca kendi anahtarı olanlar için).
// key -> bool. Sekme değişince kaybolmasın diye burada tutuluyor.
const ticketAutoAcikDurum = {};

function ticketAutoSekmeCiz() {
    ticketAutoSekmeler.innerHTML = ticketAutoKategoriler.map((k) => `
        <button type="button" class="chip${k.key === ticketAutoAktifKat ? ' active' : ''}"
            data-tkkat="${escapeHtml(k.key)}">${escapeHtml(k.label)}</button>`).join('');
    ticketAutoSekmeler.querySelectorAll('[data-tkkat]').forEach((btn) => {
        btn.addEventListener('click', () => {
            ticketAutoAktifKat = btn.dataset.tkkat;
            ticketAutoSekmeCiz();
            ticketAutoKutuGoster();
        });
    });
}

function ticketAutoKutuGoster() {
    ticketAutoKutular.querySelectorAll('textarea').forEach((t) => {
        t.hidden = t.dataset.tkkat !== ticketAutoAktifKat;
    });
    const kat = ticketAutoKategoriler.find((k) => k.key === ticketAutoAktifKat);
    ticketAutoTarget.innerHTML = kat
        ? `Kategori <b>${escapeHtml(kat.categoryId)}</b>`
            + (ticketAutoInGuild
                ? ' · sunucuya bağlı ✓'
                : ' · <span style="color:var(--attn)">⚠ hesap sunucuda görünmüyor, olay gelmez</span>')
        : '';

    // Kategorinin kendi aç/kapa anahtarı varsa göster; yoksa gizle (genel
    // şaltere uyar). Örn. AC'nin kendi anahtarı var, YT'nin yok.
    if (kat && kat.acikDuzenlenir) {
        ticketAutoKatAcikSatiri.hidden = false;
        ticketAutoKatAcik.checked = Boolean(ticketAutoAcikDurum[kat.key]);
        ticketAutoKatAcikEtiket.textContent = kat.key === 'ac'
            ? 'AC karşılaması açık (AC\'nin kendi hesabından gönderilir)'
            : `"${kat.label}" kategorisinde otomatik mesaj açık`;
    } else {
        ticketAutoKatAcikSatiri.hidden = true;
    }

    // Karşılayan AC hesabı seçimi yalnızca AC kategorisinde görünür.
    if (kat && kat.key === 'ac') {
        acKarsilamaAyar.hidden = false;
        acKarsilamaDurumCiz();
    } else {
        acKarsilamaAyar.hidden = true;
    }
}

// Karşılayan AC hesabı seçimini ve durum yazısını çizer.
function acKarsilamaDurumCiz() {
    const hesaplar = acKarsilamaVeri.hesaplar || [];
    const secili = acKarsilamaHesapSec.value || acKarsilamaVeri.hesap || '';
    acKarsilamaHesapSec.innerHTML = '<option value="">Otomatik (tek AC bağlıysa o)</option>'
        + hesaplar.map((h) => `<option value="${escapeHtml(h.username)}"${h.username === secili ? ' selected' : ''}>`
            + `${escapeHtml(h.username)}${h.tokenVar ? '' : ' — token yok'}</option>`).join('');
    acKarsilamaHesapSec.value = secili;

    const etkin = acKarsilamaVeri.etkin;
    if (!acKarsilamaVeri.acik) {
        acKarsilamaDurum.textContent = 'AC karşılaması kapalı.';
    } else if (etkin) {
        acKarsilamaDurum.textContent = `Karşılayan: ${etkin} (kendi hesabından)`;
    } else if (hesaplar.length === 0) {
        acKarsilamaDurum.innerHTML = '<span style="color:var(--attn)">⚠ Hiç AC hesabı yok. Önce AC hesabı aç ve token bağlat.</span>';
    } else {
        acKarsilamaDurum.innerHTML = '<span style="color:var(--attn)">⚠ Karşılayacak hesap belirsiz. Bir AC hesabı seç (token\'ı bağlı olmalı).</span>';
    }
}

// Kullanıcı kategori anahtarını değiştirince canlı durumu sakla (kaydedene
// kadar yalnızca bellekte; Kaydet'e basınca sunucuya gider).
ticketAutoKatAcik.addEventListener('change', () => {
    if (ticketAutoAktifKat) ticketAutoAcikDurum[ticketAutoAktifKat] = ticketAutoKatAcik.checked;
});

// Karşılayan AC hesabı seçimi değişince önizlemeyi güncelle. Seçilen hesabın
// token'ı yoksa etkin karşılayan yine belirsiz kalır - bunu hemen göster.
acKarsilamaHesapSec.addEventListener('change', () => {
    acKarsilamaVeri.hesap = acKarsilamaHesapSec.value;
    const secili = acKarsilamaHesapSec.value;
    if (secili) {
        const h = (acKarsilamaVeri.hesaplar || []).find((x) => x.username === secili);
        acKarsilamaVeri.etkin = h && h.tokenVar ? secili : null;
    } else {
        const tokenli = (acKarsilamaVeri.hesaplar || []).filter((x) => x.tokenVar);
        acKarsilamaVeri.etkin = tokenli.length === 1 ? tokenli[0].username : null;
    }
    acKarsilamaDurumCiz();
});

let ticketAutoInGuild = false;

async function loadTicketAuto() {
    try {
        const res = await fetch('/api/ticket-otomatik');
        if (res.status === 401) { showLogin(); return; }
        const d = await okuJson(res);
        if (!d.ok) return;
        ticketAutoEnabled.checked = d.enabled;
        document.getElementById('ticketAutoGecikme').value = d.gecikmeSn;
        ticketAutoInGuild = Boolean(d.inGuild);
        ticketAutoKategoriler = d.kategoriler || [];
        // AC karşılama verisi - kullanıcı dropdown'la oynamıyorsa sunucuyla eşitle.
        if (d.acKarsilama && document.activeElement !== acKarsilamaHesapSec) {
            acKarsilamaVeri = d.acKarsilama;
        }

        // Metin kutularını yalnızca ilk yüklemede (ya da kategori sayısı
        // değişince) yeniden kuruyoruz - her yüklemede sıfırdan yazsaydık
        // kullanıcının o an yazdığı metnin üstüne binerdi.
        const mevcut = [...ticketAutoKutular.querySelectorAll('textarea')].map((t) => t.dataset.tkkat);
        const gelenAnahtar = ticketAutoKategoriler.map((k) => k.key);
        if (mevcut.join(',') !== gelenAnahtar.join(',')) {
            ticketAutoKutular.innerHTML = ticketAutoKategoriler.map((k) => `
                <textarea class="text-search" data-tkkat="${escapeHtml(k.key)}" rows="11"
                    style="width:100%; resize:vertical; line-height:1.6;"></textarea>`).join('');
        }
        // Metinleri doldur. Kullanıcı bu kutuda değişiklik yapmadıysa
        // sunucudakiyle eşitliyoruz (başka biri kaydetmiş olabilir).
        ticketAutoKategoriler.forEach((k) => {
            const t = ticketAutoKutular.querySelector(`textarea[data-tkkat="${k.key}"]`);
            if (t && document.activeElement !== t) t.value = k.message;
            // Kategori anahtar durumunu sunucudan al - ama kullanıcı o an bu
            // kategorinin anahtarıyla oynuyorsa (odaktaysa) üstüne yazma.
            if (k.acikDuzenlenir) {
                const oynuyor = document.activeElement === ticketAutoKatAcik
                    && ticketAutoAktifKat === k.key;
                if (!oynuyor) ticketAutoAcikDurum[k.key] = Boolean(k.acik);
            }
        });
        if (!ticketAutoAktifKat || !gelenAnahtar.includes(ticketAutoAktifKat)) {
            ticketAutoAktifKat = gelenAnahtar[0] || null;
        }
        ticketAutoSekmeCiz();
        ticketAutoKutuGoster();
        renderTicketAutoRecent(d.recent);
    } catch (error) {
        ticketAutoMsg.textContent = `Hata: ${error.message}`;
    }
}

function renderTicketAutoRecent(kayitlar) {
    if (!kayitlar || kayitlar.length === 0) {
        ticketAutoRecent.textContent = 'Henüz otomatik mesaj yazılmadı.';
        return;
    }
    ticketAutoRecent.innerHTML = 'Son yazılanlar: '
        + kayitlar.slice(0, 5).map((k) => `<span class="legend">`
            + (k.kategoriAd ? `${escapeHtml(k.kategoriAd)} · ` : '')
            + `#${escapeHtml(k.channelName)} · ${formatDate(k.at)}</span>`).join(' ');
}

document.getElementById('ticketAutoSaveBtn').addEventListener('click', async () => {
    ticketAutoMsg.textContent = 'Kaydediliyor...';
    try {
        const res = await fetch('/api/ticket-otomatik', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                enabled: ticketAutoEnabled.checked,
                mesajlar: Object.fromEntries(
                    [...ticketAutoKutular.querySelectorAll('textarea')]
                        .map((t) => [t.dataset.tkkat, t.value])),
                // Yalnızca kendi anahtarı olan kategorilerin aç/kapa durumu.
                acikDurumlar: Object.fromEntries(
                    ticketAutoKategoriler
                        .filter((k) => k.acikDuzenlenir)
                        .map((k) => [k.key, Boolean(ticketAutoAcikDurum[k.key])])),
                acKarsilamaHesap: acKarsilamaHesapSec.value || '',
                gecikmeSn: document.getElementById('ticketAutoGecikme').value,
            }),
        });
        const d = await okuJson(res);
        if (!d.ok) { ticketAutoMsg.textContent = `Hata: ${d.error}`; return; }
        ticketAutoMsg.textContent = d.enabled ? 'Kaydedildi — açık.' : 'Kaydedildi — kapalı.';
    } catch (error) {
        ticketAutoMsg.textContent = `Hata: ${error.message}`;
    }
});

// ============================================================================
// --- PRIME SAAT HATIRLATMASI (Ayarlar) ---
// ============================================================================
const primeMsg = document.getElementById('primeMsg');
const primeSon = document.getElementById('primeSon');

function primeSonucMetni(x) {
    if (!x) return 'Henüz çalışmadı.';
    if (x.hataMesaji) return `Son çalışma (${formatDate(x.at)}) hata verdi: ${x.hataMesaji}`;
    return `Son çalışma: ${formatDate(x.at)} (${x.tetikleyen}) · `
        + `${x.yetkili} yetkiliden ${x.hedef} kişiye yazıldı `
        + `(${x.seste} seste, ${x.cevrimdisi} çevrimdışı/bilinmiyor) · `
        + `${x.dmGitti} DM gitti`
        + (x.dmHata ? `, ${x.dmHata} kişinin DM'i kapalı` : '')
        + (x.kanalHatasi ? ` — kanala yazılamadı: ${x.kanalHatasi}` : '')
        + (x.isimler && x.isimler.length ? ` · ${x.isimler.join(', ')}` : '');
}

async function loadPrime() {
    try {
        const res = await fetch('/api/prime');
        if (res.status === 401) { showLogin(); return; }
        const d = await okuJson(res);
        if (!d.ok) return;
        document.getElementById('primeAcik').checked = d.acik;
        document.getElementById('primeDm').checked = d.dm;
        document.getElementById('primeSaatler').value = d.saatler.join(', ');
        document.getElementById('primeKanal').value = d.kanal;
        document.getElementById('primeMesaj').value = d.mesaj;
        document.getElementById('primeSaatBilgi').textContent =
            `Sunucuda şu an ${d.suanki} (${d.saatDilimi})`;
        primeSon.textContent = primeSonucMetni(d.sonCalisma);
    } catch (error) {
        primeMsg.textContent = `Hata: ${error.message}`;
    }
}

document.getElementById('primeKaydetBtn').addEventListener('click', async () => {
    primeMsg.textContent = 'Kaydediliyor...';
    try {
        const res = await fetch('/api/prime', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                acik: document.getElementById('primeAcik').checked,
                dm: document.getElementById('primeDm').checked,
                // "20:00, 21:00" -> ["20:00","21:00"]
                saatler: document.getElementById('primeSaatler').value
                    .split(',').map((x) => x.trim()).filter(Boolean),
                kanal: document.getElementById('primeKanal').value.trim(),
                mesaj: document.getElementById('primeMesaj').value,
            }),
        });
        const d = await okuJson(res);
        if (!d.ok) { primeMsg.textContent = `Hata: ${d.error}`; return; }
        primeMsg.textContent = d.acik
            ? `Kaydedildi — her gün ${d.saatler.join(', ')}`
            : 'Kaydedildi — kapalı';
        loadPrime();
    } catch (error) {
        primeMsg.textContent = `Hata: ${error.message}`;
    }
});

document.getElementById('primeSimdiBtn').addEventListener('click', async () => {
    if (!window.confirm('Aktif olup seste olmayan yetkililere ŞİMDİ hatırlatma gönderilecek (kanal + DM). Onaylıyor musun?')) return;
    primeMsg.textContent = 'Gönderiliyor, DM\'ler aralıklı gittiği için sürebilir...';
    try {
        const res = await fetch('/api/prime/simdi', { method: 'POST' });
        const d = await okuJson(res);
        if (!d.ok) { primeMsg.textContent = `Hata: ${d.error}`; return; }
        primeMsg.textContent = 'Bitti.';
        primeSon.textContent = primeSonucMetni(d.sonuc);
    } catch (error) {
        primeMsg.textContent = `Hata: ${error.message}`;
    }
});

// ============================================================================
// --- AKTİFLİK: SESTE GEÇİRİLEN SÜRE ---
// Her yetkilinin seçilen günde ne kadar ses kanalında kaldığı.
// ============================================================================
const presenceList = document.getElementById('presenceList');
const presenceSearch = document.getElementById('presenceSearch');
const presenceStatus = document.getElementById('presenceStatus');
const presDayInput = document.getElementById('presDay');
const presDayBitInput = document.getElementById('presDayBit');
const presPresets = document.getElementById('presPresets');
const presRangeInfo = document.getElementById('presRangeInfo');

let presReport = null;
let presDay = null;      // aralik baslangici
let presDayBit = null;   // aralik bitisi
let presToday = null;
let presTimer = null;
let presSearchTimer = null;

// 3h 24m -> "3sa 24dk". Saniye sadece bir dakikanın altındayken anlamlı.
function sureBicimle(saniye) {
    if (!saniye || saniye < 60) return saniye ? `${Math.round(saniye)} sn` : '—';
    const dakika = Math.floor(saniye / 60);
    const saat = Math.floor(dakika / 60);
    if (saat === 0) return `${dakika} dk`;
    return `${saat} sa ${dakika % 60} dk`;
}

function renderPresence() {
    if (!presReport) return;
    const terim = presenceSearch.value.trim().toLocaleLowerCase('tr');
    const liste = terim
        ? presReport.members.filter((m) => m.displayName.toLocaleLowerCase('tr').includes(terim)
            || m.tag.toLocaleLowerCase('tr').includes(terim))
        : presReport.members;

    presenceList.innerHTML = '';
    if (liste.length === 0) {
        presenceList.innerHTML = `<div class="empty-hint">${terim ? 'Aramaya uyan yetkili yok.' : 'Yetkili bulunamadı.'}</div>`;
        return;
    }

    const enYuksek = presReport.members.length ? presReport.members[0].seconds : 0;
    liste.forEach((m) => {
        const div = document.createElement('div');
        let sinif = 'pres-row';
        if (m.inVoice) sinif += ' on';
        else if (m.seconds === 0) sinif += ' off';
        div.className = sinif;
        div.dataset.id = m.id;
        // Süre çubuğu: en çok kalana göre oran - kim ne kadar kalmış tek
        // bakışta görünsün.
        const oran = enYuksek > 0 ? Math.round((m.seconds / enYuksek) * 100) : 0;
        div.innerHTML = `
            <img src="${encodeURI(m.avatarURL)}" alt="">
            <span class="pres-body">
                <span class="pres-name">${escapeHtml(m.displayName)}
                    ${m.inVoice ? `<span class="pres-live">🔊 ${escapeHtml(m.channelName || 'seste')}${m.sessionSeconds ? ` · ${sureBicimle(m.sessionSeconds)}` : ''}</span>` : ''}
                </span>
                <span class="pres-bar"><span class="pres-bar-fill" style="width:${oran}%"></span></span>
            </span>
            <span class="pres-ago">${sureBicimle(m.seconds)}</span>`;
        presenceList.appendChild(div);
    });
}

async function loadPresence(vurgula) {
    try {
        const params = presDay
            ? `?bas=${encodeURIComponent(presDay)}&bit=${encodeURIComponent(presDayBit || presDay)}`
            : '';
        const res = await fetch(`/api/aktiflik${params}`);
        if (res.status === 401) { showLogin(); return; }
        const d = await okuJson(res);
        if (!d.ok) { presenceStatus.textContent = `Hata: ${d.error}`; return; }
        presReport = d;
        presToday = d.today;
        presDay = d.bas;
        presDayBit = d.bit;
        presDayInput.value = presDay;
        presDayBitInput.value = presDayBit;
        presDayInput.max = presToday;
        // Bkz. Etkinlik: suren donem bugunden ileri bitebiliyor.
        presRangeInfo.textContent = aralikMetni(presDay, presDayBit, presToday);
        presetIsaretle(presPresets, presDay, presDayBit, presToday);

        const hicGirmeyen = d.members.filter((m) => m.seconds === 0).length;
        document.getElementById('presInVoice').textContent = d.inVoiceCount;
        document.getElementById('presTotalTime').textContent = sureBicimle(d.totalSeconds);
        document.getElementById('presZero').textContent = hicGirmeyen;

        presGrafikKart.style.display =
            gunlukGrafikCiz(presGrafik, d.availableDays, sureBicimle) ? '' : 'none';
        presGrafikAlt.textContent = 'günlük toplam ses süresi';

        const gunAdi = aralikMetni(presDay, presDayBit, presToday);
        // Veri ne zamandan beri toplanıyor - geçmiş yok, bu özellik
        // açıldığından beri birikiyor.
        presenceStatus.textContent = `${gunAdi} · ${d.members.length} yetkili`
            + (d.trackingSince ? ` · kayıt başlangıcı: ${d.trackingSince}` : ' · henüz kayıt yok');

        renderPresence();

        if (d.totalSeconds === 0) {
            const kutu = document.createElement('div');
            kutu.className = 'empty-hint';
            kutu.style.marginBottom = '8px';
            kutu.innerHTML = d.trackingSince
                ? `<b>${escapeHtml(gunAdi)}</b> için ses kaydı yok.`
                  + `<br>Kayıt tutulan günler: ${(d.availableDays || []).slice(0, 5).map((g) => `${escapeHtml(g.day)} (${sureBicimle(g.total)})`).join(' · ')}`
                : 'Ses süresi kaydı bu özellik açıldığından beri birikiyor - geçmiş veri yok.<br>Yetkililer ses kanallarına girdikçe burası dolacak.';
            presenceList.prepend(kutu);
        }

        if (vurgula) {
            const satir = presenceList.querySelector(`.pres-row[data-id="${vurgula}"]`);
            if (satir) { satir.classList.add('flash'); setTimeout(() => satir.classList.remove('flash'), 1500); }
        }
    } catch (error) {
        presenceStatus.textContent = `Hata: ${error.message}`;
    }
}

presenceSearch.addEventListener('input', () => {
    clearTimeout(presSearchTimer);
    presSearchTimer = setTimeout(renderPresence, 200);
});
document.getElementById('presenceRefreshBtn').addEventListener('click', () => loadPresence());
// ← / → aralik uzunlugu kadar kaydiriyor - haftalik donemlerde ortusme olmasin.
function presAralikKaydir(yon) {
    if (!presDay || !presDayBit) return;
    const uzunluk = gunFarki(presDay, presDayBit);
    presDay = gunKaydir(presDay, yon * uzunluk);
    presDayBit = gunKaydir(presDayBit, yon * uzunluk);
    loadPresence();
}
document.getElementById('presDayPrev').addEventListener('click', () => presAralikKaydir(-1));
document.getElementById('presDayNext').addEventListener('click', () => presAralikKaydir(1));

presPresets.addEventListener('click', (evt) => {
    const btn = evt.target.closest('[data-preset]');
    if (!btn) return;
    const a = hazirAralik(btn.dataset.preset, presToday || bugunIso());
    presDay = a.bas; presDayBit = a.bit;
    loadPresence();
});

[presDayInput, presDayBitInput].forEach((girdi) => {
    girdi.addEventListener('change', () => {
        if (!presDayInput.value || !presDayBitInput.value) return;
        presDay = presDayInput.value;
        presDayBit = presDayBitInput.value;
        loadPresence();
    });
});

// Süre sürekli artıyor - sekme açıkken düzenli tazele.
function presenceTabAcikMi() {
    return document.getElementById('tab-aktiflik').classList.contains('active');
}
function startPresenceTimer() {
    stopPresenceTimer();
    presTimer = setInterval(() => { if (presenceTabAcikMi()) loadPresence(); }, 30000);
}
function stopPresenceTimer() {
    if (presTimer) { clearInterval(presTimer); presTimer = null; }
}
async function initPresenceTab() {
    await loadPresence();
    startPresenceTimer();
}

// Teşhis: "hiç veri yok" ile "sayaç çalışmıyor" arasındaki farkı gösterir.
document.getElementById('presenceDiagBtn').addEventListener('click', async () => {
    presenceList.innerHTML = '<div class="empty-hint">Kontrol ediliyor...</div>';
    try {
        const res = await fetch('/api/aktiflik/tani');
        if (res.status === 401) { showLogin(); return; }
        const d = await okuJson(res);
        if (!d.ok) { presenceList.innerHTML = `<div class="empty-hint">Hata: ${escapeHtml(d.error)}</div>`; return; }

        const sorunlar = [];
        const bilgiler = [];
        if (d.discord !== 'bağlı') sorunlar.push('Discord bağlı değil.');
        if (!d.guildBulundu) sorunlar.push('Sunucu önbellekte yok - GUILD_ID hatalı olabilir.');
        if (d.uyeOnbellegi === 0) sorunlar.push('Üye önbelleği boş - üye listesi henüz çekilmemiş.');
        if (d.sesKanaliSayisi === 0) sorunlar.push('Hiç ses kanalı görünmüyor.');
        // Yeniden başlatmanın hemen ardından ilk sayım daha yapılmamış olur -
        // bunu sorun gibi göstermek gereksiz alarm.
        if (!d.sonTick.at) {
            bilgiler.push(`Sayaç henüz çalışmadı; ilk sayım ${d.tickAraligiSn} saniye içinde olacak.`);
        } else if (Date.now() - d.sonTick.at > d.tickAraligiSn * 3000) {
            sorunlar.push('Sayaç uzun süredir çalışmıyor - bot takılmış olabilir.');
        }
        if (d.sestekiHerkes > 0 && d.sestekiYetkili === 0) {
            sorunlar.push('Seste kişi var ama hiçbiri yetkili rollerinde - yoklama rol ID\'leri farklı olabilir.');
        }

        const satir = (ad, deger) => `<div class="tani-satir"><span>${escapeHtml(ad)}</span><b>${escapeHtml(String(deger))}</b></div>`;
        const kisiler = d.ornekler.length
            ? d.ornekler.map((o) => `<span class="legend ${o.yetkili ? 'ok' : ''}">${escapeHtml(o.name)} · ${escapeHtml(o.kanal)}${o.yetkili ? ' ✓' : ' (yetkili değil)'}</span>`).join('')
            : '<span class="scanStatus">Şu an seste kimse yok.</span>';

        presenceList.innerHTML = `
            <div class="card" style="margin:0;">
                <h2>Ses sayacı teşhisi</h2>
                <div class="${sorunlar.length ? 'legend bad' : 'legend ok'}" style="margin-bottom:12px;">
                    ${sorunlar.length ? `⚠ ${escapeHtml(sorunlar[0])}` : '✓ Sayaç sağlıklı çalışıyor'}
                </div>
                ${sorunlar.length > 1 ? `<p class="card-desc">${sorunlar.slice(1).map(escapeHtml).join('<br>')}</p>` : ''}
                ${bilgiler.length ? `<p class="card-desc">${bilgiler.map(escapeHtml).join('<br>')}</p>` : ''}
                ${satir('Discord durumu', d.discord)}
                ${satir('Sunucu bulundu', d.guildBulundu ? 'evet' : 'HAYIR')}
                ${satir('Önbellekteki üye', d.uyeOnbellegi)}
                ${satir('Üye listesi', d.uyelerHazir)}
                ${satir('Ses kanalı sayısı', d.sesKanaliSayisi)}
                ${satir('Şu an seste (herkes)', d.sestekiHerkes)}
                ${satir('Şu an seste (yetkili)', d.sestekiYetkili)}
                ${satir('Son sayım', d.sonTick.at ? `${formatDate(d.sonTick.at)} · ${d.sonTick.sayilan} kişi sayıldı` : 'henüz çalışmadı')}
                ${satir('Sayım aralığı', `${d.tickAraligiSn} saniye`)}
                ${satir('Bugün kayıtlı kişi', d.bugunKayitliKisi)}
                ${satir('Bugün toplam süre', sureBicimle(d.bugunToplamSn))}
                ${satir('Kayıtlı günler', d.kayitliGunler.join(', ') || 'yok')}
                <p class="card-desc" style="margin:12px 0 6px;">Şu an seste olanlar:</p>
                <div class="legend-row">${kisiler}</div>
            </div>`;
    } catch (error) {
        presenceList.innerHTML = `<div class="empty-hint">Hata: ${escapeHtml(error.message)}</div>`;
    }
});

// ============================================================================
// --- ROL BOTU KOMUTLARI (Ayarlar) ---
// sendSlash komut adını birebir eşleştiriyor; ad tutmazsa "SlashCommand X is
// not found" hatası geliyor ve rol verilmiyor.
// ============================================================================
const rolVerKomutu = document.getElementById('rolVerKomutu');
const rolAlKomutu = document.getElementById('rolAlKomutu');
const rolKomutMsg = document.getElementById('rolKomutMsg');
const rolKomutListe = document.getElementById('rolKomutListe');

async function loadRolKomutlari(listele) {
    try {
        const res = await fetch('/api/rol-komutlari');
        if (res.status === 401) { showLogin(); return; }
        const d = await okuJson(res);
        if (!d.ok) { rolKomutMsg.textContent = `Hata: ${d.error}`; return; }
        rolVerKomutu.value = d.ayarli.ver;
        rolAlKomutu.value = d.ayarli.al;
        document.getElementById('rolVerKomutIdInput').value = d.ayarli.verId || '';
        document.getElementById('rolAlKomutIdInput').value = d.ayarli.alId || '';
        document.getElementById('rolBotIdInput').value = d.botId || '';

        // Ayarli ID'ler sunucunun komut dizininde gercekten var mi - "kaydettim
        // ama yine calismiyor" durumunu listelemeye gerek kalmadan gosteriyor.
        const idSatiri = (etiket, k) => {
            if (!k.id) return `<span class="role-tag">${etiket}: ID yok, ada göre aranacak</span>`;
            return k.bulundu
                ? `<span class="role-tag ok">✓ ${etiket}: /${escapeHtml(k.name)}</span>`
                : `<span class="role-tag bad">✗ ${etiket}: ${escapeHtml(k.id)} bulunamadı</span>`;
        };
        if (d.idKontrol) {
            rolKomutMsg.innerHTML = idSatiri('Ver', d.idKontrol.ver) + ' ' + idSatiri('Al', d.idKontrol.al);
        }
        if (!listele) return;

        // ID'ye gore gonderim yaptigimiz icin ID'yi kopyalanabilir bicimde
        // en one koyuyoruz; tiklayinca ilgili kutuya yaziliyor.
        const komutKutu = (c, uygulama) => `
            <div class="role-row" style="align-items:flex-start;">
                <span class="role-row-name">/${escapeHtml(c.name)}${c.subcommands.length ? ` <span class="muted">${c.subcommands.map(escapeHtml).join(' | ')}</span>` : ''}</span>
                <code class="komut-id" data-id="${escapeHtml(c.id)}" title="Tıkla: ID'yi kopyala">${escapeHtml(c.id)}</code>
                <span class="p-spacer"></span>
                <span class="scanStatus">${escapeHtml(c.options.map((o) => o.name + (o.required ? '*' : '')).join(', ') || 'parametresiz')}</span>
                ${uygulama ? `<span class="role-tag">${escapeHtml(uygulama)}</span>` : ''}
            </div>`;

        // Adinda "rol" gecen komutlari HER ZAMAN gosteriyoruz: komut ID'siyle
        // gonderim yaptigimiz icin komutun hangi uygulamaya ait oldugu onemsiz,
        // ve aranan komut cogu zaman ayarli bottan baskasina ait cikiyor.
        // Once sadece ayarli botun komutlari listeleniyordu ve dogru komut
        // listede hic gorunmuyordu.
        const botunkiler = d.botKomutlari.length
            ? `<p class="card-desc" style="margin:0 0 8px;">
                   Ayarlı botun komutları (${d.botKomutlari.length}):
               </p>`
              + d.botKomutlari.map((c) => komutKutu(c)).join('')
            : `<div class="legend bad" style="margin-bottom:10px;">
                   ⚠ Ayarlı bot (${escapeHtml(d.botId)}) sunucuda hiç slash komut sunmuyor görünüyor.
               </div>`;

        // Ayarli botta zaten gorunenleri tekrar yazma
        const botIdleri = new Set(d.botKomutlari.map((c) => c.id));
        const digerRol = d.benzerler.filter((c) => !botIdleri.has(c.id));
        const rolListesi = digerRol.length
            ? `<p class="card-desc" style="margin:14px 0 8px;">
                   Adında "rol" geçen diğer komutlar — <b>başka bota ait olsalar bile
                   ID'yi kullanabilirsin</b>, ID yazarsan bot ID'sinin önemi kalmaz:
               </p>`
              + digerRol.map((c) => komutKutu(c, c.applicationId)).join('')
            : `<p class="card-desc" style="margin:14px 0 0;">
                   Adında "rol" geçen başka komut yok. Toplam ${d.toplamKomut} komut tarandı.
               </p>`;

        rolKomutListe.innerHTML = `
            <p class="card-desc" style="margin:0 0 10px;">
                ID'ye tıklayınca panoya kopyalanır; yukarıdaki ID kutusuna yapıştır.
            </p>
            ${botunkiler}${rolListesi}`;

        rolKomutListe.querySelectorAll('.komut-id').forEach((el) => {
            el.addEventListener('click', () => {
                navigator.clipboard.writeText(el.dataset.id).then(() => {
                    el.textContent = 'kopyalandı ✓';
                    setTimeout(() => { el.textContent = el.dataset.id; }, 1200);
                }).catch(() => { /* pano izni yoksa sessiz gec */ });
            });
        });
    } catch (error) {
        rolKomutMsg.textContent = `Hata: ${error.message}`;
    }
}

document.getElementById('rolKomutListeBtn').addEventListener('click', () => {
    rolKomutListe.innerHTML = '<div class="scanStatus">Komutlar alınıyor...</div>';
    loadRolKomutlari(true);
});

document.getElementById('rolKomutKaydetBtn').addEventListener('click', async () => {
    rolKomutMsg.textContent = 'Kaydediliyor...';
    try {
        const res = await fetch('/api/rol-komutlari', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ver: rolVerKomutu.value,
                al: rolAlKomutu.value,
                botId: document.getElementById('rolBotIdInput').value.trim(),
                verId: document.getElementById('rolVerKomutIdInput').value.trim(),
                alId: document.getElementById('rolAlKomutIdInput').value.trim(),
            }),
        });
        const d = await okuJson(res);
        if (!d.ok) { rolKomutMsg.textContent = `Hata: ${d.error}`; return; }
        rolKomutMsg.textContent = 'Kaydedildi, doğrulanıyor...';
        // Kaydettikten sonra ID'ler dizinde var mi diye hemen bakiyoruz -
        // "kaydettim ama yine hata veriyor" turunu bastan kesiyor.
        loadRolKomutlari(false);
    } catch (error) {
        rolKomutMsg.textContent = `Hata: ${error.message}`;
    }
});

// ============================================================================
// --- YOKLAMAYA KATIL ---
// Panel hesabına Discord ID'si bağlı yetkililer kendilerini o günkü yoklamada
// katıldı olarak işaretleyebiliyor; katılana uyarı yazılmıyor.
// ============================================================================
// Butonun etiketi durumla birlikte degisiyor. Ikon SVG oldugu icin
// textContent tasiyamaz - sabit olarak burada duruyor ki uc ayri yerde
// tekrar yazilmasin.
const KATIL_ETIKET = '<svg class="btn-ico"><use href="#i-katil"/></svg>Yoklamaya Katıl';
const KATILDIN_ETIKET = '<svg class="btn-ico"><use href="#i-katildi"/></svg>Katıldın';

const katilBtn = document.getElementById('katilBtn');
const katilMsg = document.getElementById('katilMsg');

async function loadKatilim() {
    try {
        const res = await fetch('/api/yoklama/katilim');
        if (res.status === 401) { showLogin(); return; }
        const d = await okuJson(res);
        if (!d.ok) return;
        if (!d.discordId) {
            // Butonu KAPATMIYORUZ: pasif buton "yok" gibi gorunuyor ve
            // kullanicilar ne yapacagini anlamiyordu. Acik birakip basinca
            // dogru yere goturuyoruz.
            katilBtn.disabled = false;
            katilBtn.innerHTML = KATIL_ETIKET;
            katilBtn.title = 'Önce Ayarlar > Kendi Hesabım bölümünden Discord ID ekle';
            katilMsg.innerHTML = '<a href="#" id="katilAyarlaraGit">Discord ID ekle →</a>';
            const bag = document.getElementById('katilAyarlaraGit');
            if (bag) {
                bag.addEventListener('click', (evt) => { evt.preventDefault(); discordIdAlaninaGit(); });
            }
        } else if (d.katildim) {
            katilBtn.disabled = true;
            katilBtn.innerHTML = KATILDIN_ETIKET;
            katilBtn.title = `Bugün (${d.gun}) katıldı olarak işaretlendin`;
            katilMsg.textContent = `Bugün ${d.toplam} kişi katıldı`;
        } else {
            katilBtn.disabled = false;
            katilBtn.innerHTML = KATIL_ETIKET;
            katilBtn.title = 'Kendini bugünkü yoklamada katıldı olarak işaretle';
            katilMsg.textContent = d.toplam ? `Bugün ${d.toplam} kişi katıldı` : '';
        }
    } catch (error) {
        katilMsg.textContent = `Hata: ${error.message}`;
    }
}

// Ayarlar sekmesini acip Discord ID alanini odakla - "nereye yazacagim?"
// sorusunu ortadan kaldiriyor.
function discordIdAlaninaGit() {
    document.querySelector('.tab-btn[data-tab="ayarlar"]').click();
    setTimeout(() => {
        const alan = document.getElementById('myDiscordId');
        if (!alan) return;
        alan.scrollIntoView({ behavior: 'smooth', block: 'center' });
        alan.focus();
    }, 150);
}

katilBtn.addEventListener('click', async () => {
    katilBtn.disabled = true;
    katilMsg.textContent = 'Kaydediliyor...';
    try {
        const res = await fetch('/api/yoklama/katil', { method: 'POST' });
        const d = await okuJson(res);
        if (!d.ok) {
            katilMsg.textContent = d.error;
            katilBtn.disabled = false;
            // Sebep "Discord ID bagli degil" ise kullaniciyi elinden tutup
            // dogru alana goturuyoruz.
            if (/Discord ID/i.test(d.error || '')) discordIdAlaninaGit();
            return;
        }
        await loadKatilim();
    } catch (error) {
        katilMsg.textContent = `Hata: ${error.message}`;
        katilBtn.disabled = false;
    }
});

// ============================================================================
// --- OTOMATİK GÜNLÜK YOKLAMA (Ayarlar) ---
// Birden fazla saat tanimlanabiliyor; her satirin kendi duyuru kanali,
// kendi sebebi ve kendi ac/kapa anahtari var.
// ============================================================================
const otoYoklamaSebep = document.getElementById('otoYoklamaSebep');
const otoYoklamaMsg = document.getElementById('otoYoklamaMsg');
const otoYoklamaSon = document.getElementById('otoYoklamaSon');
const otoYoklamaListe = document.getElementById('otoYoklamaListe');

let otoYoklamalar = [];
let otoVarsayilanKanal = '';

function otoSonucMetni(x) {
    if (!x) return 'Henüz çalışmadı.';
    if (x.hataMesaji) return `Son çalışma (${formatDate(x.at)}) hata verdi: ${x.hataMesaji}`;
    return `Son çalışma: ${formatDate(x.at)} (${x.tetikleyen})`
        + (x.kanal ? ` · duyuru → ${x.kanal}` : '')
        + ` · ${x.kontrol} yetkili kontrol edildi, ${x.seste} sesde, `
        + `${x.mazeretli} mazeretli/katılan, ${x.uyarilan} uyarı verildi`
        + (x.hata ? `, ${x.hata} hata` : '')
        + (x.ilkHata ? ` — ${x.ilkHata}` : '')
        + (x.duyuruHatasi ? ` — duyuru yazılamadı: ${x.duyuruHatasi}` : '');
}

function renderOtoYoklamalar() {
    if (otoYoklamalar.length === 0) {
        otoYoklamaListe.innerHTML = '<div class="empty-hint" style="padding:14px;">Zamanlanmış yoklama yok. "+ Saat Ekle" ile ekle.</div>';
        return;
    }
    otoYoklamaListe.innerHTML = otoYoklamalar.map((y, i) => `
        <div class="oto-satir" data-i="${i}">
            <label class="check-inline"><input type="checkbox" class="oto-acik" ${y.acik ? 'checked' : ''}> Açık</label>
            <input type="text" class="text-search oto-saat" value="${escapeHtml(y.saat || '')}" placeholder="20:30" style="max-width:92px;flex:0 0 auto;">
            <input type="text" class="text-search oto-kanal" value="${escapeHtml(y.kanal || '')}"
                   placeholder="Duyuru kanalı (boş = varsayılan)" style="max-width:260px;flex:0 0 auto;">
            <input type="text" class="text-search oto-sebep" value="${escapeHtml(y.sebep || '')}" placeholder="Sebep (boş = varsayılan)">
            <button class="secondary small oto-simdi" title="Bu satırı şimdi çalıştır">Şimdi</button>
            <button class="secondary small oto-sil" title="Bu satırı sil">×</button>
            <span class="scanStatus">${y.bugunCalisti ? 'bugün çalıştı' : ''}</span>
        </div>`).join('');

    // Kullanicinin yazdiklarini kaydetmeden once modele geri yaziyoruz ki
    // satir ekleme/silme sirasinda yazilanlar kaybolmasin.
    const oku = (satir) => ({
        acik: satir.querySelector('.oto-acik').checked,
        saat: satir.querySelector('.oto-saat').value.trim(),
        kanal: satir.querySelector('.oto-kanal').value.trim(),
        sebep: satir.querySelector('.oto-sebep').value.trim(),
    });
    otoYoklamaListe.querySelectorAll('.oto-satir').forEach((satir) => {
        const i = Number(satir.dataset.i);
        satir.querySelectorAll('input').forEach((girdi) => {
            girdi.addEventListener('input', () => Object.assign(otoYoklamalar[i], oku(satir)));
            girdi.addEventListener('change', () => Object.assign(otoYoklamalar[i], oku(satir)));
        });
        satir.querySelector('.oto-sil').addEventListener('click', () => {
            otoYoklamalar.splice(i, 1);
            renderOtoYoklamalar();
            otoYoklamaMsg.textContent = 'Silindi - Kaydet\'e basmayı unutma.';
        });
        satir.querySelector('.oto-simdi').addEventListener('click', async () => {
            const y = otoYoklamalar[i];
            const nereye = y.kanal ? `${y.kanal} kanalına` : 'varsayılan uyarı kanalına';
            if (!window.confirm(`Yoklama ŞİMDİ alınacak, uyarılar OTOMATİK verilecek ve duyuru ${nereye} yazılacak. Onaylıyor musun?`)) return;
            otoYoklamaMsg.textContent = 'Çalışıyor, birkaç dakika sürebilir...';
            try {
                const res = await fetch('/api/oto-yoklama/simdi', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id: y.id }),
                });
                const d = await okuJson(res);
                if (!d.ok) { otoYoklamaMsg.textContent = `Hata: ${d.error}`; return; }
                otoYoklamaMsg.textContent = 'Bitti.';
                otoYoklamaSon.textContent = otoSonucMetni(d.sonuc);
            } catch (error) {
                otoYoklamaMsg.textContent = `Hata: ${error.message}`;
            }
        });
    });
}

async function loadOtoYoklama() {
    try {
        const res = await fetch('/api/oto-yoklama');
        if (res.status === 401) { showLogin(); return; }
        const d = await okuJson(res);
        if (!d.ok) return;
        otoYoklamalar = d.yoklamalar || [];
        otoVarsayilanKanal = d.varsayilanKanal || '';
        otoYoklamaSebep.value = d.sebep;
        renderOtoYoklamalar();
        otoYoklamaSon.textContent = otoSonucMetni(d.sonCalisma)
            + ` · Sunucuda şu an ${d.suanki} (${d.saatDilimi})`
            + (otoVarsayilanKanal ? ` · varsayılan duyuru kanalı ${otoVarsayilanKanal}` : '');
    } catch (error) {
        otoYoklamaMsg.textContent = `Hata: ${error.message}`;
    }
}

document.getElementById('otoYoklamaEkleBtn').addEventListener('click', () => {
    otoYoklamalar.push({ id: `y${Date.now()}`, saat: '', kanal: '', sebep: '', acik: true });
    renderOtoYoklamalar();
    const sonSaat = otoYoklamaListe.querySelector('.oto-satir:last-child .oto-saat');
    if (sonSaat) sonSaat.focus();
});

document.getElementById('otoYoklamaKaydetBtn').addEventListener('click', async () => {
    otoYoklamaMsg.textContent = 'Kaydediliyor...';
    try {
        const res = await fetch('/api/oto-yoklama', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ yoklamalar: otoYoklamalar, sebep: otoYoklamaSebep.value }),
        });
        const d = await okuJson(res);
        if (!d.ok) { otoYoklamaMsg.textContent = `Hata: ${d.error}`; return; }
        const acikOlanlar = d.yoklamalar.filter((y) => y.acik).map((y) => y.saat);
        otoYoklamaMsg.textContent = acikOlanlar.length
            ? `Kaydedildi — her gün ${acikOlanlar.join(', ')}`
            : 'Kaydedildi — hepsi kapalı';
        loadOtoYoklama();
    } catch (error) {
        otoYoklamaMsg.textContent = `Hata: ${error.message}`;
    }
});


// ============================================================================
// --- TICKET'A MESAJ (AC) ---
// AC kendi Discord hesabini panele baglar, kategorideki bir ticket'i secer,
// mesajini yazar ve gonderir. Otomatik hicbir sey yok: her mesaj bir butona
// basilarak gidiyor.
//
// Token asla ekrana geri yazilmiyor - panel yalnizca hangi hesabin bagli
// oldugunu ve ne zaman baglandigini gosteriyor.
// ============================================================================
const acBagliDegilKart = document.getElementById('acBagliDegilKart');
const acBagliDegilAciklama = document.getElementById('acBagliDegilAciklama');
const acTokenSatiri = document.getElementById('acTokenSatiri');
const acTokenInput = document.getElementById('acToken');
const acBaglaBtn = document.getElementById('acBaglaBtn');
const acBaglaMsg = document.getElementById('acBaglaMsg');
const acUyari = document.getElementById('acUyari');
const acPanel = document.getElementById('acPanel');
const acHesapAdi = document.getElementById('acHesapAdi');
const acHesapZaman = document.getElementById('acHesapZaman');
const acYenileBtn = document.getElementById('acYenileBtn');
const acCikarBtn = document.getElementById('acCikarBtn');
const acAra = document.getElementById('acAra');
const acTicketListe = document.getElementById('acTicketListe');
const acSeciliTicket = document.getElementById('acSeciliTicket');
const acSayac = document.getElementById('acSayac');
const acMesaj = document.getElementById('acMesaj');
const acGonderBtn = document.getElementById('acGonderBtn');
const acNexoraBtn = document.getElementById('acNexoraBtn');
const acNexoraMsg = document.getElementById('acNexoraMsg');
const acSsBtn = document.getElementById('acSsBtn');
const acSsMsg = document.getElementById('acSsMsg');
const acNexoraSonucId = document.getElementById('acNexoraSonucId');
const acNexoraSonucBtn = document.getElementById('acNexoraSonucBtn');
const acNexoraSonucMsg = document.getElementById('acNexoraSonucMsg');
const acNexoraSonucKutu = document.getElementById('acNexoraSonucKutu');
const acNexoraApiUrl = document.getElementById('acNexoraApiUrl');
const acNexoraApiKey = document.getElementById('acNexoraApiKey');
const acNexoraApiKaydet = document.getElementById('acNexoraApiKaydet');
const acNexoraApiSil = document.getElementById('acNexoraApiSil');
const acNexoraApiDurum = document.getElementById('acNexoraApiDurum');
const acNexoraApiMsg = document.getElementById('acNexoraApiMsg');

// Bu AC'nin kendi Nexora API'si ayarlı mı? Sonucu Getir buna bağlı.
let acNexoraApiAyarli = false;

// Nexora At menüsündeki hazır SS isteği mesajı. Tek yerden değiştirilsin diye
// sabit; buton bunu seçili ticket'a AC'nin kendi hesabından gönderir.
const AC_SS_MESAJI = 'Uygulamayı çalıştırıp tam ekran ss atabilir misin?';
const acGonderMsg = document.getElementById('acGonderMsg');

let acTicketler = [];
let acSecili = null;
let acAyar = { mesajTavani: 1800 };

// AC token kapısı: AC hesabı token bağlamadan panele giremez. Kapı tam ekran
// açılır, appWrap'i gizler; token bağlanınca kapanır.
const acGate = document.getElementById('acGate');
const acGateToken = document.getElementById('acGateToken');
const acGateBaglaBtn = document.getElementById('acGateBaglaBtn');
const acGateError = document.getElementById('acGateError');
const acGateAciklama = document.getElementById('acGateAciklama');
const acGateAlan = document.getElementById('acGateAlan');
const acGateUyari = document.getElementById('acGateUyari');

function acGateGoster(mod, mesajHtml) {
    appWrap.style.display = 'none';
    loginWrap.style.display = 'none';
    acGate.style.display = 'flex';
    if (mod === 'kapali') {
        // Sunucuda anahtar yok - token girmenin anlamı yok, alanı gizle.
        acGateAlan.style.display = 'none';
        acGateBaglaBtn.style.display = 'none';
        acGateUyari.style.display = 'none';
    } else {
        acGateAlan.style.display = '';
        acGateBaglaBtn.style.display = '';
        acGateUyari.style.display = '';
    }
    if (mesajHtml) acGateAciklama.innerHTML = mesajHtml;
}

function acGateGizle() {
    acGate.style.display = 'none';
    if (appWrap.style.display === 'none') appWrap.style.display = 'flex';
}

async function acDurumYukle() {
    try {
        const res = await fetch('/api/ac/durum');
        if (res.status === 401) { showLogin(); return; }
        const d = await okuJson(res);
        if (!d.ok) { acBagliDegilAciklama.textContent = `Hata: ${d.error}`; return; }
        acAyar = d;
        const acKapisi = currentTip === 'ac';   // kapı yalnızca AC hesaplarında

        if (!d.anahtarVar) {
            // Sunucuda sifreleme anahtari yoksa ozellik komple kapali. Bunu
            // acikca soylemek gerekiyor, yoksa "token girdim olmadi" olur.
            acPanel.style.display = 'none';
            acBagliDegilKart.style.display = '';
            acTokenSatiri.style.display = 'none';
            acUyari.style.display = 'none';
            acBagliDegilAciklama.innerHTML = 'Bu özellik sunucuda henüz aktif değil. '
                + 'Şifreleme anahtarı ilk açılışta <b>kendiliğinden üretilir</b> - elle '
                + 'bir şey eklemen gerekmez. Genelde sebep: <b>bot güncellendi ama yeniden '
                + 'başlatılmadı</b>. Sunucuda <code>pm2 restart all</code> ver. Yine kapalı '
                + 'kalırsa bot klasörüne yazma izni yoktur (<code>ac-anahtar.key</code> '
                + 'oluşturulamıyordur).';
            if (acKapisi) {
                acGateGoster('kapali', 'Bu özellik sunucuda henüz aktif değil. '
                    + 'Şifreleme anahtarı ilk açılışta kendiliğinden üretilir; genelde '
                    + 'sebep botun güncellenip yeniden başlatılmamasıdır. Yönetici '
                    + 'sunucuda botu yeniden başlatınca (pm2 restart) bu ekrandan '
                    + 'token\'ını bağlayabilirsin.');
            }
            return;
        }

        if (d.baglandi) {
            if (acKapisi) acGateGizle();
            acBagliDegilKart.style.display = 'none';
            acPanel.style.display = '';
            acHesapAdi.textContent = d.hesap || d.hesapId;
            acHesapZaman.textContent = d.baglanmaZamani ? `· ${formatDate(d.baglanmaZamani)}` : '';
            acSayac.textContent = `en fazla ${d.saatlikTavan}/saat · gönderimler arası ${d.kisiAralikSn} sn`;
            acTicketleriYukle();
            acNexoraApiYukle();
        } else {
            acPanel.style.display = 'none';
            acBagliDegilKart.style.display = '';
            acTokenSatiri.style.display = 'flex';
            acUyari.style.display = '';
            const kilitliMi = d.kilitliId
                ? 'Bu panel hesabı bir Discord hesabına <b>kilitli</b>. '
                  + 'Aynı hesabın token\'ını bağla.'
                : 'Ticket\'a kendi hesabından mesaj gönderebilmek için hesabını bağla. '
                  + 'İlk bağladığın hesap bu panel hesabına kilitlenir.';
            acBagliDegilAciklama.innerHTML = kilitliMi;
            // AC hesabıysa: token bağlanana kadar tam ekran kapı önünde dursun.
            if (acKapisi) acGateGoster('token', kilitliMi);
        }
    } catch (error) {
        acBagliDegilAciklama.textContent = `Hata: ${error.message}`;
    }
}

acBaglaBtn.addEventListener('click', async () => {
    const token = acTokenInput.value.trim();
    if (!token) { acBaglaMsg.textContent = 'Token boş.'; return; }
    acBaglaBtn.disabled = true;
    acBaglaMsg.textContent = 'Discord\'a soruluyor...';
    try {
        const res = await fetch('/api/ac/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token }),
        });
        if (res.status === 401) { showLogin(); return; }
        const d = await okuJson(res);
        // Basarili da olsa olmasa da alani hemen bosaltiyoruz - token ekranda
        // asili kalmasin.
        acTokenInput.value = '';
        if (!d.ok) { acBaglaMsg.textContent = d.error; return; }
        acBaglaMsg.textContent = '';
        acDurumYukle();
    } catch (error) {
        acBaglaMsg.textContent = `Hata: ${error.message}`;
    } finally {
        acBaglaBtn.disabled = false;
    }
});

acCikarBtn.addEventListener('click', async () => {
    if (!window.confirm('Hesap bağlantısı kaldırılsın mı? Token panelden silinir.')) return;
    try {
        await fetch('/api/ac/token', { method: 'DELETE' });
        acSecili = null;
        acDurumYukle();   // AC hesabıysa bu, kapıyı yeniden gösterir
    } catch (error) {
        acGonderMsg.textContent = `Hata: ${error.message}`;
    }
});

// --- AC TOKEN KAPISI: token bağla ---
acGateBaglaBtn.addEventListener('click', async () => {
    const token = acGateToken.value.trim();
    acGateError.style.display = 'none';
    if (!token) {
        acGateError.textContent = 'Token boş.';
        acGateError.style.display = '';
        return;
    }
    acGateBaglaBtn.disabled = true;
    const eskiMetin = acGateBaglaBtn.innerHTML;
    acGateBaglaBtn.textContent = 'Discord\'a soruluyor...';
    try {
        const res = await fetch('/api/ac/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token }),
        });
        if (res.status === 401) { showLogin(); return; }
        const d = await okuJson(res);
        acGateToken.value = '';   // token ekranda asılı kalmasın
        if (!d.ok) {
            acGateError.textContent = d.error || 'Bağlanamadı.';
            acGateError.style.display = '';
            return;
        }
        // Başarılı: durum yenilenince kapı kapanır ve panel açılır.
        await acDurumYukle();
        // Bağlandıysa panel sekmesine geç.
        const acDugme = document.querySelector('.side-nav .tab-btn[data-tab="ticketmesaj"]');
        if (acDugme && acGate.style.display === 'none') acDugme.click();
    } catch (error) {
        acGateError.textContent = `Hata: ${error.message}`;
        acGateError.style.display = '';
    } finally {
        acGateBaglaBtn.disabled = false;
        acGateBaglaBtn.innerHTML = eskiMetin;
    }
});

acGateToken.addEventListener('keydown', (e) => { if (e.key === 'Enter') acGateBaglaBtn.click(); });

document.getElementById('acGateGoster').addEventListener('click', () => {
    const gizli = acGateToken.type === 'password';
    acGateToken.type = gizli ? 'text' : 'password';
    document.getElementById('acGateGoster').textContent = gizli ? 'Gizle' : 'Göster';
});

document.getElementById('acGateCikis').addEventListener('click', async (e) => {
    e.preventDefault();
    try { await fetch('/api/logout', { method: 'POST' }); } catch (error) { /* yoksay */ }
    acGate.style.display = 'none';
    location.reload();
});

// Bir ticket açıldı/kapandı WebSocket olayı geldiğinde listeyi tazele -
// yalnızca sekme açık ve hesap bağlıysa. Panel açık kalır ve ticket'lar
// kendiliğinden görünür/kaybolur; AC "Yenile" basmak zorunda değil.
function acCanliGuncelle(msg) {
    const sekmeAcik = document.getElementById('tab-ticketmesaj').classList.contains('active');
    const panelAcik = acPanel && acPanel.style.display !== 'none';
    if (!sekmeAcik || !panelAcik) return;
    acTicketleriYukle();
}

async function acTicketleriYukle() {
    acTicketListe.innerHTML = '<div class="iskelet">' + '<div class="iskelet-satir"></div>'.repeat(5) + '</div>';
    try {
        const res = await fetch('/api/ac/ticketlar');
        if (res.status === 401) { showLogin(); return; }
        const d = await okuJson(res);
        if (!d.ok) {
            acTicketListe.innerHTML = `<div class="empty-hint">Hata: ${escapeHtml(d.error)}</div>`;
            return;
        }
        acTicketler = d.ticketlar || [];
        acTicketleriCiz();
    } catch (error) {
        acTicketListe.innerHTML = `<div class="empty-hint">Hata: ${escapeHtml(error.message)}</div>`;
    }
}

function acTicketleriCiz() {
    const terim = acAra.value.trim().toLocaleLowerCase('tr');
    const liste = terim
        ? acTicketler.filter((t) => t.ad.toLocaleLowerCase('tr').includes(terim))
        : acTicketler;

    acTicketListe.innerHTML = '';
    if (liste.length === 0) {
        acTicketListe.innerHTML = `<div class="empty-hint">${terim
            ? 'Aramaya uyan ticket yok.'
            : 'Bu kategoride açık ticket yok.'}</div>`;
        return;
    }
    liste.forEach((t) => {
        const btn = document.createElement('button');
        btn.className = 'act-row' + (acSecili && acSecili.id === t.id ? ' active' : '');
        btn.innerHTML = `
            <span class="act-body">
                <span class="act-name">${escapeHtml(t.ad)}</span>
                <span class="act-last">${t.acilis ? `açıldı: ${formatDate(t.acilis)}` : ''}</span>
            </span>`;
        btn.addEventListener('click', () => {
            acSecili = t;
            acSeciliTicket.textContent = t.ad;
            acGonderBtn.disabled = false;
            acNexoraBtn.disabled = false;
            acSsBtn.disabled = false;
            acGonderMsg.textContent = '';
            acNexoraMsg.textContent = '';
            acSsMsg.textContent = '';
            acNexoraSonucMsg.textContent = '';
            acSonucBtnGuncelle();
            acTicketleriCiz();
        });
        acTicketListe.appendChild(btn);
    });
}

acAra.addEventListener('input', acTicketleriCiz);
acYenileBtn.addEventListener('click', acTicketleriYukle);

acNexoraBtn.addEventListener('click', async () => {
    if (!acSecili) { acNexoraMsg.textContent = 'Önce bir ticket seç.'; return; }
    // Yanlis ticket'a Nexora atmak istenmez - onay isteniyor.
    if (!window.confirm(`"${acSecili.ad}" ticket'ında kendi hesabından /nexorapin çalıştırılsın mı?`)) return;

    acNexoraBtn.disabled = true;
    // Gateway acilmasi birkac saniye surebilir - kullaniciya bekledigini soyle.
    acNexoraMsg.textContent = 'Hesabına bağlanılıyor, gönderiliyor...';
    try {
        const res = await fetch('/api/ac/nexora', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ kanalId: acSecili.id }),
        });
        if (res.status === 401) { showLogin(); return; }
        const d = await okuJson(res);
        if (!d.ok) {
            acNexoraMsg.textContent = d.error;
            if (/yeniden bağla/i.test(d.error)) acDurumYukle();
            return;
        }
        acNexoraMsg.textContent = `Nexora atıldı → ${d.kanal}`;
    } catch (error) {
        acNexoraMsg.textContent = `Hata: ${error.message}`;
    } finally {
        acNexoraBtn.disabled = false;
    }
});

// Alt menü: hazır SS isteği. Seçili ticket'a AC'nin kendi hesabından sabit
// metni gönderir (Nexora At ile aynı hesap - /api/ac/gonder üzerinden).
acSsBtn.addEventListener('click', async () => {
    if (!acSecili) { acSsMsg.textContent = 'Önce bir ticket seç.'; return; }
    if (!window.confirm(`"${acSecili.ad}" ticket'ına kendi hesabından SS isteği gönderilsin mi?`)) return;

    acSsBtn.disabled = true;
    acSsMsg.textContent = 'Gönderiliyor...';
    try {
        const res = await fetch('/api/ac/gonder', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ kanalId: acSecili.id, mesaj: AC_SS_MESAJI }),
        });
        if (res.status === 401) { showLogin(); return; }
        const d = await okuJson(res);
        if (!d.ok) {
            acSsMsg.textContent = d.error;
            if (/yeniden bağla/i.test(d.error)) acDurumYukle();
            return;
        }
        acSsMsg.textContent = `SS isteği gönderildi → ${d.kanal}`;
    } catch (error) {
        acSsMsg.textContent = `Hata: ${error.message}`;
    } finally {
        acSsBtn.disabled = false;
    }
});

// --- Nexora Sonucu: API cevabını AC'nin ekranına bas ---
// Cevabın şeklini bilmiyoruz; "hepsini göster" istendi. Bu yüzden gelen JSON'u
// özyinelemeli olarak anahtar/değer satırlarına çeviriyoruz: string/sayı/bool
// düz yazılır, URL'ler tıklanır link, görsel URL'leri <img>, iç içe nesne/dizi
// bir alt seviye olarak açılır.
function nexoraGorselMi(s) {
    return /^https?:\/\/\S+\.(png|jpe?g|gif|webp|bmp)(\?\S*)?$/i.test(s);
}
function nexoraDegerHtml(deger) {
    if (deger === null || deger === undefined) return '<span class="muted">—</span>';
    if (typeof deger === 'boolean') return deger ? '✅ true' : '❌ false';
    if (typeof deger === 'number') return escapeHtml(String(deger));
    if (typeof deger === 'string') {
        const s = deger.trim();
        if (nexoraGorselMi(s)) {
            return `<div><a href="${escapeHtml(s)}" target="_blank" rel="noopener">${escapeHtml(s)}</a>`
                + `<br><img src="${escapeHtml(s)}" alt="" style="max-width:100%; max-height:360px; margin-top:6px; border-radius:8px;"></div>`;
        }
        if (/^https?:\/\/\S+$/i.test(s)) {
            return `<a href="${escapeHtml(s)}" target="_blank" rel="noopener">${escapeHtml(s)}</a>`;
        }
        return escapeHtml(deger || '—');
    }
    if (Array.isArray(deger)) {
        if (deger.length === 0) return '<span class="muted">[boş]</span>';
        return `<div style="display:grid; gap:6px;">${deger.map((x, i) =>
            `<div><b class="muted">#${i + 1}</b> ${nexoraDegerHtml(x)}</div>`).join('')}</div>`;
    }
    if (typeof deger === 'object') return nexoraNesneHtml(deger);
    return escapeHtml(String(deger));
}
function nexoraNesneHtml(nesne) {
    const anahtarlar = Object.keys(nesne);
    if (anahtarlar.length === 0) return '<span class="muted">{boş}</span>';
    return `<div style="display:grid; gap:8px;">${anahtarlar.map((k) => `
        <div style="display:grid; grid-template-columns:minmax(120px,180px) 1fr; gap:10px; align-items:start;">
            <b style="word-break:break-word;">${escapeHtml(k)}</b>
            <div style="min-width:0; word-break:break-word;">${nexoraDegerHtml(nesne[k])}</div>
        </div>`).join('')}</div>`;
}
function acNexoraSonucCiz(discordId, sonuc) {
    const bas = `<div class="scanStatus" style="margin-bottom:8px;">Sorgulanan Discord ID: <b>${escapeHtml(String(discordId))}</b></div>`;
    let govde;
    if (sonuc && typeof sonuc === 'object') govde = nexoraNesneHtml(sonuc);
    else govde = `<pre style="white-space:pre-wrap; margin:0;">${escapeHtml(String(sonuc))}</pre>`;
    acNexoraSonucKutu.innerHTML = bas + govde;
    acNexoraSonucKutu.hidden = false;
}

// Sonucu Getir yalnızca AC kendi API'sini girmişse ve (ticket seçili ya da
// elle ID varsa) açık olur.
function acSonucBtnGuncelle() {
    const hedefVar = Boolean(acSecili) || acNexoraSonucId.value.trim().length > 0;
    acNexoraSonucBtn.disabled = !(acNexoraApiAyarli && hedefVar);
}
acNexoraSonucId.addEventListener('input', acSonucBtnGuncelle);

// AC'nin kendi Nexora API durumunu yükle (panelde bağlı olunca çağrılır).
async function acNexoraApiYukle() {
    try {
        const res = await fetch('/api/ac/nexora-api');
        if (res.status === 401) { showLogin(); return; }
        const d = await okuJson(res);
        if (!d.ok) return;
        acNexoraApiAyarli = Boolean(d.ayarli) || Boolean(d.genelVar);
        if (d.ayarli) {
            acNexoraApiDurum.innerHTML = '<span style="color:var(--ok,#3ba55d)">ayarlı ✓</span>';
            if (document.activeElement !== acNexoraApiUrl) acNexoraApiUrl.value = d.url || '';
            acNexoraApiKey.placeholder = 'API key (değiştirmezsen boş bırak)';
            acNexoraApiSil.hidden = false;
        } else if (d.genelVar) {
            acNexoraApiDurum.textContent = 'ortak (varsayılan) API kullanılıyor — istersen kendininkini gir';
            acNexoraApiSil.hidden = true;
        } else {
            acNexoraApiDurum.innerHTML = '<span style="color:var(--attn)">ayarlı değil — API adresini ve key\'ini gir</span>';
            acNexoraApiSil.hidden = true;
        }
        acSonucBtnGuncelle();
    } catch (error) { /* sessizce geç */ }
}

acNexoraApiKaydet.addEventListener('click', async () => {
    const url = acNexoraApiUrl.value.trim();
    const key = acNexoraApiKey.value.trim();
    if (!/^https?:\/\/.+/i.test(url)) {
        acNexoraApiMsg.textContent = 'Geçerli bir API adresi gir (http/https).';
        return;
    }
    acNexoraApiKaydet.disabled = true;
    acNexoraApiMsg.textContent = 'Kaydediliyor...';
    try {
        const res = await fetch('/api/ac/nexora-api', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, key }),
        });
        if (res.status === 401) { showLogin(); return; }
        const d = await okuJson(res);
        if (!d.ok) { acNexoraApiMsg.textContent = d.error; return; }
        acNexoraApiKey.value = '';   // key ekranda asılı kalmasın
        acNexoraApiMsg.textContent = 'Kaydedildi ✓';
        acNexoraApiYukle();
    } catch (error) {
        acNexoraApiMsg.textContent = `Hata: ${error.message}`;
    } finally {
        acNexoraApiKaydet.disabled = false;
    }
});

acNexoraApiSil.addEventListener('click', async () => {
    if (!window.confirm('Kendi Nexora API bilgin silinsin mi?')) return;
    try {
        await fetch('/api/ac/nexora-api', { method: 'DELETE' });
        acNexoraApiUrl.value = '';
        acNexoraApiKey.value = '';
        acNexoraApiMsg.textContent = 'Silindi.';
        acNexoraApiYukle();
    } catch (error) {
        acNexoraApiMsg.textContent = `Hata: ${error.message}`;
    }
});

acNexoraSonucBtn.addEventListener('click', async () => {
    const elleId = acNexoraSonucId.value.trim();
    if (!elleId && !acSecili) { acNexoraSonucMsg.textContent = 'Ticket seç ya da Discord ID gir.'; return; }

    acNexoraSonucBtn.disabled = true;
    acNexoraSonucMsg.textContent = 'Nexora sonucu getiriliyor...';
    try {
        const res = await fetch('/api/ac/nexora-sonuc', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ kanalId: acSecili ? acSecili.id : '', discordId: elleId }),
        });
        if (res.status === 401) { showLogin(); return; }
        const d = await okuJson(res);
        if (!d.ok) {
            acNexoraSonucMsg.textContent = d.error;
            if (/yeniden bağla/i.test(d.error)) acDurumYukle();
            return;
        }
        acNexoraSonucMsg.textContent = 'Sonuç geldi.';
        acNexoraSonucCiz(d.discordId, d.sonuc);
    } catch (error) {
        acNexoraSonucMsg.textContent = `Hata: ${error.message}`;
    } finally {
        acNexoraSonucBtn.disabled = false;
    }
});

acGonderBtn.addEventListener('click', async () => {
    if (!acSecili) { acGonderMsg.textContent = 'Önce bir ticket seç.'; return; }
    const mesaj = acMesaj.value.trim();
    if (!mesaj) { acGonderMsg.textContent = 'Mesaj boş.'; return; }
    if (mesaj.length > acAyar.mesajTavani) {
        acGonderMsg.textContent = `Mesaj çok uzun (en fazla ${acAyar.mesajTavani}).`;
        return;
    }
    // Yanlis ticket'a mesaj geri alinamaz - gondermeden once hangisi oldugunu
    // acikca soruyoruz.
    if (!window.confirm(`"${acSecili.ad}" ticket'ına kendi hesabından gönderilsin mi?`)) return;

    acGonderBtn.disabled = true;
    acGonderMsg.textContent = 'Gönderiliyor...';
    try {
        const res = await fetch('/api/ac/gonder', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ kanalId: acSecili.id, mesaj }),
        });
        if (res.status === 401) { showLogin(); return; }
        const d = await okuJson(res);
        if (!d.ok) {
            acGonderMsg.textContent = d.error;
            // Token dustuyse sunucu bagi kaldirdi; ekrani tazeleyip
            // "yeniden bagla" durumuna gecelim.
            if (/yeniden bağla/i.test(d.error)) acDurumYukle();
            return;
        }
        acMesaj.value = '';
        acGonderMsg.textContent = `Gönderildi → ${d.kanal}`;
    } catch (error) {
        acGonderMsg.textContent = `Hata: ${error.message}`;
    } finally {
        acGonderBtn.disabled = false;
    }
});
