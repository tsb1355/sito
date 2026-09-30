(function () {
  'use strict';

  const DEBUG = false;
  function dlog(...args) { if (DEBUG) console.log(...args); }
  function dwarn(...args) { if (DEBUG) console.warn(...args); }

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Tutto passa da AzuraCast. I valori in config.meta hanno la precedenza.
const DEFAULT_STREAM_URL = 'https://radio-carducci-server.tailf86179.ts.net/listen/radio_carducci/radio.mp3';
const STREAM_URL = DEFAULT_STREAM_URL;
const DEFAULT_JSON_URL = 'https://radio-carducci-server.tailf86179.ts.net/api/nowplaying/radio_carducci';
const DEFAULT_SSE_URL = 'https://radio-carducci-server.tailf86179.ts.net/api/live/nowplaying/sse?stations=radio_carducci';
const CONFIG_URL = 'https://pub-7bdb71d3a8a643899d66d0b611b8b049.r2.dev/app/config.json';
const R2_PUBLIC = 'https://pub-7bdb71d3a8a643899d66d0b611b8b049.r2.dev';
const SITE_CONFIG_URL = `${R2_PUBLIC}/site/site.json`;           // gestito da site-tool.html
const WRAPPED_PLAYLIST_URL = `${R2_PUBLIC}/site/wrapped/playlist.json`;
const COVER_WORKER_URL = 'https://lively-glade-f2daitunes-proxy.tecniciradiocarducci.workers.dev/';

// Copertine dei brani: stesso Worker dell'app. Cache per brano, richieste in volo condivise.
const COVER_CACHE = new Map();
function fetchCoverFromWorker(artist, title) {
  if (!artist || !title) return Promise.resolve(null);
  const key = `${artist}::${title}`.toLowerCase();
  if (COVER_CACHE.has(key)) return COVER_CACHE.get(key);
  const url = `${COVER_WORKER_URL}?artist=${encodeURIComponent(artist)}&title=${encodeURIComponent(title)}`;
  const p = fetch(url, { cache: 'no-store' })
    .then(r => r.ok ? r.json() : null)
    .then(d => (d && typeof d.url === 'string' && d.url.startsWith('http')) ? d.url : null)
    .catch(() => null);
  COVER_CACHE.set(key, p);
  p.then(v => { if (!v) setTimeout(() => COVER_CACHE.delete(key), 60000); }); // riprova più tardi se vuota
  return p;
}
let APP_CONFIG = null;
let metadataPollInterval = null;

async function loadConfig() {
  try {
    const res = await fetch(`${CONFIG_URL}?_=${Date.now()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    APP_CONFIG = data;

    if (data.schedule) updateScheduleFromConfig(data.schedule);
    if (Array.isArray(data.team)) updateTeamFromConfig(data.team);
    if (Array.isArray(data.podcasts)) updatePodcastsFromConfig(data.podcasts);
    if (Array.isArray(data.bacheca)) updateBachecaFromConfig(data.bacheca);
    if (data.meta) updateMetaFromConfig(data.meta);

    initPalinsesto();
    initTeam();
    initPodcasts();
    initBacheca();
    refreshPodcastEpisodeCounts();
    updateCountLabels();
    updateOnAir();
    applyDedicheState();

    return data;
  } catch (err) {
    console.warn('[Config] Error loading remote config from R2:', err);
    return null;
  }
}

function updateScheduleFromConfig(r2Schedule) {
  const map = { lun: 'lunedi', mar: 'martedi', mer: 'mercoledi', gio: 'giovedi', ven: 'venerdi', sab: 'sabato', dom: 'domenica' };
  Object.keys(map).forEach(r2Key => {
    const siteKey = map[r2Key];
    const shows = r2Schedule[r2Key] || [];
    SCHEDULE[siteKey] = shows.map(s => {
      let start = '00:00', end = '23:59';
      if (s.time) {
        const parts = s.time.split(/[–-]/);
        if (parts.length === 2) {
          start = parts[0].trim();
          end = parts[1].trim();
        }
      }
      const img = s.img || '';
      return {
        time: s.time || '',
        start: start,
        end: end,
        name: s.name || '',
        desc: s.desc || '',
        img: img,
        slug: s.slug || ''
      };
    });
  });
}

function updateTeamFromConfig(r2Team) {
  // Il config è l'unica fonte: niente merge con dati locali.
  TEAM.length = 0;
  r2Team.forEach(m => {
    if (!m || !m.name) return;
    TEAM.push({
      slug: m.slug || '',
      name: m.name,
      role: m.role || 'Team Radio Carducci',
      categories: (Array.isArray(m.categories) && m.categories.length) ? m.categories : ['speaker'],
      bio: (typeof m.bio === 'string') ? m.bio.trim() : '',
      img: m.photo || '',
      programs: Array.isArray(m.shows) ? m.shows : []
    });
  });
}

// Conduttori di un programma, ricavati da team[].shows (stessa fonte dell'admin tool)
function getHostsForSlug(slug) {
  if (!slug) return [];
  return TEAM.filter(m => Array.isArray(m.programs) && m.programs.includes(slug)).map(m => m.name);
}

function updatePodcastsFromConfig(r2Podcasts) {
  PODCASTS.length = 0;
  const icons = ['calendar-days', 'guitar', 'atom', 'message-circle', 'zap', 'book-open', 'lightbulb', 'trophy', 'bookmark', 'landmark'];
  r2Podcasts.forEach((p, index) => {
    PODCASTS.push({
      slug: p.slug || '',
      name: p.name || '',
      episodes: PODCAST_EP_COUNT[p.feed] || 0,
      icon: icons[index % icons.length],
      feed: p.feed || '',
      url: p.feed || '#',
      img: p.img || '',
      desc: (p.desc && typeof p.desc === 'string') ? p.desc.trim() : ''
    });
  });
}

const PODCAST_EP_COUNT = {};
function refreshPodcastEpisodeCounts() {
  PODCASTS.forEach(p => {
    if (!p.feed || PODCAST_EP_COUNT[p.feed] !== undefined) return;
    PODCAST_EP_COUNT[p.feed] = 0;
    fetch(`${p.feed}?_=${Date.now()}`).then(r => r.ok ? r.text() : '').then(txt => {
      const count = (txt.match(/<item[\s>]/g) || []).length;
      PODCAST_EP_COUNT[p.feed] = count;
      PODCASTS.forEach(x => { if (x.feed === p.feed) x.episodes = count; });
      initPodcasts();
    }).catch(() => {});
  });
}
function updateBachecaFromConfig(r2Bacheca) {
  if (!Array.isArray(r2Bacheca)) return;
  BACHECA.length = 0;
  r2Bacheca.forEach(item => {
    if (typeof item === 'string') {
      BACHECA.push({ tag: 'AVVISO', text: item });
    } else if (item && typeof item === 'object') {
      BACHECA.push({
        tag: (item.tag || item.type || 'AVVISO').toUpperCase(),
        text: item.text || item.message || item.titolo || ''
      });
    }
  });
}

function updateMetaFromConfig(meta) {
  if (!meta) return;
  const streamUrl = meta.streamUrl || DEFAULT_STREAM_URL;
  const jsonUrl = meta.jsonUrl || DEFAULT_JSON_URL;

  // Lo stream viene assegnato solo al play (togglePlay legge APP_CONFIG.meta.streamUrl)

  // Link social/contatti presi da meta (gestiti dall'admin tool)
  document.querySelectorAll('[data-rc-meta-href]').forEach(a => {
    const v = meta[a.getAttribute('data-rc-meta-href')];
    if (typeof v === 'string' && /^(https?:|mailto:)/.test(v)) a.href = v;
  });

  if (window.NowPlaying) {
    window.NowPlaying.jsonUrl = jsonUrl;
    window.NowPlaying.initSSE();
    window.NowPlaying.poll();
  }
}

const BgMusic = {
  player: null,
  isReady: false,
  isPlaying: false,
  userInteracted: false,
  shouldBePlaying: false,
  ytFailed: false,
  playTimeout: null,
  startPlayTimeout() {},
  clearPlayTimeout() {},
  init() {},
  getSliderVol() { return 0.8; },
  setVolume() {},
  updateState() {},
  setSuspended() {}
};

const HEADLINES = [
  ['Radio', '<em>Carducci.</em>'],
  ['musica, cultura', 'e <em>passione.</em>'],
  ['la web radio', 'del Liceo', '<em>Carducci.</em>'],
  ['in onda', 'ogni <em>giorno.</em>'],
  ['fatta dagli', 'studenti, per', '<em>tutti.</em>'],
];

const DAY_KEYS = ['domenica', 'lunedi', 'martedi', 'mercoledi', 'giovedi', 'venerdi', 'sabato'];
const DAY_LABELS = ['DOM', 'LUN', 'MAR', 'MER', 'GIO', 'VEN', 'SAB'];

const SCHEDULE = {
  lunedi: [
    { time: '15:00 – 16:00', start: '15:00', end: '16:00', name: 'Ultima Campanella', desc: "L'intrattenimento di cui avete bisogno: teorie sui film, interviste incredibili, storie che non potete perdervi.", img: 'https://pub-7bdb71d3a8a643899d66d0b611b8b049.r2.dev/programs/chiacchiere-gratis.jpeg', slug: 'ultima-campanella' },
    { time: '16:00 – 16:30', start: '16:00', end: '16:30', name: 'Manuale di Sopravvivenza Letteraria', desc: 'I libri essenziali per sopravvivere alla vita.', img: 'https://pub-7bdb71d3a8a643899d66d0b611b8b049.r2.dev/programs/manuale-di-sopravvivenza-letteraria.jpg', slug: 'manuale-di-sopravvivenza-letteraria' },
    { time: '16:30 – 17:00', start: '16:30', end: '17:00', name: 'Emergenza Emergenti', desc: '', img: '', slug: 'emergenza-emergenti' },
    { time: '17:00 – 17:30', start: '17:00', end: '17:30', name: 'Sit and Talk', desc: '', img: '', slug: 'sit-and-talk' },
    { time: '17:30 – 18:00', start: '17:30', end: '18:00', name: 'Nuovo Programma', desc: '', img: '', slug: 'nuovo-programma' }
  ],
  martedi: [
    { time: '00:00 – 23:59', start: '00:00', end: '23:59', name: 'La Musica di Radio Carducci', desc: 'Musica non-stop per tutta la giornata.', img: 'https://pub-7bdb71d3a8a643899d66d0b611b8b049.r2.dev/programs/la-musica-di-radio-carducci.jpeg', slug: 'la-musica-di-radio-carducci' }
  ],
  mercoledi: [
    { time: '00:00 – 23:59', start: '00:00', end: '23:59', name: 'La Musica di Radio Carducci', desc: 'Musica non-stop per tutta la giornata.', img: 'https://pub-7bdb71d3a8a643899d66d0b611b8b049.r2.dev/programs/la-musica-di-radio-carducci.jpeg', slug: 'la-musica-di-radio-carducci' }
  ],
  giovedi: [
    { time: '00:00 – 23:59', start: '00:00', end: '23:59', name: 'La Musica di Radio Carducci', desc: 'Musica non-stop per tutta la giornata.', img: 'https://pub-7bdb71d3a8a643899d66d0b611b8b049.r2.dev/programs/la-musica-di-radio-carducci.jpeg', slug: 'la-musica-di-radio-carducci' }
  ],
  venerdi: [
    { time: '15:00 – 16:00', start: '15:00', end: '16:00', name: 'Ultima Campanella', desc: "L'intrattenimento di cui avete bisogno: teorie sui film, interviste incredibili, storie che non potete perdervi.", img: 'https://pub-7bdb71d3a8a643899d66d0b611b8b049.r2.dev/programs/chiacchiere-gratis.jpeg', slug: 'ultima-campanella' },
    { time: '16:00 – 16:30', start: '16:00', end: '16:30', name: 'A Tutto Ciak', desc: '', img: '', slug: 'a-tutto-ciak' },
    { time: '16:30 – 17:00', start: '16:30', end: '17:00', name: 'Frequenza Civile', desc: '', img: '', slug: 'frequenza-civile' },
    { time: '17:00 – 17:30', start: '17:00', end: '17:30', name: 'Radio Scienza Pop', desc: 'Tommaso racconta le assurde magie della scienza!', img: 'https://pub-7bdb71d3a8a643899d66d0b611b8b049.r2.dev/programs/radio-scienza-pop.jpg', slug: 'radio-scienza-pop' },
    { time: '17:30 – 18:00', start: '17:30', end: '18:00', name: 'Musica a 2 Tempi', desc: 'La musica vista da due prospettive diverse. Un viaggio sonoro ogni venerdì.', img: 'https://pub-7bdb71d3a8a643899d66d0b611b8b049.r2.dev/programs/musica-a-2-tempi.jpeg', slug: 'musica-a-2-tempi' }
  ],
  sabato: [
    { time: '00:00 – 23:59', start: '00:00', end: '23:59', name: 'La Musica di Radio Carducci', desc: 'Musica non-stop per tutto il sabato.', img: 'https://pub-7bdb71d3a8a643899d66d0b611b8b049.r2.dev/programs/la-musica-di-radio-carducci.jpeg', slug: 'la-musica-di-radio-carducci' }
  ],
  domenica: [
    { time: '00:00 – 23:59', start: '00:00', end: '23:59', name: 'La Musica di Radio Carducci', desc: 'Musica non-stop per tutta la domenica.', img: 'https://pub-7bdb71d3a8a643899d66d0b611b8b049.r2.dev/programs/la-musica-di-radio-carducci.jpeg', slug: 'la-musica-di-radio-carducci' }
  ]
};

function getCurrentLiveShow() {
  try {
    const now = new Date();
    const dayKey = DAY_KEYS[now.getDay()];
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    const shows = SCHEDULE[dayKey] || [];
    for (const show of shows) {
      if (show.start && show.end) {
        const [startH, startM] = show.start.split(':').map(Number);
        const [endH, endM] = show.end.split(':').map(Number);
        const sMin = startH * 60 + startM;
        const eMin = endH * 60 + endM;
        if (currentMinutes >= sMin && currentMinutes < eMin) {
          return show;
        }
      }
    }
    return shows.length > 0 ? shows[0] : null;
  } catch (e) {
    return null;
  }
}

const PODCASTS = [
  { slug: 'radio-scienza-pop', name: 'Radio Scienza Pop', episodes: 12, icon: 'atom', feed: 'https://pub-7bdb71d3a8a643899d66d0b611b8b049.r2.dev/radio-scienza-pop/feed.xml', url: 'https://pub-7bdb71d3a8a643899d66d0b611b8b049.r2.dev/radio-scienza-pop/feed.xml', img: 'https://pub-7bdb71d3a8a643899d66d0b611b8b049.r2.dev/podcasts/radio-scienza-pop-cover.jpg', desc: '' },
  { slug: 'emergenza-emergenti', name: 'Emergenza Emergenti', episodes: 12, icon: 'zap', feed: 'https://pub-7bdb71d3a8a643899d66d0b611b8b049.r2.dev/emergenza-emergenti/feed.xml', url: 'https://pub-7bdb71d3a8a643899d66d0b611b8b049.r2.dev/emergenza-emergenti/feed.xml', img: 'https://pub-7bdb71d3a8a643899d66d0b611b8b049.r2.dev/podcasts/emergenza-emergenti-cover.jpeg', desc: '' },
  { slug: 'manuale-di-sopravvivenza-letteraria', name: 'Manuale di Sopravvivenza Letteraria', episodes: 12, icon: 'book-open', feed: 'https://pub-7bdb71d3a8a643899d66d0b611b8b049.r2.dev/manuale-di-sopravvivenza-letteraria/feed.xml', url: 'https://pub-7bdb71d3a8a643899d66d0b611b8b049.r2.dev/manuale-di-sopravvivenza-letteraria/feed.xml', img: 'https://pub-7bdb71d3a8a643899d66d0b611b8b049.r2.dev/podcasts/manuale-di-sopravvivenza-letteraria-cover.jpg', desc: '' },
  { slug: 'frequenza-civile', name: 'Frequenza Civile', episodes: 12, icon: 'landmark', feed: 'https://pub-7bdb71d3a8a643899d66d0b611b8b049.r2.dev/frequenza-civile/feed.xml', url: 'https://pub-7bdb71d3a8a643899d66d0b611b8b049.r2.dev/frequenza-civile/feed.xml', img: 'https://pub-7bdb71d3a8a643899d66d0b611b8b049.r2.dev/podcasts/frequenza-civile-cover.jpeg', desc: '' },
  { slug: 'broken-sound', name: 'Broken Sound', episodes: 12, icon: 'guitar', feed: 'https://pub-7bdb71d3a8a643899d66d0b611b8b049.r2.dev/broken-sound/feed.xml', url: 'https://pub-7bdb71d3a8a643899d66d0b611b8b049.r2.dev/broken-sound/feed.xml', img: 'https://pub-7bdb71d3a8a643899d66d0b611b8b049.r2.dev/podcasts/broken-sound-cover.jpg', desc: '' }
];

const BACHECA = [];

function initBacheca() {
  const grid = document.getElementById('bacheca-grid');
  if (!grid) return;

  if (!BACHECA.length) {
    grid.innerHTML = '<div class="empty-state">Nessun avviso al momento.</div>';
    return;
  }

  grid.innerHTML = BACHECA.map(item => `
    <div class="bacheca-item">
      <div class="bacheca-item__tag">${escapeHtml(item.tag)}</div>
      <div class="bacheca-item__text">${escapeHtml(item.text)}</div>
    </div>
  `).join('');
}

// Il team arriva solo da config.json (admin tool)
const TEAM = [];

const RCMediaSession = {
  activeType: 'radio',
  lastRadioData: null,
  currentPodcast: null,
  currentEpisode: null,

  toAbsoluteUrl(url) {
    if (!url) return '';
    try {
      return new URL(url, window.location.href).href;
    } catch (e) {
      return url;
    }
  },

  buildArtworks(coverUrl) {
    const isRealTrackCover = coverUrl && typeof coverUrl === 'string' &&
      (coverUrl.startsWith('http') || coverUrl.startsWith('//') || coverUrl.startsWith('data:')) &&
      !coverUrl.includes('generic_song') &&
      !coverUrl.includes('media-session') &&
      !coverUrl.includes('defaultCover') &&
      !coverUrl.includes('vinyl');

    if (isRealTrackCover) {
      const fullCoverUrl = coverUrl.startsWith('//') ? ('https:' + coverUrl) : coverUrl;
      const absUrl = this.toAbsoluteUrl(fullCoverUrl);
      const mime = absUrl.toLowerCase().endsWith('.png') ? 'image/png' : (absUrl.toLowerCase().endsWith('.webp') ? 'image/webp' : 'image/jpeg');

      // Se la copertina proviene dai server Apple / iTunes, generiamo le varianti ad alta risoluzione Retina/CarPlay/Lockscreen
      if (absUrl.includes('mzstatic.com')) {
        return [
          { src: absUrl.replace(/\d+x\d+bb\./, '96x96bb.'), sizes: '96x96', type: mime },
          { src: absUrl.replace(/\d+x\d+bb\./, '128x128bb.'), sizes: '128x128', type: mime },
          { src: absUrl.replace(/\d+x\d+bb\./, '192x192bb.'), sizes: '192x192', type: mime },
          { src: absUrl.replace(/\d+x\d+bb\./, '256x256bb.'), sizes: '256x256', type: mime },
          { src: absUrl.replace(/\d+x\d+bb\./, '384x384bb.'), sizes: '384x384', type: mime },
          { src: absUrl.replace(/\d+x\d+bb\./, '512x512bb.'), sizes: '512x512', type: mime },
          { src: absUrl.replace(/\d+x\d+bb\./, '1024x1024bb.'), sizes: '1024x1024', type: mime }
        ];
      }

      const sizes = ['96x96', '128x128', '192x192', '256x256', '384x384', '512x512', '1024x1024'];
      return sizes.map(s => ({ src: absUrl, sizes: s, type: mime }));
    }

    return [
      { src: this.toAbsoluteUrl('assets/media-session-192.png'), sizes: '192x192', type: 'image/png' },
      { src: this.toAbsoluteUrl('assets/media-session-512.png'), sizes: '512x512', type: 'image/png' }
    ];
  },

  setActionSafe(action, handler) {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.setActionHandler(action, handler);
    } catch (e) {}
  },

  configureMode(mode) {
    if (!('mediaSession' in navigator)) return;
    this.activeType = mode;

    if (mode === 'radio') {
      // Azioni per Radio Live Streaming
      this.setActionSafe('play', () => {
        const playBtn = document.querySelector('.player-bar__play');
        const rAudio = document.getElementById('rc-audio');
        if (playBtn && rAudio && rAudio.paused) {
          playBtn.click();
        }
        navigator.mediaSession.playbackState = 'playing';
      });

      this.setActionSafe('pause', () => {
        const playBtn = document.querySelector('.player-bar__play');
        const rAudio = document.getElementById('rc-audio');
        if (playBtn && rAudio && !rAudio.paused) {
          playBtn.click();
        }
        navigator.mediaSession.playbackState = 'paused';
      });

      this.setActionSafe('stop', () => {
        const rAudio = document.getElementById('rc-audio');
        if (rAudio) rAudio.pause(); // il listener 'pause' scarta il buffer
        navigator.mediaSession.playbackState = 'none';
      });

      // Su live radio: 'nexttrack' ricarica e risincronizza lo streaming in tempo reale
      this.setActionSafe('nexttrack', () => {
        const rAudio = document.getElementById('rc-audio');
        if (rAudio && !rAudio.paused) {
          const currentSrc = rAudio.src;
          rAudio.src = '';
          rAudio.src = currentSrc;
          rAudio.play().catch(() => {});
        }
      });
      this.setActionSafe('previoustrack', null);
      this.setActionSafe('seekto', null);
      this.setActionSafe('seekbackward', null);
      this.setActionSafe('seekforward', null);

      // Resetta barra scrubber per live streaming
      if ('setPositionState' in navigator.mediaSession) {
        try { navigator.mediaSession.setPositionState(null); } catch (e) {}
      }
    } else if (mode === 'podcast') {
      // Azioni per Riproduzione Podcast
      this.setActionSafe('play', () => {
        const pmAudio = document.getElementById('podcast-audio');
        if (pmAudio && pmAudio.src) {
          pmAudio.play();
          const playBtn = document.getElementById('pm-play-btn');
          if (playBtn) playBtn.innerHTML = '<i data-lucide="pause" width="22" height="22"></i>';
          if (typeof lucide !== 'undefined') lucide.createIcons();
          navigator.mediaSession.playbackState = 'playing';
        }
      });

      this.setActionSafe('pause', () => {
        const pmAudio = document.getElementById('podcast-audio');
        if (pmAudio && !pmAudio.paused) {
          pmAudio.pause();
          const playBtn = document.getElementById('pm-play-btn');
          if (playBtn) playBtn.innerHTML = '<i data-lucide="play" width="22" height="22"></i>';
          if (typeof lucide !== 'undefined') lucide.createIcons();
          navigator.mediaSession.playbackState = 'paused';
        }
      });

      this.setActionSafe('stop', () => {
        const pmAudio = document.getElementById('podcast-audio');
        if (pmAudio) pmAudio.pause();
        navigator.mediaSession.playbackState = 'none';
      });

      this.setActionSafe('seekbackward', (details) => {
        const pmAudio = document.getElementById('podcast-audio');
        if (pmAudio) {
          pmAudio.currentTime = Math.max(pmAudio.currentTime - (details.seekOffset || 15), 0);
          this.updatePositionState(pmAudio);
        }
      });

      this.setActionSafe('seekforward', (details) => {
        const pmAudio = document.getElementById('podcast-audio');
        if (pmAudio) {
          pmAudio.currentTime = Math.min(pmAudio.currentTime + (details.seekOffset || 30), pmAudio.duration || 9999);
          this.updatePositionState(pmAudio);
        }
      });

      this.setActionSafe('seekto', (details) => {
        const pmAudio = document.getElementById('podcast-audio');
        if (pmAudio && pmAudio.duration && details.seekTime !== undefined) {
          pmAudio.currentTime = details.seekTime;
          this.updatePositionState(pmAudio);
        }
      });

      this.setActionSafe('previoustrack', () => {
        if (typeof window.playAdjacentPodcastEpisode === 'function') {
          window.playAdjacentPodcastEpisode(-1);
        }
      });

      this.setActionSafe('nexttrack', () => {
        if (typeof window.playAdjacentPodcastEpisode === 'function') {
          window.playAdjacentPodcastEpisode(1);
        }
      });
    }
  },

  init() {
    if (!('mediaSession' in navigator)) return;

    this.configureMode('radio');

    // Sincronizzazione automatica degli stati playback con gli elementi <audio> di sistema
    const rAudio = document.getElementById('rc-audio');
    if (rAudio) {
      rAudio.addEventListener('playing', () => {
        if (this.activeType === 'radio') navigator.mediaSession.playbackState = 'playing';
      });
      rAudio.addEventListener('pause', () => {
        if (this.activeType === 'radio') navigator.mediaSession.playbackState = 'paused';
      });
    }

    const pAudio = document.getElementById('podcast-audio');
    if (pAudio) {
      pAudio.addEventListener('playing', () => {
        if (this.activeType === 'podcast') navigator.mediaSession.playbackState = 'playing';
      });
      pAudio.addEventListener('pause', () => {
        if (this.activeType === 'podcast') navigator.mediaSession.playbackState = 'paused';
      });
      pAudio.addEventListener('timeupdate', () => {
        if (this.activeType === 'podcast') this.updatePositionState(pAudio);
      });
    }
  },

  updateRadio({ title, artist, album, coverUrl }) {
    if (!('mediaSession' in navigator)) return;
    this.configureMode('radio');
    this.lastRadioData = { title, artist, album, coverUrl };

    const artworks = this.buildArtworks(coverUrl);

    // Titoli e metadati ottimizzati per Lock Screen, CarPlay e Dynamic Island
    const isStationDefault = !artist || artist.toLowerCase() === 'radio carducci' || artist.toLowerCase() === 'in diretta';
    const displayTitle = (title && title !== 'Radio Carducci') ? title : 'Radio Carducci';
    const displayArtist = isStationDefault ? 'La Web Radio del Liceo Carducci' : artist;
    const displayAlbum = album || (isStationDefault ? 'In Diretta Streaming · Roma' : 'Radio Carducci — In Diretta');

    navigator.mediaSession.metadata = new MediaMetadata({
      title: displayTitle,
      artist: displayArtist,
      album: displayAlbum,
      artwork: artworks
    });

    const rAudio = document.getElementById('rc-audio');
    navigator.mediaSession.playbackState = (rAudio && !rAudio.paused) ? 'playing' : 'paused';
  },

  updatePodcast({ episodeTitle, podcastName, hosts, coverUrl, audioEl }) {
    if (!('mediaSession' in navigator)) return;
    this.configureMode('podcast');

    const artworks = this.buildArtworks(coverUrl);
    const hostLabel = (hosts && hosts.length) ? `con ${hosts.join(', ')}` : 'Radio Carducci';

    navigator.mediaSession.metadata = new MediaMetadata({
      title: episodeTitle || podcastName,
      artist: `${podcastName} · ${hostLabel}`,
      album: `Podcast Radio Carducci`,
      artwork: artworks
    });

    navigator.mediaSession.playbackState = (audioEl && !audioEl.paused) ? 'playing' : 'paused';
    this.updatePositionState(audioEl);
  },

  updatePositionState(audioEl) {
    if (!('mediaSession' in navigator) || !('setPositionState' in navigator.mediaSession)) return;
    if (!audioEl || !audioEl.duration || isNaN(audioEl.duration) || !isFinite(audioEl.duration)) return;
    try {
      navigator.mediaSession.setPositionState({
        duration: audioEl.duration,
        playbackRate: audioEl.playbackRate || 1,
        position: Math.max(0, Math.min(audioEl.currentTime || 0, audioEl.duration))
      });
    } catch (e) {}
  }
};

function initPlayer() {
  RCMediaSession.init();
  RCMediaSession.updateRadio({ title: 'Radio Carducci', artist: 'La Web Radio del Liceo Carducci', album: 'Radio Carducci — In Diretta' });

  const audio = document.getElementById('rc-audio');
  const playBtn = document.querySelector('.player-bar__play');
  const heroPlayBtn = document.getElementById('hero-play-cta');
  const playerBar = document.querySelector('.player-bar');
  const volumeSlider = document.querySelector('.player-bar__volume');
  const playerWave = document.querySelector('.player-bar__wave');
  const playLabel = document.querySelector('.player-bar__title');
  const playMeta = document.querySelector('.player-bar__meta');
  const lobbyAudio = document.getElementById('lobby-audio');
  const exploreBtn = document.querySelector('.nav__explore');
  const mobileExploreBtn = document.querySelector('.nav-mobile__explore-btn');

  if (!audio || !playBtn) return;

  // Live: ogni pausa (pulsante, schermata di blocco, podcast, Wrapped…) scarta il buffer,
  // così al play successivo lo stream riparte dalla diretta e non da dove si era fermato.
  function dropLiveBuffer() {
    if (!audio.getAttribute('src')) return;
    audio.removeAttribute('src');
    audio.load();
  }
  audio.addEventListener('pause', () => {
    isPlaying = false;
    dropLiveBuffer();
    if (isExplorePlaying) return;
    setUIActive(false);
    if (playLabel) playLabel.textContent = "Radio Carducci · In Pausa";
  });

  const R2_AUDIO_BASE = 'https://pub-7bdb71d3a8a643899d66d0b611b8b049.r2.dev/audio';

  // Configure lobby audio with Cloudflare R2 URL and local fallback
  if (lobbyAudio) {
    const r2LobbySrc = `${R2_AUDIO_BASE}/lobby.mp3`;
    const localLobbySrc = 'lobby.mp3';
    lobbyAudio.src = localLobbySrc;

    // Check if Cloudflare R2 has the file uploaded
    fetch(r2LobbySrc, { method: 'HEAD' }).then(res => {
      if (res.ok) lobbyAudio.src = r2LobbySrc;
    }).catch(() => {});

    lobbyAudio.addEventListener('error', () => {
      if (lobbyAudio.src !== localLobbySrc && !lobbyAudio.src.endsWith('/lobby.mp3')) {
        lobbyAudio.src = localLobbySrc;
      }
    });
  }

  let isPlaying = false;
  let isExplorePlaying = false;

  function setUIActive(active) {
    isPlaying = active;
    if (active) {
      playBtn.classList.add('player-bar__play--playing');
      playBtn.setAttribute('aria-label', 'Pausa');
      if (heroPlayBtn) heroPlayBtn.classList.add('playing');
      playerBar?.classList.add('player-bar--active');
      if (playerWave) playerWave.classList.remove('wave--paused');
    } else {
      playBtn.classList.remove('player-bar__play--playing');
      playBtn.setAttribute('aria-label', 'Riproduci');
      if (heroPlayBtn) heroPlayBtn.classList.remove('playing');
      playerBar?.classList.remove('player-bar--active');
      if (playerWave) playerWave.classList.add('wave--paused');
    }
  }

  function setExploreUI(active) {
    isExplorePlaying = active;
    if (active) {
      exploreBtn?.classList.add('nav__explore--active');
      mobileExploreBtn?.classList.add('nav__explore--active');
      document.body.classList.add('theme-explore');
      if (typeof ExploreMode !== 'undefined') ExploreMode.start();
      setUIActive(true);
      if (playLabel) playLabel.textContent = "Esplorazione in corso...";
      if (playMeta) playMeta.textContent = "MODALITÀ ESPLORAZIONE · LOBBY AUDIO";
    } else {
      exploreBtn?.classList.remove('nav__explore--active');
      mobileExploreBtn?.classList.remove('nav__explore--active');
      document.body.classList.remove('theme-explore');
      if (typeof ExploreMode !== 'undefined') ExploreMode.stop();
      if (!isPlaying) {
        setUIActive(false);
        if (playLabel) playLabel.textContent = "Radio Carducci";
        if (playMeta) playMeta.textContent = "WEB RADIO · PREMI PLAY PER ASCOLTARE";
      }
    }
  }

  function toggleExplore() {
    if (isExplorePlaying) {
      if (lobbyAudio) lobbyAudio.pause();
      setExploreUI(false);
    } else {
      // Pause main live radio stream if playing
      if (isPlaying) {
        audio.pause();
        isPlaying = false;
      }
      if (lobbyAudio) {
        lobbyAudio.currentTime = 0;
        lobbyAudio.play().catch(err => console.warn('[Lobby] Play blocked:', err));
      }
      setExploreUI(true);
      document.body.classList.remove('nav-open');
    }
  }

  if (exploreBtn) {
    exploreBtn.addEventListener('click', (e) => {
      e.preventDefault();
      toggleExplore();
    });
  }

  if (mobileExploreBtn) {
    mobileExploreBtn.addEventListener('click', (e) => {
      e.preventDefault();
      toggleExplore();
    });
  }

  function togglePlay() {
    const currentStreamUrl = (APP_CONFIG && APP_CONFIG.meta && APP_CONFIG.meta.streamUrl) ? APP_CONFIG.meta.streamUrl : STREAM_URL;

    // If explore mode was playing, stop it cleanly
    if (isExplorePlaying) {
      if (lobbyAudio) lobbyAudio.pause();
      setExploreUI(false);
    }

    if (isPlaying) {
      audio.pause();
      dropLiveBuffer();
      setUIActive(false);
      if (playLabel) playLabel.textContent = "Radio Carducci · In Pausa";
    } else {
      // Sempre una connessione nuova: si parte dal punto live
      audio.src = currentStreamUrl;

      audio.onerror = () => {
        setUIActive(false);
        if (playLabel) playLabel.textContent = "STREAM OFFLINE";
      };

      document.querySelectorAll('audio').forEach(a => {
        if (a !== audio) {
          a.pause();
        }
      });

      audio.play().then(() => {
        setUIActive(true);
        if (playLabel) playLabel.textContent = "IN DIRETTA · Radio Carducci";
      }).catch(err => {
        console.warn('[Player] Stream offline or blocked:', err);
        setUIActive(false);
        if (playLabel) playLabel.textContent = "STREAM OFFLINE";
      });
    }
  }

  playBtn.addEventListener('click', (e) => {
    e.preventDefault();
    togglePlay();
  });

  if (heroPlayBtn) {
    heroPlayBtn.addEventListener('click', (e) => {
      e.preventDefault();
      togglePlay();
    });
  }

  if (volumeSlider) {
    const vol = parseFloat(volumeSlider.value);
    audio.volume = vol;
    if (lobbyAudio) lobbyAudio.volume = vol;
    volumeSlider.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      audio.volume = val;
      if (lobbyAudio) lobbyAudio.volume = val;
    });
  }

  audio.addEventListener('play', () => setUIActive(true));
  audio.addEventListener('pause', () => setUIActive(false));
  audio.addEventListener('ended', () => setUIActive(false));
  audio.addEventListener('error', () => {
    console.warn('[RC] Errore stream audio.');
    setUIActive(false);
    if (playLabel) playLabel.textContent = "STREAM OFFLINE";
  });
}

function initHeadline() {
  const el = document.querySelector('.hero__headline');
  if (!el) return;

  let current = 0;

  function setHeadline(index) {
    const lines = HEADLINES[index];
    el.innerHTML = lines.join('<br>');
  }

  setInterval(() => {

    el.classList.add('headline-exit');

    setTimeout(() => {
      current = (current + 1) % HEADLINES.length;
      setHeadline(current);
      el.classList.remove('headline-exit');
      el.classList.add('headline-enter');

      setTimeout(() => {
        el.classList.remove('headline-enter');
      }, 200);
    }, 200);
  }, 5000);
}

function initPalinsesto() {
  const tabsContainer = document.querySelector('.palinsesto__tabs');
  const gridContainer = document.querySelector('.palinsesto__grid');
  if (!tabsContainer || !gridContainer) return;

  tabsContainer.innerHTML = '';
  const today = new Date().getDay(); 
  const order = [1, 2, 3, 4, 5, 6, 0];

  order.forEach(dayIndex => {
    const btn = document.createElement('button');
    btn.className = 'palinsesto__tab';
    btn.role = 'tab';
    btn.id = `tab-${DAY_KEYS[dayIndex]}`;
    btn.setAttribute('aria-controls', 'palinsesto-panel');
    btn.textContent = DAY_LABELS[dayIndex];
    btn.dataset.day = DAY_KEYS[dayIndex];

    if (dayIndex === today) {
      btn.classList.add('palinsesto__tab--active');
      btn.setAttribute('aria-selected', 'true');
      gridContainer.setAttribute('aria-labelledby', btn.id);
    } else {
      btn.setAttribute('aria-selected', 'false');
    }

    btn.addEventListener('click', () => {
      tabsContainer.querySelectorAll('.palinsesto__tab').forEach(t => {
        t.classList.remove('palinsesto__tab--active');
        t.setAttribute('aria-selected', 'false');
      });
      btn.classList.add('palinsesto__tab--active');
      btn.setAttribute('aria-selected', 'true');
      gridContainer.setAttribute('aria-labelledby', btn.id);
      renderDay(btn.dataset.day);
    });

    tabsContainer.appendChild(btn);
  });

  const activeTab = tabsContainer.querySelector('.palinsesto__tab--active');
  renderDay(activeTab ? activeTab.dataset.day : DAY_KEYS[today]);

  function applySpeakerHighlight(speakerName) {
    let speakerBar = document.getElementById('palinsesto-speaker-bar');
    if (speakerName) {
      if (!speakerBar) {
        speakerBar = document.createElement('div');
        speakerBar.id = 'palinsesto-speaker-bar';
        speakerBar.className = 'palinsesto__speaker-bar';
        gridContainer.parentNode.insertBefore(speakerBar, gridContainer);
      }
      speakerBar.style.display = 'flex';
      speakerBar.innerHTML = `
        <div class="palinsesto__speaker-bar-text">
          <span>CONDUTTORE SELEZIONATO: <strong>${speakerName}</strong></span>
        </div>
        <div class="palinsesto__speaker-bar-actions">
          <button type="button" class="btn btn-sm btn-red" id="speaker-bar-calendar-btn">📅 Aggiungi al Calendario</button>
          <button type="button" class="btn btn-sm" id="speaker-bar-clear-btn" style="background:#262626; color:#eaeaea;">✕ Rimuovi filtro</button>
        </div>
      `;
      speakerBar.querySelector('#speaker-bar-calendar-btn')?.addEventListener('click', () => openSpeakerCalendarModal(speakerName));
      speakerBar.querySelector('#speaker-bar-clear-btn')?.addEventListener('click', () => {
        localStorage.removeItem('rc_selected_speaker');
        applySpeakerHighlight(null);
      });
    } else if (speakerBar) {
      speakerBar.style.display = 'none';
    }

    const sLower = speakerName ? speakerName.toLowerCase() : null;

    gridContainer.querySelectorAll('.palinsesto__slot').forEach(slot => {
      const tags = slot.querySelectorAll('.palinsesto__conductor-tag');
      let matches = false;
      tags.forEach(tag => {
        const tagName = tag.getAttribute('data-name');
        if (sLower && tagName && tagName.toLowerCase() === sLower) {
          matches = true;
          tag.classList.add('active');
        } else {
          tag.classList.remove('active');
        }
      });

      if (!sLower) {
        slot.classList.remove('palinsesto__slot--speaker-highlight', 'palinsesto__slot--speaker-dimmed');
      } else if (matches) {
        slot.classList.add('palinsesto__slot--speaker-highlight');
        slot.classList.remove('palinsesto__slot--speaker-dimmed');
      } else {
        slot.classList.remove('palinsesto__slot--speaker-highlight');
        slot.classList.add('palinsesto__slot--speaker-dimmed');
      }
    });

    // Highlight in team grid
    document.querySelectorAll('.team-member').forEach(card => {
      card.classList.toggle('team-member--highlighted', !!sLower && (card.dataset.name || '').toLowerCase() === sLower);
    });
  }
  window.applySpeakerHighlight = applySpeakerHighlight;

  function renderDay(dayKey) {
    const shows = SCHEDULE[dayKey] || [];
    gridContainer.innerHTML = '';

    if (shows.length === 0) {
      gridContainer.innerHTML = '<div class="palinsesto__empty">Solo musica. 24 ore di Radio Carducci.</div>';
      return;
    }

    const now = new Date();
    const currentDayKey = DAY_KEYS[now.getDay()];
    const currentMinutes = now.getHours() * 60 + now.getMinutes();

    shows.forEach((show, index) => {
      const slot = document.createElement('div');
      slot.className = 'palinsesto__slot slot-hidden';

      let isLive = false;

      if (dayKey === currentDayKey && show.start && show.end) {
        const [startH, startM] = show.start.split(':').map(Number);
        const [endH, endM] = show.end.split(':').map(Number);
        const startMin = startH * 60 + startM;
        const endMin = endH * 60 + endM;

        if (currentMinutes >= startMin && currentMinutes < endMin) {
          slot.classList.add('palinsesto__slot--live');
          isLive = true;
        }
      }

      const hostNames = getHostsForSlug(show.slug);

      let hostsHtml = '';
      if (hostNames && hostNames.length) {
        hostsHtml = `
          <div class="palinsesto__conductors" role="group" aria-label="Conduttori del programma">
            ${hostNames.map((host, i) => `
              <span class="palinsesto__conductor-tag balloon-anim-${(i % 3) + 1}" style="--float-delay: ${(i * 0.45).toFixed(2)}s;" data-name="${host}" tabindex="0" role="button" aria-label="Conduttore: ${host}">
                <span class="palinsesto__conductor-text">${host}</span>
              </span>
            `).join('')}
          </div>
        `;
      }

      const thumbHtml = show.img
        ? `<div class="palinsesto__thumb"><img src="${escapeHtml(show.img)}" alt="" loading="lazy" onerror="this.parentNode.remove()"></div>`
        : '';

      slot.innerHTML = `
        <div class="palinsesto__time">${show.time}</div>
        ${thumbHtml}
        <div class="palinsesto__info">
          <div class="palinsesto__name">
            ${show.name}
            ${isLive ? '<span class="palinsesto__live-badge">IN ONDA ORA</span>' : ''}
          </div>
          ${show.desc ? `<div class="palinsesto__desc">${show.desc}</div>` : ''}
          <div class="palinsesto__sub">${escapeHtml(hostNames.length ? hostNames.slice(0, 2).join(', ') + (hostNames.length > 2 ? ` +${hostNames.length - 2}` : '') : (/^0?0:00\s*[–-]\s*23:59$/.test(show.time || '') ? 'Tutto il giorno' : (show.time || '')))}</div>
        </div>
        <span class="palinsesto__chev" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg></span>
        <div class="palinsesto__slot-actions">
          ${hostsHtml}
          <button type="button" class="palinsesto__cal-btn" aria-label="Aggiungi ${escapeHtml(show.name)} al calendario" title="Aggiungi al calendario">
            <i data-lucide="calendar-plus" width="14" height="14"></i>
            <span>Calendario</span>
          </button>
        </div>
      `;

      // Click on speaker balloon
      slot.querySelectorAll('.palinsesto__conductor-tag').forEach(tag => {
        tag.addEventListener('click', (e) => {
          e.stopPropagation();
          const name = tag.getAttribute('data-name');
          const current = localStorage.getItem('rc_selected_speaker');
          if (current && current.toLowerCase() === name.toLowerCase()) {
            localStorage.removeItem('rc_selected_speaker');
            applySpeakerHighlight(null);
          } else {
            localStorage.setItem('rc_selected_speaker', name);
            applySpeakerHighlight(name);
            openSpeakerCalendarModal(name);
          }
        });
      });

      // Pulsante Calendario: salva l'evento (come prima)
      const calBtn = slot.querySelector('.palinsesto__cal-btn');
      if (calBtn) {
        calBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          openEventCalendarModal(show, dayKey);
        });
      }

      // Click sul programma: scheda con descrizione, conduttori e podcast
      slot.addEventListener('click', (e) => {
        if (e.target.closest('.palinsesto__conductor-tag')) return;
        openProgramModal(show, dayKey);
      });

      gridContainer.appendChild(slot);

      setTimeout(() => {
        slot.classList.add('slot-visible');
        slot.classList.remove('slot-hidden');
      }, index * 45);
    });

    // Reapply persistent speaker highlight if selected
    const savedSpeaker = localStorage.getItem('rc_selected_speaker');
    if (savedSpeaker) {
      applySpeakerHighlight(savedSpeaker);
    }
  }
}

function openCalendarModal(config) {
  const modal = document.getElementById('speaker-calendar-modal');
  if (!modal) return;

  const titleEl = document.getElementById('calendar-modal-speaker-name');
  const descEl = document.getElementById('calendar-modal-desc');
  const showsListEl = document.getElementById('calendar-modal-shows-list');
  const googleBtn = document.getElementById('calendar-google-btn');
  const appleBtn = document.getElementById('calendar-apple-btn');
  const icsBtn = document.getElementById('calendar-ics-btn');
  const closeBtn = document.getElementById('calendar-modal-close');

  const title = config.title || 'Calendario Radio Carducci';
  const subtitle = config.subtitle || 'Vuoi aggiungere gli appuntamenti al tuo calendario personale per non perderti le prossime dirette?';
  const shows = config.shows && config.shows.length ? config.shows : [{ name: 'Radio Carducci', day: 'Lunedi', time: '16:00–17:00' }];
  const speakerName = config.speakerName || null;

  if (titleEl) titleEl.textContent = title;
  if (descEl) descEl.textContent = subtitle;

  if (showsListEl) {
    showsListEl.innerHTML = shows.map(sh => `
      <div class="calendar-modal__show-item">
        <span class="calendar-modal__show-name">${escapeHtml(sh.name)}</span>
        <span class="calendar-modal__show-time">${escapeHtml(sh.day)} · ${escapeHtml(sh.time)}</span>
      </div>
    `).join('');
  }

  // 1. Google Calendar URL
  if (googleBtn) {
    const mainShow = shows[0];
    const eventTitle = speakerName ? `${mainShow.name} con ${speakerName} — Radio Carducci` : `${mainShow.name} — Radio Carducci`;
    const gCalUrl = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(eventTitle)}&details=${encodeURIComponent('Segui la diretta su Radio Carducci: https://radiocarducci.com')}&location=${encodeURIComponent('Radio Carducci — radiocarducci.com')}`;
    googleBtn.href = gCalUrl;
  }

  // 2. ICS builder for standard .ics & fallback
  const buildIcs = () => {
    let icsEvents = '';
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const dtstamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth()+1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}00Z`;

    const dayToByDay = {
      'lunedi': 'MO', 'lunedì': 'MO', 'lun': 'MO',
      'martedi': 'TU', 'martedì': 'TU', 'mar': 'TU',
      'mercoledi': 'WE', 'mercoledì': 'WE', 'mer': 'WE',
      'giovedi': 'TH', 'giovedì': 'TH', 'gio': 'TH',
      'venerdi': 'FR', 'venerdì': 'FR', 'ven': 'FR',
      'sabato': 'SA', 'sab': 'SA',
      'domenica': 'SU', 'dom': 'SU'
    };
    const targetDayMap = { 'SU': 0, 'MO': 1, 'TU': 2, 'WE': 3, 'TH': 4, 'FR': 5, 'SA': 6 };

    shows.forEach((sh, idx) => {
      const uid = `rc-${Date.now()}-${idx}@radiocarducci.com`;
      const shDay = (sh.day || 'lunedi').toLowerCase();
      const byDay = dayToByDay[shDay] || 'MO';

      let startHour = 16, startMin = 0, endHour = 17, endMin = 0;
      if (sh.time && sh.time.includes('–')) {
        const parts = sh.time.split('–');
        const sParts = (parts[0] || '').trim().split(':');
        const eParts = (parts[1] || '').trim().split(':');
        if (sParts[0]) startHour = parseInt(sParts[0], 10) || 16;
        if (sParts[1]) startMin = parseInt(sParts[1], 10) || 0;
        if (eParts[0]) endHour = parseInt(eParts[0], 10) || (startHour + 1);
        if (eParts[1]) endMin = parseInt(eParts[1], 10) || 0;
      } else if (sh.time && sh.time.includes('-')) {
        const parts = sh.time.split('-');
        const sParts = (parts[0] || '').trim().split(':');
        const eParts = (parts[1] || '').trim().split(':');
        if (sParts[0]) startHour = parseInt(sParts[0], 10) || 16;
        if (sParts[1]) startMin = parseInt(sParts[1], 10) || 0;
        if (eParts[0]) endHour = parseInt(eParts[0], 10) || (startHour + 1);
        if (eParts[1]) endMin = parseInt(eParts[1], 10) || 0;
      }

      const targetDayIdx = targetDayMap[byDay] ?? 1;
      const eventDate = new Date();
      const currentDayIdx = eventDate.getDay();
      let diffDays = (targetDayIdx - currentDayIdx + 7) % 7;
      if (diffDays === 0) diffDays = 7;
      eventDate.setDate(eventDate.getDate() + diffDays);

      const dStr = `${eventDate.getFullYear()}${pad(eventDate.getMonth()+1)}${pad(eventDate.getDate())}`;
      const dtStart = `${dStr}T${pad(startHour)}${pad(startMin)}00`;
      const dtEnd = `${dStr}T${pad(endHour)}${pad(endMin)}00`;

      const summary = sh.name + (speakerName && !sh.name.includes(speakerName) ? ` con ${speakerName}` : '') + ' — Radio Carducci';
      const eventDesc = (sh.desc || 'Ascolta in diretta streaming su https://radiocarducci.com').replace(/\r?\n/g, '\\n');

      icsEvents += `BEGIN:VEVENT\r\nUID:${uid}\r\nDTSTAMP:${dtstamp}\r\nDTSTART;TZID=Europe/Rome:${dtStart}\r\nDTEND;TZID=Europe/Rome:${dtEnd}\r\nSUMMARY:${summary}\r\nDESCRIPTION:${eventDesc}\r\nLOCATION:Radio Carducci (Roma)\r\nRRULE:FREQ=WEEKLY;BYDAY=${byDay}\r\nSTATUS:CONFIRMED\r\nEND:VEVENT\r\n`;
    });

    return `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Radio Carducci//Web Radio//IT\r\nCALSCALE:GREGORIAN\r\nMETHOD:PUBLISH\r\nX-WR-CALNAME:Radio Carducci\r\nX-WR-TIMEZONE:Europe/Rome\r\n${icsEvents}END:VCALENDAR`;
  };

  const ics = buildIcs();
  const rawFileName = (speakerName || shows[0]?.name || 'RadioCarducci').replace(/\s+/g, '_');
  const filename = `RadioCarducci_${rawFileName}.ics`;
  const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
  const blobUrl = URL.createObjectURL(blob);

  // 3. Apple Calendar Button
  if (appleBtn) {
    appleBtn.href = blobUrl;
    appleBtn.setAttribute('download', filename);
    appleBtn.target = '_self';
  }

  // 4. Scarica promemoria (.ics) Button
  if (icsBtn) {
    icsBtn.href = blobUrl;
    icsBtn.setAttribute('download', filename);
  }

  modal.classList.add('active');
  modal.setAttribute('aria-hidden', 'false');

  const close = () => {
    modal.classList.remove('active');
    modal.setAttribute('aria-hidden', 'true');
  };

  if (closeBtn) closeBtn.onclick = close;
  modal.onclick = e => { if (e.target === modal) close(); };
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function openSpeakerCalendarModal(speakerName) {
  const sLower = speakerName.toLowerCase();
  const shows = [];
  DAY_KEYS.forEach(dk => {
    const dayShows = SCHEDULE[dk] || [];
    dayShows.forEach(s => {
      const hosts = getHostsForSlug(s.slug);
      if (hosts.some(h => h.toLowerCase() === sLower)) {
        shows.push({
          name: s.name,
          day: dk.charAt(0).toUpperCase() + dk.slice(1),
          time: s.time || 'H24',
          start: s.start,
          end: s.end,
          desc: s.desc
        });
      }
    });
  });

  openCalendarModal({
    title: `Segui ${speakerName} su Radio Carducci`,
    subtitle: `Vuoi aggiungere gli appuntamenti di questo speaker al tuo calendario personale per non perderti le prossime dirette?`,
    shows: shows.length ? shows : [{ name: `Programmi con ${speakerName}`, day: 'Palinsesto Radio Carducci', time: 'Radio Carducci' }],
    speakerName: speakerName
  });
}
window.openSpeakerCalendarModal = openSpeakerCalendarModal;

function openEventCalendarModal(show, dayKey) {
  const dayIndex = DAY_KEYS.indexOf(dayKey);
  const dayLabel = dayIndex !== -1 ? DAY_LABELS[dayIndex] : (dayKey ? dayKey.charAt(0).toUpperCase() + dayKey.slice(1) : 'Palinsesto');

  openCalendarModal({
    title: `Aggiungi ${show.name} al Calendario`,
    subtitle: `Vuoi aggiungere ${show.name} al tuo calendario per non perderti la diretta ogni ${dayLabel}?`,
    shows: [{
      name: show.name,
      day: dayKey,
      time: show.time || 'H24',
      start: show.start,
      end: show.end,
      desc: show.desc
    }],
    speakerName: null
  });
}
window.openEventCalendarModal = openEventCalendarModal;

// Scheda programma: immagine, orari, descrizione, conduttori, podcast e calendario
function openProgramModal(show, dayKey) {
  const modal = document.getElementById('program-modal');
  if (!modal) { openEventCalendarModal(show, dayKey); return; }

  const $ = id => document.getElementById(id);
  const hosts = getHostsForSlug(show.slug);
  const podcast = show.slug ? PODCASTS.find(p => p.slug === show.slug) : null;

  // Tutti i giorni in cui va in onda
  const DAY_NAMES = { lunedi: 'Lunedì', martedi: 'Martedì', mercoledi: 'Mercoledì', giovedi: 'Giovedì', venerdi: 'Venerdì', sabato: 'Sabato', domenica: 'Domenica' };
  const slots = [];
  ['lunedi', 'martedi', 'mercoledi', 'giovedi', 'venerdi', 'sabato', 'domenica'].forEach(dk => {
    (SCHEDULE[dk] || []).forEach(s => {
      if ((show.slug && s.slug === show.slug) || (!show.slug && s.name === show.name)) {
        slots.push({ day: DAY_NAMES[dk], time: s.time || 'H24' });
      }
    });
  });

  const imgWrap = $('program-modal-img');
  if (imgWrap) {
    imgWrap.innerHTML = show.img ? `<img src="${escapeHtml(show.img)}" alt="" onerror="this.parentNode.style.display='none'">` : '';
    imgWrap.style.display = show.img ? '' : 'none';
  }
  $('program-modal-title').textContent = show.name;

  const desc = $('program-modal-desc');
  desc.textContent = show.desc || '';
  desc.style.display = show.desc ? '' : 'none';

  $('program-modal-slots').innerHTML = (slots.length ? slots : [{ day: DAY_NAMES[dayKey] || '', time: show.time || '' }]).map(sl => `
    <div class="calendar-modal__show-item">
      <span class="calendar-modal__show-name">${escapeHtml(sl.day)}</span>
      <span class="calendar-modal__show-time">${escapeHtml(sl.time)}</span>
    </div>`).join('');

  const hostsWrap = $('program-modal-hosts');
  if (hosts.length) {
    hostsWrap.style.display = '';
    hostsWrap.querySelector('.program-modal__hosts-list').innerHTML = hosts.map(h =>
      `<button type="button" class="program-modal__host" data-name="${escapeHtml(h)}">${escapeHtml(h)}</button>`).join('');
    hostsWrap.querySelectorAll('.program-modal__host').forEach(btn => {
      btn.onclick = () => {
        close();
        const name = btn.getAttribute('data-name');
        const member = TEAM.find(m => m.name === name);
        if (member) openMemberModal(member);
      };
    });
  } else {
    hostsWrap.style.display = 'none';
  }

  const podBtn = $('program-modal-podcast-btn');
  if (podcast) {
    podBtn.style.display = '';
    podBtn.onclick = () => { close(); openPodcastModal(podcast); };
  } else {
    podBtn.style.display = 'none';
  }

  $('program-modal-cal-btn').onclick = () => { close(); openEventCalendarModal(show, dayKey); };

  function close() {
    modal.classList.remove('active');
    modal.setAttribute('aria-hidden', 'true');
    document.removeEventListener('keydown', onKey);
  }
  function onKey(e) { if (e.key === 'Escape') close(); }

  $('program-modal-close').onclick = close;
  modal.onclick = e => { if (e.target === modal) close(); };
  document.addEventListener('keydown', onKey);

  modal.classList.add('active');
  modal.setAttribute('aria-hidden', 'false');
  if (typeof lucide !== 'undefined') lucide.createIcons();
}
window.openProgramModal = openProgramModal;


function formatPodcastDate(dateStr) {
  if (!dateStr) return '';
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    const months = ['Gen', 'Feb', 'Mar', 'Apr', 'Mag', 'Giu', 'Lug', 'Ago', 'Set', 'Ott', 'Nov', 'Dic'];
    return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
  } catch (e) {
    return dateStr;
  }
}

function formatPodcastTime(seconds) {
  if (!seconds || isNaN(seconds)) return '00:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins < 10 ? '0' : ''}${mins}:${secs < 10 ? '0' : ''}${secs}`;
}

let currentPodcastEpisode = null;
let currentPodcastSpeed = 1;

async function openPodcastModal(podcast) {
  const modal = document.getElementById('podcast-modal');
  if (!modal) return;

  const pmTitle = document.getElementById('pm-title');
  const pmCover = document.getElementById('pm-cover');
  const pmHosts = document.getElementById('pm-hosts');
  const pmDesc = document.getElementById('pm-desc');
  const pmCount = document.getElementById('pm-count');
  const pmList = document.getElementById('pm-episodes-list');
  const pmBadge = document.getElementById('pm-badge');
  const audio = document.getElementById('podcast-audio');
  const playBtn = document.getElementById('pm-play-btn');
  const scrubber = document.getElementById('pm-scrubber');
  const timeCur = document.getElementById('pm-time-cur');
  const timeDur = document.getElementById('pm-time-dur');
  const speedBtn = document.getElementById('pm-speed-btn');
  const currentTitleEl = document.getElementById('pm-current-title');

  if (pmTitle) pmTitle.textContent = podcast.name;
  if (pmCover) {
    pmCover.src = podcast.img || 'assets/logo-rc-mark-bone.svg';
    pmCover.alt = podcast.name;
  }
  const hosts = getHostsForSlug(podcast.slug);
  if (pmHosts) {
    pmHosts.textContent = (hosts && hosts.length) ? `Condotto da: ${hosts.join(', ')}` : 'Redazione Radio Carducci';
  }
  if (pmDesc) {
    if (podcast.desc && podcast.desc.trim()) {
      pmDesc.textContent = podcast.desc.trim();
      pmDesc.style.display = 'block';
    } else {
      pmDesc.textContent = '';
      pmDesc.style.display = 'none';
    }
  }
  if (pmBadge) {
    pmBadge.textContent = 'ARCHIVIO PUNTATE';
  }
  if (pmCount) {
    pmCount.textContent = 'Caricamento puntate...';
  }
  if (pmList) {
    pmList.innerHTML = '<div class="podcast-modal__loading">Recupero archivio puntate in corso...</div>';
  }

  modal.classList.add('active');
  modal.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  if (typeof lucide !== 'undefined') lucide.createIcons();

  const closeModal = () => {
    modal.classList.remove('active');
    modal.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
  };

  const closeBtn = document.getElementById('podcast-modal-close');
  const backdrop = document.getElementById('podcast-modal-backdrop');
  if (closeBtn) closeBtn.onclick = closeModal;
  if (backdrop) backdrop.onclick = closeModal;

  let episodes = [];
  const feedUrl = podcast.feed || (podcast.url && podcast.url.endsWith('.xml') ? podcast.url : null);

  if (feedUrl) {
    try {
      const res = await fetch(feedUrl);
      if (res.ok) {
        const text = await res.text();
        const parser = new DOMParser();
        const xml = parser.parseFromString(text, 'application/xml');
        const items = Array.from(xml.querySelectorAll('item'));

        episodes = items.map(item => {
          const title = item.querySelector('title')?.textContent?.trim() || 'Puntata senza titolo';
          const enclosure = item.querySelector('enclosure');
          const audioUrl = enclosure ? enclosure.getAttribute('url') : '';
          const pubDate = item.querySelector('pubDate')?.textContent?.trim() || '';
          const subtitle = item.querySelector('subtitle, itunes\\:subtitle')?.textContent?.trim() || '';
          const desc = item.querySelector('description')?.textContent?.trim() || '';
          const epNum = item.querySelector('episode, itunes\\:episode')?.textContent?.trim() || '';
          const duration = item.querySelector('duration, itunes\\:duration')?.textContent?.trim() || '';
          return { title, audioUrl, pubDate, subtitle, desc, epNum, duration };
        });
      }
    } catch (e) {
      console.warn('[Podcasts] Errore caricamento feed XML:', e);
    }
  }


  if (pmCount) {
    pmCount.textContent = `${episodes.length} puntat${episodes.length === 1 ? 'a disponibile' : 'e disponibili'}`;
  }

  const renderEpisodesList = () => {
    if (!pmList) return;
    pmList.innerHTML = episodes.map((ep, idx) => {
      const isActive = currentPodcastEpisode === ep.audioUrl;
      const dateLabel = formatPodcastDate(ep.pubDate);
      return `
        <div class="podcast-modal__ep-item ${isActive ? 'active' : ''}" data-index="${idx}">
          <div class="podcast-modal__ep-info">
            <div class="podcast-modal__ep-title">${escapeHtml(ep.title)}</div>
            ${ep.subtitle ? `<div class="podcast-modal__ep-sub">${escapeHtml(ep.subtitle)}</div>` : ''}
            <div class="podcast-modal__ep-date">${dateLabel ? `Data: ${dateLabel}` : 'Archivio RC'} ${ep.duration ? `· Durata: ${ep.duration}` : ''}</div>
          </div>
          <button class="podcast-modal__ep-play-btn" data-index="${idx}" aria-label="Ascolta ${escapeHtml(ep.title)}">
            <i data-lucide="${isActive && audio && !audio.paused ? 'pause' : 'play'}" width="14" height="14"></i>
            <span>${isActive && audio && !audio.paused ? 'Pausa' : 'Ascolta'}</span>
          </button>
        </div>
      `;
    }).join('');

    if (typeof lucide !== 'undefined') lucide.createIcons();

    pmList.querySelectorAll('.podcast-modal__ep-item').forEach(itemEl => {
      itemEl.addEventListener('click', (e) => {
        const idx = parseInt(itemEl.dataset.index, 10);
        playEpisode(episodes[idx]);
      });
    });
  };

  const playEpisode = (ep) => {
    if (!ep || !ep.audioUrl) return;

    if (currentPodcastEpisode === ep.audioUrl && audio.src && audio.src.includes(ep.audioUrl)) {
      if (audio.paused) {
        audio.play();
        if (playBtn) playBtn.innerHTML = '<i data-lucide="pause" width="22" height="22"></i>';
      } else {
        audio.pause();
        if (playBtn) playBtn.innerHTML = '<i data-lucide="play" width="22" height="22"></i>';
      }
      if (typeof lucide !== 'undefined') lucide.createIcons();
      renderEpisodesList();
      return;
    }

    const rcAudio = document.getElementById('rc-audio');
    if (rcAudio && !rcAudio.paused) {
      rcAudio.pause();
      const mainPlayBtn = document.querySelector('.player-bar__play');
      if (mainPlayBtn) {
        mainPlayBtn.classList.remove('player-bar__play--playing');
        mainPlayBtn.setAttribute('aria-label', 'Riproduci');
      }
    }

    currentPodcastEpisode = ep.audioUrl;
    if (currentTitleEl) currentTitleEl.textContent = ep.title;
    audio.src = ep.audioUrl;
    audio.playbackRate = currentPodcastSpeed;
    audio.play().then(() => {
      if (playBtn) playBtn.innerHTML = '<i data-lucide="pause" width="22" height="22"></i>';
      if (typeof lucide !== 'undefined') lucide.createIcons();
      if (typeof RCMediaSession !== 'undefined') {
        RCMediaSession.updatePodcast({
          episodeTitle: ep.title,
          podcastName: podcast.name,
          hosts: getHostsForSlug(podcast.slug),
          coverUrl: podcast.img || '',
          audioEl: audio
        });
      }
    }).catch(err => console.warn('[Podcast Player] Play prevented:', err));

    renderEpisodesList();
  };

  window.playAdjacentPodcastEpisode = (direction) => {
    if (!episodes || !episodes.length) return;
    const currentIdx = episodes.findIndex(e => e.audioUrl === currentPodcastEpisode);
    const nextIdx = currentIdx + direction;
    if (nextIdx >= 0 && nextIdx < episodes.length) {
      playEpisode(episodes[nextIdx]);
    }
  };

  if (playBtn) {
    playBtn.onclick = () => {
      if (!audio.src) {
        if (episodes[0]) playEpisode(episodes[0]);
        return;
      }
      if (audio.paused) {
        audio.play();
        playBtn.innerHTML = '<i data-lucide="pause" width="22" height="22"></i>';
      } else {
        audio.pause();
        playBtn.innerHTML = '<i data-lucide="play" width="22" height="22"></i>';
      }
      if (typeof lucide !== 'undefined') lucide.createIcons();
      renderEpisodesList();
    };
  }

  if (audio) {
    audio.ontimeupdate = () => {
      if (!audio.duration || isNaN(audio.duration)) return;
      const pct = (audio.currentTime / audio.duration) * 100;
      if (scrubber) scrubber.value = pct;
      if (timeCur) timeCur.textContent = formatPodcastTime(audio.currentTime);
      if (timeDur) timeDur.textContent = formatPodcastTime(audio.duration);
      if (typeof RCMediaSession !== 'undefined') {
        RCMediaSession.updatePositionState(audio);
      }
    };

    audio.onloadedmetadata = () => {
      if (timeDur) timeDur.textContent = formatPodcastTime(audio.duration);
      if (typeof RCMediaSession !== 'undefined') {
        RCMediaSession.updatePositionState(audio);
      }
    };

    audio.onended = () => {
      if (playBtn) playBtn.innerHTML = '<i data-lucide="play" width="22" height="22"></i>';
      if (typeof lucide !== 'undefined') lucide.createIcons();
      renderEpisodesList();
      if (window.playAdjacentPodcastEpisode) {
        window.playAdjacentPodcastEpisode(1);
      }
    };
  }

  if (scrubber) {
    scrubber.oninput = () => {
      if (!audio.duration || isNaN(audio.duration)) return;
      audio.currentTime = (scrubber.value / 100) * audio.duration;
    };
  }

  if (speedBtn) {
    speedBtn.onclick = () => {
      const speeds = [1, 1.25, 1.5, 2];
      const curIdx = speeds.indexOf(currentPodcastSpeed);
      currentPodcastSpeed = speeds[(curIdx + 1) % speeds.length];
      speedBtn.textContent = currentPodcastSpeed + 'x';
      if (audio) audio.playbackRate = currentPodcastSpeed;
    };
  }

  renderEpisodesList();

  if (!currentPodcastEpisode && episodes[0]) {
    if (currentTitleEl) currentTitleEl.textContent = episodes[0].title;
    audio.src = episodes[0].audioUrl;
  }
}
window.openPodcastModal = openPodcastModal;

function initPodcasts() {
  const section = document.getElementById('podcast');
  if (!section) return;

  const grid = section.querySelector('.podcasts__grid');
  if (!grid) return;

  if (!section.querySelector('.podcasts-hint')) {
    const hint = document.createElement('div');
    hint.className = 'podcasts-hint';
    hint.innerHTML = '// Clicca su un podcast per ascoltare le puntate e l\'archivio';
    hint.style.fontFamily = 'var(--font-mono)';
    hint.style.fontSize = '10px';
    hint.style.color = 'var(--fg3)';
    hint.style.marginBottom = 'var(--s-4)';
    grid.parentNode.insertBefore(hint, grid);
  }

  grid.innerHTML = ''; 
  
  let tooltip = document.getElementById('podcast-tooltip');
  if (!tooltip) {
    tooltip = document.createElement('div');
    tooltip.id = 'podcast-tooltip';
    tooltip.className = 'podcast-tooltip';
    document.body.appendChild(tooltip);
  }

  PODCASTS.forEach((podcast, index) => {
    const card = document.createElement('div');
    card.className = 'podcast-card';
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');
    card.style.cursor = 'pointer';

    let imgHtml = '';
    if (podcast.img) {
      card.classList.add('podcast-card--has-img');
      const panDuration = 7 + ((index * 1.1) % 3);
      const panDelay = -((index * 2.3) % panDuration);
      imgHtml = `<div class="podcast-card__img-wrapper"><img src="${podcast.img}" alt="" class="podcast-card__img" loading="lazy" style="animation-duration: ${panDuration.toFixed(1)}s; animation-delay: ${panDelay.toFixed(1)}s;"></div>`;
    } else {
      card.classList.add('podcast-card--no-img');
      const driftDuration = 12 + ((index * 1.3) % 4);
      const driftDelay = -((index * 2.1) % driftDuration);
      imgHtml = `<div class="podcast-card__wireframe"><span style="animation-duration: ${driftDuration.toFixed(1)}s; animation-delay: ${driftDelay.toFixed(1)}s;">// il nostro fotografo è in ferie</span></div>`;
    }

    let displayDesc = (podcast.desc && podcast.desc.trim()) ? podcast.desc.trim() : '';
    let displayEpisodes = podcast.episodes ? `${podcast.episodes} episod${podcast.episodes === 1 ? 'io' : 'i'}` : '';
    let badgeHtml = '';

    card.innerHTML = `
      ${badgeHtml}
      ${imgHtml}
      <div class="podcast-card__icon"><i data-lucide="${podcast.icon}" width="28" height="28"></i></div>
      <div class="podcast-card__name">${podcast.name}</div>
      ${displayDesc ? `<div class="podcast-card__desc" style="font-size: var(--fs-caption); color: var(--fg2); margin-top: var(--s-1); margin-bottom: var(--s-2); line-height: 1.3;">${displayDesc}</div>` : ''}
      ${displayEpisodes ? `<div class="podcast-card__count">${displayEpisodes}</div>` : ''}
      <div class="podcast-card__arrow"><i data-lucide="play" width="18" height="18"></i></div>
    `;

    // Tooltip solo su hover desktop
    const hosts = getHostsForSlug(podcast.slug);
    if (hosts && hosts.length > 0) {
      card.addEventListener('mouseenter', (e) => {
        if (window.innerWidth <= 768) return;
        tooltip.innerHTML = `<div><strong>CONDOTTO DA:</strong><br>${hosts.join('<br>')}</div>`;
        tooltip.style.left = (e.pageX + 15) + 'px';
        tooltip.style.top = (e.pageY + 15) + 'px';
        tooltip.style.opacity = '1';
        tooltip.style.pointerEvents = 'none';
      });

      card.addEventListener('mouseleave', () => {
        if (window.innerWidth <= 768) return;
        tooltip.style.opacity = '0';
      });
    }

    // Click handler: apre SEMPRE il player ed archivio delle puntate
    card.addEventListener('click', (e) => {
      e.preventDefault();
      tooltip.style.opacity = '0';
      openPodcastModal(podcast);
    });

    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openPodcastModal(podcast);
      }
    });

    grid.appendChild(card);
  });
}

function getRoleBadgeStyle(role) {
  const r = (role || '').toLowerCase();
  if (r.includes('station manager')) {
    return { roleClass: 'station-manager', color: 'var(--rc-red)', bg: 'rgba(219, 56, 73, 0.14)', border: 'rgba(219, 56, 73, 0.5)' };
  } else if (r.includes('dirett') || r.includes('espert') || r.includes('artistic')) {
    return { roleClass: 'dirett', color: '#a855f7', bg: 'rgba(168, 85, 247, 0.14)', border: 'rgba(168, 85, 247, 0.5)' };
  } else if (r.includes('produzione')) {
    return { roleClass: 'produzione', color: '#f97316', bg: 'rgba(249, 115, 22, 0.14)', border: 'rgba(249, 115, 22, 0.5)' };
  } else if (r.includes('caporedatt') || r.includes('redatt') || r.includes('accrediti') || r.includes('musicale')) {
    return { roleClass: 'redazione', color: '#06b6d4', bg: 'rgba(6, 182, 212, 0.14)', border: 'rgba(6, 182, 212, 0.5)' };
  } else if (r.includes('tecnico') || r.includes('suono') || r.includes('regia')) {
    return { roleClass: 'tecnico', color: 'var(--rc-blue, #3b82f6)', bg: 'rgba(59, 130, 246, 0.14)', border: 'rgba(59, 130, 246, 0.5)' };
  } else if (r.includes('grafic') || r.includes('social')) {
    return { roleClass: 'social-grafica', color: '#ec4899', bg: 'rgba(236, 72, 153, 0.14)', border: 'rgba(236, 72, 153, 0.5)' };
  } else {
    return { roleClass: 'speaker', color: 'var(--rc-gold, #f59e0b)', bg: 'rgba(245, 158, 11, 0.14)', border: 'rgba(245, 158, 11, 0.5)' };
  }
}

const TEAM_CATEGORIES = [
  ['all', 'Tutti'], ['direzione', 'Direzione'], ['produzione', 'Produzione'], ['redazione', 'Redazione'],
  ['tecnico', 'Tecnico'], ['social', 'Social'], ['grafica', 'Grafica'], ['speaker', 'Speaker']
];
let teamFilter = 'all';

// Un colore per categoria (stessa tavolozza dei ruoli di prima)
const CATEGORY_COLORS = {
  all: 'var(--rc-bone)', direzione: '#a855f7', produzione: '#f97316', redazione: '#06b6d4',
  tecnico: '#3b82f6', social: '#ec4899', grafica: '#ec4899', speaker: '#f59e0b'
};

function memberInitials(name) {
  return String(name || 'RC').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase();
}

function initTeam() {
  const grid = document.querySelector('.team__grid');
  const section = document.getElementById('team');
  if (!grid || !section) return;

  // Filtri per categoria, con conteggio
  let filterBar = section.querySelector('.team-filters');
  if (!filterBar) {
    filterBar = document.createElement('div');
    filterBar.className = 'team-filters';
    filterBar.setAttribute('role', 'group');
    filterBar.setAttribute('aria-label', 'Filtra il team per ruolo');
    grid.parentNode.insertBefore(filterBar, grid);
  }
  const counts = {};
  TEAM_CATEGORIES.forEach(([k]) => {
    counts[k] = k === 'all' ? TEAM.length : TEAM.filter(m => (m.categories || []).includes(k)).length;
  });
  if (!counts[teamFilter]) teamFilter = 'all';
  filterBar.innerHTML = TEAM_CATEGORIES.filter(([k]) => counts[k] > 0).map(([k, label]) =>
    `<button type="button" class="team-filter${k === teamFilter ? ' active' : ''}" data-cat="${k}" aria-pressed="${k === teamFilter}" style="--c: ${CATEGORY_COLORS[k]}">${label} <span>${counts[k]}</span></button>`
  ).join('');
  filterBar.querySelectorAll('.team-filter').forEach(btn => {
    btn.addEventListener('click', () => {
      teamFilter = btn.dataset.cat;
      filterBar.querySelectorAll('.team-filter').forEach(b => {
        const on = b === btn;
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', on);
      });
      applyTeamFilter();
    });
  });

  grid.innerHTML = '';
  const currentSpeaker = (localStorage.getItem('rc_selected_speaker') || '').toLowerCase();

  TEAM.forEach((member, index) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'team-member stagger-in';
    card.dataset.categories = (member.categories || []).join(' ');
    card.dataset.name = member.name;
    card.style.setProperty('--c', getRoleBadgeStyle(member.role).color);
    card.setAttribute('aria-label', `${member.name}, ${member.role || 'Staff'}: apri la scheda`);
    if (currentSpeaker && member.name.toLowerCase() === currentSpeaker) card.classList.add('team-member--highlighted');

    const photo = member.img
      ? `<img src="${escapeHtml(member.img)}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'team-member__initials',textContent:'${memberInitials(member.name)}'}))">`
      : `<span class="team-member__initials">${memberInitials(member.name)}</span>`;

    card.innerHTML = `
      <span class="team-member__photo">${photo}</span>
      <span class="team-member__name">${escapeHtml(member.name)}</span>
      <span class="team-member__role">${escapeHtml(member.role || 'Staff')}</span>
    `;
    card.addEventListener('click', () => openMemberModal(member));
    grid.appendChild(card);
    setTimeout(() => card.classList.add('visible'), Math.min(index, 20) * 30);
  });

  applyTeamFilter();
}

function applyTeamFilter() {
  document.querySelectorAll('.team__grid .team-member').forEach(card => {
    const cats = (card.dataset.categories || '').split(' ');
    card.style.display = (teamFilter === 'all' || cats.includes(teamFilter)) ? '' : 'none';
  });
}

// Nome leggibile di un programma dal suo slug (palinsesto, podcast o slug stesso)
function findProgramBySlug(slug) {
  for (const dk of Object.keys(SCHEDULE)) {
    const s = (SCHEDULE[dk] || []).find(x => x.slug === slug);
    if (s) return { show: s, dayKey: dk };
  }
  return null;
}
function programLabel(slug) {
  const inSched = findProgramBySlug(slug);
  if (inSched) return inSched.show.name;
  const pod = PODCASTS.find(p => p.slug === slug);
  if (pod) return pod.name;
  return String(slug).split('-').map(w => w ? w[0].toUpperCase() + w.slice(1) : w).join(' ');
}

// Scheda membro: foto, ruolo, bio, programmi, categorie, palinsesto e calendario
function openMemberModal(member) {
  const modal = document.getElementById('member-modal');
  if (!modal || !member) return;
  const $ = id => document.getElementById(id);

  $('member-modal-photo').innerHTML = member.img
    ? `<img src="${escapeHtml(member.img)}" alt="" onerror="this.remove()">`
    : `<span>${memberInitials(member.name)}</span>`;
  $('member-modal-name').textContent = member.name;
  $('member-modal-role').textContent = (member.role || 'Staff').toUpperCase();
  modal.querySelector('.calendar-modal__content').style.setProperty('--c', getRoleBadgeStyle(member.role).color);

  const bio = $('member-modal-bio');
  bio.textContent = member.bio || '';
  bio.style.display = member.bio ? '' : 'none';

  const programs = member.programs || [];
  const showsWrap = $('member-modal-shows');
  showsWrap.style.display = programs.length ? '' : 'none';
  const list = showsWrap.querySelector('.program-modal__hosts-list');
  list.innerHTML = programs.map(slug => {
    const clickable = findProgramBySlug(slug) || PODCASTS.find(p => p.slug === slug);
    return clickable
      ? `<button type="button" class="program-modal__host" data-slug="${escapeHtml(slug)}">${escapeHtml(programLabel(slug))}</button>`
      : `<span class="program-modal__host program-modal__host--static">${escapeHtml(programLabel(slug))}</span>`;
  }).join('');
  list.querySelectorAll('button[data-slug]').forEach(btn => {
    btn.onclick = () => {
      const slug = btn.dataset.slug;
      close();
      const inSched = findProgramBySlug(slug);
      if (inSched) openProgramModal(inSched.show, inSched.dayKey);
      else { const pod = PODCASTS.find(p => p.slug === slug); if (pod) openPodcastModal(pod); }
    };
  });

  const label = Object.fromEntries(TEAM_CATEGORIES);
  $('member-modal-cats').innerHTML = (member.categories || []).map(c =>
    `<span class="member-modal__cat" style="--c: ${CATEGORY_COLORS[c] || 'var(--fg2)'}">${escapeHtml((label[c] || c).toUpperCase())}</span>`).join('');

  // Azioni di prima: evidenziare nel palinsesto e aggiungere al calendario
  const onAir = programs.some(slug => findProgramBySlug(slug));
  const actions = $('member-modal-actions');
  actions.style.display = onAir ? '' : 'none';
  $('member-modal-schedule-btn').onclick = () => {
    close();
    localStorage.setItem('rc_selected_speaker', member.name);
    if (typeof window.applySpeakerHighlight === 'function') window.applySpeakerHighlight(member.name);
    document.getElementById('palinsesto')?.scrollIntoView({ behavior: 'smooth' });
  };
  $('member-modal-cal-btn').onclick = () => { close(); openSpeakerCalendarModal(member.name); };

  function close() {
    modal.classList.remove('active');
    modal.setAttribute('aria-hidden', 'true');
    document.removeEventListener('keydown', onKey);
  }
  function onKey(e) { if (e.key === 'Escape') close(); }
  $('member-modal-close').onclick = close;
  modal.onclick = e => { if (e.target === modal) close(); };
  document.addEventListener('keydown', onKey);

  modal.classList.add('active');
  modal.setAttribute('aria-hidden', 'false');
  if (typeof lucide !== 'undefined') lucide.createIcons();
}
window.openMemberModal = openMemberModal;

// ═══════════════════════════════════════════════════════════════
// BARRA DI NAVIGAZIONE IN BASSO (telefono e tablet in verticale)
// Visibile solo via CSS; qui: sezione attiva, pannello "Altro".
// ═══════════════════════════════════════════════════════════════
function initTabBar() {
  const bar = document.getElementById('rc-tabbar');
  const sheet = document.getElementById('rc-more-sheet');
  if (!bar || !sheet) return;
  const moreBtn = bar.querySelector('[data-tab="altro"]');

  // Su telefono/tablet i Preferiti vanno dopo il Team, così scorrendo le sezioni
  // seguono l'ordine della barra: Diretta → Palinsesto → Podcast → Team → Altro.
  const TOUCH_QUERY = '(max-width: 768px), (max-width: 1024px) and (orientation: portrait) and (hover: none)';
  const pref = document.getElementById('preferiti');
  const teamSec = document.getElementById('team');
  if (pref && teamSec && window.matchMedia) {
    const marker = document.createComment('posizione Preferiti su desktop');
    pref.parentNode.insertBefore(marker, pref);
    const mq = window.matchMedia(TOUCH_QUERY);
    const place = () => {
      if (mq.matches) teamSec.parentNode.insertBefore(pref, teamSec.nextSibling);
      else marker.parentNode.insertBefore(pref, marker.nextSibling);
    };
    place();
    if (mq.addEventListener) mq.addEventListener('change', place); else if (mq.addListener) mq.addListener(place);
  }

  const setMore = open => {
    sheet.classList.toggle('open', open);
    sheet.setAttribute('aria-hidden', open ? 'false' : 'true');
    moreBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    moreBtn.classList.toggle('active', open);
    if (!open) highlight(currentTab);
  };
  moreBtn.addEventListener('click', () => setMore(!sheet.classList.contains('open')));
  sheet.querySelector('.rc-more-sheet__backdrop').addEventListener('click', () => setMore(false));
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && sheet.classList.contains('open')) setMore(false); });

  // Le voci del pannello chiudono il pannello (Wrapped si apre dal suo gestore)
  sheet.querySelectorAll('a, button[data-action]').forEach(el => el.addEventListener('click', () => setMore(false)));
  const exploreItem = sheet.querySelector('[data-action="explore"]');
  if (exploreItem) exploreItem.addEventListener('click', () => document.querySelector('.nav__explore')?.click());

  bar.querySelectorAll('a[data-tab]').forEach(a => a.addEventListener('click', () => setMore(false)));

  // Sezione attiva mentre si scorre
  const MAP = { top: 'diretta', 'on-air': 'diretta', bacheca: 'diretta', palinsesto: 'palinsesto', podcast: 'podcast', team: 'team',
                preferiti: 'altro', dediche: 'altro', manifesto: 'altro' };
  let currentTab = 'diretta';
  function highlight(tab) {
    bar.querySelectorAll('[data-tab]').forEach(el => {
      const on = el.dataset.tab === tab;
      el.classList.toggle('active', on);
      if (el.tagName === 'A') { if (on) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current'); }
    });
  }
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver(entries => {
      entries.forEach(en => {
        if (en.isIntersecting && MAP[en.target.id]) {
          currentTab = MAP[en.target.id];
          if (!sheet.classList.contains('open')) highlight(currentTab);
        }
      });
    }, { rootMargin: '-45% 0px -50% 0px' });
    Object.keys(MAP).forEach(id => { const el = document.getElementById(id); if (el) io.observe(el); });
  }
  highlight(currentTab);
}

function initMobileMenu() {
  const toggle = document.querySelector('.nav-toggle');
  const mobileMenu = document.querySelector('.nav-mobile');
  if (!toggle || !mobileMenu) return;

  toggle.setAttribute('aria-expanded', 'false');
  mobileMenu.setAttribute('aria-hidden', 'true');

  toggle.addEventListener('click', () => {
    const isOpen = document.body.classList.toggle('nav-open');
    toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    mobileMenu.setAttribute('aria-hidden', isOpen ? 'false' : 'true');
  });

  mobileMenu.querySelectorAll('a').forEach(link => {
    link.addEventListener('click', () => {
      document.body.classList.remove('nav-open');
      toggle.setAttribute('aria-expanded', 'false');
      mobileMenu.setAttribute('aria-hidden', 'true');
    });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.body.classList.contains('nav-open')) {
      document.body.classList.remove('nav-open');
      toggle.setAttribute('aria-expanded', 'false');
      mobileMenu.setAttribute('aria-hidden', 'true');
      toggle.focus();
    }
  });
}

function initDedicaForm() {
  const form = document.getElementById('dedica-form');
  const success = document.querySelector('.dediche__success');
  if (!form || !success) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const name = form.querySelector('[name="nome"]');
    const song = form.querySelector('[name="canzone"]');

    if (!name.value.trim() || !song.value.trim()) {
      [name, song].forEach(field => {
        if (!field.value.trim()) {
          field.style.borderColor = 'var(--rc-red)';
          setTimeout(() => { field.style.borderColor = ''; }, 1500);
        }
      });
      return;
    }

    const endpoint = APP_CONFIG && APP_CONFIG.meta && APP_CONFIG.meta.formspree;
    if (!endpoint) return;

    const btn = form.querySelector('button[type="submit"]');
    const label = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Invio…'; }

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Accept': 'application/json' },
        body: new FormData(form)
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      form.dataset.sent = '1';
      form.reset();
      form.style.display = 'none';
      success.style.display = '';
      success.setAttribute('aria-hidden', 'false');
      success.classList.add('active');
      requestAnimationFrame(() => success.classList.add('visible'));
    } catch (err) {
      dwarn('[Dediche] Invio fallito:', err);
      if (btn) { btn.textContent = 'Errore, riprova →'; }
    } finally {
      if (btn) {
        btn.disabled = false;
        setTimeout(() => { if (btn.textContent !== label) btn.textContent = label; }, 3000);
      }
    }
  });
}

function initManifestoDoubt() {
  const btn = document.getElementById('manifesto-doubt-btn');
  const section = document.getElementById('manifesto');
  if (!btn || !section) return;

  btn.addEventListener('click', () => {
    const isRevealed = section.classList.toggle('manifesto--truth-revealed');
    btn.textContent = isRevealed ? 'Ok, ora mi convince.' : 'Non mi convince.';
  });
}

function initWatermark() {
  const el = document.querySelector('.hero__watermark');
  if (!el) return;

  function update() {
    const now = new Date();
    const h = String(now.getHours()).padStart(2, '0');
    const m = String(now.getMinutes()).padStart(2, '0');
    const s = String(now.getSeconds()).padStart(2, '0');
    el.textContent = `${h}:${m}:${s} · ON AIR`;
  }

  update();
  setInterval(update, 1000);
}

function initSmoothScroll() {
  document.querySelectorAll('a[href^="#"]').forEach(link => {
    link.addEventListener('click', (e) => {
      const targetId = link.getAttribute('href');
      if (targetId === '#') return;

      const target = document.querySelector(targetId);
      if (!target) return;

      e.preventDefault();
      const offset = target.getBoundingClientRect().top + window.scrollY - 64; 
      window.scrollTo({ top: offset, behavior: 'smooth' });

      if (!target.hasAttribute('tabindex')) {
        target.setAttribute('tabindex', '-1');
        target.addEventListener('blur', function onBlur() {
          target.removeAttribute('tabindex');
          target.removeEventListener('blur', onBlur);
        });
      }
      target.focus({ preventScroll: true });
    });
  });
}

function initScrollAnimations() {
  const elements = document.querySelectorAll('.fade-in');
  if (!elements.length) return;

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.1 });

  elements.forEach(el => observer.observe(el));
}

function initScrollProgress() {
  const bar = document.querySelector('.scroll-progress');
  if (!bar) return;

  let scrollTicking = false;
  window.addEventListener('scroll', () => {
    if (!scrollTicking) {
      requestAnimationFrame(() => {
        const scrollTop = window.scrollY;
        const docHeight = document.documentElement.scrollHeight - window.innerHeight;
        bar.style.width = (docHeight > 0 ? (scrollTop / docHeight) * 100 : 0) + '%';
        scrollTicking = false;
      });
      scrollTicking = true;
    }
  }, { passive: true });
}

function initStaggerAnimations() {
  const grids = document.querySelectorAll('.podcasts__grid, .team__grid, .palinsesto__grid');

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const children = entry.target.children;
        Array.from(children).forEach((child, i) => {
          child.classList.add('stagger-in');
          setTimeout(() => {
            child.classList.add('visible');
          }, i * 50); 
        });
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.05 });

  grids.forEach(grid => observer.observe(grid));

  const labels = document.querySelectorAll('.section-label');
  const labelObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
        labelObserver.unobserve(entry.target);
      }
    });
  }, { threshold: 0.5 });

  labels.forEach(label => labelObserver.observe(label));
}

const RC_FALLBACK_LINES = [
  "sbagliamo, in diretta.",
  "tre minuti di pubblicità. zero pubblicità.",
  "fare radio a scuola e scuola attraverso la radio.",
  "niente scalette noiose. due microfoni. un'ora.",
  "ci hanno detto di farci sentire. eccoci qui, a volume alto.",
  "opinioni libere, buona musica, zero noia.",
  "non leggiamo piatto. non lo sapremmo fare.",
  "il microfono è aperto. spazio alle idee del Carducci.",
  "voci vere, microfoni accesi, storie da raccontare.",
];

function rcFallbackCopy() {
  return RC_FALLBACK_LINES[Math.floor(Math.random() * RC_FALLBACK_LINES.length)];
}

const NowPlaying = {
  currentTrack: null,
  autoEnabled: true,
  cache: {},
  sources: [],
  trackStartTime: Date.now(),
  streamLatencyMs: 5000,
  delayOffset: 6.5, // Compensazione standard +6.5s per time-based lyrics (anticipate di 1.5s)
  isTimeSyncEnabled: localStorage.getItem('rc_lyrics_sync_enabled') !== 'false',
  syncedLines: [],
  activeLyricIndex: -1,
  lyricsInterval: null,
  isUserScrolling: false,
  userScrollTimer: null,

  saveToSession(key, val) {
    try { sessionStorage.setItem('rc_np_' + key, JSON.stringify(val)); } catch (e) {}
  },
  loadFromSession(key) {
    try {
      const raw = sessionStorage.getItem('rc_np_' + key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  },

  resumeAutoScroll() {
    this.isUserScrolling = false;
    if (this.userScrollTimer) {
      clearTimeout(this.userScrollTimer);
      this.userScrollTimer = null;
    }
    const resumeBtn = document.getElementById('np-lyrics-resume');
    if (resumeBtn) resumeBtn.classList.remove('np-lyrics__resume-btn--visible');

    if (this.activeLyricIndex >= 0) {
      const activeEl = document.querySelector(`.np-lyrics__line[data-idx="${this.activeLyricIndex}"]`);
      if (activeEl) {
        activeEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  },

  syncTrackElapsed(serverElapsed) {
    if (typeof serverElapsed !== 'number' || isNaN(serverElapsed) || serverElapsed < 0) return;
    const computedStartTime = Date.now() - (serverElapsed * 1000) + (this.streamLatencyMs || 5000);
    if (!this.trackStartTime || Math.abs(this.trackStartTime - computedStartTime) > 1200) {
      this.trackStartTime = computedStartTime;
      this.tickLyricsSync();
    }
  },

  els: {},

  init() {
    this.els = {
      overlay:     document.getElementById('np-overlay'),
      expandBtn:   document.querySelector('.player-bar__expand'),
      closeBtn:    document.querySelector('.np-overlay__close'),
      toggleInput: document.getElementById('np-auto-toggle'),
      tabs:        document.querySelectorAll('.np-overlay__tab'),
      panels:      document.querySelectorAll('.np-overlay__panel'),

      title:       document.querySelector('.np-overlay__title'),
      artist:      document.querySelector('.np-overlay__artist'),
      album:       document.querySelector('.np-overlay__album'),
      cover:       document.querySelector('.np-overlay__cover'),
      sourceLinks: document.querySelector('.np-overlay__source-links'),

      barTitle:    document.querySelector('.player-bar__title'),
      barMeta:     document.querySelector('.player-bar__meta'),
      barCover:    document.querySelector('.player-bar__cover'),
    };

    if (!this.els.overlay) return;
    this.els.overlay.setAttribute('aria-modal', 'true');

    this.els.expandBtn?.addEventListener('click', () => this.toggle());
    this.els.closeBtn?.addEventListener('click', () => this.close());

    this.els.toggleInput?.addEventListener('change', (e) => {
      this.autoEnabled = e.target.checked;
    });

    this.els.tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        this.els.tabs.forEach(t => {
          t.classList.remove('np-overlay__tab--active');
          t.setAttribute('aria-selected', 'false');
        });
        this.els.panels.forEach(p => {
          p.classList.remove('np-overlay__panel--active');
          p.setAttribute('aria-hidden', 'true');
        });
        
        tab.classList.add('np-overlay__tab--active');
        tab.setAttribute('aria-selected', 'true');
        
        const panel = document.querySelector(`[data-panel="${tab.dataset.tab}"]`);
        if (panel) {
          panel.classList.add('np-overlay__panel--active');
          panel.setAttribute('aria-hidden', 'false');
        }
      });
    });

    const handleBarClick = (e) => {
      if (window.innerWidth <= 768) {
        if (!e.target.closest('button') && !e.target.closest('input')) {
          this.toggle();
        }
      }
    };
    document.querySelector('.player-bar__info')?.addEventListener('click', handleBarClick);
    document.querySelector('.player-bar__cover-wrapper')?.addEventListener('click', handleBarClick);

    document.addEventListener('keydown', (e) => {
      if (!this.els.overlay.classList.contains('active')) return;

      if (e.key === 'Escape') {
        this.close();
        e.preventDefault();
        return;
      }

      if (e.key === 'Tab') {
        const focusable = Array.from(this.els.overlay.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'))
          .filter(el => el.offsetWidth > 0 || el.offsetHeight > 0);
        
        if (focusable.length === 0) return;

        const first = focusable[0];
        const last = focusable[focusable.length - 1];

        if (e.shiftKey) {
          if (document.activeElement === first) {
            last.focus();
            e.preventDefault();
          }
        } else {
          if (document.activeElement === last) {
            first.focus();
            e.preventDefault();
          }
        }
      }
    });

    window.NowPlaying = this;
    this.jsonUrl = DEFAULT_JSON_URL;

    this.poll();
    this.initSSE();

    // Polling ultra-veloce a 2.5 secondi come heartbeat/fallback
    if (this._pollTimer) clearInterval(this._pollTimer);
    this._pollTimer = setInterval(() => this.poll(), 2500);

    // Refresh istantaneo quando l'utente torna sulla scheda o sblocca lo schermo
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) this.poll();
    });
    window.addEventListener('focus', () => this.poll());
  },

  initSSE() {
    try {
      if (!('EventSource' in window)) return;
      const jsonUrl = (APP_CONFIG && APP_CONFIG.meta && APP_CONFIG.meta.jsonUrl) || DEFAULT_JSON_URL;
      const m = jsonUrl.match(/^(https?:\/\/[^/]+)\/api\/nowplaying\/([^/?#]+)/);
      const sseUrl = m ? `${m[1]}/api/live/nowplaying/sse?stations=${m[2]}` : DEFAULT_SSE_URL;
      if (this.sse && this._sseUrl === sseUrl) return;
      this._sseUrl = sseUrl;
      if (this.sse) {
        try { this.sse.close(); } catch (e) {}
      }
      const sse = new EventSource(sseUrl);
      sse.onmessage = (e) => {
        try {
          const payload = JSON.parse(e.data);
          const npData = payload?.pub?.data?.np || payload?.data?.np || payload?.np || payload?.now_playing;
          if (npData) {
            this.handleData(npData);
          }
        } catch (err) {}
      };
      sse.onerror = () => {
        // Se SSE si disconnette, il polling a 2.5s garantisce continuità senza ritardi
      };
      this.sse = sse;
    } catch (e) {}
  },

  toggle() {
    this.els.overlay.classList.toggle('active');
    const isOpen = this.els.overlay.classList.contains('active');
    this.els.overlay.setAttribute('aria-hidden', !isOpen ? 'true' : 'false');
    if (isOpen) {
      this.lastActiveElement = document.activeElement;
      document.body.style.overflow = 'hidden';

      setTimeout(() => {
        this.els.closeBtn?.focus();
      }, 50);

      if (typeof window.updateBento === 'function') {
        window.updateBento(true);
      }
    } else {
      document.body.style.overflow = '';
      if (this.lastActiveElement) {
        this.lastActiveElement.focus();
      }
    }
  },

  close() {
    if (this.els.overlay.classList.contains('active')) {
      this.els.overlay.classList.remove('active');
      this.els.overlay.setAttribute('aria-hidden', 'true');
      document.body.style.overflow = '';
      if (this.lastActiveElement) {
        this.lastActiveElement.focus();
      }
    }
  },

  handleData(data) {
    if (!data) return;
    let trackStr = null;
    let artist = null;
    let title = null;
    let streamCoverUrl = null;
    let serverElapsed = null;

    // Calcolo robusto del tempo trascorso:
    // AzuraCast fornisce sia played_at (timestamp unix assoluto) che elapsed (secondi trascorsi)
    const playedAtSec = data.now_playing?.played_at || data.played_at;
    if (typeof playedAtSec === 'number' && playedAtSec > 0) {
      const nowSec = Math.floor(Date.now() / 1000);
      const diff = nowSec - playedAtSec;
      if (diff >= 0 && diff < 7200) {
        serverElapsed = diff;
      }
    }
    if (serverElapsed == null) {
      if (typeof data.now_playing?.elapsed === 'number') {
        serverElapsed = data.now_playing.elapsed;
      } else if (typeof data.elapsed === 'number') {
        serverElapsed = data.elapsed;
      }
    }

    // 1. Formato AzuraCast (server ufficiale Radio Carducci)
    if (data.now_playing && data.now_playing.song) {
      const song = data.now_playing.song;
      if (song.artist && song.title) {
        artist = song.artist.trim();
        title = song.title.trim();
        trackStr = `${artist} - ${title}`;
      } else if (song.text && song.text.trim()) {
        trackStr = song.text.trim();
        if (trackStr.includes(' - ')) {
          const parts = trackStr.split(' - ');
          artist = parts[0].trim();
          title = parts.slice(1).join(' - ').trim();
        } else {
          title = trackStr;
        }
      }

      if (song.art && !song.art.includes('generic_song')) {
        streamCoverUrl = song.art;
      }

      if (data.live && data.live.is_live && data.live.streamer_name) {
        artist = data.live.streamer_name;
        title = 'In Diretta su Radio Carducci';
        trackStr = `${artist} - ${title}`;
      }
    } else if (data.song) {
      // Evento diretto song da push SSE
      const song = data.song;
      if (song.artist && song.title) {
        artist = song.artist.trim();
        title = song.title.trim();
        trackStr = `${artist} - ${title}`;
      } else if (song.text) {
        trackStr = song.text.trim();
      }
      if (song.art && !song.art.includes('generic_song')) {
        streamCoverUrl = song.art;
      }
    }

    // Se il brano è vuoto o è solo il jingle della radio
    const isJingleOrEmpty = !trackStr ||
      trackStr.trim().toLowerCase() === 'radio carducci' ||
      (artist && artist.toLowerCase() === 'radio carducci' && !title);

    if (isJingleOrEmpty) {
      const liveShow = typeof getCurrentLiveShow === 'function' ? getCurrentLiveShow() : null;
      const showTitle = liveShow ? liveShow.name : 'La Musica di Radio Carducci';
      trackStr = `Radio Carducci - ${showTitle}`;
      if (!streamCoverUrl) {
        streamCoverUrl = liveShow?.img || 'assets/media-session-512.png';
      }
    }

    if (trackStr && trackStr !== this.currentTrack) {
      this.currentTrack = trackStr;
      this.onTrackChange(trackStr, streamCoverUrl, serverElapsed);
    } else if (serverElapsed != null) {
      this.syncTrackElapsed(serverElapsed);
    }
  },

  async poll() {
    if (this._isPolling) return;
    this._isPolling = true;
    try {
      const primaryUrl = this.jsonUrl || (APP_CONFIG?.meta?.jsonUrl) || DEFAULT_JSON_URL;

      let res = await fetch(`${primaryUrl}${primaryUrl.includes('?') ? '&' : '?'}_=${Date.now()}`, {
        mode: 'cors',
        cache: 'no-store'
      }).catch(() => null);

      if (res && res.ok) {
        const data = await res.json();
        this.handleData(data);
      }
    } catch (e) {
      console.warn('[RC NowPlaying] Errore polling metadati:', e);
    } finally {
      this._isPolling = false;
    }
  },

  escapeHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  },

  sanitizeMoliga(str) {
    if (!str) return str;
    return str
      .replace(/à/g, "a'")
      .replace(/è/g, "e'")
      .replace(/é/g, "e'")
      .replace(/ì/g, "i'")
      .replace(/ò/g, "o'")
      .replace(/ù/g, "u'")
      .replace(/À/g, "A'")
      .replace(/È/g, "E'")
      .replace(/É/g, "E'")
      .replace(/Ì/g, "I'")
      .replace(/Ò/g, "O'")
      .replace(/Ù/g, "U'");
  },

  async onTrackChange(trackStr, streamCoverUrl = null, serverElapsed = null) {
    if (typeof serverElapsed === 'number' && !isNaN(serverElapsed) && serverElapsed >= 0) {
      this.trackStartTime = Date.now() - (serverElapsed * 1000) + (this.streamLatencyMs || 5000);
    } else {
      this.trackStartTime = Date.now();
    }
    this.activeLyricIndex = -1;
    this.syncedLines = [];
    if (this.lyricsInterval) {
      clearInterval(this.lyricsInterval);
      this.lyricsInterval = null;
    }

    const parts = trackStr.split(' - ');
    const artist = parts.length > 1 ? parts[0].trim() : '';
    const title = parts.length > 1 ? parts.slice(1).join(' - ').trim() : trackStr.trim();

    this.els.barTitle.textContent = title || 'Radio Carducci';
    this.els.barMeta.textContent = artist || 'IN DIRETTA';

    this.els.title.textContent = this.sanitizeMoliga(title || 'In attesa...');
    this.els.artist.textContent = artist;
    this.els.album.textContent = '';

    this.els.cover.src = '';
    this.els.cover.classList.add('np-overlay__cover--hidden');
    this.els.barCover.src = '';
    this.els.barCover.classList.add('player-bar__cover--hidden');

    let processedStreamCover = streamCoverUrl;
    if (processedStreamCover && processedStreamCover.includes('100x100')) {
      processedStreamCover = processedStreamCover.replace('100x100', '500x500');
    }

    // Aggiornamento immediato MediaSession per iOS / Android / Dynamic Island
    if (typeof RCMediaSession !== 'undefined' && RCMediaSession.updateRadio && artist && artist.toLowerCase() !== 'radio carducci') {
      RCMediaSession.updateRadio({
        title: title || 'Radio Carducci',
        artist: artist || 'IN DIRETTA',
        album: 'Radio Carducci — In Diretta',
        coverUrl: processedStreamCover || null
      });
    }

    // Se è la radio stessa / rotazione palinsesto, mostra info brand pulite senza interrogare LRCLIB
    if (!this.autoEnabled || !artist || artist.toLowerCase() === 'radio carducci') {
      const cover = processedStreamCover || 'assets/media-session-512.png';
      this.els.cover.src = cover;
      this.els.cover.classList.remove('np-overlay__cover--hidden');
      this.els.barCover.src = cover;
      this.els.barCover.classList.remove('player-bar__cover--hidden');
      this.els.album.textContent = 'Web Radio del Liceo Carducci';

      const lyricsPanel = document.querySelector('[data-panel="lyrics"]');
      if (lyricsPanel) {
        lyricsPanel.innerHTML = `
          <div class="np-overlay__info-card" style="padding: 24px; border: 1px solid var(--border); background: var(--bg-card);">
            <div style="font-family: var(--font-mono); font-size: 11px; text-transform: uppercase; color: var(--rc-red); margin-bottom: 8px; letter-spacing: 0.1em;">In Onda Ora</div>
            <h3 style="margin: 0 0 8px 0; font-family: var(--font-headline); font-size: 20px; color: var(--fg);">${this.escapeHtml(title)}</h3>
            <p style="color: var(--fg2); line-height: 1.5; margin: 0 0 12px 0;">Stai ascoltando la diretta di Radio Carducci, la voce e la musica del Liceo Carducci di Roma.</p>
            <div style="font-family: var(--font-mono); font-size: 11px; color: var(--fg3);">// DIRETTA STREAMING 24/7</div>
          </div>
        `;
      }

      const bioPanel = document.querySelector('[data-panel="bio"]');
      if (bioPanel) {
        bioPanel.innerHTML = `
          <div class="np-overlay__info-card" style="padding: 24px; border: 1px solid var(--border); background: var(--bg-card);">
            <div style="font-family: var(--font-mono); font-size: 11px; text-transform: uppercase; color: var(--rc-red); margin-bottom: 8px; letter-spacing: 0.1em;">Radio Carducci</div>
            <h3 style="margin: 0 0 8px 0; font-family: var(--font-headline); font-size: 20px; color: var(--fg);">Web Radio Studentesca</h3>
            <p style="color: var(--fg2); line-height: 1.5; margin: 0 0 12px 0;">Emittente ufficiale del Liceo Carducci di Roma. Trasmissioni a cura degli studenti, podcast culturali e rotazione musicale non-stop.</p>
          </div>
        `;
      }

      if (typeof RCMediaSession !== 'undefined' && RCMediaSession.updateRadio) {
        RCMediaSession.updateRadio({
          title: title,
          artist: 'Radio Carducci',
          album: 'Radio Carducci — In Diretta',
          coverUrl: cover
        });
      }
      return;
    }

    const cacheKey = `${artist}::${title}`.toLowerCase();
    const cached = this.cache[cacheKey] || this.loadFromSession(cacheKey);

    if (cached) {
      this.cache[cacheKey] = cached;
      this.applyData(cached);
      return;
    }

    this.showLoading();
    this.sources = [];

    const isLiveDj = title === 'In Diretta su Radio Carducci';

    // La copertina arriva prima di tutto il resto: la mostro subito
    const coverPromise = isLiveDj ? Promise.resolve(null) : fetchCoverFromWorker(artist, title);
    coverPromise.then(workerCover => {
      if (this.currentTrack !== trackStr) return;
      const cover = workerCover || processedStreamCover;
      if (!cover) return;
      this.els.cover.src = cover;
      this.els.cover.classList.remove('np-overlay__cover--hidden');
      this.els.barCover.src = cover;
      this.els.barCover.classList.remove('player-bar__cover--hidden');
    });

    const [trackData, artistData, lyricsData, coverData] = await Promise.allSettled([
      this.fetchTrackInfo(artist, title),
      this.fetchArtistInfo(artist),
      this.fetchLyrics(artist, title),
      coverPromise,
    ]);

    // Nel frattempo è cambiato brano: non sovrascrivo con dati vecchi
    if (this.currentTrack !== trackStr) return;

    const result = {
      adbTrack: trackData.status === 'fulfilled' ? trackData.value : null,
      adbArtist: artistData.status === 'fulfilled' ? artistData.value : null,
      lyrics: lyricsData.status === 'fulfilled' ? lyricsData.value : null,
      workerCoverUrl: coverData.status === 'fulfilled' ? coverData.value : null,
      streamCoverUrl: processedStreamCover,
    };

    this.cache[cacheKey] = result;
    this.saveToSession(cacheKey, result);
    this.applyData(result);
  },

  showLoading() {
    document.querySelectorAll('.np-overlay__panel').forEach(p => {
      p.innerHTML = '<div class="np-overlay__loading">Caricamento...</div>';
    });
  },

  applyData(data) {

    // Copertina: Worker (come l'app) → song.art di AzuraCast → logo
    const finalCoverUrl = data.workerCoverUrl || data.streamCoverUrl || 'assets/media-session-512.png';

    if (finalCoverUrl) {
      this.els.cover.src = finalCoverUrl;
      this.els.cover.classList.remove('np-overlay__cover--hidden');
      this.els.barCover.src = finalCoverUrl;
      this.els.barCover.classList.remove('player-bar__cover--hidden');
    } else {
      this.els.cover.src = '';
      this.els.cover.classList.add('np-overlay__cover--hidden');
      this.els.barCover.src = '';
      this.els.barCover.classList.add('player-bar__cover--hidden');
    }

    if (data.adbTrack?.album) {
      this.els.album.textContent = data.adbTrack.album;
    }

    const lyricsPanel = document.querySelector('[data-panel="lyrics"]');
    const currentTrackName = this.currentTrack || 'Radio Carducci';
    const parts = currentTrackName.split(' - ');
    const curArtist = parts.length > 1 ? parts[0].trim() : 'Radio Carducci';
    const curTitle = parts.length > 1 ? parts.slice(1).join(' - ').trim() : currentTrackName;

    if (typeof RCMediaSession !== 'undefined') {
      RCMediaSession.updateRadio({
        title: curTitle,
        artist: curArtist,
        album: data.adbTrack?.album || 'Radio Carducci — In Diretta',
        coverUrl: finalCoverUrl
      });
    }

    if (lyricsPanel) {
      if (data.lyrics) {
        const synced = data.lyrics.syncedLyrics ? this.parseLRC(data.lyrics.syncedLyrics) : [];
        if (synced.length > 0) {
          this.syncedLines = synced;
          this.renderSyncedLyrics(lyricsPanel, synced);
          this.startLyricsSync();
        } else if (data.lyrics.plainLyrics) {
          if (this.lyricsInterval) clearInterval(this.lyricsInterval);
          lyricsPanel.innerHTML = `<div class="np-lyrics">${this.escapeHtml(data.lyrics.plainLyrics).replace(/&lt;br&gt;/g, '<br>')}</div>`;
        } else {
          if (this.lyricsInterval) clearInterval(this.lyricsInterval);
          lyricsPanel.innerHTML = `
            <div class="np-lyrics-empty">
              <div class="np-lyrics-empty__badge">TESTO NON DISPONIBILE SU LRCLIB</div>
              <h4>${escapeHtml(curTitle)}</h4>
              <p class="np-lyrics-empty__sub">Nessun testo sincronizzato disponibile al momento su LRCLIB per questo brano.</p>
              <div class="np-lyrics-empty__actions">
                <a href="https://genius.com/search?q=${encodeURIComponent(curArtist + ' ' + curTitle)}" target="_blank" rel="noopener" class="btn btn-sm btn-red">Cerca su Genius ↗</a>
                <a href="https://www.google.com/search?q=${encodeURIComponent('testo lyrics ' + curArtist + ' ' + curTitle)}" target="_blank" rel="noopener" class="btn btn-sm">Cerca su Google ↗</a>
              </div>
            </div>
          `;
        }
      } else {
        if (this.lyricsInterval) clearInterval(this.lyricsInterval);
        lyricsPanel.innerHTML = `
          <div class="np-lyrics-empty">
            <div class="np-lyrics-empty__badge">TESTO NON DISPONIBILE SU LRCLIB</div>
            <h4>${escapeHtml(curTitle)}</h4>
            <p class="np-lyrics-empty__sub">Nessun testo sincronizzato disponibile al momento su LRCLIB per questo brano.</p>
            <div class="np-lyrics-empty__actions">
              <a href="https://genius.com/search?q=${encodeURIComponent(curArtist + ' ' + curTitle)}" target="_blank" rel="noopener" class="btn btn-sm btn-red">Cerca su Genius ↗</a>
              <a href="https://www.google.com/search?q=${encodeURIComponent('testo lyrics ' + curArtist + ' ' + curTitle)}" target="_blank" rel="noopener" class="btn btn-sm">Cerca su Google ↗</a>
            </div>
          </div>
        `;
      }
    }

    const artistPanel = document.querySelector('[data-panel="artist"]');
    if (artistPanel) {
      if (data.adbArtist && data.adbArtist.extract) {
        let html = '';
        if (data.adbArtist.thumbnail) {
          html += `<img src="${escapeHtml(data.adbArtist.thumbnail)}" alt="${escapeHtml(data.adbArtist.title)}" style="float:right; max-width:150px; margin:0 0 var(--s-4) var(--s-4); border:1px solid var(--line-strong);">`;
        }
        html += `<h3>${escapeHtml(data.adbArtist.title)}</h3>`;
        html += `<p>${escapeHtml(data.adbArtist.extract)}</p>`;
        html += `<div style="margin-top:var(--s-4);"><a href="https://it.wikipedia.org/wiki/${encodeURIComponent(data.adbArtist.title)}" target="_blank" rel="noopener" class="btn btn-sm">Leggi su Wikipedia ↗</a></div>`;
        artistPanel.innerHTML = html;
      } else {
        artistPanel.innerHTML = `
          <div style="text-align:left;">
            <h3 style="color:var(--fg1);">${escapeHtml(curArtist)}</h3>
            <p>${escapeHtml(curArtist)} fa parte della rotazione musicale ufficiale di Radio Carducci.</p>
            <div style="margin-top:var(--s-4); display:flex; gap:8px;">
              <a href="https://www.google.com/search?q=${encodeURIComponent(curArtist + ' cantante artista')}" target="_blank" rel="noopener" class="btn btn-sm btn-red">Cerca su Google ↗</a>
            </div>
          </div>
        `;
      }
    }

    const songPanel = document.querySelector('[data-panel="song"]');
    if (songPanel) {
      let html = '<div class="np-song-info-card">';
      html += `<h3>Informazioni brano</h3>`;
      html += `<p><strong>Titolo:</strong> ${escapeHtml(data.adbTrack?.title || curTitle)}</p>`;
      html += `<p><strong>Artista:</strong> ${escapeHtml(data.adbTrack?.artist || curArtist)}</p>`;
      if (data.adbTrack?.album) html += `<p><strong>Album:</strong> ${escapeHtml(data.adbTrack.album)}</p>`;
      if (data.adbTrack?.date) html += `<p><strong>Anno:</strong> ${escapeHtml(data.adbTrack.date)}</p>`;
      if (data.adbTrack?.tags?.length) html += `<p><strong>Genere:</strong> ${data.adbTrack.tags.map(t => escapeHtml(t)).join(', ')}</p>`;
      html += `<div style="margin-top:var(--s-4); display:flex; gap:8px; flex-wrap:wrap;">
        <a href="https://open.spotify.com/search/${encodeURIComponent(curArtist + ' ' + curTitle)}" target="_blank" rel="noopener" class="btn btn-sm btn-red">Ascolta su Spotify ↗</a>
        <a href="https://music.apple.com/search?term=${encodeURIComponent(curArtist + ' ' + curTitle)}" target="_blank" rel="noopener" class="btn btn-sm">Apple Music ↗</a>
      </div>`;
      html += '</div>';
      songPanel.innerHTML = html;
    }

    this.updateSources();
  },

  updateSources() {
    if (!this.els.sourceLinks) return;
    const links = this.sources.map(s => `<a href="${s.url}" target="_blank" rel="noopener">${s.name}</a>`);
    this.els.sourceLinks.innerHTML = links.join('') || 'Nessuna fonte';
  },

  applyFallbackData() {
    const currentTrackName = this.currentTrack || 'Radio Carducci';
    const parts = currentTrackName.split(' - ');
    const curArtist = parts.length > 1 ? parts[0].trim() : 'Radio Carducci';
    const curTitle = parts.length > 1 ? parts.slice(1).join(' - ').trim() : currentTrackName;

    const lyricsPanel = document.querySelector('[data-panel="lyrics"]');
    if (lyricsPanel) {
      lyricsPanel.innerHTML = `
        <div class="np-lyrics-empty">
          <div class="np-lyrics-empty__badge">IN DIRETTA SU RADIO CARDUCCI</div>
          <h4>${escapeHtml(curTitle)}</h4>
          <p class="np-lyrics-empty__sub">Premi play sulla barra inferiore per sintonizzarti con la web radio.</p>
          <div class="np-lyrics-empty__actions">
            <a href="https://genius.com/search?q=${encodeURIComponent(curArtist + ' ' + curTitle)}" target="_blank" rel="noopener" class="btn btn-sm btn-red">Cerca testo su Genius ↗</a>
          </div>
        </div>
      `;
    }

    const artistPanel = document.querySelector('[data-panel="artist"]');
    if (artistPanel) {
      artistPanel.innerHTML = `
        <div style="text-align:left;">
          <h3 style="color:var(--fg1);">${escapeHtml(curArtist)}</h3>
        </div>
      `;
    }

    const songPanel = document.querySelector('[data-panel="song"]');
    if (songPanel) {
      songPanel.innerHTML = `
        <div style="text-align:left;">
          <h3 style="color:var(--fg1);">${escapeHtml(curTitle)}</h3>
        </div>
      `;
    }

    if (this.els.sourceLinks) {
      this.els.sourceLinks.innerHTML = '<a href="https://www.radiocarducci.com" target="_blank" rel="noopener">Sito Ufficiale</a>';
    }
  },

  cleanQuery(str) {
    if (!str) return '';
    return String(str)
      .replace(/\s*\(.*?video.*?\)/gi, '')
      .replace(/\s*\(.*?official.*?\)/gi, '')
      .replace(/\s*\(.*?radio edit.*?\)/gi, '')
      .replace(/\s*\(.*?remix.*?\)/gi, '')
      .replace(/\s*\[.*?\]/gi, '')
      .replace(/\s*feat\..*$/gi, '')
      .replace(/\s*ft\..*$/gi, '')
      .replace(/\s*prod\..*$/gi, '')
      .replace(/["',]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  },

  async fetchTrackInfo(artist, title) {
    const cleanArt = this.cleanQuery(artist);
    const cleanTit = this.cleanQuery(title);

    // 1. Prova iTunes Search API (Store Italia per catalogo completo, poi globale)
    try {
      const q = encodeURIComponent(`${cleanArt} ${cleanTit}`);
      let itunesRes = await fetch(`https://itunes.apple.com/search?term=${q}&country=it&media=music&entity=song&limit=1`).catch(() => null);
      let data = (itunesRes && itunesRes.ok) ? await itunesRes.json().catch(() => null) : null;

      if (!data || !data.resultCount) {
        itunesRes = await fetch(`https://itunes.apple.com/search?term=${q}&media=music&entity=song&limit=1`).catch(() => null);
        data = (itunesRes && itunesRes.ok) ? await itunesRes.json().catch(() => null) : null;
      }

      if ((!data || !data.resultCount) && cleanArt.includes(' ')) {
        const firstArtist = cleanArt.split(' ')[0];
        const q2 = encodeURIComponent(`${firstArtist} ${cleanTit}`);
        itunesRes = await fetch(`https://itunes.apple.com/search?term=${q2}&country=it&media=music&entity=song&limit=1`).catch(() => null);
        data = (itunesRes && itunesRes.ok) ? await itunesRes.json().catch(() => null) : null;
      }

      if (data && data.resultCount > 0 && data.results[0]) {
        const item = data.results[0];
        this.sources.push({ name: 'Apple Music / iTunes', url: item.trackViewUrl || 'https://music.apple.com' });
        return {
          title: item.trackName || title,
          artist: item.artistName || artist,
          album: item.collectionName || null,
          date: item.releaseDate ? item.releaseDate.slice(0, 4) : null,
          tags: item.primaryGenreName ? [item.primaryGenreName] : [],
          coverUrl: item.artworkUrl100 ? item.artworkUrl100.replace('100x100bb', '600x600bb') : null,
        };
      }
    } catch (e) {}

    // 2. Fallback su TheAudioDB Track
    try {
      const adb = await this.fetchTheAudioDBTrack(cleanArt, cleanTit);
      if (adb) return adb;
    } catch (e) {}

    return {
      title: title || 'Brano in onda',
      artist: artist || 'Radio Carducci',
      album: 'Rotazione Musicale Ufficiale',
      date: null,
      tags: ['Radio Rotation', 'Web Radio'],
      coverUrl: null,
    };
  },

  async fetchArtistInfo(artist) {
    const cleanArt = this.cleanQuery(artist);
    if (!cleanArt) return null;

    // 1. Prova Wikipedia Italia API diretta
    try {
      const wikiUrl = `https://it.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(cleanArt.replace(/\s+/g, '_'))}`;
      const wikiRes = await fetch(wikiUrl);
      if (wikiRes.ok) {
        const data = await wikiRes.json();
        if (data.type !== 'disambiguation' && data.extract) {
          this.sources.push({ name: 'Wikipedia Italia', url: data.content_urls?.desktop?.page || `https://it.wikipedia.org/wiki/${encodeURIComponent(cleanArt)}` });
          return {
            title: data.title || cleanArt,
            extract: data.extract,
            thumbnail: data.thumbnail?.source || null,
          };
        }
      }
    } catch (e) {}

    // 1b. Fallback su ricerca full-text Wikipedia Italia
    try {
      const searchUrl = `https://it.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(cleanArt)}&format=json&origin=*`;
      const searchRes = await fetch(searchUrl);
      if (searchRes.ok) {
        const sData = await searchRes.json();
        const firstHit = sData?.query?.search?.[0];
        if (firstHit && firstHit.title) {
          const sumUrl = `https://it.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(firstHit.title.replace(/\s+/g, '_'))}`;
          const sumRes = await fetch(sumUrl);
          if (sumRes.ok) {
            const sumData = await sumRes.json();
            if (sumData.extract) {
              this.sources.push({ name: 'Wikipedia Italia', url: sumData.content_urls?.desktop?.page || `https://it.wikipedia.org/wiki/${encodeURIComponent(firstHit.title)}` });
              return {
                title: sumData.title || firstHit.title,
                extract: sumData.extract,
                thumbnail: sumData.thumbnail?.source || null,
              };
            }
          }
        }
      }
    } catch (e) {}

    // 2. Fallback Wikipedia Internazionale
    try {
      const wikiEnUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(cleanArt.replace(/\s+/g, '_'))}`;
      const wikiEnRes = await fetch(wikiEnUrl);
      if (wikiEnRes.ok) {
        const data = await wikiEnRes.json();
        if (data.type !== 'disambiguation' && data.extract) {
          this.sources.push({ name: 'Wikipedia', url: data.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodeURIComponent(cleanArt)}` });
          return {
            title: data.title || cleanArt,
            extract: data.extract,
            thumbnail: data.thumbnail?.source || null,
          };
        }
      }
    } catch (e) {}

    // 3. Fallback TheAudioDB
    try {
      const adb = await this.fetchTheAudioDBArtist(cleanArt);
      if (adb && adb.extract && !adb.extract.includes('Nessuna biografia')) {
        return adb;
      }
    } catch (e) {}

    return {
      title: artist,
      extract: `${artist} fa parte della rotazione musicale ufficiale di Radio Carducci.`,
      thumbnail: null,
    };
  },

  async fetchTheAudioDBArtist(artist) {
    if (!artist) return null;
    try {
      const url = `https://www.theaudiodb.com/api/v1/json/2/search.php?s=${encodeURIComponent(artist)}`;
      const res = await fetch(url);
      if (!res.ok) return null;
      const data = await res.json();
      const artistData = data.artists?.[0];
      if (!artistData) return null;

      this.sources.push({ name: 'TheAudioDB', url: `https://www.theaudiodb.com/artist/${artistData.idArtist}` });

      return {
        title: artistData.strArtist,
        extract: artistData.strBiographyIT || artistData.strBiographyEN || artistData.strBiography || null,
        thumbnail: artistData.strArtistThumb || artistData.strArtistLogo || null,
      };
    } catch (e) {}
    return null;
  },

  async fetchTheAudioDBTrack(artist, title) {
    if (!artist || !title) return null;
    try {
      const url = `https://www.theaudiodb.com/api/v1/json/2/searchtrack.php?s=${encodeURIComponent(artist)}&t=${encodeURIComponent(title)}`;
      const res = await fetch(url);
      if (!res.ok) return null;
      const data = await res.json();
      const trackData = data.track?.[0];
      if (!trackData) return null;

      this.sources.push({ name: 'TheAudioDB Track', url: `https://www.theaudiodb.com/track/${trackData.idTrack}` });

      return {
        title: trackData.strTrack,
        album: trackData.strAlbum,
        date: trackData.strReleaseDate || null,
        tags: trackData.strGenre ? [trackData.strGenre] : [],
        coverUrl: trackData.strTrackThumb || null,
      };
    } catch (e) {}
    return null;
  },

  async fetchLyrics(artist, title) {
    const cleanArt = this.cleanQuery(artist);
    const cleanTit = this.cleanQuery(title);
    if (!cleanTit) return null;

    try {
      // 1. Prova query esatta su LRCLIB
      const url = `https://lrclib.net/api/get?artist_name=${encodeURIComponent(cleanArt)}&track_name=${encodeURIComponent(cleanTit)}`;
      let res = await fetch(url);
      let data = null;
      if (res.ok) {
        data = await res.json();
      } else {
        // 2. Fallback su ricerca LRCLIB
        const sUrl = `https://lrclib.net/api/search?q=${encodeURIComponent(cleanArt + ' ' + cleanTit)}`;
        const sRes = await fetch(sUrl);
        if (sRes.ok) {
          const list = await sRes.json();
          if (Array.isArray(list) && list.length > 0) {
            data = list.find(x => x.syncedLyrics) || list[0];
          }
        }
      }

      if (data && (data.syncedLyrics || data.plainLyrics)) {
        this.sources.push({ name: 'LRCLIB.net', url: 'https://lrclib.net/' });
        return {
          plainLyrics: data.plainLyrics ? data.plainLyrics.trim().replace(/\n/g, '<br>') : '',
          syncedLyrics: data.syncedLyrics || null
        };
      }
    } catch (e) {}

    return null;
  },

  parseLRC(raw) {
    if (!raw) return [];
    const lines = [];
    const re = /\[(\d+):(\d+(?:\.\d+)?)\](.*)/;
    for (const row of raw.split('\n')) {
      const m = row.match(re);
      if (!m) continue;
      const t = parseFloat(m[1]) * 60 + parseFloat(m[2]);
      const text = m[3].trim();
      if (text) lines.push({ t, text });
    }
    lines.sort((a, b) => a.t - b.t);
    return lines;
  },

  renderSyncedLyrics(container, lines) {
    const isSynced = this.isTimeSyncEnabled;
    container.innerHTML = `
      <div class="np-lyrics np-lyrics--synced ${isSynced ? '' : 'np-lyrics--manual'}">
        <div class="np-lyrics__beta-card">
          <div class="np-lyrics__beta-msg">
            Siamo in beta: le lyrics potrebbero andare in ritardo o in anticipo, la vita è un po' così...
          </div>
          <button type="button" class="np-lyrics__sync-toggle-btn ${isSynced ? 'active' : ''}" id="np-lyrics-sync-toggle" aria-label="Attiva o disattiva sincronizzazione tempo">
            <span id="np-sync-toggle-label">${isSynced ? '⚡ Sincronizzazione tempo: ATTIVA' : '⏱️ Sincronizzazione tempo: DISATTIVATA'}</span>
          </button>
        </div>
        <div class="np-lyrics__scroll-wrapper" id="np-lyrics-scroll">
          ${lines.map((l, i) => `<div class="np-lyrics__line" data-idx="${i}" data-time="${l.t}">${this.escapeHtml(l.text)}</div>`).join('')}
        </div>
        <button type="button" class="np-lyrics__resume-btn" id="np-lyrics-resume" aria-label="Torna alla strofa in onda">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="vertical-align:-1px;"><polyline points="7 13 12 18 17 13"></polyline><polyline points="7 6 12 11 17 6"></polyline></svg>
          <span>Torna al brano</span>
        </button>
      </div>
    `;

    document.getElementById('np-lyrics-sync-toggle')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.isTimeSyncEnabled = !this.isTimeSyncEnabled;
      localStorage.setItem('rc_lyrics_sync_enabled', String(this.isTimeSyncEnabled));

      const wrapper = container.querySelector('.np-lyrics--synced');
      const btn = document.getElementById('np-lyrics-sync-toggle');
      const lbl = document.getElementById('np-sync-toggle-label');

      if (this.isTimeSyncEnabled) {
        wrapper?.classList.remove('np-lyrics--manual');
        btn?.classList.add('active');
        if (lbl) lbl.textContent = '⚡ Sincronizzazione tempo: ATTIVA';
        this.resumeAutoScroll();
        this.tickLyricsSync();
      } else {
        wrapper?.classList.add('np-lyrics--manual');
        btn?.classList.remove('active');
        if (lbl) lbl.textContent = '⏱️ Sincronizzazione tempo: DISATTIVATA';
        container.querySelectorAll('.np-lyrics__line--active').forEach(el => el.classList.remove('np-lyrics__line--active'));
      }
    });

    // Rilevamento interazione di scorrimento manuale dell'utente (rotella, tocco o trascinamento)
    // Permette di cercare e leggere qualsiasi strofa senza che la strofa successiva forzi il ricentramento!
    const scrollWrapper = document.getElementById('np-lyrics-scroll');
    const resumeBtn = document.getElementById('np-lyrics-resume');

    const markUserScrolling = () => {
      if (!this.isTimeSyncEnabled) return;
      this.isUserScrolling = true;
      if (resumeBtn) resumeBtn.classList.add('np-lyrics__resume-btn--visible');

      if (this.userScrollTimer) clearTimeout(this.userScrollTimer);
      // Dopo 8 secondi di inattività dello scroll, riprende l'auto-scroll
      this.userScrollTimer = setTimeout(() => {
        this.resumeAutoScroll();
      }, 8000);
    };

    scrollWrapper?.addEventListener('wheel', () => markUserScrolling(), { passive: true });
    scrollWrapper?.addEventListener('touchstart', () => markUserScrolling(), { passive: true });
    scrollWrapper?.addEventListener('touchmove', () => markUserScrolling(), { passive: true });

    resumeBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.resumeAutoScroll();
    });

    container.querySelectorAll('.np-lyrics__line').forEach(lineEl => {
      lineEl.style.cursor = 'pointer';
      lineEl.setAttribute('title', 'Clicca per allineare il brano a questa riga');
      lineEl.addEventListener('click', (e) => {
        if (!this.isTimeSyncEnabled) return;
        e.stopPropagation();
        const lineTime = parseFloat(lineEl.dataset.time);
        if (!isNaN(lineTime)) {
          this.trackStartTime = Date.now() - (lineTime * 1000) + 5000;
          this.resumeAutoScroll();
          this.tickLyricsSync();
        }
      });
    });
  },

  startLyricsSync() {
    if (this.lyricsInterval) clearInterval(this.lyricsInterval);
    this.activeLyricIndex = -1;
    this.resumeAutoScroll();
    this.tickLyricsSync();
    this.lyricsInterval = setInterval(() => {
      this.tickLyricsSync();
    }, 150);
  },

  tickLyricsSync() {
    if (!this.isTimeSyncEnabled) return;
    if (!this.syncedLines || !this.syncedLines.length) return;
    const container = document.getElementById('np-lyrics-scroll');
    if (!container) return;

    // Tempo trascorso in secondi con compensazione standard automatica di +6.5s (anticipo di 1.5s)
    const elapsedSec = ((Date.now() - this.trackStartTime) / 1000) + (typeof this.delayOffset === 'number' ? this.delayOffset : 6.5);

    let activeIdx = -1;
    for (let i = 0; i < this.syncedLines.length; i++) {
      if (this.syncedLines[i].t <= elapsedSec) {
        activeIdx = i;
      } else {
        break;
      }
    }

    if (activeIdx !== this.activeLyricIndex) {
      this.activeLyricIndex = activeIdx;
      const allLines = container.querySelectorAll('.np-lyrics__line');
      allLines.forEach((el, i) => {
        if (i === activeIdx) {
          el.classList.add('np-lyrics__line--active');
          // Scorre automaticamente SOLO se l'utente non sta scorrendo o cercando liberamente altre strofe
          if (!this.isUserScrolling) {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        } else {
          el.classList.remove('np-lyrics__line--active');
        }
      });
    }
  },
};

function updateSlidingText(container, newHtml) {
  if (!container) return;
  if (container.dataset.currentValue === newHtml) return;
  container.dataset.currentValue = newHtml;

  const currentActive = container.querySelector('.bento-slide-item');

  if (!currentActive) {
    container.innerHTML = `<div class="bento-slide-item" style="position: relative; transform: translateX(0); opacity: 1;">${newHtml}</div>`;
    return;
  }

  const newItem = document.createElement('div');
  newItem.className = 'bento-slide-item';
  newItem.innerHTML = newHtml;

  newItem.style.position = 'absolute';
  newItem.style.left = '0';
  newItem.style.top = '0';
  newItem.style.width = '100%';
  newItem.style.opacity = '0';
  newItem.style.transform = 'translateX(40px)';

  currentActive.style.position = 'absolute';
  currentActive.style.left = '0';
  currentActive.style.top = '0';
  currentActive.style.width = '100%';

  container.appendChild(newItem);

  const currentHeight = container.offsetHeight;
  container.style.height = `${currentHeight}px`;

  newItem.offsetHeight;

  currentActive.style.transform = 'translateX(-40px)';
  currentActive.style.opacity = '0';

  newItem.style.transform = 'translateX(0)';
  newItem.style.opacity = '1';

  setTimeout(() => {
    newItem.style.position = 'relative';
    newItem.style.left = '';
    newItem.style.top = '';
    newItem.style.width = '';

    container.style.height = '';

    if (currentActive.parentNode === container) {
      container.removeChild(currentActive);
    }
  }, 500);
}

function initBento() {
  const timeEl = document.getElementById('bento-time');
  const msgEl = document.getElementById('bento-msg');
  const dayEl = document.getElementById('bento-day');
  const monthEl = document.getElementById('bento-month');
  const canvasEl = document.getElementById('bento-news-canvas');

  if (!timeEl || !msgEl || !dayEl || !monthEl || !canvasEl) return;

  function updateClock() {
    const now = new Date();
    const hours = now.getHours().toString().padStart(2, '0');
    const minutes = now.getMinutes().toString().padStart(2, '0');
    const timeStr = `${hours}:${minutes}`;

    updateSlidingText(timeEl, timeStr);

    if (!timeEl.dataset.cynicalSet) {
      const morningQuotes = [
        'BUONGIORNO... AL TUO BAR DI FIDUCIA I CORNETTI COSTANO SEMPRE LO STESSO.',
        'SVEGLIA! IL CAFFÈ NON SI BEVE DA SOLO.',
        'BUONGIORNO, SI FA PER DIRE.',
        'PRONTI PER FINGERE DI LAVORARE ANCHE OGGI?'
      ];
      const afternoonQuotes = [
        'BUON POMERIGGIO. SÌ, MANCA ANCORA MOLTO ALLA FINE.',
        'PAUSA CAFFÈ? NO, CONTINUA A SOFFRIRE.',
        'RESISTI, LA GIORNATA È QUASI FINITA. (MENTE)'
      ];
      const eveningQuotes = [
        'BUONASERA. ABBIAMO SMESSO DI PROVARCI PER OGGI?',
        'FINALMENTE SUL DIVANO? ERA ORA.',
        'BUONASERA. DISINTOSSICATI DAGLI SCHERMI (MENTRE GUARDI QUESTO SCHERMO).'
      ];
      const nightQuotes = [
        'BUONANOTTE. DOMANI SARÀ UGUALE A OGGI.',
        'DORMIRE È DA DEBOLI. MA TU VAI PURE.',
        'SEI ANCORA SVEGLIO? I FANTASMI TI OSSERVANO.',
        'BUONANOTTE. LE TUE SCELTE DI VITA TI TENGONO SVEGLIO?'
      ];

      let quote = '';
      const hrs = now.getHours();
      if (hrs >= 5 && hrs < 12) quote = morningQuotes[Math.floor(Math.random() * morningQuotes.length)];
      else if (hrs >= 12 && hrs < 18) quote = afternoonQuotes[Math.floor(Math.random() * afternoonQuotes.length)];
      else if (hrs >= 18 && hrs < 22) quote = eveningQuotes[Math.floor(Math.random() * eveningQuotes.length)];
      else quote = nightQuotes[Math.floor(Math.random() * nightQuotes.length)];

      updateSlidingText(msgEl, quote);
      timeEl.dataset.cynicalSet = 'true';
    }
  }

  function updateDate() {
    const now = new Date();
    const dayStr = now.getDate().toString().padStart(2, '0');
    const months = ['GENNAIO', 'FEBBRAIO', 'MARZO', 'APRILE', 'MAGGIO', 'GIUGNO', 'LUGLIO', 'AGOSTO', 'SETTEMBRE', 'OTTOBRE', 'NOVEMBRE', 'DICEMBRE'];
    const monthStr = `${months[now.getMonth()]} ${now.getFullYear()}`;

    updateSlidingText(dayEl, dayStr);
    updateSlidingText(monthEl, monthStr);
  }

  window.updateBento = function(forceAnim = false) {
    if (forceAnim) {
      delete timeEl.dataset.currentValue;
      delete msgEl.dataset.currentValue;
      delete dayEl.dataset.currentValue;
      delete monthEl.dataset.currentValue;
      delete timeEl.dataset.cynicalSet;
    }
    updateClock();
    updateDate();
  };

  let newsInterval;
  async function fetchNews() {
    try {

      if (SITE_CFG && SITE_CFG.sections && SITE_CFG.sections.news === false) return;
      const rssUrl = (SITE_CFG && SITE_CFG.news && SITE_CFG.news.rssUrl) || 'https://www.ansa.it/sito/ansait_rss.xml';
      const res = await fetch(`https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(rssUrl)}`);
      if (!res.ok) throw new Error('API RSS Error');
      const data = await res.json();
      if (data && data.items && data.items.length > 0) {
        const newsItems = data.items.slice(0, 10);
        canvasEl.innerHTML = newsItems.map((item, i) => {
          const safeTitle = escapeHtml(item.title);
          const query = encodeURIComponent(item.title);
          return `<a href="https://www.google.com/search?q=${query}" target="_blank" rel="noopener" class="bento-news__item ${i === 0 ? 'active' : ''}">${safeTitle}</a>`;
        }).join('');

        let currentIndex = 0;
        const items = canvasEl.querySelectorAll('.bento-news__item');
        if (items.length > 1) {
          clearInterval(newsInterval);
          newsInterval = setInterval(() => {
            items[currentIndex].classList.remove('active');
            items[currentIndex].classList.add('exit');
            let prevIndex = currentIndex;
            currentIndex = (currentIndex + 1) % items.length;
            items[currentIndex].classList.remove('exit');
            items[currentIndex].classList.add('active');
            setTimeout(() => { items[prevIndex].classList.remove('exit'); }, 1000); 
          }, 6000); 
        }
      } else {
        throw new Error('Empty news');
      }
    } catch (e) {
      dwarn('[News] Fetch failed, using fallback:', e);
      const fallbackNews = [
        'Radio Carducci online 24/7 con i nuovi programmi degli studenti',
        'Podcast e interviste disponibili nella sezione dedicata',
        'Inviaci la tua dedica per la prossima diretta radiofonica',
        'Carducci Wrapped 2025 disponibile ora'
      ];
      canvasEl.innerHTML = fallbackNews.map((title, i) => `
        <div class="bento-news__item ${i === 0 ? 'active' : ''}">${escapeHtml(title)}</div>
      `).join('');
    }
  }

  updateClock();
  updateDate();
  fetchNews();
  setInterval(updateClock, 1000 * 60); 
}

function initLogoIris() {
  const logo = document.getElementById('nav-animated-logo');
  const iris = document.getElementById('nav-animated-iris');
  if (!logo || !iris) return;
  const W = 101.34, H = 93.08, EX = 84.9, EY = 13.5, MX = 2.5, MY = 1.8;
  const DIST = 400, SPEED = 0.14, EPS = 0.004, IDLE = 3000;
  let tx=0,ty=0,cx=0,cy=0,raf=null,idleT=null,blinking=false;
  const lerp = (a,b,t)=>a+(b-a)*t;
  function tick(){
    cx=lerp(cx,tx,SPEED); cy=lerp(cy,ty,SPEED);
    iris.setAttribute('cx', EX+cx); iris.setAttribute('cy', EY+cy);
    raf = (Math.abs(cx-tx)>EPS||Math.abs(cy-ty)>EPS) ? requestAnimationFrame(tick) : null;
  }
  function run(){ if(!raf) raf=requestAnimationFrame(tick); }
  function aim(x,y){
    const r=logo.getBoundingClientRect();

    const ratioX = r.width/W;
    const ratioY = r.height/H;
    const dx=x-(r.left+EX*ratioX), dy=y-(r.top+EY*ratioY);
    const d=Math.hypot(dx,dy), f=Math.min(d/DIST,1), a=Math.atan2(dy,dx);
    tx=Math.cos(a)*MX*f; ty=Math.sin(a)*MY*f; run();
  }
  function resetIdle(){ clearTimeout(idleT); idleT=setTimeout(()=>{tx=0;ty=0;run();},IDLE); }
  function onP(x,y){ aim(x,y); resetIdle(); }
  document.addEventListener('mousemove', e=>onP(e.clientX,e.clientY));
  document.addEventListener('touchmove', e=>onP(e.touches[0].clientX,e.touches[0].clientY),{passive:true});
  function blink(cb){
    iris.style.transition='ry 0.07s ease-in'; iris.setAttribute('ry','0.35');
    setTimeout(()=>{ iris.style.transition='ry 0.12s cubic-bezier(0.34,1.56,0.64,1)'; iris.setAttribute('ry','4.2'); setTimeout(cb,130); },110);
  }
  function sched(){ if(blinking)return; setTimeout(()=>{ blinking=true; blink(()=>{ if(Math.random()<0.25){ setTimeout(()=>blink(()=>{blinking=false;sched();}),100); }else{ blinking=false;sched(); } }); }, 2000+Math.random()*4000); }
  sched();
}

var preferitiAudio = null;
var currentPreviewTrack = null;

// ═══════════════════════════════════════════════════════════════
// UN SOLO AUDIO ALLA VOLTA: diretta, podcast e anteprime Preferiti
// Quando uno parte (da qualsiasi pulsante, anche dalla schermata di blocco)
// gli altri si fermano.
// ═══════════════════════════════════════════════════════════════
function pauseOtherAudio(e) {
  const started = e.target;
  const live = document.getElementById('rc-audio');
  const pod = document.getElementById('podcast-audio');
  [live, pod].forEach(a => { if (a && a !== started && !a.paused) a.pause(); });
  if (preferitiAudio && preferitiAudio !== started && !preferitiAudio.paused) {
    if (typeof window.__stopPreferitiPreview === 'function') window.__stopPreferitiPreview();
    else preferitiAudio.pause();
  }
}

function initExclusiveAudio() {
  const live = document.getElementById('rc-audio');
  const pod = document.getElementById('podcast-audio');
  if (live) live.addEventListener('play', pauseOtherAudio);
  if (pod) {
    pod.addEventListener('play', pauseOtherAudio);
    // Il pulsante del podcast segue lo stato reale dell'audio
    const setIcon = icon => {
      const btn = document.getElementById('pm-play-btn');
      if (!btn) return;
      btn.innerHTML = `<i data-lucide="${icon}" width="22" height="22"></i>`;
      if (typeof lucide !== 'undefined') lucide.createIcons();
    };
    pod.addEventListener('play', () => setIcon('pause'));
    pod.addEventListener('pause', () => setIcon('play'));
  }
}

// Pannello info brano: pulsante play/pausa della diretta, allineato alla barra del player
function initNpPlayButton() {
  const npBtn = document.getElementById('np-play-btn');
  const barBtn = document.querySelector('.player-bar__play');
  if (!npBtn || !barBtn) return;
  const label = npBtn.querySelector('span:not(.np-overlay__play-icon)');
  const sync = () => {
    const playing = barBtn.classList.contains('player-bar__play--playing');
    npBtn.classList.toggle('np-overlay__play--playing', playing);
    npBtn.setAttribute('aria-label', playing ? 'Metti in pausa la diretta' : 'Ascolta la diretta');
    if (label) label.textContent = playing ? 'Pausa' : 'Ascolta la diretta';
  };
  npBtn.addEventListener('click', () => barBtn.click());
  new MutationObserver(sync).observe(barBtn, { attributes: true, attributeFilter: ['class'] });
  sync();
}

// ═══════════════════════════════════════════════════════════════
// SITE CONFIG — contenuti del sito gestiti da site-tool.html (R2)
// Se il file non è raggiungibile restano i testi scritti in index.html.
// ═══════════════════════════════════════════════════════════════
let SITE_CFG = null;
let _siteCfgRaw = '';

function siteGet(obj, path) {
  return String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

// Testo semplice con a capo e *corsivo*
function siteRich(text) {
  return escapeHtml(text || '').replace(/\n/g, '<br>').replace(/\*([^*]+)\*/g, '<em>$1</em>');
}

async function loadSiteConfig() {
  try {
    const res = await fetch(`${SITE_CONFIG_URL}?_=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return;
    const raw = await res.text();
    if (raw === _siteCfgRaw) return;          // nessuna modifica
    const cfg = JSON.parse(raw);
    _siteCfgRaw = raw;
    SITE_CFG = cfg;
    applySiteConfig(cfg);
  } catch (e) {
    dwarn('[SiteConfig] Non disponibile, uso i testi di default:', e);
  }
}

function applySiteConfig(cfg) {
  // Testi semplici
  document.querySelectorAll('[data-rc]').forEach(el => {
    const v = siteGet(cfg, el.getAttribute('data-rc'));
    if (typeof v === 'string') el.textContent = v;
  });
  // Testi con a capo / corsivo
  document.querySelectorAll('[data-rc-rich]').forEach(el => {
    const v = siteGet(cfg, el.getAttribute('data-rc-rich'));
    if (typeof v === 'string') el.innerHTML = siteRich(v);
  });
  // Modelli con segnaposto, es. "RC / {season}"
  document.querySelectorAll('[data-rc-tpl]').forEach(el => {
    const tpl = el.getAttribute('data-rc-tpl');
    const out = tpl.replace(/\{([\w.]+)\}/g, (m, k) => {
      const v = siteGet(cfg, k);
      return (v === undefined || v === null) ? m : String(v);
    });
    if (!/\{[\w.]+\}/.test(out)) el.textContent = out;
  });
  // Link
  document.querySelectorAll('[data-rc-href]').forEach(el => {
    const v = siteGet(cfg, el.getAttribute('data-rc-href'));
    // Link completi o pagine del sito (es. privacy.html); il vecchio indirizzo WordPress porta alla pagina nuova
    if (typeof v === 'string' && /\/privacy-policy\/?$/.test(v)) el.href = 'privacy.html';
    else if (typeof v === 'string' && (/^https?:/.test(v) || /^[\w\-/.]+\.html(#.*)?$/.test(v))) el.href = v;
  });
  // Elementi mostrati solo se il valore c'è (es. link Privacy)
  document.querySelectorAll('[data-rc-if]').forEach(el => {
    const v = siteGet(cfg, el.getAttribute('data-rc-if'));
    el.style.display = (typeof v === 'string' && v.trim()) ? '' : 'none';
  });

  // Sezioni on/off
  const sections = cfg.sections || {};
  document.querySelectorAll('[data-rc-section]').forEach(el => {
    const key = el.getAttribute('data-rc-section');
    el.style.display = sections[key] === false ? 'none' : '';
  });
  if (sections.wrapped === false) {
    document.querySelectorAll('.preferiti__open-wrapped-cta').forEach(b => b.style.display = 'none');
  }

  // Nastro scorrevole (ripetuto due volte per lo scorrimento continuo)
  const ticker = document.getElementById('rc-ticker');
  if (ticker && Array.isArray(cfg.ticker) && cfg.ticker.length) {
    const once = cfg.ticker.filter(t => t && t.trim())
      .map(t => `<span>${escapeHtml(t.trim())}</span><span class="sep">·</span>`).join('');
    ticker.innerHTML = once + once;
  }

  // Manifesto: frase "vera" + link facoltativo
  const items = (cfg.manifesto && cfg.manifesto.items) || [];
  document.querySelectorAll('[data-rc-truth]').forEach(el => {
    const it = items[Number(el.getAttribute('data-rc-truth'))];
    if (!it) return;
    let html = escapeHtml(it.truth || '');
    if (it.linkUrl && /^https?:/.test(it.linkUrl)) {
      html += `<br><a href="${escapeHtml(it.linkUrl)}" target="_blank" rel="noopener" class="manifesto__map-link">${escapeHtml(it.linkLabel || 'link')}</a>`;
    }
    el.innerHTML = html;
  });

  // Licenza SIAE in fondo alla riga del copyright (footer.siae, gestita dal tool)
  const siaeEl = document.getElementById('footer-siae');
  if (siaeEl) {
    const siae = (cfg.footer?.siae || '').trim();
    siaeEl.textContent = siae ? ` · ${siae}` : '';
  }

  // Nota podcast: nascosta se vuota
  const note = document.getElementById('podcast-note');
  if (note && cfg.podcasts) note.style.display = (cfg.podcasts.note || '').trim() ? '' : 'none';

  applyDedicheState();
  updateOnAir();
}

// Dediche: aperte solo se attivate dal tool E se c'è un endpoint Formspree in meta
function applyDedicheState() {
  const box = document.querySelector('.dediche__disabled-box');
  const form = document.getElementById('dedica-form');
  if (!box || !form) return;
  const endpoint = APP_CONFIG && APP_CONFIG.meta && APP_CONFIG.meta.formspree;
  const open = !!(SITE_CFG && SITE_CFG.dediche && SITE_CFG.dediche.open && endpoint);
  box.style.display = open ? 'none' : '';
  if (form.dataset.sent === '1') return;
  form.style.display = open ? '' : 'none';
  form.setAttribute('aria-hidden', open ? 'false' : 'true');
  form.querySelectorAll('input, textarea, button').forEach(el => { el.disabled = !open; });
}

// Contatori automatici
function updateCountLabels() {
  const pc = document.getElementById('podcast-count-label');
  if (pc) pc.textContent = `${PODCASTS.length} SHOW`;
  const tc = document.getElementById('team-count-label');
  if (tc && TEAM.length) tc.textContent = `${TEAM.length} MEMBRI · STRUTTURA UFFICIALE`;
}

// Card "On Air": programma in onda adesso secondo il palinsesto
function parseSlotRange(time) {
  const m = String(time || '').match(/(\d{1,2}):(\d{2})\s*[–-]\s*(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return { start: (+m[1]) * 60 + (+m[2]), end: (+m[3]) * 60 + (+m[4]) };
}

function updateOnAir() {
  const titleEl = document.getElementById('on-air-title');
  const metaEl = document.getElementById('on-air-meta');
  const nextEl = document.getElementById('on-air-next');
  if (!titleEl || !metaEl || !nextEl) return;

  const now = new Date();
  const mins = now.getHours() * 60 + now.getMinutes();
  const slots = (SCHEDULE[DAY_KEYS[now.getDay()]] || [])
    .map(s => ({ s, r: parseSlotRange(s.time) }))
    .filter(x => x.r)
    .sort((a, b) => a.r.start - b.r.start);
  const isAllDay = x => (x.r.end - x.r.start) >= 23 * 60;
  const startOf = x => x.s.time.split(/\s*[–-]\s*/)[0];

  // In onda: vince il programma più corto (una diretta dentro la giornata musicale)
  const current = slots.filter(x => mins >= x.r.start && mins < x.r.end)
    .sort((a, b) => (a.r.end - a.r.start) - (b.r.end - b.r.start))[0];
  const next = slots.find(x => x.r.start > mins && !isAllDay(x));

  if (current) {
    titleEl.textContent = current.s.name;
    metaEl.textContent = isAllDay(current) ? 'IN DIRETTA · 24 ORE SU 24' : `IN DIRETTA · ${current.s.time}`;
    if (next) nextEl.textContent = isAllDay(current) ? `Oggi alle ${startOf(next)}: ${next.s.name}` : `A seguire: ${next.s.name} · ${next.s.time}`;
    else nextEl.textContent = current.s.desc || 'Musica selezionata dalla redazione.';
  } else {
    // Nessun programma in palinsesto in questo momento
    titleEl.textContent = 'Radio Carducci';
    metaEl.textContent = 'IN DIRETTA · RADIOCARDUCCI.COM';
    nextEl.textContent = next ? `Oggi alle ${startOf(next)}: ${next.s.name}` : 'Musica selezionata dalla redazione.';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  console.log('%cRadio Carducci%c > Accesso eseguito. Speriamo tu abbia buon gusto musicale, altrimenti siamo nei guai.', 'color: #bd163d; font-weight: bold; font-size: 16px;', 'color: inherit; font-style: italic;');

  initPlayer();
  initTabBar();
  initExclusiveAudio();
  initNpPlayButton();
  initBento();
  initLogoIris();
  initHeadline();
  initBacheca();
  initPreferiti();
  initWrappedInPage();
  initPalinsesto();
  initPodcasts();
  initTeam();
  initMobileMenu();
  initDedicaForm();
  initManifestoDoubt();
  initWatermark();
  initSmoothScroll();
  initScrollAnimations();
  initScrollProgress();
  initStaggerAnimations();
  window.NowPlaying = NowPlaying;
  if (typeof NowPlaying !== 'undefined' && NowPlaying.init) NowPlaying.init();
  initEasterEggs();
  if (typeof BgMusic !== 'undefined') BgMusic.init();
  initCookieBanner();
  initOnboardingTutorial();
  initHeroCanvas();

  // Caricamento configurazione remota da Cloudflare R2
  loadConfig();
  loadSiteConfig();
  setInterval(() => { loadConfig(); loadSiteConfig(); }, 60000);
  setInterval(updateOnAir, 30000);
  updateOnAir();
  updateCountLabels();
  
  if (typeof lucide !== 'undefined') lucide.createIcons();

  // Animazione finta barra preloader
  const preloaderBar = document.querySelector('.preloader__bar');
  const preloaderPercent = document.getElementById('preloader-percent');
  const preloaderText = document.getElementById('preloader-text');
  if (preloaderBar && preloaderPercent && preloaderText) {
    let p = 0;
    const interval = setInterval(() => {
      p += Math.random() * 15;
      if (p >= 90) {
        p = 90;
        clearInterval(interval);
      }
      preloaderBar.style.width = p + '%';
      preloaderPercent.textContent = Math.floor(p) + '%';
      if (p > 50) preloaderText.textContent = 'CARICAMENTO PODCAST...';
    }, 150);
  }

  window.addEventListener('load', () => {
    const loader = document.getElementById('rc-preloader');
    if (loader) {
      if (preloaderBar) preloaderBar.style.width = '100%';
      if (preloaderPercent) preloaderPercent.textContent = '100%';
      if (preloaderText) preloaderText.textContent = 'SISTEMA ONLINE';
      setTimeout(() => {
        loader.classList.add('preloader--loaded');
      }, 400);
    }
  });
});

const ExploreMode = {
  overlay: null,
  hud: null,
  interval: null,
  active: false,
  mouseX: 0,
  mouseY: 0,

  init() {
    this.overlay = document.createElement('div');
    this.overlay.className = 'explore-overlay';

    this.hud = document.createElement('div');
    this.hud.className = 'explore-hud';

    const exitBtn = document.createElement('button');
    exitBtn.style.cssText = "display: block; width: 100%; margin-bottom: 8px; background: #bd163d; color: #fff; border: 1px solid #bd163d; padding: 4px 8px; font-family: var(--font-mono); font-size: 10px; cursor: pointer; pointer-events: auto; text-align: left;";
    exitBtn.textContent = "[X] TERMINATE_CONNECTION";
    exitBtn.addEventListener('click', () => {
      const exploreBtn = document.querySelector('.nav__explore');
      if (exploreBtn) exploreBtn.click(); 
    });

    this.hudText = document.createElement('div');

    this.hud.appendChild(exitBtn);
    this.hud.appendChild(this.hudText);
    this.overlay.appendChild(this.hud);

    window.addEventListener('resize', () => this.updateHud());
    window.addEventListener('scroll', () => this.updateHud());
    window.addEventListener('mousemove', (e) => {
      this.mouseX = e.clientX;
      this.mouseY = e.clientY;
      if (this.active) this.updateHud();
    });
  },

  start() {
    if (!this.overlay) this.init();
    document.body.appendChild(this.overlay);
    this.active = true;
    this.updateHud();
    this.interval = setInterval(() => this.spawnLabels(), 2000);
  },

  stop() {
    if (this.overlay && this.overlay.parentNode) {
      this.overlay.parentNode.removeChild(this.overlay);
    }
    this.active = false;
    clearInterval(this.interval);
    document.querySelectorAll('.explore-node-label').forEach(el => el.remove());
  },

  updateHud() {
    if (!this.active) return;
    const w = window.innerWidth;
    const h = window.innerHeight;
    const scrollY = window.scrollY;
    const nodes = document.querySelectorAll('*').length;

    const mem = performance.memory ? (performance.memory.usedJSHeapSize / 1048576).toFixed(2) + ' MB' : '14.2 MB';
    const conn = (navigator.connection && navigator.connection.effectiveType) ? navigator.connection.effectiveType.toUpperCase() : 'UNKNOWN';
    const vol = document.querySelector('.player-bar__volume')?.value || '100';

    this.hudText.innerHTML = `
      <div style="color: #666; margin-bottom: 4px; font-weight: bold;">// SYSTEM_OVERRIDE_ACTIVE</div>
      VIEWPORT: ${w}x${h}px<br>
      DOC_HEIGHT: ${document.body.scrollHeight}px<br>
      SCROLL_Y: ${Math.round(scrollY)}px<br>
      CURSOR_POS: [${this.mouseX}, ${this.mouseY}]<br>
      <br>
      <div style="color: #666; margin-bottom: 4px; font-weight: bold;">// TELEMETRY</div>
      DOM_NODES: ${nodes}<br>
      MEMORY_JS: ${mem}<br>
      NET_TYPE: ${conn}<br>
      PROTOCOL: ${window.location.protocol.replace(':','')}<br>
      <br>
      <div style="color: #666; margin-bottom: 4px; font-weight: bold;">// AUDIO_CONTEXT</div>
      BUFFER: LOBBY.MP3<br>
      STATE: FORCED_PLAYBACK<br>
      GAIN: ${vol}%
    `;
  },

  spawnLabels() {
    if (!this.active) return;
    document.querySelectorAll('.explore-node-label').forEach(el => el.remove());

    const elements = Array.from(document.querySelectorAll('div, section, header, nav, button, a, article, footer, aside, span, img, p, h1, h2')).filter(el => {
      const rect = el.getBoundingClientRect();

      return rect.top >= 0 && rect.bottom <= window.innerHeight && rect.width > 20 && rect.height > 10;
    });

    const maxLabels = window.innerWidth < 768 ? 4 : 12;
    for (let i = 0; i < Math.min(maxLabels, elements.length); i++) {
      const el = elements[Math.floor(Math.random() * elements.length)];
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);

      const label = document.createElement('div');
      label.className = 'explore-node-label';
      label.style.left = (rect.left + window.scrollX) + 'px';
      label.style.top = (rect.top + window.scrollY - (Math.random() * 20)) + 'px';

      let classText = '';
      if (el.className && typeof el.className === 'string') {
        const cls = el.className.split(' ').filter(c => c && !c.includes('explore-node-label'))[0];
        if (cls) classText = '.' + cls;
      }

      let w = Math.round(rect.width);
      let h = Math.round(rect.height);

      label.innerHTML = `
        <span style="color:#888; font-weight:bold;">&lt;${el.tagName.toLowerCase()}${classText}&gt;</span><br>
        DIM: [${w}x${h}]<br>
        POS: (${Math.round(rect.left)}, ${Math.round(rect.top)})<br>
        DISP: ${style.display.toUpperCase()}
      `;
      document.body.appendChild(label);
    }
  }
};

function initCookieBanner() {
  const banner = document.getElementById('rc-cookie-banner');
  const acceptBtn = document.getElementById('cookie-accept-all');
  const rejectBtn = document.getElementById('cookie-reject');

  if (!banner || !acceptBtn || !rejectBtn) return;

  const consent = localStorage.getItem('rc_cookie_consent');
  if (!consent) {
    banner.style.display = 'block';
    banner.setAttribute('aria-hidden', 'false');
  }

  const hideBanner = (choice) => {
    localStorage.setItem('rc_cookie_consent', choice);
    banner.style.display = 'none';
    banner.setAttribute('aria-hidden', 'true');
  };

  acceptBtn.addEventListener('click', () => hideBanner('accept'));
  rejectBtn.addEventListener('click', () => hideBanner('reject'));
}

function initEasterEggs() {
  console.log(`%c
   ██████╗  █████╗ ██████╗ ██╗ ██████╗ 
   ██╔══██╗██╔══██╗██╔══██╗██║██╔═══██╗
   ██████╔╝███████║██║  ██║██║██║   ██║
   ██╔══██╗██╔══██║██║  ██║██║██║   ██║
   ██║  ██║██║  ██║██████╔╝██║╚██████╔╝
   ╚═╝  ╚═╝╚═╝  ╚═╝╚═════╝ ╚═╝ ╚═════╝ 
    C A R D U C C I   W E B   R A D I O
  `, 'color: #db3849; font-weight: bold;');
  console.log('%cGuardare il codice non ti renderà uno speaker migliore. Chiudi e ascolta.', 'color: #EBEBE6; background: #1E1F1C; font-size: 14px; padding: 4px;');
}

// initBackgroundIntro rimosso



function initOnboardingTutorial() {
  if (localStorage.getItem('rc_tutorial_completed') === 'true') return;

  const overlay = document.createElement('div');
  overlay.className = 'tutorial-overlay';
  overlay.innerHTML = `
    <div class="tutorial-highlight-ring"></div>
    <div class="tutorial-card">
      <div class="tutorial-card__step"></div>
      <h3 class="tutorial-card__title"></h3>
      <p class="tutorial-card__text"></p>
      <div class="tutorial-card__nav">
        <button class="tutorial-card__btn btn-prev">Indietro</button>
        <button class="tutorial-card__btn btn-next">Avanti</button>
        <button class="tutorial-card__btn btn-skip">Salta</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const steps = [
    {
      title: "Benvenuto",
      text: "Benvenuto su Radio Carducci! Questa breve guida ti mostrerà come navigare e ascoltare la nostra radio.",
      target: null
    },
    {
      title: "Ascolta la Radio",
      text: "Clicca 'Ascolta ora' per avviare subito la diretta radio. Se la diretta è offline, te lo segnaleremo.",
      target: "#hero-play-cta"
    },
    {
      title: "Modalità Esplora",
      text: "Questo pulsante attiva una speciale visualizzazione tecnica del sito, accompagnata da una traccia sonora ambient futuristica.",
      target: ".nav__explore"
    },
    {
      title: "I nostri Podcast",
      text: "Qui trovi l'elenco di tutte le nostre trasmissioni. Clicca su un podcast per vederne i dettagli o per ascoltare le puntate.",
      target: "#podcast"
    },
    {
      title: "Il Palinsesto",
      text: "Controlla la programmazione settimanale. Il programma in onda in questo momento è evidenziato in rosso lampeggiante.",
      target: "#palinsesto"
    },
    {
      title: "Redazione e Staff",
      text: "Scopri chi c'è dietro il microfono e alla regia di Radio Carducci.",
      target: "#team"
    },
    {
      title: "Pronto ad ascoltare?",
      text: "Il tour è finito! Mettiti comodo ed esplora la radio degli studenti del Liceo Carducci.",
      target: null
    }
  ];

  let currentStep = 0;

  const ring = overlay.querySelector('.tutorial-highlight-ring');
  const card = overlay.querySelector('.tutorial-card');
  const stepLabel = overlay.querySelector('.tutorial-card__step');
  const titleLabel = overlay.querySelector('.tutorial-card__title');
  const textLabel = overlay.querySelector('.tutorial-card__text');
  const btnPrev = overlay.querySelector('.btn-prev');
  const btnNext = overlay.querySelector('.btn-next');
  const btnSkip = overlay.querySelector('.btn-skip');

  const handleResize = () => {
    if (overlay.parentNode) {
      showStep(currentStep);
    }
  };
  window.addEventListener('resize', handleResize);

  function showStep(index) {
    if (index < 0 || index >= steps.length) return;
    currentStep = index;

    const step = steps[index];
    stepLabel.textContent = `${index + 1}/${steps.length}`;
    titleLabel.textContent = step.title;
    textLabel.textContent = step.text;

    btnPrev.style.display = index === 0 ? 'none' : 'block';
    btnNext.textContent = index === steps.length - 1 ? 'Fine' : 'Avanti';

    if (step.target) {
      const targetEl = document.querySelector(step.target);
      if (targetEl) {
        targetEl.scrollIntoView({ behavior: 'auto', block: 'center' });

        setTimeout(() => {
          const rect = targetEl.getBoundingClientRect();
          const padding = 10;
          ring.style.display = 'block';
          ring.style.width = (rect.width + padding * 2) + 'px';
          ring.style.height = (rect.height + padding * 2) + 'px';
          ring.style.left = (rect.left - padding) + 'px';
          ring.style.top = (rect.top - padding) + 'px';
          
          positionCard(rect);
        }, 100);
      } else {
        showNoTarget();
      }
    } else {
      showNoTarget();
    }
  }

  function showNoTarget() {
    ring.style.display = 'none';
    card.style.left = '50%';
    card.style.top = '50%';
    card.style.transform = 'translate(-50%, -50%)';
  }

  function positionCard(targetRect) {
    const cardRect = card.getBoundingClientRect();
    const spaceBelow = window.innerHeight - targetRect.bottom;
    const spaceAbove = targetRect.top;

    let left = targetRect.left + (targetRect.width - cardRect.width) / 2;
    if (left < 10) left = 10;
    if (left + cardRect.width > window.innerWidth - 10) {
      left = window.innerWidth - cardRect.width - 10;
    }

    let top;
    if (spaceBelow > cardRect.height + 30) {
      top = targetRect.bottom + 15;
    } else if (spaceAbove > cardRect.height + 30) {
      top = targetRect.top - cardRect.height - 15;
    } else {
      top = targetRect.top + (targetRect.height - cardRect.height) / 2;
    }

    card.style.left = left + 'px';
    card.style.top = top + 'px';
    card.style.transform = 'none';
  }

  function finishTour() {
    window.removeEventListener('resize', handleResize);
    document.documentElement.style.scrollBehavior = '';
    overlay.classList.remove('tutorial-overlay--active');
    document.body.classList.remove('tutorial-active');
    setTimeout(() => {
      overlay.remove();
      localStorage.setItem('rc_tutorial_completed', 'true');
    }, 300);
  }

  btnNext.addEventListener('click', () => {
    if (currentStep === steps.length - 1) {
      finishTour();
    } else {
      showStep(currentStep + 1);
    }
  });

  btnPrev.addEventListener('click', () => {
    showStep(currentStep - 1);
  });

  btnSkip.addEventListener('click', finishTour);

  setTimeout(() => {
    overlay.style.display = 'block';
    setTimeout(() => {
      document.documentElement.style.scrollBehavior = 'auto';
      overlay.classList.add('tutorial-overlay--active');
      document.body.classList.add('tutorial-active');
      showStep(0);
    }, 50);
  }, 3500);
}

function initHeroCanvas() {
  const canvas = document.getElementById('hero-canvas');
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  let animationFrameId;
  let width = 0;
  let height = 0;

  let mouse = { x: -1000, y: -1000, targetX: -1000, targetY: -1000 };
  
  function resize() {
    width = canvas.offsetWidth;
    height = canvas.offsetHeight;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);
  }

  window.addEventListener('resize', resize);
  resize();

  window.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    mouse.targetX = e.clientX - rect.left;
    mouse.targetY = e.clientY - rect.top;
  });

  const lerp = (a, b, t) => a + (b - a) * t;

  let time = 0;
  let currentFreq = 0.004;
  let currentSpeed = 0.05;
  let currentAmp = 40;

  function draw() {
    ctx.clearRect(0, 0, width, height);

    mouse.x = lerp(mouse.x, mouse.targetX, 0.08);
    mouse.y = lerp(mouse.y, mouse.targetY, 0.08);

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.015)';
    ctx.lineWidth = 1;
    const gridSize = 40;
    
    for (let x = 0; x < width; x += gridSize) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
    for (let y = 0; y < height; y += gridSize) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }

    let targetAmp = 25;
    let targetSpeed = 0.015;
    let targetFreq = 0.003;

    const audio = document.getElementById('rc-audio');
    const lobbyAudio = document.getElementById('lobby-audio');
    const isAudioPlaying = (audio && !audio.paused) || (lobbyAudio && !lobbyAudio.paused) || (typeof BgMusic !== 'undefined' && BgMusic.isPlaying);

    if (isAudioPlaying) {
      targetAmp = 65;
      targetSpeed = 0.055;
      targetFreq = 0.006;
    }

    currentAmp = lerp(currentAmp, targetAmp, 0.05);
    currentSpeed = lerp(currentSpeed, targetSpeed, 0.05);
    currentFreq = lerp(currentFreq, targetFreq, 0.05);

    time += currentSpeed;

    const wavesCount = 4;
    const colors = [
      'rgba(189, 22, 61, 0.65)',
      'rgba(110, 12, 36, 0.45)',
      'rgba(235, 235, 230, 0.15)',
      'rgba(189, 22, 61, 0.25)'
    ];

    for (let w = 0; w < wavesCount; w++) {
      ctx.beginPath();
      ctx.strokeStyle = colors[w];
      ctx.lineWidth = w === 0 ? 2 : 1;

      const centerY = height / 2;

      for (let x = 0; x < width; x += 8) {
        const phaseShift = w * (Math.PI / 2) + Math.sin(time * 0.1) * 0.5;
        const frequencyScale = currentFreq * (1 + w * 0.2);
        
        let angle = x * frequencyScale + time + phaseShift;
        let sineValue = Math.sin(angle);
        
        sineValue += Math.sin(angle * 2.3) * 0.35;
        sineValue += Math.cos(angle * 0.7) * 0.2;

        let amp = currentAmp * (1 - w * 0.18);

        const dx = x - mouse.x;
        const dy = centerY - mouse.y;
        const dist = Math.hypot(dx, dy);
        
        if (dist < 250) {
          const force = (1 - dist / 250);
          amp += force * 45;
          sineValue += Math.sin(x * 0.08 + time * 3) * force * 0.3;
        }

        const y = centerY + sineValue * amp;

        if (x === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.stroke();
    }

    ctx.font = '8px monospace';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.15)';
    
    const status = isAudioPlaying ? "ONLINE / TX_ACTIVE" : "STDBY / RX_SCANNING";
    const freq = isAudioPlaying ? "FREQ: 104.20 MHz" : `FREQ: ${(98.5 + Math.sin(time*0.05)*5).toFixed(2)} MHz`;
    
    ctx.fillText(`SYSTEM_STATUS: ${status}`, 20, 30);
    ctx.fillText(freq, 20, 45);
    ctx.fillText(`SIG_LEVEL: ${isAudioPlaying ? "-9.4 dB" : "-42.8 dB"}`, 20, 60);

    ctx.fillText(`SYS_TIME: ${new Date().toLocaleTimeString()}`, width - 150, 30);
    ctx.fillText(`RENDER_FLOW: ${(1000 / 16.6).toFixed(0)} FPS`, width - 150, 45);

    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!prefersReducedMotion) {
      animationFrameId = requestAnimationFrame(draw);
    }
  }

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        if (!animationFrameId) {
          draw();
        }
      } else {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
      }
    });
  }, { threshold: 0.1 });

  observer.observe(canvas);
}

function initWrappedInPage() {
  const overlay = document.getElementById('wrapped-view');
  const frame = document.getElementById('wrapped-frame');
  const closeBtn = document.getElementById('wrapped-view-close');
  if (!overlay || !frame) return;

  function openWrapped(e) {
    if (e) e.preventDefault();
    if (!frame.src || frame.src === 'about:blank' || !frame.src.includes('wrapped')) {
      frame.src = 'wrapped/';
    }
    overlay.classList.add('active');
    overlay.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';

    // Pause radio live audio if playing
    const rcAudio = document.getElementById('rc-audio');
    if (rcAudio && !rcAudio.paused) {
      const playBtn = document.querySelector('.player-bar__play');
      if (playBtn) playBtn.click();
    }
    // Pause preferiti preview audio if playing
    if (preferitiAudio && !preferitiAudio.paused) {
      preferitiAudio.pause();
    }
  }

  function closeWrapped() {
    overlay.classList.remove('active');
    overlay.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';

    // Stop all audio inside wrapped iframe immediately
    try {
      frame.contentWindow?.postMessage({ type: 'rc-stop-audio' }, '*');
      const iframeAudio = frame.contentDocument?.querySelector('audio');
      if (iframeAudio) {
        iframeAudio.pause();
        iframeAudio.currentTime = 0;
      }
    } catch(e) {}

    // Reset iframe to completely stop all background audio/scripts
    frame.src = 'about:blank';

    window.dispatchEvent(new Event('rc-liked-tracks-updated'));
  }

  document.addEventListener('click', (e) => {
    const wrappedLink = e.target.closest('a[href*="wrapped"], .open-wrapped-inpage');
    if (wrappedLink) {
      e.preventDefault();
      e.stopPropagation();
      openWrapped(e);
    }
  });

  if (closeBtn) closeBtn.addEventListener('click', closeWrapped);

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay.classList.contains('active')) {
      closeWrapped();
    }
  });

  window.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'rc-track-liked') {
      window.dispatchEvent(new Event('rc-liked-tracks-updated'));
    }
  });
}

function initPreferiti() {
  window.initPreferiti = initPreferiti;
  const container = document.getElementById('preferiti-container');
  const countBadge = document.getElementById('preferiti-count-badge');
  if (!container) {
    console.warn('[Preferiti] Container not found');
    return;
  }
  console.log('[Preferiti] container found, initializing');

  let allWrappedTracks = [];
  let currentFilter = 'all'; // 'all' | 'saved'

  // Audio preview element
  if (!preferitiAudio) {
    preferitiAudio = new Audio();
    preferitiAudio.preload = 'none';
    preferitiAudio.addEventListener('play', pauseOtherAudio);
  }

  async function loadWrappedTracks() {
    try {
      let res = await fetch(`${WRAPPED_PLAYLIST_URL}?_=${Date.now()}`).catch(() => null);
      if (!res || !res.ok) res = await fetch('wrapped/playlist.json?v=2');
      if (res.ok) {
        allWrappedTracks = await res.json();
      }
    } catch (e) {
      allWrappedTracks = [];
    }
    try {
      render();
    } catch(err) {
      console.error('[Preferiti] Error in render:', err);
    }
  }

  function getLikedList() {
    try {
      const list = JSON.parse(localStorage.getItem('rc_liked_tracks') || '[]');
      let migrated = false;
      list.forEach(item => {
        if (item && typeof item === 'object') {
          const t = (item.title || '').toLowerCase();
          if (t.includes('from here') || item.speaker === 'Tommaso Staino Baldino') {
            item.speaker = 'Simone Palmieri';
            migrated = true;
          }
        }
      });
      if (migrated) {
        localStorage.setItem('rc_liked_tracks', JSON.stringify(list));
      }
      return list;
    } catch(e) {
      return [];
    }
  }

  function isLiked(track) {
    const liked = getLikedList();
    return liked.some(item => {
      const t = typeof item === 'string' ? item : item.title;
      return t.toLowerCase() === track.title.toLowerCase();
    });
  }

  function toggleLike(track) {
    let liked = getLikedList();
    const idx = liked.findIndex(item => {
      const t = typeof item === 'string' ? item : item.title;
      return t.toLowerCase() === track.title.toLowerCase();
    });

    if (idx >= 0) {
      liked.splice(idx, 1);
    } else {
      const speakerName = track.speaker || (track.title?.toLowerCase().includes('from here') ? 'Simone Palmieri' : 'Staff Carducci');
      liked.push({
        title: track.title,
        artist: track.artist,
        cover: track.cover,
        spotifyUrl: `https://open.spotify.com/search/${encodeURIComponent(track.artist + ' ' + track.title)}`,
        speaker: speakerName
      });
    }
    localStorage.setItem('rc_liked_tracks', JSON.stringify(liked));
    window.dispatchEvent(new Event('rc-liked-tracks-updated'));
    render();
  }

  // Fermata da un altro audio (diretta o podcast)
  window.__stopPreferitiPreview = () => {
    if (!preferitiAudio.paused) preferitiAudio.pause();
    currentPreviewTrack = null;
    render();
  };

  function playPreview(track, btn) {
    if (currentPreviewTrack === track.title && !preferitiAudio.paused) {
      preferitiAudio.pause();
      currentPreviewTrack = null;
      render();
      return;
    }

    // Stop main live stream if playing
    const rcAudio = document.getElementById('rc-audio');
    if (rcAudio && !rcAudio.paused) {
      const playBtn = document.querySelector('.player-bar__play');
      if (playBtn) playBtn.click();
    }

    if (!track.src) return;
    // Stesse fonti del Wrapped: R2 (audio/) e poi cartella del sito, anche col nome in minuscolo
    const sources = [];
    if (/^https?:/.test(track.src)) sources.push(track.src);
    else {
      const file = track.src.replace(/^audio\//, '');
      sources.push(`${R2_PUBLIC}/audio/${file}`, `${R2_PUBLIC}/audio/${file.toLowerCase()}`,
                   `wrapped/${track.src}`, `wrapped/${track.src.toLowerCase()}`);
    }
    const uniq = [...new Set(sources)];
    let attempt = 0;
    preferitiAudio.onerror = () => {
      attempt++;
      if (attempt < uniq.length && currentPreviewTrack === track.title) {
        preferitiAudio.src = uniq[attempt];
        if (track.startTime) preferitiAudio.currentTime = track.startTime;
        preferitiAudio.play().catch(() => {});
      }
    };
    preferitiAudio.src = uniq[0];
    if (track.startTime) preferitiAudio.currentTime = track.startTime;
    preferitiAudio.play().catch(() => {});
    currentPreviewTrack = track.title;
    render();

    preferitiAudio.onended = () => {
      currentPreviewTrack = null;
      render();
    };
  }

  function render() {
    const likedList = getLikedList();
    if (countBadge) {
      countBadge.textContent = `${likedList.length} BRAN${likedList.length === 1 ? 'O SALVATO' : 'I SALVATI'}`;
    }

    const tracksToShow = currentFilter === 'saved' 
      ? likedList 
      : (allWrappedTracks.length ? allWrappedTracks : likedList);

    console.log('[Preferiti] render called, tracksToShow:', tracksToShow.length);

    const filterBarHtml = `
      <div class="preferiti__toolbar">
        <div class="preferiti__tabs-filter">
          <button class="preferiti__filter-btn ${currentFilter === 'all' ? 'active' : ''}" data-filter="all">
            <span>TUTTI I BRANI WRAPPED (${allWrappedTracks.length || 25})</span>
          </button>
          <button class="preferiti__filter-btn ${currentFilter === 'saved' ? 'active' : ''}" data-filter="saved">
            <span>I TUOI SALVATI (${likedList.length})</span>
          </button>
        </div>
        <button type="button" class="preferiti__open-wrapped-cta open-wrapped-inpage">
          <span>Apri Wrapped ✦</span>
        </button>
      </div>
    `;

    if (currentFilter === 'saved' && !likedList.length) {
      container.innerHTML = `
        ${filterBarHtml}
        <div class="preferiti-empty">
          <div class="preferiti-empty__icon">
            <i data-lucide="heart" width="32" height="32"></i>
          </div>
          <div class="preferiti-empty__title">Nessun brano salvato nei preferiti</div>
          <p class="preferiti-empty__sub">
            Clicca sul cuore accanto ai brani qui sotto o dentro l'esperienza Wrapped per salvarli nella tua libreria!
          </p>
          <button class="btn btn-red" id="preferiti-switch-to-all">
            Esplora i brani Wrapped →
          </button>
        </div>
      `;
      const switchBtn = document.getElementById('preferiti-switch-to-all');
      if (switchBtn) {
        switchBtn.addEventListener('click', () => {
          currentFilter = 'all';
          render();
        });
      }
      attachToolbarEvents();
      if (typeof lucide !== 'undefined') lucide.createIcons();
      return;
    }

    container.innerHTML = `
      ${filterBarHtml}
      <div class="preferiti-grid">
        ${tracksToShow.map((item, idx) => {
          const title = typeof item === 'string' ? item : item.title;
          const artist = item.artist || 'Radio Carducci';
          const cover = item.cover || 'assets/logo-rc-mark-bone.svg';
          let speaker = item.speaker || 'Staff Carducci';
          if (speaker.includes('Tommaso Staino') || (title && title.toLowerCase().includes('from here'))) {
            speaker = 'Simone Palmieri';
          }
          const isPlaying = currentPreviewTrack === title;
          const hasLiked = isLiked(item);
          const spotifyUrl = item.spotifyUrl || ('https://open.spotify.com/search/' + encodeURIComponent((artist || 'Radio Carducci') + ' ' + (title || '')));

          return `
            <div class="preferiti-card ${isPlaying ? 'preferiti-card--playing' : ''}">
              <div class="preferiti-card__cover-wrap">
                <img src="${cover}" alt="${title}" class="preferiti-card__cover" onerror="this.style.opacity='0.2'">
                <button class="preferiti-card__play-btn" data-track-index="${idx}" aria-label="${isPlaying ? 'Pausa' : 'Riproduci anteprima'}">
                  <i data-lucide="${isPlaying ? 'pause' : 'play'}" width="18" height="18"></i>
                </button>
              </div>
              <div class="preferiti-card__info">
                <div class="preferiti-card__title">${title}</div>
                <div class="preferiti-card__artist">${artist}</div>
                <div class="preferiti-card__meta-line">
                  <span class="preferiti-card__tag">WRAPPED</span>
                  <span class="preferiti-card__speaker">✦ ${speaker}</span>
                </div>
              </div>
              <div class="preferiti-card__actions">
                <button class="preferiti-card__heart-btn ${hasLiked ? 'active' : ''}" data-track-index="${idx}" aria-label="${hasLiked ? 'Rimuovi dai preferiti' : 'Aggiungi ai preferiti'}" title="${hasLiked ? 'Rimuovi dai preferiti' : 'Salva nei preferiti'}">
                  <i data-lucide="heart" width="18" height="18"></i>
                </button>
                <a href="${spotifyUrl}" target="_blank" rel="noopener" class="preferiti-card__spotify-btn" title="Ascolta su Spotify">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.24 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15.001 10.62 18.66 12.84c.361.181.54.78.301 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.781-.18-.6.18-1.2.78-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.239.54-.959.72-1.56.42z"/></svg>
                </a>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;

    attachToolbarEvents();

    container.querySelectorAll('.preferiti-card__play-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.getAttribute('data-track-index'), 10);
        const track = tracksToShow[idx];
        if (track) playPreview(track, btn);
      });
    });

    container.querySelectorAll('.preferiti-card__heart-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.getAttribute('data-track-index'), 10);
        const track = tracksToShow[idx];
        if (track) toggleLike(track);
      });
    });

    if (typeof lucide !== 'undefined') lucide.createIcons();
  }

  function attachToolbarEvents() {
    container.querySelectorAll('.preferiti__filter-btn').forEach(b => {
      b.addEventListener('click', () => {
        currentFilter = b.getAttribute('data-filter');
        render();
      });
    });
  }

    loadWrappedTracks();
    window.addEventListener('storage', render);
    window.addEventListener('rc-liked-tracks-updated', render);
  }

  initWrappedInPage();
  initPreferiti();
})();

