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

// Yonetici olmayan hesaplarda hesap yonetimi ve hesap loglari gizleniyor.
// Sunucu tarafinda da kapali (requireAdmin) - burasi sadece gorunum.
function applyAdminVisibility() {
    document.querySelectorAll('.admin-only').forEach((el) => {
        el.style.display = currentIsAdmin ? '' : 'none';
    });
    // Yonetici olmayan biri Hesap Logları sekmesindeyken yetkisi alinirsa
    // bos ekranda kalmasin - Yoklama'ya donduruyoruz.
    if (!currentIsAdmin) {
        const acik = document.querySelector('.tab-panel.active');
        if (acik && acik.id === 'tab-hesaploglari') {
            document.querySelector('.tab-btn[data-tab="yoklama"]').click();
        }
    }
}

async function checkSession() {
    const res = await fetch('/api/me');
    const data = await okuJson(res);
    if (data.loggedIn) {
        currentUsername = data.username;
        currentIsAdmin = Boolean(data.isAdmin);
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
    document.getElementById('whoAmI').textContent = currentUsername ? `· ${currentUsername}` : '';
    applyAdminVisibility();
    connectWebSocket();
    refreshLogMenu();
    if (currentIsAdmin) refreshAccounts();
    loadKatilim();
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
        // kaynaktan gelsin.
        currentIsAdmin = Boolean(data.isAdmin);
        if (data.isAdmin === undefined) {
            try {
                const me = await okuJson(await fetch('/api/me'));
                currentIsAdmin = Boolean(me.isAdmin);
            } catch (hata) { currentIsAdmin = false; }
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
            } else if (msg.type === 'yoklama-katilim') {
                // Baska bir panel kullanicisi katildi - sayac anlik guncellensin.
                loadKatilim();
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
        emptyState.style.display = 'block';
        return;
    }
    const filtered = getFilteredMembers();
    if (filtered.length === 0) {
        emptyState.textContent = 'Aramaya/filtreye uyan kimse yok.';
        emptyState.style.display = 'block';
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
// --- SEKMELER ---
// ============================================================================
const tabButtons = document.querySelectorAll('.tab-btn');
tabButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
        tabButtons.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        document.querySelectorAll('.tab-panel').forEach((panel) => panel.classList.remove('active'));
        document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
        if (btn.dataset.tab === 'yoklama') loadKatilim();
        if (btn.dataset.tab === 'loglar') txLogTab.refreshMenu();
        if (btn.dataset.tab === 'mutelog') muteLogTab.refreshMenu();
        if (btn.dataset.tab === 'felox') feloxLogTab.refreshMenu();
        if (btn.dataset.tab === 'ayarlar') {
            if (currentIsAdmin) refreshAccounts();
            loadTicketAuto(); loadRolKomutlari(false); loadOtoYoklama();
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
        list.innerHTML = '<div class="empty-hint">Yükleniyor...</div>';
        try {
            const params = new URLSearchParams({ offset: String(offset), limit: String(LOG_PAGE_SIZE) });
            if (term) params.set('q', term);
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
                return;
            }
            if (data.status === 'yukleniyor' || data.status === 'bekliyor') {
                status.textContent = data.status === 'bekliyor'
                    ? 'Sıradaki kanal - geçmiş henüz çekilmedi.'
                    : 'Geçmiş çekiliyor...';
            } else if (data.status === 'hata') {
                status.textContent = `Hata: ${data.error || 'bilinmeyen'}`;
            } else {
                status.textContent = `${data.total} mesaj · son güncelleme ${formatDate(data.fetchedAt)}`;
            }

            list.innerHTML = '';
            if (data.messages.length === 0) {
                // Bos liste her zaman "mesaj yok" demek degil - kanalin gecmisi
                // henuz cekilmemis de olabilir; ikisini ayirt ediyoruz.
                let hint;
                if (term) hint = 'Aramaya uyan mesaj yok.';
                else if (data.status === 'bekliyor') hint = 'Bu kanalın geçmişi henüz çekilmedi - sırada bekliyor.';
                else if (data.status === 'yukleniyor') hint = 'Geçmiş çekiliyor, birazdan burada görünecek...';
                else if (data.status === 'hata') hint = `Çekilemedi: ${escapeHtml(data.error || 'bilinmeyen hata')}`;
                else hint = 'Bu kanalda mesaj yok.';
                list.innerHTML = `<div class="empty-hint">${hint}</div>`;
                pager.style.display = 'none';
                return;
            }
            data.messages.forEach((entry) => list.appendChild(renderLogEntry(entry)));
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

    return { refreshMenu, onStatus, onNewMessage };
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
                <span class="acc-spacer"></span>
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
    staffList.innerHTML = '<div class="empty-hint">Yükleniyor...</div>';
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
const loginBrand = document.getElementById('loginBrand');
if (loginBrand) {
    const loginCard = loginBrand.closest('.login-card');
    loginCard.addEventListener('mousemove', (evt) => {
        const k = loginCard.getBoundingClientRect();
        const x = (evt.clientX - k.left) / k.width - 0.5;
        const y = (evt.clientY - k.top) / k.height - 0.5;
        loginBrand.style.transform =
            `perspective(600px) rotateY(${x * 14}deg) rotateX(${-y * 14}deg) translateZ(12px)`;
        loginBrand.style.filter = `drop-shadow(${-x * 16}px ${-y * 12 + 8}px 20px rgba(255,59,71,.4))`;
    });
    loginCard.addEventListener('mouseleave', () => {
        loginBrand.style.transform = '';
        loginBrand.style.filter = '';
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

const ACT_PAGE = 50;
let actChannelKey = null;
let actReport = null;
let actMemberId = null;
let actOffset = 0;
let actSearchTimer = null;

function renderActivityChannels(kanallar) {
    activityChannels.innerHTML = kanallar.map((c) => {
        const etiket = c.configured ? escapeHtml(c.label) : `${escapeHtml(c.label)} (ID yok)`;
        return `<button class="chip${c.key === actChannelKey ? ' active' : ''}" data-actch="${c.key}">${etiket}</button>`;
    }).join('');
    activityChannels.querySelectorAll('[data-actch]').forEach((btn) => {
        btn.addEventListener('click', () => {
            actChannelKey = btn.dataset.actch;
            actMemberId = null;
            loadActivityReport();
        });
    });
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
    activityList.innerHTML = '<div class="empty-hint">Yükleniyor...</div>';
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
const actDayInput = document.getElementById('actDay');
let actMode = 'toplam';   // 'toplam' | 'gunluk'
let actDay = null;        // YYYY-MM-DD
let actToday = null;

function gunKaydir(gun, adim) {
    const [y, a, g] = gun.split('-').map(Number);
    const d = new Date(Date.UTC(y, a - 1, g));
    d.setUTCDate(d.getUTCDate() + adim);
    return d.toISOString().slice(0, 10);
}

document.querySelectorAll('[data-actmode]').forEach((btn) => {
    btn.addEventListener('click', () => {
        actMode = btn.dataset.actmode;
        document.querySelectorAll('[data-actmode]').forEach((b) => b.classList.toggle('active', b === btn));
        actDayControls.style.display = actMode === 'gunluk' ? 'flex' : 'none';
        actMemberId = null;
        loadActivityReport();
    });
});
document.getElementById('actDayPrev').addEventListener('click', () => {
    if (!actDay) return; actDay = gunKaydir(actDay, -1); actDayInput.value = actDay; loadActivityReport();
});
document.getElementById('actDayNext').addEventListener('click', () => {
    if (!actDay) return; actDay = gunKaydir(actDay, 1); actDayInput.value = actDay; loadActivityReport();
});
document.getElementById('actDayToday').addEventListener('click', () => {
    actDay = actToday; actDayInput.value = actDay; loadActivityReport();
});
actDayInput.addEventListener('change', () => {
    if (!actDayInput.value) return; actDay = actDayInput.value; loadActivityReport();
});

// Günlük moddaki raporu çeker. Tüm zamanlar modu mevcut loadActivityReport'u
// kullanmaya devam ediyor - ikisi aynı listeyi besliyor.
async function loadDailyReport() {
    if (!actChannelKey) return;
    activityList.innerHTML = '<div class="empty-hint">Yükleniyor...</div>';
    try {
        const params = actDay ? `?gun=${encodeURIComponent(actDay)}` : '';
        const res = await fetch(`/api/etkinlik/${actChannelKey}/gunluk${params}`);
        if (res.status === 401) { showLogin(); return; }
        const data = await okuJson(res);
        if (!data.ok) { activityStatus.textContent = `Hata: ${data.error}`; return; }

        actToday = data.today;
        actDay = data.day;
        actDayInput.value = actDay;
        actDayInput.max = actToday;
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

        const gunAdi = actDay === actToday ? 'Bugün' : actDay;
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
                    actDayInput.value = actDay;
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
// --- YENİ TICKET'A OTOMATİK MESAJ (Ayarlar) ---
// ============================================================================
const ticketAutoEnabled = document.getElementById('ticketAutoEnabled');
const ticketAutoMessage = document.getElementById('ticketAutoMessage');
const ticketAutoMsg = document.getElementById('ticketAutoMsg');
const ticketAutoTarget = document.getElementById('ticketAutoTarget');
const ticketAutoRecent = document.getElementById('ticketAutoRecent');

async function loadTicketAuto() {
    try {
        const res = await fetch('/api/ticket-otomatik');
        if (res.status === 401) { showLogin(); return; }
        const d = await okuJson(res);
        if (!d.ok) return;
        ticketAutoEnabled.checked = d.enabled;
        ticketAutoMessage.value = d.message;
        ticketAutoTarget.innerHTML = `Kategori <b>${escapeHtml(d.categoryId)}</b>`
            + (d.inGuild
                ? ' · sunucuya bağlı ✓'
                : ' · <span style="color:var(--attn)">⚠ hesap bu sunucuda görünmüyor, olay gelmez</span>');
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
        + kayitlar.slice(0, 5).map((k) => `<span class="legend">#${escapeHtml(k.channelName)} · ${formatDate(k.at)}</span>`).join(' ');
}

document.getElementById('ticketAutoSaveBtn').addEventListener('click', async () => {
    ticketAutoMsg.textContent = 'Kaydediliyor...';
    try {
        const res = await fetch('/api/ticket-otomatik', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: ticketAutoEnabled.checked, message: ticketAutoMessage.value }),
        });
        const d = await okuJson(res);
        if (!d.ok) { ticketAutoMsg.textContent = `Hata: ${d.error}`; return; }
        ticketAutoMsg.textContent = d.enabled ? 'Kaydedildi — açık.' : 'Kaydedildi — kapalı.';
    } catch (error) {
        ticketAutoMsg.textContent = `Hata: ${error.message}`;
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

let presReport = null;
let presDay = null;
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

function presGunKaydir(gun, adim) {
    const [y, a, g] = gun.split('-').map(Number);
    const d = new Date(Date.UTC(y, a - 1, g));
    d.setUTCDate(d.getUTCDate() + adim);
    return d.toISOString().slice(0, 10);
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
        const params = presDay ? `?gun=${encodeURIComponent(presDay)}` : '';
        const res = await fetch(`/api/aktiflik${params}`);
        if (res.status === 401) { showLogin(); return; }
        const d = await okuJson(res);
        if (!d.ok) { presenceStatus.textContent = `Hata: ${d.error}`; return; }
        presReport = d;
        presToday = d.today;
        presDay = d.day;
        presDayInput.value = presDay;
        presDayInput.max = presToday;

        const hicGirmeyen = d.members.filter((m) => m.seconds === 0).length;
        document.getElementById('presInVoice').textContent = d.inVoiceCount;
        document.getElementById('presTotalTime').textContent = sureBicimle(d.totalSeconds);
        document.getElementById('presZero').textContent = hicGirmeyen;

        const gunAdi = presDay === presToday ? 'Bugün' : presDay;
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
document.getElementById('presDayPrev').addEventListener('click', () => {
    if (!presDay) return; presDay = presGunKaydir(presDay, -1); loadPresence();
});
document.getElementById('presDayNext').addEventListener('click', () => {
    if (!presDay) return; presDay = presGunKaydir(presDay, 1); loadPresence();
});
document.getElementById('presDayToday').addEventListener('click', () => {
    presDay = presToday; loadPresence();
});
presDayInput.addEventListener('change', () => {
    if (presDayInput.value) { presDay = presDayInput.value; loadPresence(); }
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
            katilBtn.textContent = '✋ Yoklamaya Katıl';
            katilBtn.title = 'Önce Ayarlar > Kendi Hesabım bölümünden Discord ID ekle';
            katilMsg.innerHTML = '<a href="#" id="katilAyarlaraGit">Discord ID ekle →</a>';
            const bag = document.getElementById('katilAyarlaraGit');
            if (bag) {
                bag.addEventListener('click', (evt) => { evt.preventDefault(); discordIdAlaninaGit(); });
            }
        } else if (d.katildim) {
            katilBtn.disabled = true;
            katilBtn.textContent = '✓ Katıldın';
            katilBtn.title = `Bugün (${d.gun}) katıldı olarak işaretlendin`;
            katilMsg.textContent = `Bugün ${d.toplam} kişi katıldı`;
        } else {
            katilBtn.disabled = false;
            katilBtn.textContent = '✋ Yoklamaya Katıl';
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
