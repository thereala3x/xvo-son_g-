const manifestPath = 'manifest.json';
const LIKES_KEY = 'xvo_likes';

async function loadManifest() {
  try {
    const res = await fetch(manifestPath);
    if (!res.ok) throw new Error('manifest missing');
    return res.json();
  } catch (e) {
    console.error('Failed loading manifest:', e);
    return { artists: [] };
  }
}

function qs(id) { return document.getElementById(id); }

function escapeHtml(s) {
  return (s + '').replace(/[&<>'"]/g, c =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;' })[c] || c);
}

function formatTime(secs) {
  if (!isFinite(secs) || secs < 0) return '0:00';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function encodeSrc(path) {
  if (/^https?:\/\//i.test(path)) return path;
  return path.split('/').map(encodeURIComponent).join('/');
}

/* ── Likes persistence ── */
function loadLikes() {
  try { return new Set(JSON.parse(localStorage.getItem(LIKES_KEY) || '[]')); }
  catch { return new Set(); }
}
function saveLikes(set) {
  localStorage.setItem(LIKES_KEY, JSON.stringify([...set]));
}

/* ── Dominant color extraction ── */
function extractColor(imgEl) {
  try {
    const size = 48;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    ctx.drawImage(imgEl, 0, 0, size, size);
    const d = ctx.getImageData(0, 0, size, size).data;
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 100) continue;
      const sat = Math.max(d[i], d[i+1], d[i+2]) - Math.min(d[i], d[i+1], d[i+2]);
      if (sat < 20) continue;
      r += d[i]; g += d[i+1]; b += d[i+2]; n++;
    }
    if (n < 10) { n = size * size; r = g = b = 0; for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i+1]; b += d[i+2]; } }
    return [Math.round(r/n), Math.round(g/n), Math.round(b/n)];
  } catch { return [50, 50, 50]; }
}

function applyAlbumColor(rgb) {
  const [r, g, b] = rgb;
  document.documentElement.style.setProperty('--album-r', r);
  document.documentElement.style.setProperty('--album-g', g);
  document.documentElement.style.setProperty('--album-b', b);
}

class Player {
  constructor() {
    this.audio         = qs('audio');
    this.playBtn       = qs('playBtn');
    this.playIcon      = qs('playIcon');
    this.pauseIcon     = qs('pauseIcon');
    this.prevBtn       = qs('prevBtn');
    this.nextBtn       = qs('nextBtn');
    this.shuffleBtn    = qs('shuffleBtn');
    this.repeatBtn     = qs('repeatBtn');
    this.repeatIcon    = qs('repeatIcon');
    this.repeatOneIcon = qs('repeatOneIcon');
    this.miniTitle     = qs('miniTitle');
    this.miniArtist    = qs('miniArtist');
    this.miniCover     = qs('miniCover');
    this.miniLike      = qs('miniLike');
    this.coverImg      = qs('coverImg');
    this.artistName    = qs('artistName');
    this.albumName     = qs('albumName');
    this.playlistEl    = qs('playlist');
    this.progressBar   = qs('currentProgress');
    this.progressBuf   = qs('progressBuffered');
    this.progressThumb = qs('progressThumb');
    this.progressCont  = qs('progressContainer');
    this.currentTimeEl = qs('currentTime');
    this.totalTimeEl   = qs('totalTime');
    this.volumeSlider  = qs('volumeSlider');
    this.muteBtn       = qs('muteBtn');
    this.volIcon       = qs('volIcon');
    this.muteIcon      = qs('muteIcon');
    this.heroPlayBtn   = qs('heroPlayBtn');
    this.miniPlayer    = qs('miniplayer');
    this.queueBtn      = qs('queueBtn');
    this.downloadBtn   = qs('downloadBtn');
    this.queuePanel    = qs('queuePanel');
    this.queueOverlay  = qs('queueOverlay');
    this.queueList     = qs('queueList');
    this.likedItem     = qs('likedItem');
    this.likedCount    = qs('likedCount');
    this.heroBg        = qs('heroBg');
    this.vizCanvas     = qs('vizCanvas');

    this.queue      = [];
    this.index      = -1;
    this.shuffle    = false;
    this.repeatMode = 'none';   // 'none' | 'one' | 'all'
    this.shuffleOrder = [];
    this.likes      = loadLikes();
    this.isMuted    = false;
    this.lastVol    = 0.8;
    this.isDragging = false;
    this._vizInit   = false;
    this._vizPlaying = false;
    this._likedView = false;
    this._allTracks = [];

    this.audio.volume = 0.8;
    this._bind();
    this._updateLikedCount();
    this._updateSliderFill();
  }

  _bind() {
    this.playBtn.addEventListener('click', () => this.toggle());
    this.prevBtn.addEventListener('click', () => this.prev());
    this.nextBtn.addEventListener('click', () => this.next());
    this.shuffleBtn.addEventListener('click', () => this._toggleShuffle());
    this.repeatBtn.addEventListener('click', () => this._cycleRepeat());
    this.heroPlayBtn.addEventListener('click', () => this._heroPlay());
    this.miniLike.addEventListener('click', () => this._toggleCurrentLike());
    this.queueBtn.addEventListener('click', () => this._toggleQueue());
    this.downloadBtn.addEventListener('click', () => this._downloadCurrent());
    this.queueOverlay.addEventListener('click', () => this._closeQueue());
    qs('closeQueue').addEventListener('click', () => this._closeQueue());
    this.likedItem.addEventListener('click', () => this._showLikedView());

    this.audio.addEventListener('ended',          () => this._onEnded());
    this.audio.addEventListener('play',           () => this._updatePlayUI(true));
    this.audio.addEventListener('pause',          () => this._updatePlayUI(false));
    this.audio.addEventListener('timeupdate',     () => this._onTimeUpdate());
    this.audio.addEventListener('progress',       () => this._onBufferUpdate());
    this.audio.addEventListener('durationchange', () => {
      this.totalTimeEl.textContent = formatTime(this.audio.duration);
    });
    this.audio.addEventListener('play', () => {
      this._initVisualizer();
      this._vizPlaying = true;
    });
    this.audio.addEventListener('pause', () => { this._vizPlaying = false; });

    this.playlistEl.addEventListener('click', e => {
      const likeBtn = e.target.closest('.track-like-btn');
      if (likeBtn) { e.stopPropagation(); this._toggleLike(Number(likeBtn.dataset.index)); return; }
      const tr = e.target.closest('.track');
      if (!tr) return;
      const idx = Number(tr.dataset.index);
      if (!Number.isNaN(idx)) this.playIndex(idx);
    });

    this.progressCont.addEventListener('mousedown', e => this._seekStart(e));
    this.progressCont.addEventListener('touchstart', e => this._seekStart(e), { passive: true });
    document.addEventListener('mousemove', e => { if (this.isDragging) this._seekMove(e); });
    document.addEventListener('touchmove', e => { if (this.isDragging) this._seekMove(e); }, { passive: true });
    document.addEventListener('mouseup',  () => { this.isDragging = false; });
    document.addEventListener('touchend', () => { this.isDragging = false; });

    this.volumeSlider.addEventListener('input', () => {
      const val = this.volumeSlider.value / 100;
      this.audio.volume = val; this.lastVol = val; this.isMuted = val === 0;
      this._updateVolUI(); this._updateSliderFill();
    });
    this.muteBtn.addEventListener('click', () => this._toggleMute());
    document.addEventListener('keydown', e => this._onKey(e));
  }

  /* ── Shuffle ── */
  _toggleShuffle() {
    this.shuffle = !this.shuffle;
    this.shuffleBtn.classList.toggle('active', this.shuffle);
    if (this.shuffle) this._buildShuffleOrder();
  }

  _buildShuffleOrder() {
    const indices = this.queue.map((_, i) => i);
    for (let i = indices.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [indices[i], indices[j]] = [indices[j], indices[i]];
    }
    if (this.index >= 0) {
      const pos = indices.indexOf(this.index);
      if (pos > 0) [indices[0], indices[pos]] = [indices[pos], indices[0]];
    }
    this.shuffleOrder = indices;
  }

  _shuffleNext() {
    if (!this.shuffleOrder.length) this._buildShuffleOrder();
    const pos = this.shuffleOrder.indexOf(this.index);
    const next = this.shuffleOrder[(pos + 1) % this.shuffleOrder.length];
    return next;
  }

  _shufflePrev() {
    if (!this.shuffleOrder.length) this._buildShuffleOrder();
    const pos = this.shuffleOrder.indexOf(this.index);
    const prev = this.shuffleOrder[(pos - 1 + this.shuffleOrder.length) % this.shuffleOrder.length];
    return prev;
  }

  /* ── Repeat ── */
  _cycleRepeat() {
    const modes = ['none', 'one', 'all'];
    this.repeatMode = modes[(modes.indexOf(this.repeatMode) + 1) % modes.length];
    this.repeatBtn.classList.toggle('active', this.repeatMode !== 'none');
    this.repeatIcon.style.display    = this.repeatMode === 'one' ? 'none' : '';
    this.repeatOneIcon.style.display = this.repeatMode === 'one' ? '' : 'none';
    const titles = { none: 'Repeat off', one: 'Repeat one', all: 'Repeat all' };
    this.repeatBtn.title = titles[this.repeatMode];
  }

  _onEnded() {
    if (this.repeatMode === 'one') {
      this.audio.currentTime = 0;
      this.audio.play();
    } else if (this.repeatMode === 'all') {
      const nextIdx = this.shuffle
        ? this._shuffleNext()
        : (this.index + 1) % this.queue.length;
      this.playIndex(nextIdx);
    } else {
      this.next();
    }
  }

  /* ── Likes ── */
  _toggleLike(idx) {
    const track = this.queue[idx];
    if (!track) return;
    if (this.likes.has(track.src)) this.likes.delete(track.src);
    else this.likes.add(track.src);
    saveLikes(this.likes);
    this._updateLikeUI(idx);
    this._updateMiniLike();
    this._updateLikedCount();
  }

  _toggleCurrentLike() {
    if (this.index >= 0) this._toggleLike(this.index);
  }

  _updateLikeUI(idx) {
    const btn = this.playlistEl.querySelector(`.track-like-btn[data-index="${idx}"]`);
    if (!btn) return;
    const liked = this.likes.has(this.queue[idx]?.src);
    btn.classList.toggle('liked', liked);
    btn.title = liked ? 'Unlike' : 'Like';
  }

  _updateMiniLike() {
    const liked = this.index >= 0 && this.likes.has(this.queue[this.index]?.src);
    this.miniLike.classList.toggle('liked', liked);
    this.miniLike.title = liked ? 'Unlike' : 'Like';
  }

  _updateLikedCount() {
    const n = this.likes.size;
    this.likedCount.textContent = n + ' song' + (n !== 1 ? 's' : '');
  }

  /* ── Liked Songs view ── */
  _showLikedView() {
    const likedTracks = this._allTracks.filter(t => this.likes.has(t.src));
    document.querySelectorAll('.artist-pill').forEach(p => p.classList.remove('active'));
    this.likedItem.classList.add('active');
    qs('heroLabel').textContent = 'Playlist';
    qs('artistName').textContent = 'Liked Songs';
    qs('albumName').textContent = likedTracks.length + ' songs';
    qs('coverImg').src = likedTracks[0]?.image || '';
    const fakeArtist = { name: 'Liked Songs', image: likedTracks[0]?.image || '', tracks: likedTracks };
    this.loadQueue(likedTracks, { name: 'Liked Songs' });
    this.heroPlayBtn.classList.remove('hidden');
    applyAlbumColor([100, 0, 0]);
    this._likedView = true;
  }

  /* ── Download ── */
  _downloadCurrent() {
    if (this.index < 0 || !this.queue[this.index]) return;
    const track = this.queue[this.index];
    const a = document.createElement('a');
    a.href = encodeSrc(track.src);
    a.download = track.title.replace(/[/\\?%*:|"<>]/g, '-') + '.mp3';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  /* ── Queue panel ── */
  _toggleQueue() {
    if (this.queuePanel.classList.contains('open')) this._closeQueue();
    else this._openQueue();
  }

  _openQueue() {
    this._renderQueuePanel();
    this.queuePanel.classList.add('open');
    this.queueOverlay.classList.add('visible');
    this.queueBtn.classList.add('active');
  }

  _closeQueue() {
    this.queuePanel.classList.remove('open');
    this.queueOverlay.classList.remove('visible');
    this.queueBtn.classList.remove('active');
  }

  _renderQueuePanel() {
    this.queueList.innerHTML = '';
    if (!this.queue.length) {
      this.queueList.innerHTML = '<div style="padding:20px;color:#555;font-size:0.85rem;text-align:center">No queue</div>';
      return;
    }
    const order = this.shuffle ? this.shuffleOrder : this.queue.map((_,i) => i);
    order.forEach((qi, pos) => {
      const t = this.queue[qi];
      const div = document.createElement('div');
      div.className = 'queue-track' + (qi === this.index ? ' q-active' : '');
      div.innerHTML = `
        <span class="q-num">${pos + 1}</span>
        <div class="q-info">
          <div class="q-name">${escapeHtml(t.title)}</div>
          <div class="q-art">${escapeHtml(t.artist)}</div>
        </div>
      `;
      div.addEventListener('click', () => { this.playIndex(qi); this._closeQueue(); });
      this.queueList.appendChild(div);
    });
  }

  /* ── Audio Visualizer ── */
  _initVisualizer() {
    if (this._vizInit) return;
    this._vizInit = true;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this._audioCtx = new AudioCtx();
      this._analyser = this._audioCtx.createAnalyser();
      this._analyser.fftSize = 128;
      const src = this._audioCtx.createMediaElementSource(this.audio);
      src.connect(this._analyser);
      this._analyser.connect(this._audioCtx.destination);
      this._runViz();
    } catch (e) { console.warn('Visualizer unavailable:', e); }
  }

  _runViz() {
    const canvas  = this.vizCanvas;
    const ctx     = canvas.getContext('2d');
    const analyser = this._analyser;
    const bins    = analyser.frequencyBinCount;
    const data    = new Uint8Array(bins);

    const draw = () => {
      requestAnimationFrame(draw);
      canvas.width  = canvas.offsetWidth;
      canvas.height = canvas.offsetHeight;
      const W = canvas.width, H = canvas.height;
      ctx.clearRect(0, 0, W, H);
      if (!this._vizPlaying) return;
      analyser.getByteFrequencyData(data);
      const barW = W / bins;
      for (let i = 0; i < bins; i++) {
        const v = data[i] / 255;
        const h = v * H;
        const alpha = v * 0.9 + 0.05;
        ctx.fillStyle = `rgba(230, 30, 30, ${alpha})`;
        ctx.fillRect(i * barW, H - h, barW - 1, h);
      }
    };
    draw();
  }

  /* ── Seek ── */
  _seekStart(e) { this.isDragging = true; this._seekTo(e); }
  _seekMove(e)  { this._seekTo(e); }
  _seekTo(e) {
    if (!this.audio.duration) return;
    const rect   = this.progressCont.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const ratio  = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    this.audio.currentTime = ratio * this.audio.duration;
    this.progressBar.style.width  = (ratio * 100) + '%';
    this.progressThumb.style.left = (ratio * 100) + '%';
    this.currentTimeEl.textContent = formatTime(this.audio.currentTime);
  }

  _onTimeUpdate() {
    if (this.isDragging) return;
    const { currentTime, duration } = this.audio;
    if (!duration) return;
    const pct = (currentTime / duration) * 100;
    this.progressBar.style.width  = pct + '%';
    this.progressThumb.style.left = pct + '%';
    this.currentTimeEl.textContent = formatTime(currentTime);
  }

  _onBufferUpdate() {
    const { buffered, duration } = this.audio;
    if (!duration || !buffered.length) return;
    this.progressBuf.style.width = ((buffered.end(buffered.length - 1) / duration) * 100) + '%';
  }

  /* ── Volume ── */
  _toggleMute() {
    if (this.isMuted) {
      this.audio.volume = this.lastVol || 0.8;
      this.volumeSlider.value = (this.lastVol || 0.8) * 100;
      this.isMuted = false;
    } else {
      this.lastVol = this.audio.volume;
      this.audio.volume = 0;
      this.volumeSlider.value = 0;
      this.isMuted = true;
    }
    this._updateVolUI(); this._updateSliderFill();
  }

  _updateVolUI() {
    this.volIcon.style.display  = this.isMuted ? 'none' : '';
    this.muteIcon.style.display = this.isMuted ? '' : 'none';
  }

  _updateSliderFill() {
    const pct = this.volumeSlider.value;
    this.volumeSlider.style.background =
      `linear-gradient(to right, rgba(255,255,255,0.55) ${pct}%, rgba(255,255,255,0.12) ${pct}%)`;
  }

  /* ── Keyboard ── */
  _onKey(e) {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (e.key === ' ')           { e.preventDefault(); this.toggle(); }
    if (e.key === 'ArrowRight')  { e.preventDefault(); this.next(); }
    if (e.key === 'ArrowLeft')   { e.preventDefault(); this.prev(); }
    if (e.key === 's' || e.key === 'S') this._toggleShuffle();
    if (e.key === 'r' || e.key === 'R') this._cycleRepeat();
    if (e.key === 'l' || e.key === 'L') this._toggleCurrentLike();
    if (e.key === 'm' || e.key === 'M') this._toggleMute();
  }

  /* ── Queue management ── */
  loadQueue(tracks, artist) {
    this.queue = tracks.map(t => ({
      src:    t.src,
      title:  t.title || t.file || 'Unknown',
      artist: t.artist || artist.name,
      image:  t.image  || artist.image || ''
    }));
    this.index = -1;
    this.shuffleOrder = [];
    this._renderQueue();
    this.heroPlayBtn.classList.remove('hidden');

    const n = this.queue.length;
    qs('heroStats').innerHTML =
      `<span class="hero-stat"><strong>${n}</strong> track${n !== 1 ? 's' : ''}</span>`;
  }

  _renderQueue() {
    this.playlistEl.innerHTML = '';
    this.queue.forEach((t, i) => {
      const liked = this.likes.has(t.src);
      const div = document.createElement('div');
      div.className = 'track';
      div.dataset.index = i;
      div.innerHTML = `
        <div class="track-num">
          <span class="num-text">${i + 1}</span>
          <div class="playing-bars"><span></span><span></span><span></span></div>
        </div>
        <div class="tmeta">
          <div class="t-title">${escapeHtml(t.title)}</div>
          <div class="t-artist">${escapeHtml(t.artist)}</div>
        </div>
        <button class="track-like-btn ${liked ? 'liked' : ''}" data-index="${i}" title="${liked ? 'Unlike' : 'Like'}" aria-label="Like">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="${liked ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
        </button>
        <div class="t-dur" data-index="${i}">—</div>
      `;
      this.playlistEl.appendChild(div);
    });
    this._loadDurations();
  }

  _loadDurations() {
    this._durationEls = [];
    this.queue.forEach((t, i) => {
      const tmp = new Audio();
      tmp.preload = 'metadata';
      this._durationEls.push(tmp);
      tmp.addEventListener('loadedmetadata', () => {
        const el = this.playlistEl.querySelector(`.t-dur[data-index="${i}"]`);
        if (el) el.textContent = formatTime(tmp.duration);
      });
      tmp.src = encodeSrc(t.src);
    });
  }

  async playIndex(i) {
    if (i < 0 || i >= this.queue.length) return;
    this.index = i;
    const track = this.queue[i];
    this.audio.src = encodeSrc(track.src);
    try { await this.audio.play(); } catch (e) { console.warn('Play blocked:', e); }
    this._updateNow(track);
    this._highlightCurrent();
    this.currentTimeEl.textContent = '0:00';
    this.totalTimeEl.textContent   = '0:00';
    if (this.queuePanel.classList.contains('open')) this._renderQueuePanel();
  }

  toggle() {
    if (this.audio.paused) {
      if (!this.audio.src && this.queue.length > 0) this.playIndex(0);
      else this.audio.play();
    } else {
      this.audio.pause();
    }
  }

  next() {
    if (!this.queue.length) return;
    const next = this.shuffle
      ? this._shuffleNext()
      : (this.index + 1 < this.queue.length ? this.index + 1 : -1);
    if (next >= 0) this.playIndex(next);
  }

  prev() {
    if (this.audio.currentTime > 3) {
      this.audio.currentTime = 0; return;
    }
    const prev = this.shuffle
      ? this._shufflePrev()
      : (this.index > 0 ? this.index - 1 : -1);
    if (prev >= 0) this.playIndex(prev);
  }

  _heroPlay() {
    if (!this.queue.length) return;
    if (this.index < 0) this.playIndex(0); else this.toggle();
  }

  _updateNow(track) {
    this.miniTitle.textContent  = track.title;
    this.miniArtist.textContent = track.artist;
    if (track.image) { this.miniCover.src = track.image; }
    this._updateMiniLike();
    qs('heroLabel').textContent = 'Now Playing';
  }

  _updatePlayUI(isPlaying) {
    this.playIcon.style.display  = isPlaying ? 'none' : '';
    this.pauseIcon.style.display = isPlaying ? '' : 'none';
    this.miniPlayer.classList.toggle('paused', !isPlaying);
  }

  _highlightCurrent() {
    [...this.playlistEl.querySelectorAll('.track')].forEach(el => el.classList.remove('playing'));
    const cur = this.playlistEl.querySelector(`.track[data-index="${this.index}"]`);
    if (cur) { cur.classList.add('playing'); cur.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
  }
}

/* ── Folder auto-scan ── */
async function scanFolder(folderPath) {
  try {
    const encodedPath = folderPath.split('/').map(encodeURIComponent).join('/');
    const res = await fetch(encodedPath + '/');
    if (!res.ok) return null;
    const html = await res.text();
    const tracks = [];
    const seen   = new Set();
    const re     = /href="([^"?#\/][^"?#]*\.mp3)"/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
      if (seen.has(m[1])) continue;
      seen.add(m[1]);
      const decoded = decodeURIComponent(m[1]);
      tracks.push({ title: decoded.replace(/\.mp3$/i, ''), src: folderPath + '/' + decoded });
    }
    return tracks.length ? tracks : null;
  } catch (e) {
    console.error('Folder scan failed:', e);
    return null;
  }
}

/* ── Album helpers ── */
function getAlbums(artist) {
  if (artist.albums && artist.albums.length > 0) return artist.albums;
  if (artist.tracks)  return [{ title: artist.album || 'Album', tracks: artist.tracks }];
  return [];
}

async function selectAlbum(album, artist, player) {
  qs('playlist').innerHTML = '<div class="tracks-loading">Scanning folder…</div>';
  let tracks = album.tracks;
  if (!tracks && album.folder) tracks = await scanFolder(album.folder);

  if (!tracks || !tracks.length) {
    qs('playlist').innerHTML = '<div class="tracks-error">No tracks found in this folder.</div>';
    return;
  }

  qs('albumName').textContent = album.title || '';
  player.loadQueue(tracks, artist);

  const coverSrc = album.image || artist.image || '';
  const img = qs('coverImg');
  if (img.src !== coverSrc) img.src = coverSrc;
  if (coverSrc) {
    if (img.complete && img.naturalWidth > 0) applyAlbumColor(extractColor(img));
    else img.onload = () => applyAlbumColor(extractColor(img));
  }

  tracks.forEach(t => {
    if (!player._allTracks.find(x => x.src === t.src))
      player._allTracks.push({ ...t, artist: artist.name, image: artist.image || '' });
  });
}

function renderAlbumTabs(albums, artist, player) {
  const container = qs('albumTabs');
  container.innerHTML = '';
  if (albums.length <= 1) return;
  albums.forEach((album, i) => {
    const btn = document.createElement('button');
    btn.className = 'album-tab' + (i === 0 ? ' active' : '');
    btn.textContent = album.title || `Album ${i + 1}`;
    btn.addEventListener('click', async () => {
      container.querySelectorAll('.album-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      await selectAlbum(album, artist, player);
    });
    container.appendChild(btn);
  });
}

/* ── Render artists ── */
function renderArtists(artists, onSelect) {
  const container = qs('artists');
  container.innerHTML = '';
  artists.forEach(a => {
    const pill = document.createElement('div');
    pill.className = 'artist-pill';
    pill.setAttribute('role', 'button');
    pill.setAttribute('tabindex', '0');
    pill.dataset.name = a.name;
    pill.innerHTML = `
      <img src="${escapeHtml(a.image || '')}" alt="${escapeHtml(a.name)}" onerror="this.style.opacity=0">
      <span class="pill-name">${escapeHtml(a.name)}</span>
    `;
    pill.addEventListener('click', () => onSelect(a));
    pill.addEventListener('keydown', e => { if (e.key === 'Enter') onSelect(a); });
    container.appendChild(pill);
  });
}

/* ── Show artist ── */
async function showArtist(artist, player) {
  player._likedView = false;
  qs('likedItem').classList.remove('active');
  qs('heroLabel').textContent  = 'Artist';
  qs('artistName').textContent = artist.name;
  qs('albumName').textContent  = '';
  qs('albumTabs').innerHTML    = '';

  document.querySelectorAll('.artist-pill').forEach(p => p.classList.remove('active'));
  const active = document.querySelector(`.artist-pill[data-name="${CSS.escape(artist.name)}"]`);
  if (active) active.classList.add('active');

  const albums = getAlbums(artist);
  renderAlbumTabs(albums, artist, player);

  if (albums.length > 0) await selectAlbum(albums[0], artist, player);
}

/* ── Search ── */
function setupSearch(data, player) {
  const overlay   = qs('searchOverlay');
  const input     = qs('searchInput');
  const results   = qs('searchResults');

  function open()  { overlay.hidden = false; input.value = ''; results.innerHTML = ''; input.focus(); }
  function close() { overlay.hidden = true; }

  qs('searchBtn').addEventListener('click', open);
  qs('closeSearch').addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !overlay.hidden) { close(); return; }
    if (e.key === '/' && overlay.hidden && document.activeElement?.tagName !== 'INPUT') { e.preventDefault(); open(); }
  });

  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    results.innerHTML = '';
    if (!q) return;
    const hits = [];
    data.artists.forEach(a => {
      if (a.name.toLowerCase().includes(q))
        hits.push({ type: 'artist', label: a.name, sub: 'Artist', image: a.image, ref: a });
      getAlbums(a).forEach(alb => {
        if ((alb.title || '').toLowerCase().includes(q))
          hits.push({ type: 'album', label: alb.title || '', sub: a.name, image: a.image, ref: a });
        (alb.tracks || []).forEach(t => {
          const title = t.title || '';
          if (title.toLowerCase().includes(q))
            hits.push({ type: 'track', label: title, sub: `${a.name} — ${alb.title || ''}`, image: a.image, ref: a });
        });
      });
    });
    if (!hits.length) { results.innerHTML = '<div class="search-no-results">No results</div>'; return; }
    hits.slice(0, 12).forEach(h => {
      const item = document.createElement('div');
      item.className = 'search-result-item';
      item.innerHTML = `
        <img class="r-icon" src="${escapeHtml(h.image||'')}" alt="" onerror="this.style.opacity=0">
        <div><div class="r-name">${escapeHtml(h.label)}</div><div class="r-sub">${escapeHtml(h.sub)}</div></div>
      `;
      item.addEventListener('click', () => {
        showArtist(h.ref, player);
        if (h.type === 'track') {
          const idx = (h.ref.tracks||[]).findIndex(t => t === h.track);
          if (idx >= 0) setTimeout(() => player.playIndex(idx), 60);
        }
        close();
      });
      results.appendChild(item);
    });
  });
}

/* ── Mobile sidebar drawer ── */
function setupMobileMenu() {
  const menuBtn  = qs('menuBtn');
  const sidebar  = qs('sidebarNav');
  const overlay  = qs('sidebarOverlay');

  function openSidebar() {
    sidebar.classList.add('mobile-open');
    overlay.classList.add('visible');
  }
  function closeSidebar() {
    sidebar.classList.remove('mobile-open');
    overlay.classList.remove('visible');
  }

  menuBtn.addEventListener('click', () => {
    sidebar.classList.contains('mobile-open') ? closeSidebar() : openSidebar();
  });
  overlay.addEventListener('click', closeSidebar);

  qs('artists').addEventListener('click', () => { if (window.innerWidth <= 860) closeSidebar(); });
  qs('likedItem').addEventListener('click', () => { if (window.innerWidth <= 860) closeSidebar(); });
}

/* ── About ── */
function setupAbout() {
  const overlay = qs('about');
  qs('aboutBtn').addEventListener('click', () => { overlay.hidden = false; });
  qs('closeAbout').addEventListener('click', () => { overlay.hidden = true; });
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.hidden = true; });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !overlay.hidden) overlay.hidden = true; });
}

/* ── Init ── */
(async function init() {
  const data   = await loadManifest();
  const player = new Player();
  player._allTracks = [];

  renderArtists(data.artists || [], a => showArtist(a, player));
  setupSearch(data, player);
  setupAbout();
  setupMobileMenu();

  if (data.artists?.[0]) await showArtist(data.artists[0], player);
})();
