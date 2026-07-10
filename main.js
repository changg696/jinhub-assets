// LOGIC SHARED (FRONTEND) buat halaman Key System tiap provider
// (lootlabs/linkvertise/workink). window.JinHubKeySystem.init(slug, cfg)
// dipanggil dari client.js masing-masing provider.
//
// Nyambung ke backend BENERAN di src/api/getkey.js (KV-based). Alurnya:
//   1) START ditekan -> POST /start -> dapet token + checkpointUrl,
//      tab checkpoint dibuka, kita polling GET /status?token=... tiap 4 detik.
//   2) Begitu provider (atau browser pas balik) ngonfirm via /callback,
//      status verified=true -> polling BERHENTI. Tombol START berubah jadi "DONE".
//   3) User klik tombol di kolom ACTIONS (yang tampilannya berubah sesuai kondisi):
//        - Belum punya key / punya slot kosong -> "GET A NEW KEY" 
//          -> POST /claim {mode:"new"} -> key string BARU ditambahkan ke daftar
//        - Key expired -> "RENEW" -> POST /claim {mode:"renew", targetKey}
//          -> key string LAMA diperpanjang, streak bisa lanjut
//        - Key aktif -> "+Xh" (ADD TIME) -> POST /claim {mode:"extend", targetKey}
//          -> key TETEP SAMA, cuma expiresAt-nya nambah bonus streak
//   4) GET /state dipanggil pas halaman kebuka buat sinkron SEMUA keys user
//      (maksimal 3 keys, bisa mix aktif dan expired).
//
// PERUBAHAN UTAMA (MULTI-KEY):
// - User bisa punya MULTIPLE KEYS (maksimal 3 per provider)
// - Tabel nampilin SEMUA keys (aktif dan expired) sampai maksimal 3 baris
// - Setiap key punya tombol aksinya sendiri (Renew untuk expired, +Xh untuk aktif)
// - Key lama TIDAK DIHAPUS saat get new key
// - Tombol "Get a New Key" disabled kalau sudah punya 3 keys
export const keysystemClientScript = `
window.JinHubKeySystem = window.JinHubKeySystem || {};

window.JinHubKeySystem.init = function(slug, cfg){
  const API = '/api/getkey/' + slug;
  const PENDING_KEY = 'jinhub_pending_' + slug; // {token, verified} -- biar kalau user refresh gak ilang
  const KEYS_CACHE_KEY = 'jinhub_keys_cache_' + slug; // cache list keys terakhir, biar tabel gak flash kosong pas reload
  const COOLDOWN_MS = 30 * 1000; // HARUS sama kaya START_COOLDOWN_MS di src/api/getkey.js

  const COPY_ICON    = '<svg viewBox="0 0 24 24"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12zm-1 4l6 6v10c0 1.1-.9 2-2 2H7.99C6.89 23 6 22.1 6 21l.01-14c0-1.1.89-2 1.99-2zm-1 7h5.5L14 6.5z"/></svg>';
  const RENEW_ICON   = '<svg viewBox="0 0 24 24"><path d="M12 8v4l3 3M3.223 14A9 9 0 1 0 12 3a9 9 0 0 0-8.294 5.5M7 9H3V5"/></svg>';
  const ADDTIME_ICON = '<svg viewBox="0 0 24 24"><circle cx="12" cy="13" r="9"/><path stroke-linecap="round" d="M15 13h-3m0 0H9m3 0v-3m0 3v3"/><path stroke-linecap="round" stroke-linejoin="round" d="m3.5 4.5l4-2.5m13 2.5l-4-2.5"/></svg>';

  const root = document.getElementById('pkPage-' + slug);
  if(!root) return;
  if(root.dataset.pkInited === '1'){ 
    // Re-initialization: still need to restore cache and setup state properly
    // Don't just call refreshState() and skip everything!
    console.log('[KeySystem] Re-initializing', slug, '- restoring cache first');
  } else {
    root.dataset.pkInited = '1';
  }

  // Baca totalCheckpoints dari data attribute yang di-set template
  const TOTAL_CHECKPOINTS = parseInt(root.dataset.totalCheckpoints || '1', 10);
  console.log('[KeySystem]', slug, 'TOTAL_CHECKPOINTS =', TOTAL_CHECKPOINTS);

  const el = {
    progressLabel: root.querySelector('[data-pk-progress-label]'),
    barFill:       root.querySelector('[data-pk-bar-fill]'),
    status:        root.querySelector('[data-pk-status]'),
    startBtn:      root.querySelector('[data-pk-start]'),
    startLabel:    root.querySelector('[data-pk-start-label]'),
    count:         root.querySelector('[data-pk-count]'),
    tableHead:     root.querySelector('[data-pk-table-head]'),
    empty:         root.querySelector('[data-pk-empty]'),
    emptyStatus:   root.querySelector('[data-pk-empty-status]'),
    rowsContainer: root.querySelector('[data-pk-rows-container]'),
    row:           root.querySelector('[data-pk-row]'), // Template row
    newKeyBtn:     root.querySelector('[data-pk-newkey]'),
    note:          root.querySelector('[data-pk-note]'),
    badge:         root.querySelector('[data-pk-badge]'),
    badgeText:     root.querySelector('[data-pk-badge-text]')
  };

  let state = { keys: [], activeKeys: [], expiredKeys: [], totalKeys: 0, remaining: 3, lastClaimAt: null };
  let isRefreshingState = false; // Track when we're loading fresh data from server

  // PREVENT KEY-TABLE FLICKER: pas reload/return-from-ads, jangan biarin
  // tabel key nge-flash "No key yet" dulu sambil nunggu GET /state kelar
  // (network + Worker/KV latency). Kalau ada cache dari load sebelumnya,
  // pakai itu dulu buat render awal -- refreshState() bakal nimpa dengan
  // data asli begitu selesai, cache ini cuma optimistic placeholder.
  (function restoreKeysCache(){
    const cached = loadKeysCache();
    if(!cached || !cached.keys || !cached.keys.length) return;
    state.keys = cached.keys;
    state.totalKeys = cached.totalKeys || cached.keys.length;
    state.remaining = cached.remaining != null ? cached.remaining : state.remaining;
    const now = Date.now();
    state.activeKeys = state.keys.filter(k => k.expiresAt && k.expiresAt > now).map(k => k.key);
    state.expiredKeys = state.keys.filter(k => k.expiresAt && k.expiresAt <= now).map(k => k.key);
  })();
  let waiting = false;             // lagi nunggu checkpoint dikonfirmasi provider
  let checkpointVerified = false;  // checkpoint UDAH dikonfirmasi tapi user BELUM milih aksi
  let pendingToken = null;
  let starting = false;            // lagi proses klik START (cegah double klik)
  let claiming = false;            // lagi proses klik GET A NEW KEY / RENEW / ADD TIME (cegah double klik)
  let clockTimer = null;
  let cooldownTimer = null;
  let pollTimer = null;
  let pollTries = 0;
  let checkpointTab = null; // referensi ke tab checkpoint yang dibuka
  const MAX_POLL_TRIES = 90; // ~3 menit @ 2 detik sekali (dikurangi jadi lebih cepat timeout)
  
  // MULTIPLE CHECKPOINTS STATE
  let currentCheckpoint = 0; // Checkpoint saat ini (0-based)
  let requiredCheckpoints = TOTAL_CHECKPOINTS; // Total checkpoint yang dibutuhkan dari server
  let firstRender = true; // dipakai buat matiin transition CSS di render pertama

  function getCooldownMs(){
    if(!state.lastClaimAt) return 0;
    return Math.max(0, COOLDOWN_MS - (Date.now() - state.lastClaimAt));
  }

  function fmtTimeLeft(expiresAt){
    if(!expiresAt) return '--';
    const ms = expiresAt - Date.now();
    if(ms <= 0) return '<span class="pk-time-expired">00:00</span>';
    const h = Math.floor(ms/3600000), m = Math.floor((ms%3600000)/60000);
    return h + 'h ' + m + 'm';
  }

  // Format menit bonus jadi label pendek buat tombol, ex: 45 -> "+45m",
  // 90 -> "+1h 30m", 120 -> "+2h".
  function fmtBonus(min){
    min = Math.max(0, Math.round(min || 0));
    if(min <= 0) return '+0m';
    const h = Math.floor(min/60), m = min%60;
    if(h <= 0) return '+' + m + 'm';
    if(m <= 0) return '+' + h + 'h';
    return '+' + h + 'h ' + m + 'm';
  }

  function loadPending(){
    try{
      const raw = localStorage.getItem(PENDING_KEY);
      return raw ? JSON.parse(raw) : null;
    }catch(e){ return null; }
  }
  function savePending(token, verified, checkpointCount, requiredCheckpoints){
    try{ 
      localStorage.setItem(PENDING_KEY, JSON.stringify({ 
        token: token, 
        verified: !!verified,
        checkpointCount: checkpointCount || 0,
        requiredCheckpoints: requiredCheckpoints || TOTAL_CHECKPOINTS
      })); 
    }catch(e){}
  }
  function clearPending(){
    try{ localStorage.removeItem(PENDING_KEY); }catch(e){}
  }

  // Cache list keys (hasil /state) di localStorage biar pas reload,
  // tabel gak flash "No key yet" dulu sambil nunggu /state kelar di-fetch.
  // Ini CUMA buat tampilan sementara -- data asli tetep dari server lewat
  // refreshState(), cache ini langsung ketimpa begitu itu selesai.
  function loadKeysCache(){
    try{
      const raw = localStorage.getItem(KEYS_CACHE_KEY);
      return raw ? JSON.parse(raw) : null;
    }catch(e){ return null; }
  }
  function saveKeysCache(keys, totalKeys, remaining){
    try{
      localStorage.setItem(KEYS_CACHE_KEY, JSON.stringify({ keys: keys || [], totalKeys: totalKeys || 0, remaining: remaining }));
    }catch(e){}
  }

  // CHECKPOINT PROGRESS CACHE - prevents backward progress flicker
  const CHECKPOINT_PROGRESS_KEY = 'jinhub_checkpoint_progress_' + slug;
  function loadCheckpointProgress(){
    try{
      const raw = localStorage.getItem(CHECKPOINT_PROGRESS_KEY);
      return raw ? JSON.parse(raw) : null;
    }catch(e){ return null; }
  }
  function saveCheckpointProgress(checkpoint, required){
    try{
      localStorage.setItem(CHECKPOINT_PROGRESS_KEY, JSON.stringify({ checkpoint: checkpoint, required: required, timestamp: Date.now() }));
    }catch(e){}
  }
  function clearCheckpointProgress(){
    try{ localStorage.removeItem(CHECKPOINT_PROGRESS_KEY); }catch(e){}
  }

  async function apiGet(path){
    const res = await fetch(API + path, { credentials: 'same-origin' });
    return res.json();
  }
  async function apiPost(path, body){
    const res = await fetch(API + path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    });
    return res.json();
  }

  function showNote(text){
    if(!text){ el.note.hidden = true; return; }
    el.note.textContent = text;
    el.note.hidden = false;
  }

  // SweetAlert2 notification helper
  function showAlert(type, title, text){
    if(!window.Swal) return; // Fallback kalau SweetAlert2 belum load
    
    const icons = {
      success: 'success',
      error: 'error',
      warning: 'warning',
      info: 'info'
    };
    
    Swal.fire({
      icon: icons[type] || 'info',
      title: title,
      text: text,
      showConfirmButton: false, // Hilangkan tombol OK
      timer: 2500, // Auto-close setelah 2.5 detik
      timerProgressBar: false, // MATIKAN progress bar biar clean
      background: '#1a1a2e',
      color: '#ffffff',
      toast: false, // Popup centered (bukan toast di pojok)
      position: 'center',
      customClass: {
        popup: 'swal-jinhub-popup',
        icon: 'swal-jinhub-icon',
        title: 'swal-jinhub-title',
        htmlContainer: 'swal-jinhub-text'
      },
      didOpen: (popup) => {
        // Tambahkan animasi smooth
        popup.style.animation = 'swal-show 0.3s ease-out';
      },
      willClose: () => {
        // Animasi saat close
        const popup = Swal.getPopup();
        if(popup) popup.style.animation = 'swal-hide 0.2s ease-in';
      }
    });
  }

  // Nama tampilan provider buat dipakein di modal verifikasi (fallback ke
  // slug ter-kapital kalau providernya baru/belum ke-daftar di sini).
  const PROVIDER_DISPLAY_NAMES = { lootlabs: 'LootLabs', linkvertise: 'Linkvertise', workink: 'Workink' };
  const providerDisplayName = PROVIDER_DISPLAY_NAMES[slug] || (slug.charAt(0).toUpperCase() + slug.slice(1));

  // NATIVE HTML POPUP "Verification in progress" (NO EXTERNAL LIBRARY)
  // Popup muncul di tengah layar pas user balik dari ads, dengan loading
  // spinner dan progress checkpoint. Pure HTML/CSS/JS, gak pakai SweetAlert2.
  function showVerifyingModal(checkpointNum, totalCheckpoints){
    // Remove existing modal kalau ada (cleanup)
    closeVerifyingModal();
    
    const safeTotal = totalCheckpoints || 1;
    const safeCheckpoint = Math.max(1, Math.min(checkpointNum || 1, safeTotal));
    
    // Create modal overlay
    const overlay = document.createElement('div');
    overlay.id = 'pk-verify-overlay';
    overlay.className = 'pk-verify-overlay';
    
    // Create modal content (string concatenation untuk avoid nested template literals)
    overlay.innerHTML = 
      '<div class="pk-verify-modal">' +
        '<button type="button" class="pk-verify-close" aria-label="Cancel">&times;</button>' +
        '<h3 class="pk-verify-title">Verification in progress</h3>' +
        '<p class="pk-verify-sub">Keep this tab open. The key flow will finish here.</p>' +
        '<div class="pk-verify-checkpoint">CHECKPOINT ' + safeCheckpoint + ' / ' + safeTotal + '</div>' +
        '<div class="pk-verify-spinner" aria-hidden="true"></div>' +
        '<div class="pk-verify-status">Verifying tasks&hellip;</div>' +
        '<p class="pk-verify-desc">Waiting for ' + providerDisplayName + ' to confirm your completed tasks. This takes a few seconds.</p>' +
        '<button type="button" class="pk-verify-cancel-btn">Cancel</button>' +
      '</div>';
    
    // Add to body
    document.body.appendChild(overlay);
    
    // Trigger animation (slight delay untuk smooth fade-in)
    setTimeout(function() {
      overlay.classList.add('pk-verify-visible');
    }, 10);
    
    // Close handlers
    const closeBtn = overlay.querySelector('.pk-verify-close');
    const cancelBtn = overlay.querySelector('.pk-verify-cancel-btn');
    
    if (closeBtn) {
      closeBtn.addEventListener('click', closeVerifyingModal);
    }
    if (cancelBtn) {
      cancelBtn.addEventListener('click', closeVerifyingModal);
    }
  }

  // Update angka checkpoint di modal yang lagi kebuka
  function updateVerifyingModal(checkpointNum, totalCheckpoints){
    const overlay = document.getElementById('pk-verify-overlay');
    if (!overlay) return;
    
    const label = overlay.querySelector('.pk-verify-checkpoint');
    if (label) {
      const safeTotal = totalCheckpoints || 1;
      const safeCheckpoint = Math.max(1, Math.min(checkpointNum || 1, safeTotal));
      label.textContent = 'CHECKPOINT ' + safeCheckpoint + ' / ' + safeTotal;
    }
  }

  function closeVerifyingModal(){
    const overlay = document.getElementById('pk-verify-overlay');
    if (!overlay) return;
    
    // Fade out animation
    overlay.classList.remove('pk-verify-visible');
    
    // Remove from DOM after animation
    setTimeout(function() {
      if (overlay.parentNode) {
        overlay.parentNode.removeChild(overlay);
      }
    }, 300);
  }

  function render(){
    // CRITICAL FIX: Check cache to prevent BACKWARD progress (flicker from 2→0)
    // But ALWAYS save current progress so we can move forward!
    const cachedProgress = loadCheckpointProgress();
    
    // Only restore from cache if currentCheckpoint would GO BACKWARDS
    // (e.g., currentCheckpoint=0 but cache=2, restore to 2)
    // But if currentCheckpoint is HIGHER or EQUAL, use current value!
    if(cachedProgress && cachedProgress.checkpoint > currentCheckpoint) {
      console.log('[KeySystem] Restoring checkpoint from cache to prevent backward:', cachedProgress.checkpoint, 'instead of', currentCheckpoint);
      currentCheckpoint = cachedProgress.checkpoint;
    }
    
    // ALWAYS save current checkpoint (even if same or higher)
    // This ensures forward progress is persisted
    saveCheckpointProgress(currentCheckpoint, requiredCheckpoints);
    
    const hasActiveKeys = state.activeKeys && state.activeKeys.length > 0;
    const hasExpiredKeys = state.expiredKeys && state.expiredKeys.length > 0;
    const hasAnyKey = state.keys && state.keys.length > 0;
    
    // LOCKED = user sudah 3 keys DAN semua keys sudah MAX (28h)
    // Kalau ada key yang belum max, masih boleh checkpoint untuk extend key itu
    const capH = 28;
    const allKeysMaxed = state.keys && state.keys.length >= 3 && state.keys.every(k => {
      const isActive = k.expiresAt && k.expiresAt > Date.now();
      if (!isActive) return false; // expired key = belum max
      const grantedMin = k.grantedMin != null ? k.grantedMin : 0;
      return grantedMin >= (capH * 60); // 28h in minutes
    });
    const locked = state.remaining <= 0 && allKeysMaxed;
    
    const cooldownMs = getCooldownMs();
    const inCooldown = cooldownMs > 0;
    
    // Checkpoint kelar & user tinggal pilih aksi
    const readyToClaimNew = checkpointVerified && !locked;

    // ===== HEADER: progress + START =====
    el.progressLabel.textContent = currentCheckpoint + '/' + requiredCheckpoints;
    const progressPercent = requiredCheckpoints > 0 ? (currentCheckpoint / requiredCheckpoints) * 100 : 0;
    if(firstRender){
      // Render PERTAMA (biasanya hasil restore dari localStorage): matiin
      // transition sesaat biar bar langsung "loncat" ke posisi yang bener,
      // bukan nyapu dari 0% -> keliatan kayak sempet balik ke awal.
      el.barFill.style.transition = 'none';
      el.barFill.style.width = progressPercent + '%';
      void el.barFill.offsetWidth; // force reflow biar transition off-nya kepake
      el.barFill.style.transition = '';
      firstRender = false;
    } else {
      el.barFill.style.width = progressPercent + '%';
    }
    el.status.textContent = checkpointVerified ? 'DONE' : waiting ? 'WAITING' : locked ? 'LOCKED' : inCooldown ? 'COOLDOWN' : hasActiveKeys ? 'ACTIVE' : 'READY';

    el.startBtn.disabled = locked || waiting || starting || checkpointVerified || inCooldown;
    el.startLabel.textContent = checkpointVerified ? 'DONE' : waiting ? 'WAITING...' : locked ? 'LIMIT REACHED' : inCooldown ? ('WAIT ' + Math.ceil(cooldownMs / 1000) + 's') : 'START';

    // ===== TABEL: tampilkan semua keys (maks 3) =====
    el.count.textContent = state.totalKeys || 0;
    
    // Sembunyikan baris jika belum ada key sama sekali, dan tampilin
    // empty-state list ("No key yet" ala Rift) sebagai gantinya. Header
    // kolom tabel juga disembunyiin pas kosong -- gak relevan kalau cuma
    // nampilin list 2 baris tanpa data.
    el.row.hidden = !hasAnyKey;
    if(el.tableHead) el.tableHead.hidden = !hasAnyKey;
    if(el.empty){
      el.empty.hidden = hasAnyKey;
      if(!hasAnyKey && el.emptyStatus){
        el.emptyStatus.textContent = waiting ? 'Waiting'
          : checkpointVerified ? 'Ready to claim'
          : locked ? 'Locked'
          : inCooldown ? 'Cooldown'
          : 'Ready';
      }
    }

    if(hasAnyKey){
      // Render semua keys (aktif dan expired)
      const container = el.rowsContainer || el.row.parentElement;
      const existingRows = container.querySelectorAll('[data-pk-row]');
      
      // Hapus semua baris kecuali template pertama
      existingRows.forEach((row, index) => {
        if(index > 0) row.remove();
      });
      
      // Render setiap key
      state.keys.forEach((keyData, index) => {
        const row = index === 0 ? el.row : el.row.cloneNode(true);
        const isActive = keyData.expiresAt && keyData.expiresAt > Date.now();
        const capH = 28; // STREAK_CAP_HOURS
        const baseH = 14; // BASE_HOURS untuk provider ini (bisa dikasih dari state.baseHours kalau perlu)
        const grantedMin = keyData.grantedMin != null ? keyData.grantedMin : (baseH * 60);
        const nextBonusMin = Math.min(14 * 60, Math.max(0, capH * 60 - grantedMin)); // STREAK_BONUS_MIN
        
        // FITUR BARU: Key yang pernah max (28h) tapi turun di bawah 10 jam bisa di-extend lagi
        // Logic: Kalau time left < 10h DAN pernah dapat granted time (grantedMin > base), reset streak
        const timeLeftMs = isActive ? (keyData.expiresAt - Date.now()) : 0;
        const timeLeftH = timeLeftMs / 3600000; // convert to hours
        const wasMaxedBefore = grantedMin >= (capH * 60); // pernah mencapai 28h
        const canReExtend = wasMaxedBefore && timeLeftH < 10; // bisa extend lagi kalau turun < 10h
        
        // Recalculate nextBonusMin untuk key yang bisa re-extend
        const effectiveGrantedMin = canReExtend ? (baseH * 60) : grantedMin; // reset ke base kalau re-extend
        const effectiveNextBonus = Math.min(14 * 60, Math.max(0, capH * 60 - effectiveGrantedMin));
        const capped = isActive && effectiveNextBonus <= 0 && !canReExtend;
        
        row.hidden = false;
        row.querySelector('[data-pk-key-text]').textContent = keyData.key;
        row.querySelector('[data-pk-time-cell]').innerHTML = isActive ? fmtTimeLeft(keyData.expiresAt) : '<span class="pk-time-expired">00:00</span>';
        
        const statusPill = row.querySelector('[data-pk-status-pill]');
        statusPill.textContent = isActive ? 'ACTIVE' : 'EXPIRED';
        statusPill.classList.toggle('is-active', isActive);
        statusPill.classList.toggle('is-expired', !isActive);
        
        // Setup copy button untuk key ini
        const copyBtn = row.querySelector('[data-pk-copy]');
        copyBtn.onclick = () => copyKey(keyData.key);
        
        // Setup tombol aksi (Renew/Extend/AddTime)
        const renewBtn = row.querySelector('[data-pk-renew]');
        const renewIcon = row.querySelector('[data-pk-renew-icon]');
        const renewLabel = row.querySelector('[data-pk-renew-label]');
        
        if(isActive){
          // Key aktif -> tombol "+Xh" (add time / extend)
          renewIcon.innerHTML = ADDTIME_ICON;
          renewLabel.textContent = capped ? 'Max' : fmtBonus(effectiveNextBonus);
          // PENTING: Disable kalau TIDAK ADA checkpoint verified (locked juga disable)
          // locked = user sudah 3 keys, gak boleh extend key manapun kecuali ada verified checkpoint
          renewBtn.disabled = !checkpointVerified || claiming || capped || locked;
          renewBtn.classList.toggle('is-solid', checkpointVerified && !capped && !locked);
          renewBtn.classList.toggle('is-capped', capped);
          renewBtn.onclick = () => claimKey('extend', keyData.key);
        } else {
          // Key expired -> tombol "Renew"
          renewIcon.innerHTML = RENEW_ICON;
          renewLabel.textContent = 'Renew';
          // Renew juga harus cek locked (kalau 3 keys full, gak bisa renew kecuali ada checkpoint)
          renewBtn.disabled = !checkpointVerified || claiming || locked;
          renewBtn.classList.toggle('is-solid', checkpointVerified && !locked);
          renewBtn.classList.toggle('is-capped', false);
          renewBtn.onclick = () => claimKey('renew', keyData.key);
        }
        
        if(index > 0) container.appendChild(row);
      });
    }

    // ===== TOMBOL GET A NEW KEY (di bawah tabel) =====
    el.newKeyBtn.disabled = !readyToClaimNew || claiming;
    el.newKeyBtn.classList.toggle('is-solid', readyToClaimNew);
    el.newKeyBtn.querySelector('span').textContent = locked ? 'Limit Reached' : 'Get a New Key';

    // Update badge text untuk multiple keys
    if(el.badge && el.badgeText) {
      el.badge.hidden = !hasActiveKeys;
      const activeCount = state.activeKeys ? state.activeKeys.length : 0;
      el.badgeText.textContent = activeCount === 1 
        ? 'One active key saved in this browser'
        : activeCount + ' active keys saved in this browser';
    }

    if(locked){
      showNote('All 3 keys have reached maximum time (28h each). Come back later when time drops below 10 hours to extend again.');
    } else if(readyToClaimNew){
      const hasExpired = state.expiredKeys && state.expiredKeys.length > 0;
      showNote(hasExpired
        ? 'Checkpoint completed! Choose Get a New Key or Renew an existing key.'
        : 'Checkpoint completed! Click Get a New Key to receive your key.');
    } else if(!checkpointVerified && !waiting && currentCheckpoint > 0 && currentCheckpoint < requiredCheckpoints){
      // Checkpoint parsial (misal 1/2 buat lootlabs) -- kasih tau user
      // harus lanjut, jangan biarin keliatan kayak progress-nya ilang.
      showNote('Checkpoint ' + currentCheckpoint + '/' + requiredCheckpoints + ' complete. Press START again to continue.');
    } else if(inCooldown){
      showNote('Please wait a moment before starting a new checkpoint.');
    } else if(!waiting){
      showNote(null);
    }

    if(clockTimer) clearInterval(clockTimer);
    if(hasActiveKeys){
      clockTimer = setInterval(function(){
        // Cek apakah ada key yang expired - kalau ada, refresh state dari server
        const anyExpired = state.keys.some(k => k.expiresAt && k.expiresAt <= Date.now());
        if(anyExpired){ 
          clearInterval(clockTimer); 
          refreshState(); 
          return; 
        }
        
        // HANYA update TIME DISPLAY, JANGAN modify state.keys
        // Ambil rows dari DOM (bukan dari state)
        const rows = document.querySelectorAll('[data-pk-row]:not([hidden])');
        rows.forEach((row, index) => {
          const keyData = state.keys[index];
          if(keyData && keyData.expiresAt && keyData.expiresAt > Date.now()){
            const timeCell = row.querySelector('[data-pk-time-cell]');
            if(timeCell){
              timeCell.innerHTML = fmtTimeLeft(keyData.expiresAt);
            }
          }
        });
      }, 60000); // Update setiap 1 menit
    }

    if(cooldownTimer) clearInterval(cooldownTimer);
    if(inCooldown){
      cooldownTimer = setInterval(function(){
        if(getCooldownMs() <= 0){ clearInterval(cooldownTimer); }
        render();
      }, 1000);
    }
  }

  async function refreshState(){
    isRefreshingState = true;
    // PRESERVE checkpoint progress before refresh (don't let it reset!)
    const preservedCheckpoint = currentCheckpoint;
    const preservedRequired = requiredCheckpoints;
    const preservedVerified = checkpointVerified;
    
    try{
      const data = await apiGet('/state');
      if(data.success){
        // Update state dari server HANYA jika berhasil
        // JANGAN reset state sebelum dapat response - preserve cache
        state.keys = data.keys || [];
        state.totalKeys = data.totalKeys || 0;
        state.remaining = data.remaining || 0;
        state.lastClaimAt = data.lastClaimAt;
        
        // Re-calculate activeKeys dan expiredKeys
        const now = Date.now();
        state.activeKeys = state.keys.filter(k => k.expiresAt && k.expiresAt > now).map(k => k.key);
        state.expiredKeys = state.keys.filter(k => k.expiresAt && k.expiresAt <= now).map(k => k.key);
        
        saveKeysCache(state.keys, state.totalKeys, state.remaining);
        
        // RESTORE checkpoint state before render (prevent reset!)
        currentCheckpoint = preservedCheckpoint;
        requiredCheckpoints = preservedRequired;
        checkpointVerified = preservedVerified;
        
        render();
      }
      // Kalau API gagal, JANGAN ubah state sama sekali - biar pakai cache lama
    }catch(e){ 
      console.warn('[KeySystem] refreshState failed, keeping cached data:', e);
      // Tetap render dengan data cache yang ada (state tidak diubah)
    } finally {
      isRefreshingState = false;
    }
  }

  function stopPolling(){
    if(pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
  }

  async function pollStatus(token){
    pollTries++;
    if(pollTries > MAX_POLL_TRIES){
      stopPolling();
      waiting = false;
      pendingToken = null;
      clearPending();
      clearCheckpointProgress(); // Clear cached progress on timeout
      currentCheckpoint = 0;
      showAlert('warning', 'Checkpoint Timeout', 'Checkpoint verification timed out. Please press START again.');
      showNote('Checkpoint belum kekonfirmasi. Coba tekan START lagi.');
      render();
      return;
    }
    try{
      const data = await apiGet('/status?token=' + encodeURIComponent(token));
      if(data.success){
        // ALWAYS trust server data for checkpoint progress
        // Server knows the truth - update directly!
        if(data.checkpointCount != null && data.checkpointCount >= 0) {
          currentCheckpoint = data.checkpointCount; // Direct assignment from server
        }
        if(data.requiredCheckpoints) {
          requiredCheckpoints = data.requiredCheckpoints;
        }
        
        if(data.verified){
          // SEMUA checkpoint selesai - update progress ke nilai final SEBELUM render
          currentCheckpoint = requiredCheckpoints; // FORCE ke nilai final (contoh: 2/2)
          stopPolling();
          waiting = false;
          checkpointVerified = true;
          pendingToken = token;
          savePending(token, true, currentCheckpoint, requiredCheckpoints);
          
          showAlert('success', 'All Checkpoints Completed!', 'All ' + requiredCheckpoints + ' checkpoints verified! You can now claim your key.');
          render();
          return;
        } else if(currentCheckpoint > 0 && currentCheckpoint < requiredCheckpoints){
          // Checkpoint parsial selesai, masih ada yang kurang
          render(); // Update progress bar
        }
      }
      if(data.code === 'EXPIRED'){
        stopPolling();
        waiting = false;
        checkpointVerified = false;
        pendingToken = null;
        clearPending();
        clearCheckpointProgress(); // Clear cached progress on expiry
        currentCheckpoint = 0;
        showAlert('error', 'Session Expired', 'Your checkpoint session has expired. Please press START again.');
        showNote('Sesi checkpoint expired. Tekan START lagi.');
        render();
        return;
      }
    }catch(e){ /* network glitch, coba lagi di polling berikutnya */ }
    
    // Polling interval dinamis untuk responsiveness:
    // - First 15 attempts (15 seconds): 1 second intervals untuk fast response
    // - Next 15 attempts (15 seconds): 1.5 second intervals  
    // - Remaining attempts: 2 second intervals
    let interval;
    if(pollTries <= 15) {
      interval = 1000; // Super responsive first 15 seconds
    } else if(pollTries <= 30) {
      interval = 1500; // Moderate for next 15 seconds  
    } else {
      interval = 2000; // Standard after 30 seconds
    }
    
    pollTimer = window.setTimeout(function(){ pollStatus(token); }, interval);
  }

  async function startFlow(){
    if(starting || waiting || checkpointVerified) return;
    const hasActiveKey = !!(state.key && state.expiresAt && state.expiresAt > Date.now());
    if(hasActiveKey && state.capReached) return; // udah mentok, START disabled anyway

    starting = true;
    render();
    try{
      const data = await apiPost('/start', {});
      if(!data.success){
        try{
          const fresh = await apiGet('/state');
          if(fresh.success) state = fresh;
        }catch(e){}
        
        // Show error notification based on error code
        if(data.code === 'COOLDOWN'){
          showAlert('warning', 'Please Wait', 'You need to wait ' + (data.waitSeconds || 30) + ' seconds before starting a new checkpoint.');
        } else if(data.code === 'LIMIT_REACHED'){
          showAlert('error', 'Limit Reached', 'You have reached the maximum of 3 keys for this provider.');
        } else {
          showAlert('error', 'Unable to Start', data.error || 'Failed to start checkpoint. Please try again.');
        }
        
        if(data.code !== 'COOLDOWN'){
          showNote(data.error || 'Unable to start. Please try again.');
        }
        starting = false;
        render();
        return;
      }
      
      // PENTING: kalau server nge-resume sesi checkpoint yang masih pending
      // (multi-checkpoint provider kayak lootlabs/workink), trust server data!
      // Server knows the actual progress - update directly
      if(data.checkpointCount != null && data.checkpointCount >= 0) {
        currentCheckpoint = data.checkpointCount; // Direct from server
      }
      if(data.requiredCheckpoints) {
        requiredCheckpoints = data.requiredCheckpoints;
      }
      
      pendingToken = data.token;
      savePending(data.token, false, currentCheckpoint, requiredCheckpoints);
      
      if(data.checkpointUrl){
        // REDIRECT LANGSUNG ke checkpoint URL di tab yang sama (bukan buka tab baru)
        // Simpan EXACT URL halaman ini (provider page) di localStorage
        // PENTING: Build URL dari origin + pathname (yang sudah di-update via history.replaceState)
        try{
          const storageKey = 'jinhub_return_url_' + slug;
          // Gunakan window.location untuk ambil URL yang sudah di-update oleh history.replaceState
          const currentUrl = window.location.origin + window.location.pathname;
          localStorage.setItem(storageKey, currentUrl);
        }catch(e){}
        
        // Redirect ke ads
        window.location.href = data.checkpointUrl;
        
        // Note: Setelah redirect, code di bawah tidak akan jalan
        // User akan balik ke sini setelah ads selesai via redirect dari provider
      } else {
        showAlert('error', 'Configuration Error', 'Provider link has not been configured yet. Please contact the administrator.');
        showNote('Provider link belum di-setting admin. Hubungi admin JinHub.');
        starting = false;
        render();
      }
    }catch(e){
      starting = false;
      showAlert('error', 'Connection Error', 'Failed to connect to server. Please check your internet connection and try again.');
      showNote('Gagal menghubungi server. Coba lagi.');
      render();
    }
  }

  // mode: "new" (tombol Get a New Key) | "renew" (key expired) | "extend" (key masih aktif, add time)
  // targetKey: key string yang mau di-renew atau di-extend
  async function claimKey(mode, targetKey){
    if(claiming || !checkpointVerified || !pendingToken) return;
    claiming = true;
    render();
    try{
      const data = await apiPost('/claim', { token: pendingToken, mode: mode, targetKey: targetKey });
      if(data.success){
        state.keys = data.keys || [];
        state.totalKeys = data.totalKeys || 0;
        state.remaining = data.remaining || 0;
        state.lastClaimAt = data.lastClaimAt;
        
        // Update activeKeys dan expiredKeys
        const now = Date.now();
        state.activeKeys = state.keys.filter(k => k.expiresAt > now).map(k => k.key);
        state.expiredKeys = state.keys.filter(k => k.expiresAt <= now).map(k => k.key);
        
        checkpointVerified = false;
        pendingToken = null;
        currentCheckpoint = 0;
        clearPending();
        
        // Show success notifications based on mode
        if(mode === 'extend' && data.addedMin){
          const bonusText = fmtBonus(data.addedMin);
          showAlert('success', 'Time Added!', bonusText + ' has been added to your key successfully.');
          showNote(bonusText + ' added to your key!');
        } else if(mode === 'new'){
          showAlert('success', 'Key Created!', 'Your new key has been created successfully: ' + (data.newKey || ''));
          showNote('New key created: ' + (data.newKey || ''));
        } else if(mode === 'renew'){
          showAlert('success', 'Key Renewed!', 'Your key has been renewed successfully: ' + (data.renewedKey || ''));
          showNote('Key renewed: ' + (data.renewedKey || ''));
        }
      } else {
        // Bisa gagal karena race condition, tarik ulang state dari server
        try{
          const fresh = await apiGet('/state');
          if(fresh.success){
            state = fresh;
            const now = Date.now();
            state.activeKeys = state.keys.filter(k => k.expiresAt > now).map(k => k.key);
            state.expiredKeys = state.keys.filter(k => k.expiresAt <= now).map(k => k.key);
          }
        }catch(e){}
        
        // Reset checkpoint state jika sudah tidak relevan
        if(state.totalKeys >= 3 || (mode !== 'new' && !targetKey)){
          checkpointVerified = false;
          pendingToken = null;
          clearPending();
        }
        
        // Show error notification
        const errorMsg = data.error || 'Failed to claim key. Please try again.';
        showAlert('error', 'Oops!', errorMsg);
        showNote(errorMsg);
      }
    }catch(e){
      showAlert('error', 'Connection Error', 'Failed to connect to server. Please check your internet connection and try again.');
      showNote('Failed to connect to server. Please try again.');
    }
    claiming = false;
    render();
  }

  function copyKey(keyString){
    if(!keyString) return;
    
    const showToast = function(success){
      if(!window.Swal) return; // Fallback kalau SweetAlert2 belum load
      
      Swal.mixin({
        toast: true,
        position: "bottom", // Muncul di bawah card key
        showConfirmButton: false,
        timer: 3000,
        timerProgressBar: true,
        backdrop: false, // DISABLE backdrop (no overlay hitam)
        showClass: {
          backdrop: 'swal2-noanimation' // No animation untuk backdrop
        },
        hideClass: {
          backdrop: 'swal2-noanimation'
        },
        didOpen: (toast) => {
          toast.onmouseenter = Swal.stopTimer;
          toast.onmouseleave = Swal.resumeTimer;
        },
        background: '#1a1a2e',
        color: '#ffffff',
        customClass: {
          popup: 'swal-jinhub-toast swal-jinhub-toast-bottom',
          icon: 'swal-jinhub-toast-icon',
          title: 'swal-jinhub-toast-title',
          container: 'swal-jinhub-toast-container' // Custom container class
        }
      }).fire({
        icon: success ? "success" : "error",
        title: success ? "Key copied to clipboard!" : "Failed to copy key"
      });
    };
    
    const done = function(success){
      const allCopyBtns = document.querySelectorAll('[data-pk-copy]');
      allCopyBtns.forEach(btn => btn.classList.add('is-copied'));
      window.setTimeout(function(){
        allCopyBtns.forEach(btn => btn.classList.remove('is-copied'));
      }, 1400);
      
      showToast(success);
    };
    
    if(navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(keyString).then(function(){
        done(true);
      }).catch(function(){
        done(false);
      });
    } else {
      // Fallback untuk browser lama - anggap berhasil
      done(true);
    }
  }

  // Batalin sesi checkpoint yang lagi nggantung & balikin UI ke READY,
  // TANPA nunggu timeout polling (10 menit) atau TTL sesi di server (30
  // menit). Dipanggil pas user klik "Back" ATAU pas halaman baru dibuka
  // dan ternyata sesi lama belum keverifikasi. Ini justru NGURANGIN beban
  // ke Cloudflare Workers/KV dibanding polling terus-terusan sampai timeout.
  function cancelPendingCheckpoint(){
    stopPolling();
    waiting = false;
    checkpointVerified = false;
    pendingToken = null;
    clearPending();
    // Tutup tab checkpoint kalau masih kebuka
    if(checkpointTab && !checkpointTab.closed){
      try{ checkpointTab.close(); }catch(e){}
    }
    checkpointTab = null;
    showNote(null);
    render();
  }

  el.startBtn.addEventListener('click', startFlow);
  el.newKeyBtn.addEventListener('click', function(){ claimKey('new', null); });
  // Tombol renew/extend per-key sudah di-handle di dalam render() dengan onclick dynamic

  // Klik "Back" -> anggep sesi checkpoint yang lagi jalan batal seketika.
  const backBtn = root.querySelector('[data-pk-back]');
  if(backBtn){ backBtn.addEventListener('click', cancelPendingCheckpoint); }

  // Load pertama: sinkron state beneran dari server
  const pending = loadPending();

  // PREVENT PROGRESS FLICKER: langsung pakai object 'pending' yang UDAH
  // di-parse sama loadPending() di atas. 
  // CRITICAL: Only restore pending if it has ACTUAL progress (> 0)
  // Don't overwrite with 0 from stale localStorage!
  if(pending && pending.token) {
    if(pending.checkpointCount && pending.checkpointCount > 0) {
      currentCheckpoint = pending.checkpointCount;
      console.log('[KeySystem] Restored checkpoint from localStorage:', currentCheckpoint);
    }
    if(pending.requiredCheckpoints) {
      requiredCheckpoints = pending.requiredCheckpoints;
    }
  }
  // Render SEKALI di awal pakai apapun yang udah kita tau (cache keys +
  // pending checkpoint kalau ada) -- SEBELUM ada network call apapun.
  // Ini yang bikin tabel key & progress bar gak sempet nge-flash kosong/0
  // pas halaman baru kebuka/reload.
  render();

  // Pas user baru balik dari ads, kita nampilin modal "Verification in
  // progress" di tengah layar (bukan toast kecil di pojok kayak sebelumnya)
  // sambil diem-diem ngecek status ke server di background -- lihat
  // showVerifyingModal() di atas.
  
  // CEK APAKAH BARU BALIK DARI ADS (single-tab flow)
  // Logic: Kalau ada localStorage jinhub_return_url_<slug>, berarti baru balik dari redirect
  let handledReturnFromAds = false; // Flag to prevent double-handling in normal flow
  (async function checkReturnFromAds(){
    try {
      // Cek localStorage dengan key per-provider: jinhub_return_url_<slug>
      const returnUrlKey = 'jinhub_return_url_' + slug;
      const hadReturnUrl = !!localStorage.getItem(returnUrlKey);
      
      if (hadReturnUrl) {
        console.log('[KeySystem] Detected return from ads - fast-track status check');
        
        // User baru balik dari ads redirect - cleanup localStorage
        localStorage.removeItem(returnUrlKey);
        
        // SHOW MODAL IMMEDIATELY (bahkan sebelum cek pending token)
        // Biar user PASTI lihat "Verification in progress"
        const modalCheckpointNum = Math.min((pending && pending.checkpointCount || 0) + 1, requiredCheckpoints || TOTAL_CHECKPOINTS);
        
        console.log('[DEBUG-BEFORE] About to call showVerifyingModal, function exists?', typeof showVerifyingModal);
        console.log('[DEBUG-BEFORE] modalCheckpointNum:', modalCheckpointNum, 'requiredCheckpoints:', requiredCheckpoints || TOTAL_CHECKPOINTS);
        
        try {
          showVerifyingModal(modalCheckpointNum, requiredCheckpoints || TOTAL_CHECKPOINTS);
          console.log('[DEBUG-AFTER] showVerifyingModal call completed');
        } catch(err) {
          console.error('[DEBUG-ERROR] showVerifyingModal threw error:', err);
        }
        
        // Kalau ada pending token, cek status langsung DENGAN PRIORITAS TINGGI
        if (pending && pending.token) {
          // Track when modal was shown untuk ensure minimum display time
          const modalShownAt = Date.now();
          const MIN_MODAL_DISPLAY_MS = 1500; // Minimum 1.5 seconds

          // MULTIPLE RAPID CHECKS (3x dengan delay pendek) untuk responsiveness
          let statusChecked = false;
          
          for(let attempt = 1; attempt <= 3 && !statusChecked; attempt++) {
            try {
              console.log('[KeySystem] Status check attempt', attempt);
              const statusData = await apiGet('/status?token=' + encodeURIComponent(pending.token));
              
              if (statusData.success && statusData.verified) {
                console.log('[KeySystem] ✓ VERIFIED - All checkpoints completed!');
                pendingToken = pending.token;
                checkpointVerified = true;
                currentCheckpoint = statusData.checkpointCount || requiredCheckpoints;
                requiredCheckpoints = statusData.requiredCheckpoints || requiredCheckpoints;
                savePending(pending.token, true, currentCheckpoint, requiredCheckpoints);
                
                // INSTANT UI UPDATE before state refresh
                render();
                
                // Load state THEN wait before closing modal (let user see "Verifying" for 1.5s minimum)
                await refreshState();
                
                // Calculate remaining time to reach minimum display duration
                const elapsed = Date.now() - modalShownAt;
                const remainingTime = Math.max(0, MIN_MODAL_DISPLAY_MS - elapsed);
                
                if (remainingTime > 0) {
                  await new Promise(resolve => setTimeout(resolve, remainingTime));
                }
                
                closeVerifyingModal();
                showAlert('success', 'All Checkpoints Completed!', 'Verification successful! You can now claim your key.');
                statusChecked = true;
                handledReturnFromAds = true; // Mark as handled to skip normal flow
                return; // Success - exit early
                
              } else if (statusData.success && (statusData.checkpointCount || 0) > 0) {
                console.log('[KeySystem] ✓ PARTIAL - Checkpoint', statusData.checkpointCount, '/', statusData.requiredCheckpoints, 'completed');
                // INSTANT progress update to prevent flicker
                pendingToken = pending.token;
                currentCheckpoint = statusData.checkpointCount;
                requiredCheckpoints = statusData.requiredCheckpoints || requiredCheckpoints;
                checkpointVerified = false;
                savePending(pending.token, false, currentCheckpoint, requiredCheckpoints);

                // Update modal with new checkpoint number
                updateVerifyingModal(currentCheckpoint, requiredCheckpoints);

                // IMMEDIATE render to show correct progress
                render();
                
                await refreshState();
                
                // Calculate remaining time to reach minimum display duration
                const elapsed = Date.now() - modalShownAt;
                const remainingTime = Math.max(0, MIN_MODAL_DISPLAY_MS - elapsed);
                
                if (remainingTime > 0) {
                  await new Promise(resolve => setTimeout(resolve, remainingTime));
                }
                
                closeVerifyingModal();
                showAlert('success', 'Checkpoint ' + currentCheckpoint + '/' + requiredCheckpoints + ' Complete!', 'Press START again to continue the next checkpoint.');
                statusChecked = true;
                handledReturnFromAds = true; // Mark as handled to skip normal flow
                return; // Success - exit early
                
              } else if (statusData.code === 'EXPIRED' || !statusData.success) {
                console.log('[KeySystem] ✗ Session expired/invalid');
                clearPending();
                closeVerifyingModal();
                showAlert('warning', 'Session Expired', 'Your checkpoint session has expired. Please press START again.');
                statusChecked = true;
                break; // Invalid session - stop trying
              }
              
              // If not verified yet and this is not the last attempt, wait briefly before retry
              if(attempt < 3) {
                await new Promise(resolve => setTimeout(resolve, 500)); // 500ms between attempts
              }
              
            } catch(e) {
              console.warn('[KeySystem] Status check attempt', attempt, 'failed:', e);
              // Try again after short delay (unless last attempt)
              if(attempt < 3) {
                await new Promise(resolve => setTimeout(resolve, 800)); // Longer delay on error
              }
            }
          }
          
          // If all attempts failed to get verified status, fall back to normal flow
          if(!statusChecked) {
            console.warn('[KeySystem] All status check attempts failed - falling back to normal polling');
            // Don't show error - just fall through to normal refresh
            closeVerifyingModal();
          }
        }
      }
    } catch(e) {
      console.error('[KeySystem] Return from ads detection failed:', e);
      closeVerifyingModal();
    }
    
    // Normal flow: refresh state dengan small delay biar UI cache sempat terlihat
    // Delay 300ms cukup untuk user lihat keys yang cached tanpa flicker
    // SKIP kalau sudah di-handle oleh checkReturnFromAds untuk prevent double-update
    setTimeout(() => {
      if(handledReturnFromAds){
        console.log('[KeySystem] Skipping normal flow - already handled by return-from-ads flow');
        return; // Don't run normal flow if already handled
      }
      
      refreshState().then(async function(){
        if(!pending || !pending.token) return;
      
      // Cek apakah checkpoint lama masih relevan
      if(state.totalKeys >= 3){
        clearPending();
        return;
      }

      try{
        const data = await apiGet('/status?token=' + encodeURIComponent(pending.token));
        if(data.success && data.verified){
          pendingToken = pending.token;
          checkpointVerified = true;
          currentCheckpoint = data.checkpointCount || requiredCheckpoints;
          requiredCheckpoints = data.requiredCheckpoints || requiredCheckpoints;
          render();
        } else if(data.success && (data.checkpointCount || 0) > 0){
          // Sama kayak di atas: checkpoint parsial BUKAN sesi invalid,
          // jangan di-clearPending -- cuma update progress-nya aja.
          pendingToken = pending.token;
          currentCheckpoint = data.checkpointCount;
          requiredCheckpoints = data.requiredCheckpoints || requiredCheckpoints;
          checkpointVerified = false;
          render();
        } else if(!data.success){
          // Token beneran invalid/expired di server -> baru di-clear.
          clearPending();
        }
      }catch(e){
        // Network glitch doang -- JANGAN buang progress yang udah ada
        // cuma gara-gara request status gagal sesaat.
      }
    });
  }, 300); // 300ms delay to let cached UI show first
  })();
};
`;
