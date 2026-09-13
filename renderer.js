window.addEventListener('DOMContentLoaded', () => {
  const audio = document.getElementById('audio');
  const songList = document.getElementById('song-list');
  const emptyState = document.getElementById('empty-state');
  const search = document.getElementById('search');
  const contentTitle = document.getElementById('content-title');

  let songs = [];
  let currentIndex = -1;
  let isPlaying = false;
  let shuffle = false;
  let repeat = false;
  let currentView = 'library';
  let lastPlayedPath = null;
  let playStats = {};
  let mixLabel = null;
  let audioCtx = null;
  let analyzing = false;

  // ---------------- IndexedDB persistence ----------------
  const DB_NAME = 'sonora-db';
  const DB_VERSION = 1;
  const dbStore = 'library';
  const statsStore = 'stats';

  function openDb() {
    return new Promise((resolve) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(dbStore)) db.createObjectStore(dbStore, { keyPath: 'path' });
        if (!db.objectStoreNames.contains(statsStore)) db.createObjectStore(statsStore);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });
  }

  function dbGetAll(db, store) {
    return new Promise((resolve) => {
      if (!db) return resolve([]);
      const tx = db.transaction(store, 'readonly');
      const req = tx.objectStore(store).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });
  }

  function dbPutAll(db, store, items) {
    return new Promise((resolve) => {
      if (!db) return resolve();
      const tx = db.transaction(store, 'readwrite');
      const os = tx.objectStore(store);
      items.forEach(item => os.put(item));
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  }

  function dbClear(db, store) {
    return new Promise((resolve) => {
      if (!db) return resolve();
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).clear();
      tx.oncomplete = () => resolve();
    });
  }

  let db = null;
  openDb().then(d => { db = d; restoreLibrary(d); });

  async function restoreLibrary(d) {
    const [saved, stats] = await Promise.all([dbGetAll(d, dbStore), dbGetAll(d, statsStore)]);
    if (saved && saved.length) {
      songs = saved;
      playStats = stats && stats.length ? stats[0] : {};
      lastPlayedPath = null;
      showLibrary();
      scheduleAnalysis();
    }
  }

  async function persistLibrary() {
    if (!db) return;
    const clone = songs.map(s => {
      const { cover, ...rest } = s;
      return rest;
    });
    await dbClear(db, dbStore);
    await dbPutAll(db, dbStore, clone);
    await dbPutAll(db, statsStore, [playStats]);
  }

  // ---------------- Window controls ----------------
  document.getElementById('btn-min').addEventListener('click', () => window.api.minimize());
  document.getElementById('btn-max').addEventListener('click', () => window.api.maximize());
  document.getElementById('btn-close').addEventListener('click', () => window.api.close());
  document.getElementById('btn-import').addEventListener('click', importMusic);
  document.getElementById('btn-empty-import').addEventListener('click', importMusic);
  document.getElementById('btn-shuffle').addEventListener('click', () => {
    shuffle = !shuffle;
    document.getElementById('btn-shuffle').classList.toggle('active', shuffle);
  });
  document.getElementById('btn-repeat').addEventListener('click', () => {
    repeat = !repeat;
    document.getElementById('btn-repeat').classList.toggle('active', repeat);
  });
  document.getElementById('btn-radio').addEventListener('click', () => {
    if (currentIndex >= 0) startRadio(songs[currentIndex], true);
  });

  // ---------------- Sidebar navigation ----------------
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => {
      document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
      item.classList.add('active');
      currentView = item.dataset.view;
      renderCurrentView();
    });
  });

  // ---------------- Library import ----------------
  async function importMusic() {
    const result = await window.api.selectFolder();
    if (!result || !result.songs || result.songs.length === 0) {
      window.api.notify('No music found in that folder', 'info');
      return;
    }
    songs = result.songs;
    mixLabel = null;
    showLibrary();
    persistLibrary();
    scheduleAnalysis();
    window.api.notify('Added ' + songs.length + ' songs', 'success');
  }

  function showLibrary() {
    emptyState.style.display = 'none';
    songList.style.display = 'flex';
    renderCurrentView();
  }

  // ---------------- AI analysis pipeline ----------------
  function scheduleAnalysis() {
    if (analyzing) return;
    analyzing = true;
    analyzeNext(0, gs('AI analyzing', 0));
  }

  function analyzedSongs() {
    return songs.filter(s => s.features);
  }

  async function analyzeNext(idx, statusEl) {
    const pending = songs.filter(s => !s.features);
    if (idx >= pending.length || pending.length === 0) {
      analyzing = false;
      if (statusEl) statusEl.remove();
      persistLibrary();
      window.api.notify('AI analysis complete — ' + analyzedSongs().length + ' songs', 'success');
      return;
    }
    if (!audioCtx) {
      try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
      catch (e) { analyzing = false; return; }
    }
    if (statusEl) statusEl.textContent = 'AI analyzing (' + idx + '/' + pending.length + ')';

    const song = pending[idx];
    try {
      const data = await window.api.readAudioFile(song.path);
      if (data && audioCtx.decodeAudioData) {
        const buf = await audioCtx.decodeAudioData(data);
        song.features = SonoraAI.analyzeBuffer(buf);
        song.aiTags = SonoraAI.classify(song.features);
      }
    } catch (e) {
      // fallback: metadata-only features
      song.features = {
        duration: song.duration || 0,
        energy: 0.5, tempo: 120, tempoScore: 0.6, brightness: 0.5, flux: 0.5, dynamic: 0.5
      };
      song.aiTags = [];
    }
    renderListSafe();
    await analyzeNext(idx + 1, statusEl);
  }

  function renderListSafe() {
    if (currentView === 'library' && songList.style.display !== 'none') renderList(filteredSongs());
  }

  // ---------------- Views ----------------
  function renderCurrentView() {
    if (!songs.length) return;
    if (currentView === 'albums') { renderAlbums(filteredSongs()); return; }
    if (currentView === 'artists') { renderArtists(filteredSongs()); return; }
    if (currentView === 'mixes') { renderMixes(); return; }
    contentTitle.textContent = mixLabel || 'All Music';
    renderList(filteredSongs());
  }

  function filteredSongs() {
    const q = search.value.toLowerCase();
    if (!q) return songs.slice();
    return songs.filter(s =>
      (s.name || '').toLowerCase().includes(q) ||
      (s.title || '').toLowerCase().includes(q) ||
      (s.artist || '').toLowerCase().includes(q) ||
      (s.album || '').toLowerCase().includes(q) ||
      (s.genre || '').toLowerCase().includes(q) ||
      ((s.aiTags || []).join(' ')).toLowerCase().includes(q)
    );
  }

  function escapeHtml(str) {
    const el = document.createElement('div');
    el.textContent = String(str);
    return el.innerHTML;
  }

  // ---------------- AI Mixes view ----------------
  const MIXES = [
    { id: 'chill', label: 'Chill', icon: '🌙', desc: 'Low energy, relaxed tempo', tags: ['Chill'], mood: null },
    { id: 'upbeat', label: 'Upbeat', icon: '⚡', desc: 'High energy, fast tempo', tags: ['Upbeat'], mood: null },
    { id: 'energetic', label: 'Energetic', icon: '🔥', desc: 'Loud, bright, powerful', tags: ['Energetic'], mood: null },
    { id: 'focus', label: 'Focus', icon: '🎯', desc: 'Steady, low-variance', tags: ['Focus'], mood: null },
    { id: 'mellow', label: 'Mellow', icon: '🌒', desc: 'Soft and slow', tags: ['Mellow'], mood: null },
    { id: 'fast', label: 'Fast', icon: '🚀', desc: 'High tempo tracks', tags: ['Fast'], mood: null }
  ];

  function renderMixes() {
    contentTitle.textContent = 'AI Mixes';
    songList.innerHTML = '';

    const promptCard = document.createElement('div');
    promptCard.className = 'ai-prompt-card';
    promptCard.innerHTML =
      '<div class="ai-prompt-label">🧠 Describe a playlist in your own words</div>' +
      '<div class="ai-prompt-row">' +
      '<input type="text" id="ai-prompt" class="search" placeholder="e.g. upbeat rock for the gym, or chill mellow songs for late night">' +
      '<button class="btn-primary" id="ai-generate">Generate</button>' +
      '</div>' +
      '<div class="ai-prompt-hint">Try: "focus study instrumental", "90s pop", "sad mellow", "songs by <artist>"</div>';
    songList.appendChild(promptCard);

    const grid = document.createElement('div');
    grid.className = 'mix-grid';
    MIXES.forEach(mix => {
      const card = document.createElement('div');
      card.className = 'mix-card';
      card.innerHTML =
        '<div class="mix-icon">' + mix.icon + '</div>' +
        '<div class="mix-name">' + mix.label + '</div>' +
        '<div class="mix-desc">' + mix.desc + '</div>' +
        '<div class="mix-count" id="mix-count-' + mix.id + '">—</div>';
      card.addEventListener('click', () => {
        const list = songs.filter(s => (s.aiTags || []).includes(mix.tags[0]));
        activateSet(list, mix.label + ' Mix');
      });
      grid.appendChild(card);
    });
    songList.appendChild(grid);

    const youCard = document.createElement('div');
    youCard.className = 'mix-grid';
    const personal = [
      { id: 'most', label: 'Most Played', icon: '🏆', desc: 'Your favorites' },
      { id: 'fresh', label: 'Fresh Finds', icon: '🌟', desc: 'Never played tracks' },
      { id: 'forYou', label: 'For You', icon: '💡', desc: 'AI picks from your stats' }
    ];
    personal.forEach(mix => {
      const card = document.createElement('div');
      card.className = 'mix-card personal';
      card.innerHTML =
        '<div class="mix-icon">' + mix.icon + '</div>' +
        '<div class="mix-name">' + mix.label + '</div>' +
        '<div class="mix-desc">' + mix.desc + '</div>';
      card.addEventListener('click', () => {
        if (mix.id === 'most') activateSet(mostPlayed(), 'Most Played');
        if (mix.id === 'fresh') activateSet(songs.filter(s => !(playStats[s.path] || 0)), 'Fresh Finds');
        if (mix.id === 'forYou') forYou();
      });
      youCard.appendChild(card);
    });
    songList.appendChild(youCard);

    const gen = document.getElementById('ai-generate');
    if (gen) gen.addEventListener('click', runAiPrompt);
    const prompt = document.getElementById('ai-prompt');
    if (prompt) prompt.addEventListener('keydown', e => { if (e.key === 'Enter') runAiPrompt(); });

    document.getElementById('mix-count-chill').textContent = songs.filter(s => (s.aiTags || []).includes('Chill')).length + ' tracks';
    document.getElementById('mix-count-upbeat').textContent = songs.filter(s => (s.aiTags || []).includes('Upbeat')).length + ' tracks';
    document.getElementById('mix-count-energetic').textContent = songs.filter(s => (s.aiTags || []).includes('Energetic')).length + ' tracks';
    document.getElementById('mix-count-focus').textContent = songs.filter(s => (s.aiTags || []).includes('Focus')).length + ' tracks';
    document.getElementById('mix-count-mellow').textContent = songs.filter(s => (s.aiTags || []).includes('Mellow')).length + ' tracks';
    document.getElementById('mix-count-fast').textContent = songs.filter(s => (s.aiTags || []).includes('Fast')).length + ' tracks';
  }

  function runAiPrompt() {
    const prompt = document.getElementById('ai-prompt');
    const text = prompt.value.trim();
    if (!text) return;
    const query = SonoraAI.parseQuery(text);
    const scored = songs.map(s => ({ song: s, score: SonoraAI.scoreQuery(s, query, s.features) }))
      .filter(r => r.score > 0.25)
      .sort((a, b) => b.score - a.score)
      .slice(0, 100);

    contentTitle.textContent = 'AI results: "' + text + '"';
    songList.innerHTML = '';
    if (!scored.length) {
      const empty = document.createElement('div');
      empty.className = 'list-empty';
      empty.textContent = 'Nothing matched. Try a mood like "chill" or "upbeat".';
      songList.appendChild(empty);
      return;
    }

    const shared = {};
    scored.forEach((r, i) => { shared[r.song.path] = r.score; });
    const list = scored.map(r => r.song);
    activeShared = shared;
    activateSet(list, 'AI results', false);
    const header = document.createElement('div');
    header.className = 'ai-result-bar';
    header.textContent = 'Matched ' + list.length + ' tracks. Green bar = best match.';
    songList.prepend(header);
  }

  let activeShared = null;

  function activateSet(list, label, go) {
    if (!list.length) {
      window.api.notify('No songs matched that mix', 'info');
      return;
    }
    songs = list.slice();
    mixLabel = label;
    currentView = 'library';
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    document.querySelector('.nav-item[data-view="library"]').classList.add('active');
    renderList(songs);
    renderCurrentView();
    if (go) {
      currentIndex = 0;
      playSong(0);
    }
  }

  function mostPlayed() {
    const withPlays = songs.map(s => ({ song: s, n: playStats[s.path] || 0 }))
      .filter(x => x.n > 0)
      .sort((a, b) => b.n - a.n)
      .map(x => x.song);
    return withPlays.length ? withPlays : songs.slice();
  }

  function forYou() {
    const ranked = SonoraAI.recommendAffinity(songs, playStats);
    const picks = ranked.slice(0, 50).map(r => r.song);
    if (!picks.length) { window.api.notify('Import some music first', 'info'); return; }
    activeShared = {};
    ranked.forEach((r, i) => { activeShared[r.song.path] = i < 10 ? 0.9 : 0.6; });
    songs = picks;
    mixLabel = 'For You';
    currentView = 'library';
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    document.querySelector('.nav-item[data-view="library"]').classList.add('active');
    renderList(songs);
    contentTitle.textContent = 'For You';
  }

  // ---------------- Radio ----------------
  function startRadio(song, playNow) {
    const analyzed = songs.filter(s => s.features);
    const targetVec = song.features ? SonoraAI.featureVector(song.features, song) : null;
    const sims = [];
    analyzed.forEach(s => {
      if (s.path === song.path) return;
      let score = 0.5;
      if (targetVec && s.features) {
        score = SonoraAI.cosineSimilarity(targetVec, SonoraAI.featureVector(s.features, s));
      }
      if ((s.artist || '').toLowerCase() === (song.artist || '').toLowerCase()) score += 0.15;
      if (song.genre && s.genre && s.genre.toLowerCase() === song.genre.toLowerCase()) score += 0.1;
      sims.push({ song: s, score });
    });
    sims.sort((a, b) => b.score - a.score);
    const picks = [{ song }, ...sims.slice(0, 40).map(s => s.song)];
    activeShared = {};
    sims.slice(0, 40).forEach((r, i) => { activeShared[r.song.path] = Math.max(0.4, 0.9 - i * 0.012); });

    songs = picks;
    mixLabel = 'Radio · ' + (song.artist || song.title || song.name);
    currentView = 'library';
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    document.querySelector('.nav-item[data-view="library"]').classList.add('active');
    renderList(songs);
    contentTitle.textContent = mixLabel;
    if (playNow) {
      currentIndex = 0;
      playSong(0);
    }
    window.api.notify('Radio started from ' + (song.title || song.name), 'info');
  }

  // ---------------- Album / Artist views ----------------
  function renderAlbums(list) {
    contentTitle.textContent = 'Albums';
    const albums = {};
    list.forEach(song => {
      const key = (song.album || song.folder || 'Unknown');
      if (!albums[key]) {
        albums[key] = { name: key, artist: song.artist || 'Unknown Artist', songs: [], cover: song.cover || null };
      }
      if (!albums[key].cover && song.cover) albums[key].cover = song.cover;
      albums[key].songs.push(song);
    });
    const grid = document.createElement('div');
    grid.className = 'album-grid';
    Object.values(albums).forEach(album => {
      const tile = document.createElement('div');
      tile.className = 'album-tile';
      tile.innerHTML =
        '<div class="album-cover">' + (album.cover ? '<img src="' + album.cover + '">' : escapeHtml(album.name.charAt(0))) + '</div>' +
        '<div class="album-name">' + escapeHtml(album.name) + '</div>' +
        '<div class="album-artist">' + escapeHtml(album.artist) + '</div>' +
        '<div class="album-count">' + album.songs.length + ' songs</div>';
      tile.addEventListener('click', () => {
        activateSet(album.songs.slice(), album.name);
        contentTitle.textContent = album.name;
      });
      grid.appendChild(tile);
    });
    songList.innerHTML = '';
    songList.appendChild(grid);
  }

  function renderArtists(list) {
    contentTitle.textContent = 'Artists';
    const artists = {};
    list.forEach(song => {
      const key = song.artist || 'Unknown Artist';
      if (!artists[key]) artists[key] = { name: key, songs: [] };
      artists[key].songs.push(song);
    });
    const grid = document.createElement('div');
    grid.className = 'artist-list';
    Object.values(artists).forEach(artist => {
      const row = document.createElement('div');
      row.className = 'artist-row';
      row.innerHTML = '<div class="artist-avatar">' + escapeHtml(artist.name.charAt(0)) + '</div>' +
        '<div class="artist-info"><div class="artist-name">' + escapeHtml(artist.name) + '</div>' +
        '<div class="artist-count">' + artist.songs.length + ' songs</div></div>';
      row.addEventListener('click', () => {
        activateSet(artist.songs.slice(), artist.name);
        contentTitle.textContent = artist.name;
      });
      grid.appendChild(row);
    });
    songList.innerHTML = '';
    songList.appendChild(grid);
  }

  // ---------------- Song list ----------------
  function renderList(list) {
    songList.innerHTML = '';
    if (!list.length) {
      const empty = document.createElement('div');
      empty.className = 'list-empty';
      empty.textContent = 'No songs found';
      songList.appendChild(empty);
      return;
    }
    list.forEach((song, i) => {
      const item = document.createElement('div');
      item.className = 'song-item';
      const originalIndex = songs.indexOf(song);
      if (originalIndex === currentIndex) item.classList.add('playing');

      const idx = document.createElement('span');
      idx.className = 'song-idx';
      idx.textContent = i + 1;

      const name = document.createElement('span');
      name.className = 'song-name';
      name.textContent = song.title || song.name;
      const tags = song.aiTags && song.aiTags.length ? '  ' + song.aiTags.map(t => '[' + t + ']').join(' ') : '';
      const tagEl = document.createElement('span');
      tagEl.className = 'song-tags';
      tagEl.textContent = tags;
      name.appendChild(tagEl);

      const folder = document.createElement('span');
      folder.className = 'song-folder';
      folder.textContent = (song.artist || 'Unknown Artist') + ' — ' + (song.album || song.folder);

      const length = document.createElement('span');
      length.className = 'song-length';
      length.textContent = formatTime(song.duration) || formatBytes(song.size);
      length.title = formatMetadata(song);

      const radio = document.createElement('button');
      radio.className = 'song-radio';
      radio.textContent = '🎧';
      radio.title = 'Play similar (AI Radio)';
      radio.addEventListener('click', (e) => {
        e.stopPropagation();
        startRadio(song, true);
      });

      item.appendChild(idx);
      item.appendChild(name);
      item.appendChild(folder);
      item.appendChild(length);
      item.appendChild(radio);

      if (activeShared && activeShared[song.path]) {
        const bar = document.createElement('div');
        bar.className = 'match-bar';
        bar.style.width = Math.round(activeShared[song.path] * 100) + '%';
        item.appendChild(bar);
      }

      item.addEventListener('click', () => playSong(originalIndex));
      item.addEventListener('dblclick', () => window.api.revealFile(song.path));
      songList.appendChild(item);
    });
  }

  function formatMetadata(song) {
    const lines = [];
    if (song.title) lines.push(song.title);
    if (song.artist) lines.push(song.artist);
    if (song.album) lines.push(song.album);
    if (song.year) lines.push('Year: ' + song.year);
    if (song.codec) lines.push('Format: ' + song.codec);
    if (song.bitrate) lines.push('Bitrate: ' + Math.round(song.bitrate / 1000) + ' kbps');
    if (song.features) {
      lines.push('Energy: ' + (song.features.energy * 100).toFixed(0) + '%');
      lines.push('Tempo: ' + Math.round(song.features.tempo) + ' BPM');
      lines.push('Mood: ' + ((song.aiTags || []).join(', ') || '—'));
    }
    if (song.size) lines.push('Size: ' + formatBytes(song.size));
    return lines.join('\n');
  }

  function formatBytes(bytes) {
    if (!bytes) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(0) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  }

  function formatTime(seconds) {
    if (!seconds || !isFinite(seconds)) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  // ---------------- Playback ----------------
  function playSong(index) {
    if (index < 0 || index >= songs.length) return;
    currentIndex = index;
    const song = songs[index];
    audio.src = 'file:///' + song.path.replace(/\\/g, '/');
    audio.play();
    isPlaying = true;
    lastPlayedPath = song.path;
    updatePlayButton();
    syncNowPlayingText(song, true);
    renderList(filteredSongs());
    persistLibrary();
  }

  function syncNowPlayingText(song, withArt) {
    document.getElementById('np-title').textContent = song.title || song.name;
    const badge = document.getElementById('np-badge');
    if (mixLabel) { badge.textContent = mixLabel; badge.style.display = 'inline-block'; }
    else { badge.style.display = 'none'; }
    document.getElementById('np-subtitle').textContent = (song.artist || 'Unknown Artist') + ' — ' + (song.album || song.folder || '') +
      (song.aiTags && song.aiTags.length ? '   ·   ' + song.aiTags.join(' · ') : '');
    const art = document.getElementById('np-art');
    if (withArt && song.cover) {
      art.innerHTML = '<img src="' + song.cover + '">';
    } else if (withArt) {
      art.textContent = (song.album || song.title || '♪').charAt(0);
      art.style.fontSize = '26px';
    }
    art.title = formatMetadata(song);
  }

  function togglePlay() {
    if (currentIndex < 0 && songs.length) {
      playSong(0);
      return;
    }
    if (currentIndex < 0) return;
    if (audio.paused) {
      audio.play();
      isPlaying = true;
    } else {
      audio.pause();
      isPlaying = false;
    }
    updatePlayButton();
  }

  function updatePlayButton() {
    document.getElementById('btn-play').textContent = isPlaying ? '⏸' : '▶';
  }

  function nextSong() {
    const list = filteredSongs();
    if (!list.length) return;
    const cur = Math.max(0, list.indexOf(songs[currentIndex]));
    if (shuffle) {
      let pick;
      do { pick = Math.floor(Math.random() * list.length); } while (list.length > 1 && pick === cur);
      playSong(songs.indexOf(list[pick]));
    } else if (cur + 1 < list.length) {
      playSong(songs.indexOf(list[cur + 1]));
    } else {
      pauseAtEnd();
    }
  }

  function pauseAtEnd() {
    audio.pause();
    isPlaying = false;
    updatePlayButton();
  }

  function prevSong() {
    if (audio.currentTime > 3) {
      audio.currentTime = 0;
      return;
    }
    const list = filteredSongs();
    if (!list.length) return;
    const cur = Math.max(0, list.indexOf(songs[currentIndex]));
    playSong(songs.indexOf(list[(cur - 1 + list.length) % list.length]));
  }

  let lastCountKey = null;
  audio.addEventListener('play', () => {
    if (currentIndex >= 0) {
      const song = songs[currentIndex];
      const key = song.path + Math.floor(Date.now() / 60000);
      if (key !== lastCountKey) {
        lastCountKey = key;
        playStats[song.path] = (playStats[song.path] || 0) + 1;
        persistLibrary();
      }
    }
    isPlaying = true;
    updatePlayButton();
  });

  audio.addEventListener('pause', () => { isPlaying = false; updatePlayButton(); });
  audio.addEventListener('error', () => {
    window.api.notify('Could not play this file', 'error');
  });

  document.getElementById('btn-play').addEventListener('click', togglePlay);
  document.getElementById('btn-next').addEventListener('click', nextSong);
  document.getElementById('btn-prev').addEventListener('click', prevSong);

  audio.addEventListener('timeupdate', () => {
    document.getElementById('time-current').textContent = formatTime(audio.currentTime);
    document.getElementById('time-total').textContent = formatTime(audio.duration);
    const pct = audio.duration ? (audio.currentTime / audio.duration) * 100 : 0;
    document.getElementById('progress-fill').style.width = pct + '%';
  });

  audio.addEventListener('ended', () => {
    if (repeat) {
      audio.currentTime = 0;
      audio.play();
    } else {
      nextSong();
    }
  });

  const volumeSlider = document.getElementById('volume');
  try { audio.volume = parseFloat(localStorage.getItem('sonora-volume') || '0.8'); volumeSlider.value = audio.volume * 100; } catch (e) { /* ignore */ }
  volumeSlider.addEventListener('input', (e) => {
    audio.volume = e.target.value / 100;
    try { localStorage.setItem('sonora-volume', String(audio.volume)); } catch (err) { /* ignore */ }
  });

  document.getElementById('progress-bar').addEventListener('click', (e) => {
    if (!audio.duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    audio.currentTime = pct * audio.duration;
  });

  search.addEventListener('input', () => {
    if (currentView === 'library') renderList(filteredSongs());
    else renderCurrentView();
  });

  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && e.target.tagName !== 'INPUT') {
      e.preventDefault();
      togglePlay();
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') {
      e.preventDefault();
      importMusic();
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      search.focus();
    }
  });

  // ---------------- Helpers & toast ----------------
  function gs(text, n) {
    const el = document.createElement('div');
    el.className = 'ai-status';
    el.textContent = text;
    document.getElementById('content').appendChild(el);
    return el;
  }

  function showToast(message, type) {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = 'toast ' + (type || 'info');
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
      toast.classList.add('toast-hide');
      setTimeout(() => toast.remove(), 300);
    }, 2600);
  }
});