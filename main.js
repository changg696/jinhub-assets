
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

  function render(){
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
      currentCheckpoint = 0;
      showAlert('warning', 'Checkpoint Timeout', 'Checkpoint verification timed out. Please press START again.');
      showNote('Checkpoint belum kekonfirmasi. Coba tekan START lagi.');
      render();
      return;
    }
    try{
      const data = await apiGet('/status?token=' + encodeURIComponent(token));
      if(data.success){
        // ALWAYS update checkpoint progress dari server (baik verified atau belum)
        currentCheckpoint = data.checkpointCount || 0;
        requiredCheckpoints = data.requiredCheckpoints || TOTAL_CHECKPOINTS;
        
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
      // (multi-checkpoint provider kayak lootlabs/workink), JANGAN reset
      // currentCheckpoint ke 0 -- pakai checkpointCount yang server balikin
      // biar progress bar tetep nampilin ronde yang udah kelar sebelumnya.
      currentCheckpoint = data.checkpointCount || 0;
      requiredCheckpoints = data.requiredCheckpoints || TOTAL_CHECKPOINTS;
      
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

  // ===== CRITICAL FIX: CHECK RETURN FROM ADS SYNCHRONOUSLY BEFORE INITIAL RENDER =====
  // Kalau user baru balik dari ads, JANGAN render dengan cached checkpointCount lama (0)
  // Kita perlu preserve OLD checkpoint count sampai API update nya datang
  const returnUrlKey = 'jinhub_return_url_' + slug;
  const isReturningFromAds = !!localStorage.getItem(returnUrlKey);
  
  // PREVENT PROGRESS FLICKER: langsung pakai object 'pending' yang UDAH
  // di-parse sama loadPending() di atas. Sebelumnya di sini ada re-read +
  // re-parse localStorage KEDUA KALINYA -- kalau itu gagal/keselip timing,
  // currentCheckpoint diem di nilai awal (0) dan progress kelihatan "0/X"
  // sesaat sebelum kekoreksi belakangan. Sekarang cuma 1 sumber data.
  if(pending && pending.token && pending.checkpointCount >= 0) {
    currentCheckpoint = pending.checkpointCount || 0;
    requiredCheckpoints = pending.requiredCheckpoints || TOTAL_CHECKPOINTS;
  }
  
  // CRITICAL: Kalau returning from ads, DON'T show old cached progress (0/2)
  // Keep the LAST KNOWN checkpoint count from pending to prevent flicker
  // The API call will update it in ~500ms with real server data
  if(isReturningFromAds && pending && pending.checkpointCount !== undefined) {
    // Preserve last known checkpoint to prevent 1/2 -> 0/2 -> 2/2 jump
    console.log('[KeySystem] Returning from ads - preserving checkpoint:', pending.checkpointCount);
    currentCheckpoint = pending.checkpointCount; // Keep last value, don't reset to 0
  }
  
  // CRITICAL: Kalau returning from ads, mark as WAITING state
  // DON'T show stale checkpoint count from localStorage (might be outdated)
  // API call will update with fresh server data in ~100-500ms
  if(isReturningFromAds && pending && pending.token) {
    // Set waiting = true to prevent showing stale progress during API check
    waiting = true;
    console.log('[KeySystem] Returning from ads - setting WAITING state until API confirms progress');
  }
  
  // Render SEKALI di awal pakai apapun yang udah kita tau (cache keys +
  // pending checkpoint kalau ada) -- SEBELUM ada network call apapun.
  // Ini yang bikin tabel key & progress bar gak sempet nge-flash kosong/0
  // pas halaman baru kebuka/reload.
  render();

  // Toast KECIL non-blocking buat status "lagi ngecek checkpoint" -- ini
  // BUKAN showAlert() yang bikin popup di tengah layar. Popup di tengah
  // yang nutupin 2.5 detik itu yang bikin progress bar di baliknya
  // (yang sebenernya udah bener duluan) berasa "telat muncul".
  function showCheckingToast(){
    if(!window.Swal) return;
    Swal.mixin({
      toast: true,
      position: 'bottom', // Muncul di bawah card key (sama kayak notif copy key)
      showConfirmButton: false,
      timer: 4000,
      timerProgressBar: true,
      backdrop: false, // DISABLE backdrop (no overlay hitam)
      showClass: {
        backdrop: 'swal2-noanimation' // No animation untuk backdrop
      },
      hideClass: {
        backdrop: 'swal2-noanimation'
      },
      background: '#1a1a2e',
      color: '#ffffff',
      customClass: {
        popup: 'swal-jinhub-toast swal-jinhub-toast-bottom',
        icon: 'swal-jinhub-toast-icon',
        title: 'swal-jinhub-toast-title',
        container: 'swal-jinhub-toast-container' // Custom container class
      }
    }).fire({ icon: 'info', title: 'Checking progress...' });
  }
  
  // Toast SUCCESS untuk checkpoint completion (bottom, no backdrop)
  function showSuccessToast(title, text){
    if(!window.Swal) return;
    Swal.mixin({
      toast: true,
      position: 'bottom', // Muncul di bawah card key
      showConfirmButton: false,
      timer: 3000, // 3 seconds
      timerProgressBar: true,
      backdrop: false, // DISABLE backdrop (no overlay hitam)
      showClass: {
        backdrop: 'swal2-noanimation'
      },
      hideClass: {
        backdrop: 'swal2-noanimation'
      },
      background: '#1a1a2e',
      color: '#ffffff',
      customClass: {
        popup: 'swal-jinhub-toast swal-jinhub-toast-bottom',
        icon: 'swal-jinhub-toast-icon',
        title: 'swal-jinhub-toast-title',
        container: 'swal-jinhub-toast-container'
      }
    }).fire({ icon: 'success', title: title });
  }
  
  // CEK APAKAH BARU BALIK DARI ADS (single-tab flow)
  // Logic: Kalau ada localStorage jinhub_return_url_<slug>, berarti baru balik dari redirect
  (async function checkReturnFromAds(){
    try {
      // Cek localStorage dengan key per-provider: jinhub_return_url_<slug>
      const returnUrlKey = 'jinhub_return_url_' + slug;
      const hadReturnUrl = !!localStorage.getItem(returnUrlKey);
      
      if (hadReturnUrl) {
        console.log('[KeySystem] Detected return from ads - fast-track status check');
        
        // User baru balik dari ads redirect - cleanup localStorage
        localStorage.removeItem(returnUrlKey);
        
        // IMMEDIATE UI FEEDBACK - toast kecil non-blocking (bukan popup
        // center) biar gak nutupin progress bar yang udah ke-restore bener
        // dari localStorage di baris atas tadi.
        showCheckingToast();
        
        // Kalau ada pending token, cek status langsung DENGAN PRIORITAS TINGGI
        if (pending && pending.token) {
          // MULTIPLE RAPID CHECKS (3x dengan delay pendek) untuk responsiveness
          let statusChecked = false;
          
          for(let attempt = 1; attempt <= 3 && !statusChecked; attempt++) {
            try {
              console.log('[KeySystem] Status check attempt', attempt);
              const statusData = await apiGet('/status?token=' + encodeURIComponent(pending.token));
              
              if (statusData.success && statusData.verified) {
                console.log('[KeySystem] ✓ VERIFIED - All checkpoints completed!');
                waiting = false; // Clear waiting state
                pendingToken = pending.token;
                checkpointVerified = true;
                currentCheckpoint = statusData.checkpointCount || requiredCheckpoints;
                requiredCheckpoints = statusData.requiredCheckpoints || requiredCheckpoints;
                savePending(pending.token, true, currentCheckpoint, requiredCheckpoints);
                
                // INSTANT UI UPDATE before state refresh
                render();
                
                // Load state lalu show success alert
                await refreshState();
                showSuccessToast('All Checkpoints Completed! You can now claim your key.');
                statusChecked = true;
                return; // Success - exit early
                
              } else if (statusData.success && (statusData.checkpointCount || 0) > 0) {
                console.log('[KeySystem] ✓ PARTIAL - Checkpoint', statusData.checkpointCount, '/', statusData.requiredCheckpoints, 'completed');
                // INSTANT progress update to prevent flicker
                waiting = false; // Clear waiting state
                pendingToken = pending.token;
                currentCheckpoint = statusData.checkpointCount;
                requiredCheckpoints = statusData.requiredCheckpoints || requiredCheckpoints;
                checkpointVerified = false;
                savePending(pending.token, false, currentCheckpoint, requiredCheckpoints);

                // IMMEDIATE render to show correct progress
                render();
                
                await refreshState();
                showSuccessToast('Checkpoint ' + currentCheckpoint + '/' + requiredCheckpoints + ' Complete!');
                statusChecked = true;
                return; // Success - exit early
                
              } else if (statusData.code === 'EXPIRED' || !statusData.success) {
                console.log('[KeySystem] ✗ Session expired/invalid');
                waiting = false; // Clear waiting state
                clearPending();
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
            waiting = false; // Clear waiting state even on failure
            console.warn('[KeySystem] All status check attempts failed - falling back to normal polling');
            // Don't show error - just fall through to normal refresh
          }
        }
      }
    } catch(e) {
      console.error('[KeySystem] Return from ads detection failed:', e);
    }
    
    // Normal flow: refresh state dengan small delay biar UI cache sempat terlihat
    // Delay 300ms cukup untuk user lihat keys yang cached tanpa flicker
    setTimeout(() => {
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



(function(){
  // Fade-up entrance animation (.home-inview) pake animation-fill-mode:forwards,
  // yang bikin transform dari animasi itu terus "menang" atas transform dari
  // .home-card:hover walau animasinya udah selesai. Makanya efek naik/turun
  // pas hover kelihatan gak jalan. Fix-nya: begitu animasi fade-up kelar,
  // matiin animation di elemen itu, biar :hover + transition normal ambil alih.
  document.addEventListener('animationend', function(e){
    if(e.animationName === 'homeFadeUp' && e.target.classList && e.target.classList.contains('home-card')){
      e.target.classList.add('home-settled');
      e.target.style.animation = 'none';
    }
  });

  let typeStarted = false;
  function startTypewriter(){
    if(typeStarted) return; typeStarted = true;
    const container = document.getElementById('tw');
    const phrases = [
      ["Why Use ", {brand:true, text:"JinHub"}, "?"],
      ["Why Choose ", {brand:true, text:"JinHub"}, "?"],
      ["Why ", {brand:true, text:"JinHub"}, "?"],
      ["What Makes ", {brand:true, text:"JinHub"}, " Better?"],
      ["Why Pick ", {brand:true, text:"JinHub"}, "?"],
      ["Reason To use ", {brand:true, text:"JinHub"}]
    ];
    let p = 0, t = 0, el = null;
    function buildToken(token){
      const span = document.createElement('span');
      if(token.brand){ span.className = 'brand-word'; }
      span.textContent = '';
      return span;
    }
    function doType(){
      const tokens = phrases[p];
      if(!el){ el = buildToken(tokens[t]); container.appendChild(el); }
      const token = tokens[t];
      const full = token.text || token;
      const current = el.textContent;
      if(current.length < full.length){
        el.textContent = full.slice(0, current.length + 1);
        setTimeout(doType, 90);
      }else{
        t++;
        if(t < tokens.length){
          el = buildToken(tokens[t]); container.appendChild(el);
          setTimeout(doType, 90);
        }else{
          setTimeout(startErase, 1100);
        }
      }
    }
    function startErase(){
      const nodes = Array.from(container.childNodes);
      if(nodes.length === 0){
        p = (p + 1) % phrases.length; t = 0; el = null;
        setTimeout(doType, 420); return;
      }
      const last = nodes[nodes.length - 1];
      if(last.textContent.length > 0){
        last.textContent = last.textContent.slice(0, -1);
        setTimeout(startErase, 60);
      }else{
        last.remove();
        setTimeout(startErase, 40);
      }
    }
    doType();
  }

  function resetCardEntrance(){
    var cards = document.querySelectorAll('#tab-home .home-card');
    cards.forEach(function(card){
      card.classList.remove('home-settled');
      card.style.animation = '';
    });
  }

  window.JinHubTabs.home = {
    onShow: function(){
      resetCardEntrance();
      startTypewriter();
    }
  };
})();



(function(){
  const stepHero      = document.getElementById('gkStepHero');
  const stepProviders = document.getElementById('gkStepProviders');

  // Kumpulin semua halaman "Key System" provider (.pk-page) yang udah
  // ke-render di dalam #tab-getkey (dari src/tabs/provider/<nama>/template.js).
  const pkPages = {};
  document.querySelectorAll('#tab-getkey .pk-page').forEach(function(elm){
    pkPages[elm.dataset.provider] = elm;
  });

  // Dipakai biar deep-link (mis. buka langsung /getkey/lootlabs) cuma
  // di-apply SEKALI pas page pertama kali load, bukan tiap kali user
  // pindah-pindah balik ke tab Get Key.
  let usedInitialProvider = false;

  // Animasi fade-in-up ditanam & dikendaliin di sini (bukan di nav.client.js) supaya
  // gak ada race condition antar file soal step mana yang lagi aktif.
  function triggerAnim(el){
    el.classList.remove('gk-inview');
    void el.offsetWidth; // force reflow biar animasi bisa di-replay tiap kali dipanggil
    el.classList.add('gk-inview');
  }

  function hideAllSteps(){
    stepHero.classList.remove('active');
    stepProviders.classList.remove('active');
    Object.keys(pkPages).forEach(function(slug){ pkPages[slug].classList.remove('active'); });
  }

  // step: 'hero' | 'providers'
  function showStep(step){
    // SCROLL TO TOP DULU - KHUSUS MOBILE/iOS biar title gak ketutup navbar
    window.scrollTo(0, 0);
    
    hideAllSteps();
    const target = (step === 'providers') ? stepProviders : stepHero;
    target.classList.add('active');
    triggerAnim(target);
    
    // Update page title
    if(step === 'providers'){
      document.title = 'JinHub - Free Key';
    } else {
      document.title = 'JinHub - Get Key';
    }
    
    try { history.replaceState(null, '', '/getkey'); } catch(e){}
  }

  // Dipanggil pas user pencet "Continue" di kartu provider (step 2), ATAU
  // pas landing langsung ke /getkey/<provider> (deep link dari worker.js).
  // slug null/gak dikenal -> balik ke step 2 (list provider).
  function showProviderPage(slug){
    // SCROLL TO TOP DULU - KHUSUS MOBILE/iOS biar title gak ketutup navbar
    window.scrollTo(0, 0);
    
    if(!slug || !pkPages[slug]){ showStep('providers'); return; }
    hideAllSteps();
    pkPages[slug].classList.add('active');
    triggerAnim(pkPages[slug]);
    
    // Update page title based on provider
    const providerTitles = {
      'lootlabs': 'JinHub - Lootlabs Key',
      'linkvertise': 'JinHub - Linkvertise Key',
      'workink': 'JinHub - Work.ink Key'
    };
    document.title = providerTitles[slug] || 'JinHub - Get Key';
    
    try { history.replaceState(null, '', '/getkey/' + slug); } catch(e){}

    const tabKey = 'pk_' + slug;
    if(window.JinHubTabs[tabKey] && typeof window.JinHubTabs[tabKey].onShow === 'function'){
      window.JinHubTabs[tabKey].onShow();
    }
  }
  window.showProviderPage = showProviderPage; // dipakai tombol Back di halaman provider

  const continueFreeBtn = document.getElementById('gkContinueFreeBtn');
  if(continueFreeBtn){ continueFreeBtn.addEventListener('click', ()=> showStep('providers')); }

  const backBtn = document.getElementById('gkBackBtn');
  if(backBtn){ backBtn.addEventListener('click', ()=> showStep('hero')); }

  const premiumBtn = document.getElementById('gkPremiumBtn');
  if(premiumBtn){ premiumBtn.addEventListener('click', ()=> window.showTab('premium')); }

  const upsellBtn = document.getElementById('gkUpsellBtn');
  if(upsellBtn){ upsellBtn.addEventListener('click', ()=> window.showTab('premium')); }

  // Tombol "Continue" di tiap kartu provider (step 2) -> masuk ke halaman
  // Key System provider itu (step 3), BUKAN langsung buka link ad-nya.
  document.querySelectorAll('#tab-getkey [data-provider-slug]').forEach(function(btn){
    btn.addEventListener('click', function(){ showProviderPage(btn.dataset.providerSlug); });
  });

  // Tombol "Back" di tiap halaman Key System provider -> balik ke step 2.
  document.querySelectorAll('#tab-getkey [data-pk-back]').forEach(function(btn){
    btn.addEventListener('click', function(){ showProviderPage(null); });
  });

  // Setiap kali balik ke tab Get Key dari nav utama, selalu mulai dari step Hero
  // (kecuali pas load pertama kali user emang landing di /getkey/<provider>).
  //
  // window.scrollTo(0,0) WAJIB ada di sini: tab getkey (di desktop) dibikin
  // overflow:hidden lewat CSS supaya gak bisa di-scroll. Tapi kalau sebelum
  // pindah ke tab ini user lagi scroll jauh ke bawah di tab lain (misal tab
  // Home), posisi scroll itu KEBAWA pas tab getkey ditampilin -- karena
  // overflow:hidden cuma nge-lock, bukan reset posisi scroll. Hasilnya
  // bagian atas (judul "Unlock JinHub") ketutup/ilang dari layar. Reset ke
  // (0,0) di awal onShow ini yang mastiin tab getkey selalu mulai dari
  // paling atas, siapapun dari tab mana pindahnya.
  window.JinHubTabs.getkey = {
    onShow: function(){
      window.scrollTo(0, 0);
      if(!usedInitialProvider && window.__initialProviderSlug){
        usedInitialProvider = true;
        showProviderPage(window.__initialProviderSlug);
      } else {
        showStep('hero');
      }
    }
  };
})();



window.JinHubTabs.pk_linkvertise = {
  onShow: function(){
    window.JinHubKeySystem.init('linkvertise', {});
  }
};



window.JinHubTabs.pk_lootlabs = {
  onShow: function(){
    window.JinHubKeySystem.init('lootlabs', {});
  }
};



window.JinHubTabs.pk_workink = {
  onShow: function(){
    window.JinHubKeySystem.init('workink', {});
  }
};



(function(){
  const scripts = window.__scriptsData || [];
  let activeFilter = 'all';
  let searchQuery  = '';

  // Sama kayak tab home: animasi scriptsFadeUp pake forwards, yang bikin
  // transform dari animasi itu terus "menang" atas transform dari
  // .s-card:hover walau animasinya udah selesai. Fix-nya: begitu animasi
  // fade-up kelar, tandain settled + matiin animation di elemen itu, biar
  // :hover + transition normal ambil alih buat efek naik pas cursor masuk.
  document.addEventListener('animationend', function(e){
    if(e.animationName === 'scriptsFadeUp' && e.target.classList && e.target.classList.contains('s-card')){
      e.target.classList.add('s-settled');
      e.target.style.animation = 'none';
    }
  });

  function resetCardEntrance(){
    document.querySelectorAll('#tab-scripts .s-card').forEach(function(card){
      card.classList.remove('s-settled');
      card.style.animation = '';
    });
  }

  const SVG_COPY  = '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
  const SVG_CHECK = '<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>';
  const SVG_LIST  = '<svg viewBox="0 0 24 24"><path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2M9 5a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2M9 5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2M9 12h6M9 16h4"/></svg>';

  function renderScripts(){
    const grid    = document.getElementById('scriptsGrid');
    const countEl = document.getElementById('scriptsCount');
    const q = searchQuery.toLowerCase();
    const filtered = scripts.filter(s=>{
      const matchFilter = activeFilter === 'all' || (s.status||'Working') === activeFilter;
      const matchSearch = !q || s.title.toLowerCase().includes(q);
      return matchFilter && matchSearch;
    });

    countEl.textContent = filtered.length + ' script' + (filtered.length !== 1 ? 's' : '');

    if(filtered.length === 0){
      grid.innerHTML =
        '<div class="scripts-empty">'
        + '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="11" x2="14" y2="11"/></svg>'
        + '<strong style="font-size:15px;color:#3a4a6a;">No scripts found</strong>'
        + '<p>Try a different search or filter.</p>'
        + '</div>';
      return;
    }

    grid.innerHTML = filtered.map(s=>{
      const realIdx   = scripts.indexOf(s);
      const status    = s.status || 'Working';
      const statusCls = status === 'Working' ? 'working' : 'discontinue';
      const featCount = Array.isArray(s.features) ? s.features.length : 0;
      const progW     = Math.min(100, 40 + featCount * 4);
      return (
        '<article class="s-card">'
        + '<div class="s-thumb">'
        + (s.img ? '<img src="'+s.img+'" alt="'+s.title+'" loading="lazy">' : '<div style="background:#0d1320;width:100%;height:100%"></div>')
        + '<div class="s-thumb-overlay"></div>'
        + '<span class="s-status '+statusCls+'"><span class="s-dot"></span>'+status+'</span>'
        + '</div>'
        + '<div class="s-body">'
        + '<div class="s-title-row">'
        + '<h3 class="s-title">'+s.title+'</h3>'
        + '<span class="s-feat-pill">'+featCount+' feat</span>'
        + '</div>'
        + '<div class="s-prog"><div class="s-prog-fill" style="width:'+progW+'%"></div></div>'
        + '<div class="s-actions">'
        + '<button class="s-btn copy-btn" data-i="'+realIdx+'">'+SVG_COPY+'<span>Copy Script</span></button>'
        + '<button class="s-btn feat-btn" data-i="'+realIdx+'">'+SVG_LIST+'<span>Features</span></button>'
        + '</div>'
        + '</div>'
        + '</article>'
      );
    }).join('');
  }

  renderScripts();

  document.querySelectorAll('.s-filter').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      document.querySelectorAll('.s-filter').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      activeFilter = btn.dataset.filter;
      renderScripts();
    });
  });

  document.getElementById('scriptSearch').addEventListener('input', e=>{
    searchQuery = e.target.value;
    renderScripts();
  });

  document.getElementById('scriptsGrid').addEventListener('click', async e=>{
    const btn = e.target.closest('.copy-btn'); if(!btn) return;
    const idx  = +btn.dataset.i;
    const code = scripts[idx]?.script || '';
    try{ await navigator.clipboard.writeText(code); }
    catch{
      const ta = document.createElement('textarea'); ta.value = code;
      document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
    }
    btn.classList.add('copied');
    btn.innerHTML = SVG_CHECK + '<span>Copied!</span>';
    setTimeout(()=>{
      btn.classList.remove('copied');
      btn.innerHTML = SVG_COPY + '<span>Copy Script</span>';
    }, 1600);
  });

  document.getElementById('scriptsGrid').addEventListener('click', e=>{
    const b = e.target.closest('.feat-btn'); if(!b) return;
    const i = +b.dataset.i; const s = scripts[i] || {};
    window.openFeatureModal(s.title, s.features);
  });

  window.JinHubTabs.scripts = { onShow: resetCardEntrance };
})();



(function(){
  const WEAO_API = 'https://weao.xyz/api';
  const REFRESH_INTERVAL = 900000; // 15 menit (900 detik) - sangat hemat API calls
  const CACHE_DURATION = 600000; // 10 menit cache - balance antara freshness dan performance
  
  let allExecutors = [];
  let searchQuery = '';
  let refreshTimer = null;
  
  // Filter state
  let filterState = {
    pricing: [], // 'free', 'paid'
    keySystem: [], // 'keyless', 'key-system'
    platform: [], // 'windows', 'mac', 'android', 'ios'
    type: [], // 'executor', 'external'
    detection: [], // 'undetected', 'detected', 'client-mod-bypass', 'possible-banswave', 'unknown'
    status: [] // 'updated', 'not-updated'
  };
  
  // ===== CACHE HELPERS =====
  function getCachedData(key) {
    try {
      const cached = localStorage.getItem('weao_' + key);
      if (!cached) return null;
      
      const data = JSON.parse(cached);
      const now = Date.now();
      
      // Check if cache is still valid
      if (now - data.timestamp < CACHE_DURATION) {
        console.log('Using cached data for:', key);
        return data.value;
      }
      
      // Cache expired
      localStorage.removeItem('weao_' + key);
      return null;
    } catch (err) {
      console.error('Cache read error:', err);
      return null;
    }
  }
  
  function setCachedData(key, value) {
    try {
      const data = {
        timestamp: Date.now(),
        value: value
      };
      localStorage.setItem('weao_' + key, JSON.stringify(data));
    } catch (err) {
      console.error('Cache write error:', err);
    }
  }

  const els = {
    loading: document.querySelector('[data-ex-loading]'),
    error: document.querySelector('[data-ex-error]'),
    errorMsg: document.querySelector('[data-error-message]'),
    list: document.querySelector('[data-ex-list]'),
    empty: document.querySelector('[data-ex-empty]'),
    search: document.querySelector('[data-ex-search]'),
    refresh: document.querySelector('[data-ex-refresh]'),
    retry: document.querySelector('[data-ex-retry]'),
    versionsRefresh: document.querySelector('[data-versions-refresh]'),
    filterBtn: document.querySelector('[data-ex-filter]')
  };

  // ===== FETCH ROBLOX VERSIONS =====
  async function fetchRobloxVersions() {
    try {
      // Check cache first
      const cached = getCachedData('versions');
      if (cached) {
        updateVersionsUI(cached);
        return;
      }
      
      const res = await fetch(WEAO_API + '/versions/current', {
        headers: {
          'User-Agent': 'WEAO-3PService'
        }
      });
      if (!res.ok) throw new Error('Failed to fetch versions');
      
      const data = await res.json();
      
      // Save to cache
      setCachedData('versions', data);
      
      // Update UI
      updateVersionsUI(data);
      
    } catch (err) {
      console.error('Failed to fetch Roblox versions:', err);
    }
  }
  
  function updateVersionsUI(data) {
    // Update Windows version
    const windowsEl = document.querySelector('[data-version="windows"]');
    const windowsDateEl = document.querySelector('[data-version-date="windows"]');
    if (windowsEl && data.Windows) {
      windowsEl.textContent = data.Windows;
      windowsEl.dataset.versionText = data.Windows;
    }
    if (windowsDateEl && data.WindowsDate) {
      windowsDateEl.textContent = data.WindowsDate.replace(' UTC', '').replace(' EST', '');
    }
    
    // Update Mac version
    const macEl = document.querySelector('[data-version="mac"]');
    const macDateEl = document.querySelector('[data-version-date="mac"]');
    if (macEl && data.Mac) {
      macEl.textContent = data.Mac;
      macEl.dataset.versionText = data.Mac;
    }
    if (macDateEl && data.MacDate) {
      macDateEl.textContent = data.MacDate.replace(' UTC', '').replace(' EST', '');
    }
    
    // Update Android version
    const androidEl = document.querySelector('[data-version="android"]');
    const androidDateEl = document.querySelector('[data-version-date="android"]');
    if (androidEl && data.Android) {
      androidEl.textContent = data.Android;
      androidEl.dataset.versionText = data.Android;
    }
    if (androidDateEl && data.AndroidDate) {
      androidDateEl.textContent = data.AndroidDate.replace(' UTC', '').replace(' EST', '');
    }
    
    // Update iOS version
    const iosEl = document.querySelector('[data-version="ios"]');
    const iosDateEl = document.querySelector('[data-version-date="ios"]');
    if (iosEl && data.iOS) {
      iosEl.textContent = data.iOS;
      iosEl.dataset.versionText = data.iOS;
    }
    if (iosDateEl && data.iOSDate) {
      iosDateEl.textContent = data.iOSDate.replace(' UTC', '').replace(' EST', '');
    }
  }

  // ===== FETCH EXECUTORS =====
  async function fetchExecutors() {
    try {
      // Check cache first
      const cached = getCachedData('executors');
      if (cached) {
        allExecutors = cached;
        renderExecutors();
        hideLoading();
        return;
      }
      
      showLoading();
      
      const res = await fetch(WEAO_API + '/status/exploits', {
        headers: {
          'User-Agent': 'WEAO-3PService'
        }
      });
      if (!res.ok) {
        if (res.status === 429) {
          throw new Error('Rate limit exceeded. Please wait a moment.');
        }
        throw new Error('Failed to fetch executors');
      }
      
      const data = await res.json();
      
      // Check if rate limited
      if (data.error === 'Too Many Requests') {
        throw new Error(data.error + '. Wait ' + Math.ceil(data.rateLimitInfo.remainingTime / 1000) + 's');
      }
      
      allExecutors = data;
      
      // Save to cache
      setCachedData('executors', data);
      
      renderExecutors();
      hideLoading();
    } catch (err) {
      showError(err.message);
    }
  }

  // ===== RENDER EXECUTORS (LIST VIEW PER PLATFORM) =====
  function renderExecutors() {
    let filtered = filterExecutors(allExecutors);
    
    // Filter out Melatonin dan Volcano
    filtered = filtered.filter(ex => {
      const title = ex.title.toLowerCase();
      return title !== 'melatonin' && title !== 'volcano';
    });
    
    if (filtered.length === 0) {
      els.list.hidden = true;
      els.empty.hidden = false;
      return;
    }
    
    els.list.hidden = false;
    els.empty.hidden = true;
    
    // Group by platform and type (Windows External paling bawah)
    const grouped = {
      'windows-script': filtered.filter(ex => ex.platform === 'Windows' && ex.extype === 'wexecutor'),
      mac: filtered.filter(ex => ex.platform === 'Mac'),
      android: filtered.filter(ex => ex.platform === 'Android'),
      ios: filtered.filter(ex => ex.platform.toLowerCase().includes('ios')),
      'windows-external': filtered.filter(ex => ex.platform === 'Windows' && ex.extype === 'wexternal')
    };
    
    // Render each platform section
    Object.keys(grouped).forEach(platform => {
      const listEl = document.querySelector('[data-list="' + platform + '"]');
      const sectionEl = document.querySelector('[data-platform="' + platform + '"]');
      
      if (listEl && sectionEl) {
        if (grouped[platform].length === 0) {
          // Hide section jika tidak ada data
          sectionEl.hidden = true;
        } else {
          // Show section dan render items
          sectionEl.hidden = false;
          listEl.innerHTML = grouped[platform].map((ex) => createListItem(ex)).join('');
        }
      }
    });
    
    // Trigger fade-in animation
    setTimeout(() => {
      document.querySelectorAll('.ex-item').forEach((item, i) => {
        setTimeout(() => {
          item.classList.add('ex-visible');
        }, i * 30);
      });
    }, 50);
  }

  // ===== FILTER EXECUTORS (SEARCH ONLY) =====
  function filterExecutors(executors) {
    const search = searchQuery.toLowerCase();
    
    let filtered = executors;
    
    // Search filter
    if (search) {
      filtered = filtered.filter(ex => {
        return ex.title.toLowerCase().includes(search) ||
               ex.platform.toLowerCase().includes(search);
      });
    }
    
    // Pricing filter
    if (filterState.pricing.length > 0) {
      filtered = filtered.filter(ex => {
        if (filterState.pricing.includes('free') && ex.free) return true;
        if (filterState.pricing.includes('paid') && !ex.free) return true;
        return false;
      });
    }
    
    // Key System filter
    if (filterState.keySystem.length > 0) {
      filtered = filtered.filter(ex => {
        if (filterState.keySystem.includes('keyless') && !ex.keysystem) return true;
        if (filterState.keySystem.includes('key-system') && ex.keysystem) return true;
        return false;
      });
    }
    
    // Platform filter
    if (filterState.platform.length > 0) {
      filtered = filtered.filter(ex => {
        const platform = ex.platform.toLowerCase();
        if (filterState.platform.includes('windows') && platform === 'windows') return true;
        if (filterState.platform.includes('mac') && platform === 'mac') return true;
        if (filterState.platform.includes('android') && platform === 'android') return true;
        if (filterState.platform.includes('ios') && platform.includes('ios')) return true;
        return false;
      });
    }
    
    // Type filter
    if (filterState.type.length > 0) {
      filtered = filtered.filter(ex => {
        if (filterState.type.includes('executor') && ex.extype === 'wexecutor') return true;
        if (filterState.type.includes('external') && ex.extype === 'wexternal') return true;
        return false;
      });
    }
    
    // Detection filter
    if (filterState.detection.length > 0) {
      filtered = filtered.filter(ex => {
        const detectionType = ex.detectionType || 'unknown';
        if (filterState.detection.includes('undetected') && detectionType === 'Undetected') return true;
        if (filterState.detection.includes('detected') && detectionType === 'Detected') return true;
        if (filterState.detection.includes('client-mod-bypass') && detectionType === 'Client Mod Bypass') return true;
        if (filterState.detection.includes('possible-banswave') && detectionType === 'Possible Banswave') return true;
        if (filterState.detection.includes('unknown') && detectionType === 'unknown') return true;
        return false;
      });
    }
    
    // Status filter
    if (filterState.status.length > 0) {
      filtered = filtered.filter(ex => {
        if (filterState.status.includes('updated') && ex.updateStatus === true) return true;
        if (filterState.status.includes('not-updated') && ex.updateStatus === false) return true;
        return false;
      });
    }
    
    return filtered;
  }

  // ===== CREATE EXECUTOR LIST ITEM (OLD DESIGN) =====
  function createListItem(ex) {
    // Status logic matching WEAO:
    // Green (Updated) = updateStatus === true (regardless of detected)
    // Red (Not Updated) = updateStatus === false
    const isWorking = ex.updateStatus === true;
    const statusClass = isWorking ? 'working' : 'down';
    const statusLabel = isWorking ? 'Updated' : 'Not Updated';
    const statusBg = isWorking ? 'rgba(34, 197, 94, 1)' : 'rgba(239, 68, 68, 1)';
    
    // Badges
    const uncBadge = ex.uncStatus 
      ? '<span class="ex-badge unc"><span class="ex-badge-s">s</span>UNC</span>'
      : '';
    
    const priceBadge = ex.free 
      ? '<span class="ex-badge free">FREE</span>'
      : '<span class="ex-badge paid">PAID</span>';
    
    const keysystemBadge = ex.keysystem 
      ? '<span class="ex-badge special">KEY SYSTEM</span>'
      : '';
    
    // Detection badge (for expanded view)
    const detectionBadge = ex.detected 
      ? '<span class="ex-expand-badge detected"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg> Detected</span>'
      : '';
    
    // Price display (for expanded view)
    const priceDisplay = !ex.free && ex.cost 
      ? '<span class="ex-expand-badge price">' + ex.cost + '</span>'
      : '';
    
    // Version display
    const versionDisplay = '<span class="ex-expand-info"><strong>version:</strong> ' + (ex.rbxversion || ex.version || 'Unknown') + '</span>';
    
    // sUNC score display
    const suncDisplay = ex.uncStatus && ex.suncPercentage !== undefined
      ? '<span class="ex-expand-info"><strong><span class="ex-sunc-s">s</span>UNC</strong> <span class="ex-sunc-percentage">' + ex.suncPercentage + '%</span></span>'
      : '';
    
    // UNC score display
    const uncDisplay = ex.uncPercentage !== undefined
      ? '<span class="ex-expand-info"><strong>UNC</strong> ' + ex.uncPercentage + '%</span>'
      : '';
    
    // Features display
    const decompilerDisplay = ex.decompiler 
      ? '<span class="ex-expand-info"><strong>Decompiler:</strong> <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg></span>'
      : '';
    
    const multiInjectDisplay = ex.multiInject 
      ? '<span class="ex-expand-info"><strong>Multi-Instance:</strong> <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg></span>'
      : '';
    
    return `
      <div class="ex-item-wrapper" data-executor-wrapper="${ex.title}">
        <div class="ex-item ex-${statusClass}" data-executor="${ex.title}" data-sunc-scrap="${ex.sunc?.suncScrap || ''}" data-sunc-key="${ex.sunc?.suncKey || ''}">
          <div class="ex-item-border" style="background: ${statusBg};"></div>
          
          <div class="ex-item-dots">
            <span></span>
            <span></span>
            <span></span>
          </div>
          
          <div class="ex-item-main">
            <div class="ex-item-title-wrap">
              <h4 class="ex-item-title">${ex.title}</h4>
              <span class="ex-item-version">${ex.version || 'v?'}</span>
            </div>
            
            <div class="ex-item-meta">
              <div class="ex-item-badges">
                ${uncBadge}
                ${priceBadge}
                ${keysystemBadge}
              </div>
              <span class="ex-item-updated">Last updated: ${formatDate(ex.updatedDate)}</span>
            </div>
          </div>
          
          <div class="ex-item-status">
            <span class="ex-status-label" style="background: ${statusBg};">${statusLabel}</span>
          </div>
          
          <button class="ex-item-expand" data-expand="${ex.title}" aria-expanded="false">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="6 9 12 15 18 9"/>
            </svg>
          </button>
        </div>
        
        <div class="ex-item-details" hidden>
          <div class="ex-item-details-inner">
            <div class="ex-details-badges">
              ${detectionBadge}
              ${priceDisplay}
            </div>
            
            <div class="ex-details-info-row">
              ${versionDisplay}
              ${suncDisplay}
              ${uncDisplay}
              ${decompilerDisplay}
              ${multiInjectDisplay}
            </div>
            
            <div class="ex-details-links">
              ${ex.websitelink ? '<a href="' + ex.websitelink + '" target="_blank" rel="noopener" class="ex-detail-btn"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><g fill="none"><path d="m12.594 23.258l-.012.002l-.071.035l-.02.004l-.014-.004l-.071-.036q-.016-.004-.024.006l-.004.01l-.017.428l.005.02l.01.013l.104.074l.015.004l.012-.004l.104-.074l.012-.016l.004-.017l-.017-.427q-.004-.016-.016-.018m.264-.113l-.014.002l-.184.093l-.01.01l-.003.011l.018.43l.005.012l.008.008l.201.092q.019.005.029-.008l.004-.014l-.034-.614q-.005-.019-.02-.022m-.715.002a.02.02 0 0 0-.027.006l-.006.014l-.034.614q.001.018.017.024l.015-.002l.201-.093l.01-.008l.003-.011l.018-.43l-.003-.012l-.01-.01z"/><path fill="currentColor" d="M13.649 2.135a10 10 0 0 0-3.298 0c-.336.456-.664 1.045-.963 1.764c-.282.676-.53 1.446-.736 2.291A29 29 0 0 1 12 6c1.155 0 2.278.066 3.348.19a15.6 15.6 0 0 0-.735-2.29c-.3-.72-.628-1.31-.964-1.765m2.093 6.123A27 27 0 0 0 12 8c-1.318 0-2.576.092-3.742.258A27 27 0 0 0 8 12c0 1.318.092 2.576.258 3.742C9.424 15.908 10.682 16 12 16s2.576-.091 3.742-.258C15.908 14.576 16 13.318 16 12s-.091-2.576-.258-3.742m2.068 7.09c.124-1.07.19-2.193.19-3.348a29 29 0 0 0-.19-3.348a15.6 15.6 0 0 1 2.29.736c.72.3 1.31.627 1.765.963a10 10 0 0 1 0 3.298c-.455.336-1.045.664-1.764.964c-.676.281-1.446.53-2.291.735m-2.462 2.462A29 29 0 0 1 12 18a29 29 0 0 1-3.348-.19c.206.845.454 1.615.736 2.29c.3.72.627 1.31.963 1.765a10 10 0 0 0 3.298 0c.336-.455.664-1.045.964-1.764c.281-.676.53-1.446.735-2.291m1.066 3.166l.045-.106c.415-.996.758-2.143 1.014-3.397a19 19 0 0 0 3.016-.862l.487-.197a10.04 10.04 0 0 1-4.562 4.562m-8.828 0l-.045-.106c-.415-.996-.758-2.143-1.014-3.397a19 19 0 0 1-3.016-.862l-.487-.197a10.04 10.04 0 0 0 4.562 4.562M6.19 15.348A29 29 0 0 1 6 12c0-1.155.066-2.278.19-3.348c-.845.206-1.615.454-2.29.736c-.72.3-1.31.627-1.765.963a10 10 0 0 0 0 3.298c.456.336 1.045.664 1.764.964c.676.281 1.446.53 2.291.735m.337-8.82A19 19 0 0 1 7.39 3.51l.197-.487a10.04 10.04 0 0 0-4.562 4.562l.106-.045c.996-.415 2.143-.758 3.397-1.014m10.946 0a19 19 0 0 0-.862-3.017l-.197-.487a10.04 10.04 0 0 1 4.562 4.562l-.106-.045c-.996-.415-2.143-.758-3.397-1.014"/></g></svg> Website</a>' : ''}
              ${ex.discordlink ? '<a href="' + ex.discordlink + '" target="_blank" rel="noopener" class="ex-detail-btn"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg> Discord</a>' : ''}
              ${ex.purchaselink ? '<a href="' + ex.purchaselink + '" target="_blank" rel="noopener" class="ex-detail-btn"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M2.237 2.288a.75.75 0 1 0-.474 1.423l.265.089c.676.225 1.124.376 1.453.529c.312.145.447.262.533.382s.155.284.194.626c.041.361.042.833.042 1.546v2.672c0 1.367 0 2.47.117 3.337c.12.9.38 1.658.982 2.26c.601.602 1.36.86 2.26.981c.866.117 1.969.117 3.336.117H18a.75.75 0 0 0 0-1.5h-7c-1.435 0-2.436-.002-3.192-.103c-.733-.099-1.122-.28-1.399-.556c-.235-.235-.4-.551-.506-1.091h10.12c.959 0 1.438 0 1.814-.248s.565-.688.943-1.57l.428-1c.81-1.89 1.215-2.834.77-3.508S18.506 6 16.45 6H5.745a9 9 0 0 0-.047-.833c-.055-.485-.176-.93-.467-1.333c-.291-.404-.675-.66-1.117-.865c-.417-.194-.946-.37-1.572-.58zM7.5 18a1.5 1.5 0 1 1 0 3a1.5 1.5 0 0 1 0-3m9 0a1.5 1.5 0 1 1 0 3a1.5 1.5 0 0 1 0-3"/></svg> Purchase</a>' : ''}
              ${ex.uncStatus && ex.sunc?.suncScrap && ex.sunc?.suncKey ? '<button class="ex-detail-btn ex-sunc-btn" data-sunc-fetch="' + ex.title + '"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg> <span class="ex-sunc-text"><span class="ex-sunc-s">s</span>UNC Results</span></button>' : ''}
            </div>
          </div>
        </div>
      </div>
    `;
  }

  // ===== COPY TO CLIPBOARD =====
  function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => {
        console.log('Copied to clipboard:', text);
      }).catch(err => {
        console.error('Failed to copy:', err);
      });
    } else {
      // Fallback for older browsers
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      try {
        document.execCommand('copy');
        console.log('Copied to clipboard:', text);
      } catch (err) {
        console.error('Failed to copy:', err);
      }
      document.body.removeChild(textarea);
    }
  }

  // ===== UI HELPERS =====
  function showLoading() {
    els.loading.hidden = false;
    els.error.hidden = true;
    els.list.hidden = true;
    els.empty.hidden = true;
  }

  function hideLoading() {
    els.loading.hidden = true;
  }

  function showError(message) {
    els.loading.hidden = true;
    els.error.hidden = false;
    els.list.hidden = true;
    els.empty.hidden = true;
    if (els.errorMsg) els.errorMsg.textContent = message;
  }

  function formatDate(dateStr) {
    if (!dateStr) return 'No date';
    
    // API returns format: "07/24/2025 at 3:47 PM UTC"
    // Just display it as-is since it's already human readable
    return dateStr.replace(' UTC', '').replace(' EST', '');
  }
  
  // ===== FILTER MODAL =====
  function showFilterModal() {
    // Create or get modal container
    let modalContainer = document.getElementById('ex-filter-modal-container');
    if (!modalContainer) {
      modalContainer = document.createElement('div');
      modalContainer.id = 'ex-filter-modal-container';
      modalContainer.className = 'ex-filter-modal-overlay';
      document.body.appendChild(modalContainer);
    }
    
    // Render modal
    let html = '<div class="ex-filter-modal">';
    
    // Header
    html += '<div class="ex-filter-modal-header">';
    html += '<h3>Filters</h3>';
    html += '<div class="ex-filter-modal-actions">';
    html += '<button class="ex-filter-clear-btn" data-filter-clear>Clear All</button>';
    html += '<button class="ex-filter-close-btn" data-filter-close>';
    html += '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    html += '</button>';
    html += '</div>';
    html += '</div>';
    
    // Content
    html += '<div class="ex-filter-modal-content">';
    
    // Pricing
    html += '<div class="ex-filter-group">';
    html += '<div class="ex-filter-group-label">PRICING</div>';
    html += '<div class="ex-filter-buttons">';
    html += '<button class="ex-filter-chip ' + (filterState.pricing.includes('free') ? 'active' : '') + '" data-filter="pricing" data-value="free">Free</button>';
    html += '<button class="ex-filter-chip ' + (filterState.pricing.includes('paid') ? 'active' : '') + '" data-filter="pricing" data-value="paid">Paid</button>';
    html += '</div>';
    html += '</div>';
    
    // Key System
    html += '<div class="ex-filter-group">';
    html += '<div class="ex-filter-group-label">KEY SYSTEM</div>';
    html += '<div class="ex-filter-buttons">';
    html += '<button class="ex-filter-chip ' + (filterState.keySystem.includes('keyless') ? 'active' : '') + '" data-filter="keySystem" data-value="keyless">Keyless</button>';
    html += '<button class="ex-filter-chip ' + (filterState.keySystem.includes('key-system') ? 'active' : '') + '" data-filter="keySystem" data-value="key-system">Key System</button>';
    html += '</div>';
    html += '</div>';
    
    // Platform
    html += '<div class="ex-filter-group">';
    html += '<div class="ex-filter-group-label">PLATFORM</div>';
    html += '<div class="ex-filter-buttons">';
    html += '<button class="ex-filter-chip ' + (filterState.platform.includes('windows') ? 'active' : '') + '" data-filter="platform" data-value="windows">';
    html += '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M0 3.449L9.75 2.1v9.451H0m10.949-9.602L24 0v11.4H10.949M0 12.6h9.75v9.451L0 20.699M10.949 12.6H24V24l-12.9-1.801"/></svg>';
    html += 'Windows</button>';
    html += '<button class="ex-filter-chip ' + (filterState.platform.includes('mac') ? 'active' : '') + '" data-filter="platform" data-value="mac">';
    html += '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/></svg>';
    html += 'Mac</button>';
    html += '<button class="ex-filter-chip ' + (filterState.platform.includes('android') ? 'active' : '') + '" data-filter="platform" data-value="android">';
    html += '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M17.523 15.341c-.7 0-1.263.565-1.263 1.265s.565 1.265 1.263 1.265 1.265-.565 1.265-1.265-.565-1.265-1.265-1.265zm-11.046 0c-.7 0-1.265.565-1.265 1.265s.565 1.265 1.265 1.265 1.265-.565 1.265-1.265-.565-1.265-1.265-1.265zM12 0C8.687 0 6 2.687 6 6v2H4.523A1.523 1.523 0 0 0 3 9.523v8.954A1.523 1.523 0 0 0 4.523 20h14.954A1.523 1.523 0 0 0 21 18.477V9.523A1.523 1.523 0 0 0 19.477 8H18V6c0-3.313-2.687-6-6-6zm-1 5a1 1 0 1 1 0 2 1 1 0 0 1 0-2zm2 0a1 1 0 1 1 0 2 1 1 0 0 1 0-2z"/></svg>';
    html += 'Android</button>';
    html += '<button class="ex-filter-chip ' + (filterState.platform.includes('ios') ? 'active' : '') + '" data-filter="platform" data-value="ios">iOS</button>';
    html += '</div>';
    html += '</div>';
    
    // Type
    html += '<div class="ex-filter-group">';
    html += '<div class="ex-filter-group-label">TYPE</div>';
    html += '<div class="ex-filter-buttons">';
    html += '<button class="ex-filter-chip ' + (filterState.type.includes('executor') ? 'active' : '') + '" data-filter="type" data-value="executor">Executor</button>';
    html += '<button class="ex-filter-chip ' + (filterState.type.includes('external') ? 'active' : '') + '" data-filter="type" data-value="external">External</button>';
    html += '</div>';
    html += '</div>';
    
    // Detection
    html += '<div class="ex-filter-group">';
    html += '<div class="ex-filter-group-label">DETECTION</div>';
    html += '<div class="ex-filter-buttons">';
    html += '<button class="ex-filter-chip ' + (filterState.detection.includes('undetected') ? 'active' : '') + '" data-filter="detection" data-value="undetected">Undetected</button>';
    html += '<button class="ex-filter-chip ' + (filterState.detection.includes('detected') ? 'active' : '') + '" data-filter="detection" data-value="detected">Detected</button>';
    html += '<button class="ex-filter-chip ' + (filterState.detection.includes('client-mod-bypass') ? 'active' : '') + '" data-filter="detection" data-value="client-mod-bypass">Client Mod Bypass</button>';
    html += '<button class="ex-filter-chip ' + (filterState.detection.includes('possible-banswave') ? 'active' : '') + '" data-filter="detection" data-value="possible-banswave">Possible Banswave</button>';
    html += '<button class="ex-filter-chip ' + (filterState.detection.includes('unknown') ? 'active' : '') + '" data-filter="detection" data-value="unknown">Unknown</button>';
    html += '</div>';
    html += '</div>';
    
    // Status
    html += '<div class="ex-filter-group">';
    html += '<div class="ex-filter-group-label">STATUS</div>';
    html += '<div class="ex-filter-buttons">';
    html += '<button class="ex-filter-chip ' + (filterState.status.includes('updated') ? 'active' : '') + '" data-filter="status" data-value="updated">Updated</button>';
    html += '<button class="ex-filter-chip ' + (filterState.status.includes('not-updated') ? 'active' : '') + '" data-filter="status" data-value="not-updated">Not Updated</button>';
    html += '</div>';
    html += '</div>';
    
    html += '</div>'; // end content
    html += '</div>'; // end modal
    
    modalContainer.innerHTML = html;
    modalContainer.classList.add('ex-filter-modal-active');
    
    // Add event listeners
    const filterChips = modalContainer.querySelectorAll('[data-filter]');
    filterChips.forEach(chip => {
      chip.addEventListener('click', () => {
        const filterType = chip.dataset.filter;
        const value = chip.dataset.value;
        
        // Toggle filter
        if (filterState[filterType].includes(value)) {
          filterState[filterType] = filterState[filterType].filter(v => v !== value);
          chip.classList.remove('active');
        } else {
          filterState[filterType].push(value);
          chip.classList.add('active');
        }
        
        // Re-render executors
        renderExecutors();
      });
    });
    
    // Clear all filters
    const clearBtn = modalContainer.querySelector('[data-filter-clear]');
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        filterState = {
          pricing: [],
          keySystem: [],
          platform: [],
          type: [],
          detection: [],
          status: []
        };
        renderExecutors();
        showFilterModal(); // Re-render modal
      });
    }
    
    // Close modal
    const closeBtn = modalContainer.querySelector('[data-filter-close]');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        modalContainer.classList.remove('ex-filter-modal-active');
      });
    }
    
    // Close on overlay click
    modalContainer.addEventListener('click', (e) => {
      if (e.target === modalContainer) {
        modalContainer.classList.remove('ex-filter-modal-active');
      }
    });
    
    // Close on ESC
    const escHandler = (e) => {
      if (e.key === 'Escape') {
        modalContainer.classList.remove('ex-filter-modal-active');
        document.removeEventListener('keydown', escHandler);
      }
    };
    document.addEventListener('keydown', escHandler);
  }

  // ===== EVENT LISTENERS =====
  
  // Filter button
  if (els.filterBtn) {
    els.filterBtn.addEventListener('click', () => {
      showFilterModal();
    });
  }
  
  // Search
  if (els.search) {
    els.search.addEventListener('input', (e) => {
      searchQuery = e.target.value;
      renderExecutors();
    });
  }

  // Refresh executors
  if (els.refresh) {
    els.refresh.addEventListener('click', () => {
      els.refresh.classList.add('ex-spinning');
      // Clear cache to force fresh fetch
      localStorage.removeItem('weao_executors');
      fetchExecutors().finally(() => {
        setTimeout(() => {
          els.refresh.classList.remove('ex-spinning');
        }, 500);
      });
    });
  }

  // Refresh versions
  if (els.versionsRefresh) {
    els.versionsRefresh.addEventListener('click', () => {
      els.versionsRefresh.classList.add('ex-spinning');
      // Clear cache to force fresh fetch
      localStorage.removeItem('weao_versions');
      fetchRobloxVersions().finally(() => {
        setTimeout(() => {
          els.versionsRefresh.classList.remove('ex-spinning');
        }, 500);
      });
    });
  }

  // Copy version buttons and all click handlers
  document.addEventListener('click', (e) => {
    // Debug: log all clicks
    console.log('Click detected on:', e.target);
    
    const copyBtn = e.target.closest('[data-copy]');
    if (copyBtn) {
      const platform = copyBtn.dataset.copy;
      const versionEl = document.querySelector('[data-version="' + platform + '"]');
      if (versionEl && versionEl.dataset.versionText) {
        copyToClipboard(versionEl.dataset.versionText);
        
        // Visual feedback
        const originalHTML = copyBtn.innerHTML;
        copyBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>';
        copyBtn.style.color = '#22c55e';
        setTimeout(() => {
          copyBtn.innerHTML = originalHTML;
          copyBtn.style.color = '';
        }, 1500);
      }
      return; // Early return to prevent other handlers
    }
    
    // Fetch sUNC data button - PRIORITY CHECK (before detail link check)
    const suncBtn = e.target.closest('[data-sunc-fetch]');
    if (suncBtn) {
      console.log('sUNC button clicked!', suncBtn);
      e.preventDefault();
      e.stopPropagation();
      
      const wrapper = suncBtn.closest('.ex-item-wrapper');
      if (!wrapper) {
        console.error('Wrapper not found!');
        return;
      }
      
      const item = wrapper.querySelector('.ex-item');
      if (!item) {
        console.error('Item not found!');
        return;
      }
      
      const suncScrap = item.dataset.suncScrap;
      const suncKey = item.dataset.suncKey;
      const executorName = item.dataset.executor;
      
      console.log('sUNC data:', { executorName, suncScrap, suncKey });
      
      if (suncScrap && suncKey) {
        console.log('Calling fetchSuncData...');
        fetchSuncData(executorName, suncScrap, suncKey);
      } else {
        console.error('Missing sUNC data!', { suncScrap, suncKey });
        alert('sUNC data not available for this executor');
      }
      return; // Early return
    }
    
    // Check if click is on a link or button inside details (should not toggle)
    const detailLink = e.target.closest('.ex-details-links a, .ex-details-links button');
    if (detailLink) {
      console.log('Detail link/button clicked, not toggling');
      return; // Don't toggle if clicking on links/buttons inside details
    }
    
    // Expand/collapse executor items (Accordion behavior)
    // Check if click is on expand button OR on the card itself
    const expandBtn = e.target.closest('[data-expand]');
    const cardItem = e.target.closest('.ex-item');
    
    if (expandBtn || (cardItem && !e.target.closest('.ex-item-details'))) {
      console.log('Card or expand button clicked');
      const item = cardItem;
      const wrapper = item.closest('.ex-item-wrapper');
      const detailsPanel = wrapper.querySelector('.ex-item-details');
      const expandButton = item.querySelector('[data-expand]');
      const isExpanded = expandButton.getAttribute('aria-expanded') === 'true';
      
      // Close all other expanded items first (accordion behavior)
      if (!isExpanded) {
        document.querySelectorAll('.ex-item.ex-expanded').forEach(otherItem => {
          if (otherItem !== item) {
            const otherWrapper = otherItem.closest('.ex-item-wrapper');
            const otherExpandBtn = otherItem.querySelector('[data-expand]');
            const otherDetailsPanel = otherWrapper.querySelector('.ex-item-details');
            
            otherExpandBtn.setAttribute('aria-expanded', 'false');
            otherDetailsPanel.hidden = true;
            otherItem.classList.remove('ex-expanded');
          }
        });
      }
      
      // Toggle current item
      expandButton.setAttribute('aria-expanded', !isExpanded);
      detailsPanel.hidden = isExpanded;
      
      // Add/remove expanded class for styling
      if (!isExpanded) {
        item.classList.add('ex-expanded');
      } else {
        item.classList.remove('ex-expanded');
      }
      return; // Early return
    }
  }, true); // Use capture phase
  
  // ===== FETCH sUNC DATA =====
  async function fetchSuncData(executorName, suncScrap, suncKey) {
    console.log('fetchSuncData called with:', { executorName, suncScrap, suncKey });
    
    // Create or get modal container
    let modalContainer = document.getElementById('ex-sunc-modal-container');
    if (!modalContainer) {
      modalContainer = document.createElement('div');
      modalContainer.id = 'ex-sunc-modal-container';
      modalContainer.className = 'ex-sunc-modal-overlay';
      document.body.appendChild(modalContainer);
    }
    
    // Show modal with loading
    modalContainer.classList.add('ex-sunc-modal-active');
    modalContainer.innerHTML = '<div class="ex-sunc-modal-wrapper"><div class="ex-sunc-loading"><div class="ex-spinner-small"></div> Loading sUNC data...</div></div>';
    
    try {
      console.log('Fetching sUNC data from API...');
      const res = await fetch(WEAO_API + '/sunc?scrap=' + suncScrap + '&key=' + suncKey, {
        headers: {
          'User-Agent': 'WEAO-3PService'
        }
      });
      
      if (!res.ok) {
        throw new Error('Failed to fetch sUNC data (HTTP ' + res.status + ')');
      }
      
      const data = await res.json();
      console.log('sUNC data received:', data);
      
      // Render sUNC results in modal
      renderSuncDataModal(modalContainer, data, executorName);
      
    } catch (err) {
      console.error('Failed to fetch sUNC data:', err);
      modalContainer.innerHTML = '<div class="ex-sunc-modal-wrapper"><div class="ex-sunc-error">Failed to load sUNC data: ' + err.message + '</div></div>';
    }
  }
  
  // ===== RENDER sUNC DATA IN MODAL =====
  function renderSuncDataModal(container, data, executorName) {
    const passedCount = data.tests?.passed?.length || 0;
    const failedCount = data.tests?.failed?.length || 0;
    const totalCount = passedCount + failedCount;
    const passRate = totalCount > 0 ? Math.round((passedCount / totalCount) * 100) : 0;
    
    // Calculate circle stroke
    const circumference = 2 * Math.PI * 58;
    const strokeDashoffset = circumference - (passRate / 100) * circumference;
    
    let html = '<div class="ex-sunc-modal-wrapper">';
    html += '<div class="ex-sunc-modal">';
    
    // Close button
    html += '<button class="ex-sunc-close" data-sunc-close-modal>';
    html += '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    html += '</button>';
    
    // Header
    html += '<div class="ex-sunc-modal-header">';
    html += '<h3>sUNC Results</h3>';
    html += '<p class="ex-sunc-warning">Important: Failed tests don\'t always mean functions won\'t work. They just indicate that the functions didn\'t pass sUNC\'s specific compatibility checks.</p>';
    html += '</div>';
    
    // Content area
    html += '<div class="ex-sunc-modal-content">';
    
    // Left: Circle + Stats
    html += '<div class="ex-sunc-left">';
    
    // Circular progress
    html += '<div class="ex-sunc-circle-wrapper">';
    html += '<svg class="ex-sunc-circle" viewBox="0 0 120 120">';
    html += '<circle class="ex-sunc-circle-bg" cx="60" cy="60" r="58"/>';
    html += '<circle class="ex-sunc-circle-progress" cx="60" cy="60" r="58" style="stroke-dasharray: ' + circumference + '; stroke-dashoffset: ' + strokeDashoffset + ';"/>';
    html += '</svg>';
    html += '<div class="ex-sunc-circle-text">';
    html += '<div class="ex-sunc-circle-percent">' + passRate + '%</div>';
    html += '<div class="ex-sunc-circle-label">' + passedCount + '/' + totalCount + '</div>';
    html += '</div>';
    html += '</div>';
    
    html += '<div class="ex-sunc-executor-name">' + (data.executor || executorName) + ' <span>v' + data.version + '</span></div>';
    html += '<div class="ex-sunc-version-label">sUNC v' + (data.version || '2.1.5') + '</div>';
    
    // Stats cards
    html += '<div class="ex-sunc-stats-grid">';
    html += '<div class="ex-sunc-stat-card passed">';
    html += '<div class="ex-sunc-stat-number">' + passedCount + '</div>';
    html += '<div class="ex-sunc-stat-label">Passed</div>';
    html += '</div>';
    html += '<div class="ex-sunc-stat-card failed">';
    html += '<div class="ex-sunc-stat-number">' + failedCount + '</div>';
    html += '<div class="ex-sunc-stat-label">Failed</div>';
    html += '</div>';
    html += '</div>';
    
    html += '<div class="ex-sunc-time-card">';
    html += '<div class="ex-sunc-time-value">' + data.timeTaken + 's</div>';
    html += '<div class="ex-sunc-time-label">Time Taken</div>';
    html += '</div>';
    
    html += '</div>'; // end left
    
    // Right: Function list
    html += '<div class="ex-sunc-right">';
    
    // Search bar
    html += '<div class="ex-sunc-search-wrap">';
    html += '<svg class="ex-sunc-search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>';
    html += '<input type="text" class="ex-sunc-search" placeholder="Search functions..." data-sunc-search>';
    html += '<button class="ex-sunc-filter-btn">';
    html += '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>';
    html += '</button>';
    html += '</div>';
    
    // Function list
    html += '<div class="ex-sunc-func-list" data-sunc-list>';
    
    // Passed functions
    if (data.tests?.passed) {
      data.tests.passed.forEach(test => {
        html += '<div class="ex-sunc-func-item passed" data-func-name="' + test.name.toLowerCase() + '" data-func-lib="' + test.library.toLowerCase() + '">';
        html += '<div class="ex-sunc-func-status"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg></div>';
        html += '<div class="ex-sunc-func-name">' + test.name + '</div>';
        html += '<div class="ex-sunc-func-lib">' + test.library + '</div>';
        html += '</div>';
      });
    }
    
    // Failed functions
    if (data.tests?.failed) {
      data.tests.failed.forEach(test => {
        html += '<div class="ex-sunc-func-item failed" data-func-name="' + test.name.toLowerCase() + '" data-func-lib="' + test.library.toLowerCase() + '">';
        html += '<div class="ex-sunc-func-status"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></div>';
        html += '<div class="ex-sunc-func-name">' + test.name + '</div>';
        html += '<div class="ex-sunc-func-lib">' + test.library + '</div>';
        html += '</div>';
      });
    }
    
    html += '</div>'; // end func-list
    
    html += '</div>'; // end right
    
    html += '</div>'; // end content
    
    // Footer
    html += '<div class="ex-sunc-modal-footer">';
    html += '<span>Powered by <strong>llumination</strong></span>';
    html += '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>';
    html += '</div>';
    
    html += '</div>'; // end modal
    html += '</div>'; // end wrapper
    
    container.innerHTML = html;
    
    // Add search functionality
    const searchInput = container.querySelector('[data-sunc-search]');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase();
        const items = container.querySelectorAll('.ex-sunc-func-item');
        items.forEach(item => {
          const name = item.dataset.funcName;
          const lib = item.dataset.funcLib;
          if (name.includes(query) || lib.includes(query)) {
            item.style.display = '';
          } else {
            item.style.display = 'none';
          }
        });
      });
    }
    
    // Add close button handler
    const closeBtn = container.querySelector('[data-sunc-close-modal]');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        container.classList.remove('ex-sunc-modal-active');
      });
    }
    
    // Close on overlay click
    container.addEventListener('click', (e) => {
      if (e.target === container) {
        container.classList.remove('ex-sunc-modal-active');
      }
    });
    
    // Close on ESC key
    const escHandler = (e) => {
      if (e.key === 'Escape') {
        container.classList.remove('ex-sunc-modal-active');
        document.removeEventListener('keydown', escHandler);
      }
    };
    document.addEventListener('keydown', escHandler);
  }

  // Retry
  if (els.retry) {
    els.retry.addEventListener('click', () => {
      fetchExecutors();
    });
  }

  // ===== AUTO REFRESH =====
  function startAutoRefresh() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(() => {
      fetchExecutors();
      fetchRobloxVersions();
    }, REFRESH_INTERVAL);
  }

  function stopAutoRefresh() {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  }

  // ===== INIT =====
  function init() {
    fetchRobloxVersions();
    fetchExecutors();
    startAutoRefresh();
  }

  // ===== TAB LIFECYCLE =====
  window.JinHubTabs = window.JinHubTabs || {};
  window.JinHubTabs.executors = {
    onShow: function() {
      window.scrollTo(0, 0);
      // Refresh data saat tab dibuka jika data sudah stale (>2 menit)
      if (allExecutors.length === 0) {
        fetchRobloxVersions();
        fetchExecutors();
      }
      startAutoRefresh();
    },
    onHide: function() {
      stopAutoRefresh();
    }
  };

  // Auto-init saat tab dibuka pertama kali
  if (document.getElementById('tab-executors')) {
    init();
  }
})();



(function(){
  const discordLink = window.__discordLink || '#';

  // Start now / Bulk -> sementara arahkan ke Discord (belum ada payment gateway).
  // Ganti target-nya di sini kalau nanti udah pasang payment link asli per tier.
  document.querySelectorAll('.pp-btn').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      window.open(discordLink, '_blank');
    });
  });

  const goBack = document.getElementById('ppGoBack');
  if(goBack){ goBack.addEventListener('click', ()=> window.showTab('getkey')); }

  // Terms/Privacy sementara ke Discord juga, ganti ke halaman policy asli kalau sudah ada
  const ppTerms = document.getElementById('ppTerms');
  const ppPrivacy = document.getElementById('ppPrivacy');
  [ppTerms, ppPrivacy].forEach(el=>{
    if(el){ el.addEventListener('click', (e)=>{ e.preventDefault(); window.open(discordLink, '_blank'); }); }
  });

  // Sama kayak fix di tab getkey: reset posisi scroll ke paling atas tiap
  // kali tab premium ditampilin. Tanpa ini, kalau sebelumnya user lagi
  // scroll jauh ke bawah di tab lain (misal Home), posisi scroll itu
  // KEBAWA pas tab premium ditampilin -- overflow:hidden cuma nge-lock,
  // bukan reset posisi scroll -- jadi bagian atas (judul "Pricing Plans")
  // sempet ketutup/keluar layar sesaat sebelum browser render ulang.
  window.JinHubTabs.premium = {
    onShow: function(){
      window.scrollTo(0, 0);
    }
  };
})();



window.JinHubTabs = window.JinHubTabs || {}; // sudah diinit di worker.js, ini cuma jaga-jaga

(function(){
  const tabHome    = document.getElementById('tab-home');
  const tabGK      = document.getElementById('tab-getkey');
  const tabScripts = document.getElementById('tab-scripts');
  const tabExec    = document.getElementById('tab-executors');
  const tabPrem    = document.getElementById('tab-premium');
  // [data-tab] biar logo di topbar (bukan .navitem) juga ikut bisa mindahin tab
  const items      = document.querySelectorAll('[data-tab]');

  // Hamburger menu untuk mobile
  const hamburger = document.querySelector('.hamburger-btn');
  const mobileMenu = document.querySelector('.mobile-menu');
  const mobileBackdrop = document.querySelector('.mobile-menu-backdrop');
  const mobileNavItems = document.querySelectorAll('.mobile-nav-item');
  const topbarInner = document.querySelector('.topbar-inner'); // Navbar element

  function closeMobileMenu(){
    if(hamburger) hamburger.classList.remove('active');
    if(mobileMenu) mobileMenu.classList.remove('active');
    if(mobileBackdrop) mobileBackdrop.classList.remove('active');
    if(topbarInner) topbarInner.classList.remove('menu-open'); // Remove class dari navbar
    document.body.style.overflow = '';
  }

  function openMobileMenu(){
    if(hamburger) hamburger.classList.add('active');
    if(mobileMenu) mobileMenu.classList.add('active');
    if(mobileBackdrop) mobileBackdrop.classList.add('active');
    if(topbarInner) topbarInner.classList.add('menu-open'); // Add class ke navbar
    document.body.style.overflow = 'hidden';
  }

  if(hamburger){
    hamburger.addEventListener('click', ()=>{
      if(mobileMenu && mobileMenu.classList.contains('active')){
        closeMobileMenu();
      } else {
        openMobileMenu();
      }
    });
  }

  if(mobileBackdrop){
    mobileBackdrop.addEventListener('click', closeMobileMenu);
  }

  // Mobile nav items - auto close saat item diklik
  mobileNavItems.forEach(item => {
    item.addEventListener('click', closeMobileMenu);
  });

  // Mapping nama tab -> element & class -inview yang dipakai buat trigger
  // animasi fade-up (CSS-nya ada di masing-masing tab: gk-inview, home-inview, dst)
  const INVIEW_MAP = {
    home:      { el: tabHome,    cls: 'home-inview' },
    scripts:   { el: tabScripts, cls: 'scripts-inview' },
    executors: { el: tabExec,    cls: 'exec-inview' },
    premium:   { el: tabPrem,    cls: 'pp-inview' },
    getkey:    { el: tabGK,      cls: 'gk-inview' }
  };

  function triggerInview(name){
    const target = INVIEW_MAP[name];
    if(!target || !target.el) return;

    // Lepas dulu semua class -inview dari semua tab, biar kalau user
    // balik lagi ke tab yang sama, animasinya ke-replay bukan diem aja
    // (soalnya kalau class-nya masih nempel, browser gak re-trigger animation).
    Object.values(INVIEW_MAP).forEach(t=>{
      if(t.el) t.el.classList.remove(t.cls);
    });

    // Force reflow supaya browser "lupa" state animasi sebelumnya
    // sebelum class ditambahin lagi.
    void target.el.offsetWidth;

    target.el.classList.add(target.cls);
  }

  function showTab(name){
    // Close mobile menu saat pindah tab
    closeMobileMenu();

    tabHome.classList.remove('active');
    tabGK.classList.remove('active');
    tabScripts.classList.remove('active');
    tabExec.classList.remove('active');
    tabPrem.classList.remove('active');

    if(name==='home') tabHome.classList.add('active');
    else if(name==='scripts') tabScripts.classList.add('active');
    else if(name==='executors') tabExec.classList.add('active');
    else if(name==='premium') tabPrem.classList.add('active');
    else tabGK.classList.add('active');

    items.forEach(a=>{
      if(!a.classList.contains('navitem') && !a.classList.contains('mobile-nav-item')) return;
      if(a.dataset.tab===name) a.classList.add('active');
      else a.classList.remove('active');
    });

    // Update page title based on active tab
    const titles = {
      'home': 'JinHub - Documentation',
      'getkey': 'JinHub - Get Key',
      'scripts': 'JinHub - Support Script',
      'executors': 'JinHub - Executor Status',
      'premium': 'JinHub - Unlock Premium'
    };
    document.title = titles[name] || 'JinHub';

    try {
      const path =
        name==='home'      ? '/home' :
        name==='scripts'   ? '/scripts' :
        name==='executors' ? '/executors' :
        name==='premium'   ? '/premium' : '/getkey';
      history.replaceState(null, '', path);
    } catch(e){}

    // SIMPAN tab aktif ke localStorage untuk restore saat refresh
    try {
      localStorage.setItem('jinhub_last_tab', name);
    } catch(e){}

    // Trigger animasi fade-up buat tab yang baru aktif
    triggerInview(name);

    // Kasih kesempatan tab yang baru aktif jalanin init/animasi sendiri
    if(window.JinHubTabs[name] && typeof window.JinHubTabs[name].onShow === 'function'){
      window.JinHubTabs[name].onShow();
    }

    // Scroll ke atas saat pindah tab (reset posisi scroll)
    window.scrollTo(0, 0);
  }
  window.showTab = showTab; // dipakai tombol di tab lain (getkey -> premium, dst)

  items.forEach(a=>{
    a.addEventListener('click', (e)=>{
      const t = a.dataset.tab;
      if(t){ e.preventDefault(); showTab(t); }
    });
  });

  // Modal fitur (dipakai tab Scripts, tapi elemen modal-nya global)
  const modal     = document.getElementById('featModal');
  const featClose = document.getElementById('featClose');
  if(featClose){
    featClose.addEventListener('click', ()=>modal.setAttribute('aria-hidden','true'));
    modal.addEventListener('click', e=>{ if(e.target===modal) modal.setAttribute('aria-hidden','true'); });
  }
  window.openFeatureModal = function(title, features){
    document.querySelector('.modal-title').textContent = title + ' – Features';
    const col1 = document.getElementById('featCol1');
    const col2 = document.getElementById('featCol2');
    const feats = Array.isArray(features) ? features : [];
    const half  = Math.ceil(feats.length/2);
    col1.innerHTML = feats.slice(0,half).map(x=>'<li>'+x+'</li>').join('') || '<li>No details provided.</li>';
    col2.innerHTML = feats.slice(half).map(x=>'<li>'+x+'</li>').join('');
    modal.setAttribute('aria-hidden','false');
  };

  // FAQ single-open (dipakai tab Home)
  const details = document.querySelectorAll('.faq-item');
  details.forEach(d=>{
    d.addEventListener('toggle', ()=>{
      if(d.open){ details.forEach(o=>{ if(o!==d) o.removeAttribute('open'); }); }
    });
  });

  // Tab awal saat page pertama load
  let initialTab = 'getkey'; // default fallback
  let useLocalStorage = true; // Flag untuk tentukan apakah boleh pakai localStorage
  
  // STEP 1: Check URL path FIRST (highest priority)
  const currentPath = window.location.pathname;
  console.log('[JinHub] Current URL path:', currentPath);
  
  if(currentPath.includes('/home')){
    initialTab = 'home';
    useLocalStorage = false; // URL path explicitly set, don't use localStorage
  } else if(currentPath.includes('/scripts')){
    initialTab = 'scripts';
    useLocalStorage = false;
  } else if(currentPath.includes('/executors')){
    initialTab = 'executors';
    useLocalStorage = false;
  } else if(currentPath.includes('/premium')){
    initialTab = 'premium';
    useLocalStorage = false;
  } else if(currentPath.includes('/getkey')){
    initialTab = 'getkey';
    useLocalStorage = false;
  } else if(currentPath === '/' || currentPath === ''){
    // Root URL - allow localStorage restore
    useLocalStorage = true;
  }
  
  // STEP 2: Check server-injected __initialTab (dari ?tab= query atau #hash)
  if(window.__initialTab && ['home','getkey','scripts','executors','premium'].includes(window.__initialTab)){
    initialTab = window.__initialTab;
    useLocalStorage = false;
    console.log('[JinHub] Using server-injected __initialTab:', window.__initialTab);
  }
  
  // STEP 3: Restore dari localStorage HANYA jika URL tidak explicitly set tab
  if(useLocalStorage){
    try {
      const savedTab = localStorage.getItem('jinhub_last_tab');
      console.log('[JinHub] Saved tab from localStorage:', savedTab);
      if(savedTab && ['home','getkey','scripts','executors','premium'].includes(savedTab)){
        initialTab = savedTab;
        console.log('[JinHub] Using saved tab from localStorage');
      }
    } catch(e){
      console.error('[JinHub] Error reading localStorage:', e);
    }
  } else {
    console.log('[JinHub] URL explicitly set tab, ignoring localStorage');
  }
  
  console.log('[JinHub] Final initialTab:', initialTab);
  showTab(initialTab);
  
  // Scroll ke atas setelah tab di-load
  setTimeout(()=>{
    window.scrollTo(0, 0);
  }, 50);
})();
