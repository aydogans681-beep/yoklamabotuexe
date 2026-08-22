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
const summaryText = document.getElementById('summaryText');
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

function showError(message) {
    errorBox.textContent = message;
    errorBox.style.display = 'block';
}
function hideError() {
    errorBox.style.display = 'none';
}

// --- GİRİŞ / OTURUM ---
let currentUsername = null;

async function checkSession() {
    const res = await fetch('/api/me');
    const data = await res.json();
    if (data.loggedIn) {
        currentUsername = data.username;
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
    connectWebSocket();
    refreshLogMenu();
    refreshAccounts();
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
        const data = await res.json();
        if (!data.ok) {
            loginError.textContent = data.error || 'Giriş başarısız.';
            loginError.style.display = 'block';
            return;
        }
        currentUsername = username;
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
            } else if (msg.type === 'log-durum') {
                onLogStatusUpdate(msg);
            } else if (msg.type === 'log-yeni') {
                onLogNewMessage(msg);
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
        const result = await res.json();
        if (!result.ok) {
            const text = result.reason === 'max' ? `Zaten en üst kademede.` : `Hata: ${result.error || 'bilinmeyen hata'}`;
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
        const result = await res.json();
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
        const result = await res.json();
        if (!result.ok && result.error) {
            bulkProgress.textContent = `Hata: ${result.error}`;
            return;
        }
        bulkProgress.textContent = `Tamamlandı: ${result.warned.length} kişiye verildi, ${result.skipped.length} atlandı (maks kademe), ${result.failed.length} hata.`;
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
        const result = await res.json();
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
        const result = await res.json();
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
    summaryText.innerHTML = `Kontrol edilen: <b>${data.totalChecked}</b> · Sesde: <span class="green-num">${data.totalInVoice}</span> · Sesde değil: <span class="red-num">${data.totalChecked - data.totalInVoice}</span>`;
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
    scanStatus.textContent = 'Tarama sürüyor, birkaç saniye sürebilir...';
    try {
        const res = await fetch('/api/yoklama/tara', { method: 'POST' });
        const result = await res.json();
        if (res.status === 401) { showLogin(); return; }
        if (!result.ok) {
            showError(`Tarama başarısız: ${result.error}`);
            return;
        }
        scanStatus.textContent = `Son tarama: ${formatDate(result.data.scannedAt)}`;
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
        if (btn.dataset.tab === 'loglar') refreshLogMenu();
        if (btn.dataset.tab === 'ayarlar') refreshAccounts();
    });
});

// ============================================================================
// --- TX LOGS ---
// Sunucu tüm geçmişi bellekte tutuyor; burada sadece sayfa sayfa istiyoruz.
// ============================================================================
const logsMenu = document.getElementById('logsMenu');
const logsList = document.getElementById('logsList');
const logTitle = document.getElementById('logTitle');
const logStatus = document.getElementById('logStatus');
const logSearch = document.getElementById('logSearch');
const logRefreshBtn = document.getElementById('logRefreshBtn');
const logPager = document.getElementById('logPager');
const logPageInfo = document.getElementById('logPageInfo');
const logPrevBtn = document.getElementById('logPrevBtn');
const logNextBtn = document.getElementById('logNextBtn');

const LOG_PAGE_SIZE = 100;
let logChannels = [];
let activeLogKey = null;
let logOffset = 0;
let logSearchTerm = '';
let logSearchTimer = null;

function statusLabel(channel) {
    if (!channel.configured) return 'ID yok';
    if (channel.status === 'yukleniyor') return `${channel.loaded}...`;
    if (channel.status === 'hata') return 'hata';
    if (channel.status === 'bekliyor') return 'bekliyor';
    return String(channel.loaded);
}

function renderLogMenu() {
    logsMenu.innerHTML = '';
    logChannels.forEach((channel) => {
        const btn = document.createElement('button');
        let cls = 'log-menu-item';
        if (channel.key === activeLogKey) cls += ' active';
        if (!channel.configured) cls += ' missing';
        else if (channel.status === 'yukleniyor' || channel.status === 'bekliyor') cls += ' pending';
        btn.className = cls;
        btn.innerHTML = `<span>${escapeHtml(channel.label)}</span><span class="count">${escapeHtml(statusLabel(channel))}</span>`;
        btn.title = channel.configured
            ? `${channel.label} - ${channel.loaded} mesaj`
            : `${channel.label} için kanal ID'si girilmemiş (server.js içindeki LOG_CHANNELS)`;
        btn.addEventListener('click', () => selectLog(channel.key));
        logsMenu.appendChild(btn);
    });
}

async function refreshLogMenu() {
    try {
        const res = await fetch('/api/loglar');
        if (res.status === 401) { showLogin(); return; }
        const data = await res.json();
        if (!data.ok) return;
        logChannels = data.channels;
        renderLogMenu();
    } catch (error) {
        // sessizce geç - WebSocket'ten gelen durum güncellemeleri zaten menüyü tazeleyecek
    }
}

function onLogStatusUpdate(msg) {
    const channel = logChannels.find((c) => c.key === msg.key);
    if (channel) {
        channel.status = msg.status;
        channel.loaded = msg.loaded;
        channel.error = msg.error;
        renderLogMenu();
    }
    if (msg.key === activeLogKey) {
        if (msg.status === 'yukleniyor') {
            logStatus.textContent = `Geçmiş çekiliyor: ${msg.loaded} mesaj...`;
        } else if (msg.status === 'hazir') {
            logStatus.textContent = `${msg.loaded} mesaj hazır.`;
            loadLogPage();
        } else if (msg.status === 'hata') {
            logStatus.textContent = `Hata: ${msg.error || 'bilinmeyen'}`;
        }
    }
}

// Yeni bir log mesajı geldiğinde: ilk sayfadaysak ve arama yoksa listeyi tazele.
function onLogNewMessage(msg) {
    const channel = logChannels.find((c) => c.key === msg.key);
    if (channel) { channel.loaded = msg.loaded; renderLogMenu(); }
    if (msg.key === activeLogKey && logOffset === 0 && !logSearchTerm) loadLogPage();
}

function selectLog(key) {
    activeLogKey = key;
    logOffset = 0;
    logSearchTerm = '';
    logSearch.value = '';
    const channel = logChannels.find((c) => c.key === key);
    logTitle.textContent = channel ? `${channel.label} Logu` : key;
    logSearch.disabled = false;
    logRefreshBtn.disabled = !(channel && channel.configured);
    renderLogMenu();
    loadLogPage();
}

function renderEmbed(embed) {
    const fields = embed.fields
        .map((f) => `<div class="embed-field"><b>${escapeHtml(f.name)}</b><br>${escapeHtml(f.value)}</div>`)
        .join('');
    return `<div class="log-embed">
        ${embed.title ? `<div class="embed-title">${escapeHtml(embed.title)}</div>` : ''}
        ${embed.description ? `<div class="embed-desc">${escapeHtml(embed.description)}</div>` : ''}
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
            ${entry.content ? `<div class="log-content">${escapeHtml(entry.content)}</div>` : ''}
            ${embeds}
            ${attachments}
        </div>`;
    return div;
}

async function loadLogPage() {
    if (!activeLogKey) return;
    logsList.innerHTML = '<div class="empty-hint">Yükleniyor...</div>';
    try {
        const params = new URLSearchParams({ offset: String(logOffset), limit: String(LOG_PAGE_SIZE) });
        if (logSearchTerm) params.set('q', logSearchTerm);
        const res = await fetch(`/api/loglar/${activeLogKey}?${params.toString()}`);
        if (res.status === 401) { showLogin(); return; }
        const data = await res.json();
        if (!data.ok) {
            logsList.innerHTML = `<div class="empty-hint">Hata: ${escapeHtml(data.error || 'bilinmeyen')}</div>`;
            return;
        }

        if (!data.configured) {
            logsList.innerHTML = '<div class="empty-hint">Bu menü için kanal ID\'si girilmemiş.<br>server.js içindeki <b>LOG_CHANNELS</b> listesine ID\'yi ekle.</div>';
            logPager.style.display = 'none';
            logStatus.textContent = '';
            return;
        }
        if (data.status === 'yukleniyor' || data.status === 'bekliyor') {
            logStatus.textContent = data.status === 'bekliyor'
                ? 'Sıradaki kanal - geçmiş henüz çekilmedi.'
                : 'Geçmiş çekiliyor...';
        } else if (data.status === 'hata') {
            logStatus.textContent = `Hata: ${data.error || 'bilinmeyen'}`;
        } else {
            logStatus.textContent = `${data.total} mesaj · son güncelleme ${formatDate(data.fetchedAt)}`;
        }

        logsList.innerHTML = '';
        if (data.messages.length === 0) {
            // Bos liste her zaman "mesaj yok" demek degil - kanalin gecmisi
            // henuz cekilmemis de olabilir; ikisini ayirt ediyoruz.
            let hint;
            if (logSearchTerm) hint = 'Aramaya uyan mesaj yok.';
            else if (data.status === 'bekliyor') hint = 'Bu kanalın geçmişi henüz çekilmedi - sırada bekliyor.';
            else if (data.status === 'yukleniyor') hint = 'Geçmiş çekiliyor, birazdan burada görünecek...';
            else if (data.status === 'hata') hint = `Çekilemedi: ${escapeHtml(data.error || 'bilinmeyen hata')}`;
            else hint = 'Bu kanalda mesaj yok.';
            logsList.innerHTML = `<div class="empty-hint">${hint}</div>`;
            logPager.style.display = 'none';
            return;
        }
        data.messages.forEach((entry) => logsList.appendChild(renderLogEntry(entry)));
        logsList.scrollTop = 0;

        const from = data.offset + 1;
        const to = data.offset + data.messages.length;
        logPageInfo.textContent = `${from}-${to} / ${data.matched}${logSearchTerm ? ` (toplam ${data.total})` : ''}`;
        logPrevBtn.disabled = data.offset === 0;
        logNextBtn.disabled = to >= data.matched;
        logPager.style.display = 'flex';
    } catch (error) {
        logsList.innerHTML = `<div class="empty-hint">Hata: ${escapeHtml(error.message)}</div>`;
    }
}

logSearch.addEventListener('input', () => {
    clearTimeout(logSearchTimer);
    logSearchTimer = setTimeout(() => {
        logSearchTerm = logSearch.value.trim();
        logOffset = 0;
        loadLogPage();
    }, 250);
});
logPrevBtn.addEventListener('click', () => {
    logOffset = Math.max(0, logOffset - LOG_PAGE_SIZE);
    loadLogPage();
});
logNextBtn.addEventListener('click', () => {
    logOffset += LOG_PAGE_SIZE;
    loadLogPage();
});
logRefreshBtn.addEventListener('click', async () => {
    if (!activeLogKey) return;
    logRefreshBtn.disabled = true;
    logStatus.textContent = 'Yenileme başlatıldı...';
    try {
        await fetch(`/api/loglar/${activeLogKey}/yenile`, { method: 'POST' });
    } catch (error) {
        logStatus.textContent = `Hata: ${error.message}`;
    } finally {
        logRefreshBtn.disabled = false;
    }
});

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
        const data = await res.json();
        if (!data.ok) return;
        accountList.innerHTML = '';
        data.users.forEach((user) => {
            const row = document.createElement('div');
            row.className = 'account-row';
            row.innerHTML = `
                <span class="acc-name">${escapeHtml(user.username)}</span>
                ${user.isPrimary ? '<span class="acc-badge">Ana hesap</span>' : ''}
                ${user.isSelf ? '<span class="acc-badge">Sen</span>' : ''}
                <span class="acc-spacer"></span>
                <button class="secondary small" data-del="${escapeHtml(user.username)}">Sil</button>`;
            accountList.appendChild(row);
        });
        accountList.querySelectorAll('[data-del]').forEach((btn) => {
            btn.addEventListener('click', () => deleteAccount(btn.dataset.del));
        });
    } catch (error) {
        accountList.innerHTML = `<div class="empty-hint">Hesaplar alınamadı: ${escapeHtml(error.message)}</div>`;
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
        const data = await res.json();
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
            body: JSON.stringify({ username: addUsername.value.trim(), password: addPassword.value }),
        });
        const data = await res.json();
        if (!data.ok) { addAccountMsg.textContent = `Hata: ${data.error}`; return; }
        addAccountMsg.textContent = 'Hesap eklendi.';
        addUsername.value = '';
        addPassword.value = '';
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
            }),
        });
        const data = await res.json();
        if (!data.ok) { accountMsg.textContent = `Hata: ${data.error}`; return; }
        currentUsername = data.username;
        document.getElementById('whoAmI').textContent = `· ${currentUsername}`;
        accountMsg.textContent = 'Kaydedildi. Diğer oturumlar düşürüldü.';
        curPassword.value = '';
        newUsernameEl.value = '';
        newPasswordEl.value = '';
        refreshAccounts();
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
        const result = await res.json();
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
        const result = await res.json();
        if (result.ok === false && result.error) {
            previewProgress.textContent = `Hata: ${result.error}`;
            previewApplyBtn.disabled = false;
            return;
        }
        const summary = `Tamamlandı: ${result.warned.length} uyarı verildi, ${result.skipped.length} atlandı, ${result.failed.length} hata.`;
        previewProgress.textContent = summary;
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
