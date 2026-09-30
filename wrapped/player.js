// ==========================================
// STAFF WRAPPED - LOGIC (THREE.JS 3D & LRCLIB)
// ==========================================

const snowCanvas = document.getElementById('snow-canvas');
const snowCtx = snowCanvas.getContext('2d');

const startBtn = document.getElementById('start-btn');
const introOverlay = document.getElementById('intro-overlay');
const wrappedUi = document.getElementById('wrapped-ui');
const endOverlay = document.getElementById('end-overlay');
const transitionOverlay = document.getElementById('track-transition');

const titleEl = document.getElementById('track-title');
const artistEl = document.getElementById('track-artist');
const currentTrackNum = document.getElementById('current-track-num');
const totalTrackNum = document.getElementById('total-track-num');

const lyricsContainer = document.getElementById('lyrics-container');
const kineticBg = document.getElementById('kinetic-bg');
const coverImg = document.getElementById('cover-img');
const coverPlaceholder = document.getElementById('cover-placeholder');
const coverWrapper = document.getElementById('cover-wrapper');
const trackMeta = document.querySelector('.track-meta');
const trackSubtitle = document.getElementById('track-subtitle');

const btnSkip = document.getElementById('btn-skip');
const btnLike = document.getElementById('btn-like');
const btnSpotify = document.getElementById('btn-spotify');

let audioCtx, analyser;
let playlist = [];
let currentTrackIndex = 0;
let isPlaying = false;
let currentSource = null;
let currentBpm = 100;
let likedTracks = JSON.parse(localStorage.getItem('rc_liked_tracks') || '[]');

// Incrementato ad ogni chiamata a playTrack(): permette a una chiamata più
// recente (es. skip veloce) di invalidare quelle precedenti ancora in corso,
// evitando che due caricamenti/riproduzioni si accavallino sullo stesso currentSource.
let playToken = 0;

let currentLyrics = [];
let lyricsSyncInterval = null;
let lastActiveLyricIndex = -1;

// --- LRCLIB API ---
async function fetchLyrics(track) {
  try {
    const query = new URLSearchParams({
      track_name: track.title,
      artist_name: track.artist
    });
    const res = await fetch(`https://lrclib.net/api/get?${query.toString()}`);
    if (!res.ok) throw new Error("Lyrics not found");
    const data = await res.json();
    
    if (data.syncedLyrics) {
      return parseLRC(data.syncedLyrics);
    } else if (data.plainLyrics) {
      return [{ time: 0, text: data.plainLyrics.split('\n')[0] }];
    } else {
      return [{ time: 0, text: "Probabile strumentale" }];
    }
  } catch (e) {
    console.log("LRCLIB Error:", e);
    return [{ time: 0, text: "Probabile strumentale" }];
  }
}

function parseLRC(lrc) {
  const lines = lrc.split('\n');
  const parsed = [];
  const regex = /\[(\d{2}):(\d{2}\.\d{2,3})\](.*)/;
  
  for (const line of lines) {
    const match = line.match(regex);
    if (match) {
      const minutes = parseInt(match[1], 10);
      const seconds = parseFloat(match[2]);
      const text = match[3].trim();
      if (text) {
        parsed.push({ time: minutes * 60 + seconds, text });
      }
    }
  }
  return parsed;
}

const stopwords = new Set(['the','a','an','and','or','but','is','are','was','were','in','on','at','to','for','with','by','about','like','through','over','before','between','after','since','without','under','within','along','following','across','behind','beyond','plus','except','but','up','out','around','down','off','above','near','i','you','he','she','it','we','they','me','him','her','us','them','my','your','his','their','this','that','these','those','am','be','been','do','does','did','have','has','had','can','could','will','would','shall','should','may','might','must','what','who','where','when','why','how','so','too','very','non','che','di','la','il','un','una','e','o','per','con','su','da','tra','fra']);

function extractKeywords(text) {
  const words = text.toLowerCase().replace(/[^a-zà-ù0-9\s]/g, '').split(/\s+/).filter(w => w.length > 0);
  // Prima prova: filtra stopwords e parole cortissime
  const filtered = words.filter(w => w.length > 2 && !stopwords.has(w));
  if (filtered.length > 0) {
    return filtered.sort((a,b) => b.length - a.length).slice(0, 3);
  }
  // Fallback: se tutto è stato filtrato, prendi le parole più lunghe senza filtro stopwords
  const fallback = words.filter(w => w.length > 1).sort((a,b) => b.length - a.length);
  return fallback.slice(0, 2);
}

// Misura la larghezza/altezza REALE con cui una kinetic-word verrebbe renderizzata
// a una data font-size (stesso font, stesso stroke) — niente stime a occhio, così
// il clamping anti-clipping funziona per qualunque parola/font/viewport.
function measureKineticWord(text, fontSize) {
  const probe = document.createElement('span');
  probe.className = 'kinetic-word-inner';
  probe.style.position = 'fixed';
  probe.style.visibility = 'hidden';
  probe.style.left = '-9999px';
  probe.style.top = '0';
  probe.style.animation = 'none';
  probe.style.transform = 'none';
  probe.style.fontSize = fontSize;
  probe.textContent = text;
  document.body.appendChild(probe);
  const rect = probe.getBoundingClientRect();
  probe.remove();
  return { width: rect.width, height: rect.height };
}

function renderLyrics() {
  lyricsContainer.innerHTML = '';

  // If only "Probabile strumentale", don't render lyrics at all
  if (currentLyrics.length === 1 && currentLyrics[0].text.toLowerCase().includes('probabile strumentale')) {
    return;
  }

  currentLyrics.forEach((line, index) => {
    const div = document.createElement('div');
    div.className = 'lyric-line';
    div.id = `lyric-${index}`;
    
    // 1. United Version
    const unitedDiv = document.createElement('div');
    unitedDiv.className = 'lyric-united';
    unitedDiv.textContent = line.text;

    // 2. Split Version
    const splitDiv = document.createElement('div');
    splitDiv.className = 'lyric-split';

    const words = line.text.split(' ');
    const half = Math.ceil(words.length / 2);
    const leftText = words.slice(0, half).join(' ');
    const rightText = words.slice(half).join(' ');

    const leftSpan = document.createElement('span');
    leftSpan.className = 'lyric-left';
    leftSpan.textContent = leftText;

    const gap = document.createElement('span');
    gap.className = 'lyric-gap';

    const rightSpan = document.createElement('span');
    rightSpan.className = 'lyric-right';
    rightSpan.textContent = rightText;

    splitDiv.appendChild(leftSpan);
    splitDiv.appendChild(gap);
    splitDiv.appendChild(rightSpan);

    div.appendChild(unitedDiv);
    div.appendChild(splitDiv);
    lyricsContainer.appendChild(div);
  });
}

function syncLyrics() {
  if (!audioCtx || !isPlaying || !currentSource || currentLyrics.length === 0) return;
  const track = playlist[currentTrackIndex];
  
  const elapsedTime = audioCtx.currentTime - currentSource.startedAt;
  const currentSongTime = (track.startTime || 0) + elapsedTime;

  if ('mediaSession' in navigator && 'setPositionState' in navigator.mediaSession) {
    const elapsedClamped = Math.max(0, Math.min(30, elapsedTime));
    if (Math.abs(elapsedClamped - lastMediaSessionPos) >= 1.0) {
      lastMediaSessionPos = elapsedClamped;
      try {
        navigator.mediaSession.setPositionState({
          duration: 30,
          playbackRate: isPlaying ? 1 : 0,
          position: elapsedClamped
        });
      } catch (e) {}
    }
  }

  let activeIndex = -1;
  for (let i = 0; i < currentLyrics.length; i++) {
    if (currentSongTime >= currentLyrics[i].time) {
      activeIndex = i;
    } else {
      break;
    }
  }

  if (activeIndex !== -1 && activeIndex !== lastActiveLyricIndex) {
    lastActiveLyricIndex = activeIndex;

    // Scroll container
    const activeEl = document.getElementById(`lyric-${activeIndex}`);
    if (activeEl && !activeEl.classList.contains('active')) {
      document.querySelectorAll('.lyric-line.active').forEach(el => el.classList.remove('active'));
      activeEl.classList.add('active');
      
      const isMobile = window.innerWidth <= 768;
      const containerCenter = isMobile ? (window.innerHeight * 0.16) : (window.innerHeight / 2);
      const elRect = activeEl.getBoundingClientRect();
      const offset = (elRect.top + elRect.height / 2) - containerCenter;
      
      const currentTransform = parseFloat(lyricsContainer.dataset.y || 0);
      const newY = currentTransform - offset;
      lyricsContainer.style.transform = `translateY(${newY}px)`;
      lyricsContainer.dataset.y = newY;
    }
    // Kinetic Typography disabled per user request (big text removed, normal lyrics preserved)
    kineticBg.innerHTML = '';
  }
}

// --- THREE.JS SETUP ---
const canvasContainer = document.getElementById('canvas-container');
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 1000);
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
renderer.setClearColor(0x1e1e1e, 1); // rc-ink — sfondo nero solido
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
renderer.setSize(window.innerWidth, window.innerHeight);
canvasContainer.appendChild(renderer.domElement);

camera.position.set(0, 0, 15);

const uniforms = {
  u_time: { value: 0.0 },
  u_frequency: { value: 0.0 },
  u_color: { value: new THREE.Color('#eaeaea') },  // bone white
  u_color2: { value: new THREE.Color('#db3849') }   // rc-red
};

const mat = new THREE.ShaderMaterial({
  wireframe: true,
  transparent: true,
  uniforms,
  vertexShader: document.getElementById('vertexshader').textContent,
  fragmentShader: document.getElementById('fragmentshader').textContent,
});

const geo = new THREE.IcosahedronGeometry(4, 20); // 20 subdivisions: smooth senza essere pesante
const mesh = new THREE.Mesh(geo, mat);
// Scala piena — il blob deve essere visibile
mesh.scale.set(1.0, 1.0, 1.0);
scene.add(mesh);

const clock = new THREE.Clock();

function updateLyricSplits() {
  if (window.innerWidth <= 768) {
    document.querySelectorAll('.lyric-line.split').forEach(el => el.classList.remove('split'));
    requestAnimationFrame(updateLyricSplits);
    return;
  }
  const windowHeight = window.innerHeight;
  const splitZoneTop = windowHeight * 0.25;
  const splitZoneBottom = windowHeight * 0.75;

  document.querySelectorAll('.lyric-line').forEach(el => {
    const rect = el.getBoundingClientRect();
    const elCenterY = rect.top + rect.height / 2;
    
    // If the center of the text is inside the blob zone, split it!
    if (elCenterY > splitZoneTop && elCenterY < splitZoneBottom) {
      if (!el.classList.contains('split')) el.classList.add('split');
    } else {
      if (el.classList.contains('split')) el.classList.remove('split');
    }
  });
  
  requestAnimationFrame(updateLyricSplits);
}
// Start the continuous spatial check
updateLyricSplits();

// --- MOUSE PARALLAX VARIABLES ---
let mouseX = 0;
let mouseY = 0;

window.addEventListener('mousemove', (e) => {
  mouseX = (e.clientX / window.innerWidth) * 2 - 1;
  mouseY = -(e.clientY / window.innerHeight) * 2 + 1;
});

function animate3D() {
  requestAnimationFrame(animate3D);
  uniforms.u_time.value = clock.getElapsedTime();

  if (analyser && isPlaying) {
    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(dataArray);
    
    // Broader frequency response (not just sub-bass)
    let sum = 0;
    for(let i = 0; i < 16; i++) {
      sum += dataArray[i];
    }
    const avg = sum / 16;
    // Exponential curve for harder impact on beats
    const val = avg / 255.0;
    const target = Math.pow(val, 2) * 2.5;
    // Lerp: attacco veloce (0.15), rilascio lento (0.06) — elimina lo scatto epilettico
    const current = uniforms.u_frequency.value;
    uniforms.u_frequency.value = current + (target - current) * (target > current ? 0.15 : 0.06);
  } else {
    uniforms.u_frequency.value *= 0.93; // Smooth decay verso zero
  }

  // Slowly rotate the blob
  mesh.rotation.x += 0.001;
  mesh.rotation.y += 0.002;

  // Parallax effect on mouse movement
  mesh.position.x += (mouseX * 0.5 - mesh.position.x) * 0.05;
  mesh.position.y += (mouseY * 0.5 - mesh.position.y) * 0.05;

  renderer.render(scene, camera);
}
animate3D();

// Resize handling
function resizeCanvases() {
  snowCanvas.width = window.innerWidth;
  snowCanvas.height = window.innerHeight;
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  renderer.setSize(window.innerWidth, window.innerHeight);
}
window.addEventListener('resize', resizeCanvases);
resizeCanvases();

// --- SNOW PARTICLES ---
const particles = Array.from({ length: 150 }, () => ({
  x: Math.random() * window.innerWidth,
  y: Math.random() * window.innerHeight,
  r: Math.random() * 2 + 0.5,
  baseSpeedY: Math.random() * 1 + 0.5,
  speedX: (Math.random() - 0.5) * 1
}));

function drawSnow() {
  requestAnimationFrame(drawSnow);
  snowCtx.clearRect(0, 0, snowCanvas.width, snowCanvas.height);
  snowCtx.fillStyle = 'rgba(235, 235, 230, 0.6)'; 

  const bpmMultiplier = currentBpm / 100;

  particles.forEach(p => {
    p.y += p.baseSpeedY * bpmMultiplier;
    p.x += p.speedX * bpmMultiplier;

    if (p.y > snowCanvas.height) {
      p.y = 0;
      p.x = Math.random() * snowCanvas.width;
    }
    if (p.x > snowCanvas.width) p.x = 0;
    if (p.x < 0) p.x = snowCanvas.width;

    snowCtx.beginPath();
    snowCtx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    snowCtx.fill();
  });
}
drawSnow();

// --- AUDIO LOGIC ---
async function loadPlaylist() {
  try {
    let res = await fetch('https://pub-7bdb71d3a8a643899d66d0b611b8b049.r2.dev/site/wrapped/playlist.json?_=' + Date.now()).catch(() => null);
    playlist = (res && res.ok) ? await res.json().catch(() => null) : null;
    if (!Array.isArray(playlist) || !playlist.length) playlist = await (await fetch('playlist.json?v=2')).json();
    totalTrackNum.textContent = playlist.length;
    currentBpm = playlist[0].bpm || 100;
    initRoulette();
  } catch (err) {
    console.error("Failed to load playlist", err);
  }
}

// Identificatore univoco del brano per i "like": usa src (unico per file)
// invece del solo titolo, che può collidere tra brani diversi con lo stesso nome.
function trackKey(track) {
  return track.src || track.title;
}

const SPEAKERS_LIST = [
  'Lorenzo Martorana',
  'Paolo Vignati',
  'Tommaso Staino Baldino',
  'Andrea Curcuruto',
  'Riccardo Billi',
  'Micol Parente',
  'Simone Palmeri',
  'Mauro Martorana',
  'Francesco Maciocia',
  'Marta Falcocchio',
  'Tommaso Cristaldi',
  'Asia Speranza',
  'Diletta Principe',
  'Giada Valletta',
  'Silvia Biondi',
  'Morgana Stefanutti',
  'Lavinia Tarricone'
];

function showMatchToast(speaker, track) {
  let toast = document.getElementById('rc-match-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'rc-match-toast';
    toast.className = 'rc-match-toast';
    document.body.appendChild(toast);
  }

  toast.innerHTML = `
    <div class="rc-match-toast__badge">✨ AFFINITÀ MUSICALE RC</div>
    <div class="rc-match-toast__body">
      A te e a <strong>${speaker}</strong> piace la stessa canzone!
    </div>
    <div class="rc-match-toast__track">«${track.title}» di ${track.artist}</div>
  `;

  toast.classList.add('visible');
  if (window._matchToastTimeout) clearTimeout(window._matchToastTimeout);
  window._matchToastTimeout = setTimeout(() => {
    toast.classList.remove('visible');
  }, 4200);
}

function getSpeakerForTrack(track, index) {
  if (track && track.speaker) return track.speaker;
  return SPEAKERS_LIST[index % SPEAKERS_LIST.length];
}

function updateLikeButton(track) {
  const key = trackKey(track);
  let currentLikes = [];
  try {
    currentLikes = JSON.parse(localStorage.getItem('rc_liked_tracks')) || [];
  } catch (e) {}

  const isLiked = currentLikes.some(item => {
    if (typeof item === 'string') return item === key;
    return item.src === key || item.title === track.title;
  });

  if (isLiked) {
    btnLike.classList.add('liked');
  } else {
    btnLike.classList.remove('liked');
  }
}

async function updateUI(track, index) {
  if (!track) return;
  
  // Transition OUT old content
  coverWrapper.classList.add('transition-hide');
  trackMeta.classList.add('transition-hide');
  lyricsContainer.style.transform = `translateY(0px)`;
  lyricsContainer.dataset.y = 0;
  lastActiveLyricIndex = -1;
  kineticBg.innerHTML = '';
  
  setTimeout(() => {
    titleEl.textContent = track.title;
    artistEl.textContent = track.artist;
    currentTrackNum.textContent = index + 1;
    currentBpm = track.bpm || 100;

    // Update progress bar
    const progressFill = document.getElementById('progress-bar-fill');
    if (progressFill) {
      const pct = ((index + 1) / playlist.length) * 100;
      progressFill.style.width = pct + '%';
    }
    
    // Always set valid Spotify link
    if (btnSpotify) {
      const spotifyQuery = encodeURIComponent(`${track.artist} ${track.title}`);
      btnSpotify.href = track.spotifyUrl || `https://open.spotify.com/search/${spotifyQuery}`;
      btnSpotify.target = '_blank';
      btnSpotify.rel = 'noopener noreferrer';
    }
    
    const primaryColor = track.primaryColor || track.dominantColor || '#BD162D';
    const secondaryColor = track.secondaryColor || '#ffffff';
    
    document.documentElement.style.setProperty('--primary-color', primaryColor);
    document.documentElement.style.setProperty('--secondary-color', secondaryColor);
    document.documentElement.style.setProperty('--dynamic-color', primaryColor);
    
    uniforms.u_color.value.set(primaryColor);
    uniforms.u_color2.value.set(secondaryColor);

    // Update Cover Art
    if (track.cover) {
      coverImg.src = track.cover;
      coverImg.style.display = 'block';
      coverPlaceholder.style.display = 'none';
    } else {
      coverImg.style.display = 'none';
      coverPlaceholder.style.display = 'block';
      coverPlaceholder.style.background = `linear-gradient(135deg, ${primaryColor}, ${secondaryColor})`;
    }

    updateLikeButton(track);

    // Transition IN new content
    coverWrapper.classList.remove('transition-hide');
    trackMeta.classList.remove('transition-hide');
  }, 400);
}

function updateSubtitle() {
  if (currentLyrics.length === 1 && currentLyrics[0].text.toLowerCase().includes('probabile strumentale')) {
    trackSubtitle.textContent = 'Probabile strumentale';
    trackSubtitle.style.display = 'block';
  } else {
    trackSubtitle.textContent = '';
    trackSubtitle.style.display = 'none';
  }
}

let consecutiveLoadErrors = 0;
async function fetchAudioBuffer(url) {
  const CLOUDFLARE_R2_AUDIO = 'https://pub-7bdb71d3a8a643899d66d0b611b8b049.r2.dev/audio';
  const candidates = [];
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    const filename = url.replace(/^audio\//, '');
    // I server distinguono maiuscole/minuscole: provo il nome com'è e in minuscolo
    candidates.push(`${CLOUDFLARE_R2_AUDIO}/${filename}`, `${CLOUDFLARE_R2_AUDIO}/${filename.toLowerCase()}`);
    candidates.push(url, url.toLowerCase());
  } else {
    candidates.push(url);
  }
  let lastErr;
  for (const u of [...new Set(candidates)]) {
    try {
      const res = await fetch(u);
      if (!res.ok) { lastErr = new Error(`HTTP ${res.status} per ${u}`); continue; }
      const arrayBuffer = await res.arrayBuffer();
      return await audioCtx.decodeAudioData(arrayBuffer);
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('Audio non disponibile');
}

function setupAudioContext() {
  if (audioCtx) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 256; 
  analyser.connect(audioCtx.destination);
}

async function playTrack(index) {
  // Ogni chiamata prende il proprio "biglietto": se nel frattempo arriva una
  // chiamata più recente (doppio click su Salta, skip + fine naturale del brano
  // quasi simultanei...), questa chiamata si accorge di essere superata e si ferma
  // pulita, invece di continuare in parallelo e sovrapporre due riproduzioni audio.
  const myToken = ++playToken;
  const superseded = () => myToken !== playToken;

  if (index >= playlist.length) {
    wrappedUi.classList.add('hidden');
    // Populate end recap
    const endRecap = document.getElementById('end-recap');
    if (endRecap) {
      const count = likedTracks.length;
      if (count > 0) {
        endRecap.textContent = `Hai salvato ${count} bran${count === 1 ? 'o' : 'i'} su ${playlist.length}. Buon gusto.`;
      } else {
        endRecap.textContent = `${playlist.length} brani ascoltati. Nessun cuore? Duro.`;
      }
    }
    endOverlay.classList.remove('hidden');
    return;
  }

  if (!audioCtx) setupAudioContext();
  if (audioCtx.state === 'suspended') await audioCtx.resume();
  if (superseded()) return;

  const track = playlist[index];
  const isFirstTrack = (index === 0 && !currentSource);

  // Disabilita "Salta" durante il caricamento: click multipli non accodano
  // più richieste concorrenti (il playToken resta comunque come rete di sicurezza).
  btnSkip.disabled = true;

  // Show transition overlay (except for first track — intro overlay handles that)
  if (!isFirstTrack) {
    transitionOverlay.classList.remove('hidden');
    // Wait for the fade-in of the overlay
    await new Promise(r => setTimeout(r, 1200));
  }
  if (superseded()) return;

  // Preload everything in parallel behind the overlay
  let buffer, fetchedLyrics;
  try {
    [buffer, fetchedLyrics] = await Promise.all([
      fetchAudioBuffer(track.src),
      fetchLyrics(track)
    ]);
  } catch (err) {
    console.error(`Impossibile caricare "${track.title}" (${track.src}):`, err);
    if (superseded()) return;
    // Se nessun brano si carica, fermati invece di saltare all'infinito
    consecutiveLoadErrors++;
    if (consecutiveLoadErrors >= Math.min(playlist.length, 5)) {
      transitionOverlay.classList.add('hidden');
      btnSkip.disabled = false;
      const t = document.getElementById('track-title');
      const a = document.getElementById('track-artist');
      if (t) t.textContent = 'Brani non disponibili';
      if (a) a.textContent = 'Riprova più tardi';
      return;
    }
    // Non bloccare l'esperienza su un file mancante/corrotto: salta al prossimo brano.
    btnSkip.disabled = false;
    currentTrackIndex = index + 1;
    playTrack(currentTrackIndex);
    return;
  }
  if (superseded()) return;
  consecutiveLoadErrors = 0;

  // Update UI while hidden behind overlay
  updateUI(track, index);

  // Set lyrics AFTER updateUI so they don't get cleared
  currentLyrics = fetchedLyrics;
  renderLyrics();
  updateSubtitle();

  // Small extra pause so UI settles
  await new Promise(r => setTimeout(r, 600));
  if (superseded()) return;

  // Fade OUT the transition overlay to reveal the new track
  if (!isFirstTrack) {
    transitionOverlay.classList.add('hidden');
  }

  try {
    if (currentSource) {
      currentSource.onended = null;
      currentSource.stop();
      currentSource.disconnect();
    }

    currentSource = audioCtx.createBufferSource();
    currentSource.buffer = buffer;

    const trackGain = audioCtx.createGain();
    currentSource.connect(trackGain);
    trackGain.connect(analyser);

    const startTime = track.startTime || 90;
    const duration = 30;
    const fadeDuration = 4;
    const now = audioCtx.currentTime;

    currentSource.startedAt = now;

    trackGain.gain.setValueAtTime(0, now);
    trackGain.gain.linearRampToValueAtTime(1, now + fadeDuration);
    trackGain.gain.setValueAtTime(1, now + duration - fadeDuration);
    trackGain.gain.linearRampToValueAtTime(0, now + duration);

    currentSource.start(now, startTime, duration);
    isPlaying = true;
    updateWrappedMediaSession(track);

    if (lyricsSyncInterval) clearInterval(lyricsSyncInterval);
    lyricsSyncInterval = setInterval(syncLyrics, 100);

    currentSource.onended = () => {
      currentTrackIndex++;
      playTrack(currentTrackIndex);
    };

  } catch (err) {
    console.error("Error playing track", err);
  } finally {
    btnSkip.disabled = false;
  }
}

// --- NAME ROULETTE ---
// Personalizzabile via ?name=... nell'URL (es. index.html?name=Marco).
// Se il parametro manca o è vuoto, resta il default 'Simone' (comportamento invariato).
const TARGET_NAME = (new URLSearchParams(window.location.search).get('name') || '').trim() || 'Simone P.';
const FAKE_NAMES = [
  'Sabina Panocchia',
  'Tommaso Staino Baldino',
  'Alfredo Imbellone',
  'Lorenzo Martorana',
  'Giada Valletta',
  'Diletta Principe',
  'Andrea Curcuruto',
  'Micol Parente',
  'Asia Speranza',
  'Mauro Martorana',
  'Paolo Vignati',
  'Riccardo Billi',
  'Francesco Maciocia',
  'Marta Falcocchio',
  'Tommaso Cristaldi',
  'Lavinia Tarricone',
  'Silvia Biondi',
  'Morgana Stefanutti',
  'Laura Contardi',
  'Flavia Ippoliti',
  'Leonardo Sinestrari',
  'Valentina Scacco',
  'Romina Micheli',
  'Alessio Viglietta',
  'Samia Hussein',
  'Ilaria Ciamillo'
];

function initRoulette() {
  const roulette = document.getElementById('name-roulette');
  // Evita che il nome target compaia due volte nella strip se coincide con un fake name
  const availableFakes = FAKE_NAMES.filter(n => n.toLowerCase() !== TARGET_NAME.toLowerCase());
  const fakesPool = availableFakes.length > 0 ? availableFakes : FAKE_NAMES;

  // Build the strip: many fakes, then target at the end
  const names = [];
  for (let i = 0; i < 30; i++) {
    names.push(fakesPool[i % fakesPool.length]);
  }
  names.push(TARGET_NAME);

  roulette.innerHTML = '';
  names.forEach(name => {
    const div = document.createElement('div');
    div.className = 'roulette-name';
    div.textContent = name;
    roulette.appendChild(div);
  });

  // Animate: scroll through all names, decelerating to stop on the last one
  let currentIndex = 0;
  const totalNames = names.length;
  const totalDuration = 3000; // 3 seconds total
  const startTime = performance.now();

  function tick(now) {
    const elapsed = now - startTime;
    const progress = Math.min(elapsed / totalDuration, 1);

    // Ease-out cubic for deceleration
    const eased = 1 - Math.pow(1 - progress, 3);
    const targetIndex = Math.round(eased * (totalNames - 1));

    if (targetIndex !== currentIndex) {
      currentIndex = targetIndex;
      roulette.style.transform = `translateY(-${currentIndex * 1.1}em)`;
    }

    if (progress < 1) {
      requestAnimationFrame(tick);
    }
  }

  // Start after a small delay so the page renders first
  setTimeout(() => requestAnimationFrame(tick), 500);
}

// --- COVER EXPLOSION ---
function triggerCoverExplosion(callback) {
  const explosionContainer = document.getElementById('cover-explosion');
  const introContent = document.querySelector('.intro-content');

  // Fade out the intro text first
  introContent.style.transition = 'opacity 0.5s ease-out';
  introContent.style.opacity = '0';

  setTimeout(() => {
    // Build the cover grid
    explosionContainer.classList.remove('hidden');
    const covers = playlist.filter(t => t.cover).map(t => t.cover);

    // Se non ci sono copertine disponibili, salta la griglia (evita img.src=undefined
    // per via del modulo su covers.length === 0) e passa subito allo step successivo.
    if (covers.length === 0) {
      explosionContainer.classList.add('hidden');
      callback();
      return;
    }

    // Fill the screen with covers (5x5 desktop, 3x6 mobile for square aspect ratio)
    const isMobile = window.innerWidth <= 768;
    const cols = isMobile ? 3 : 5;
    const rows = isMobile ? 6 : 5;
    const totalTiles = cols * rows;

    explosionContainer.style.setProperty('--explosion-cols', String(cols));
    explosionContainer.style.setProperty('--explosion-rows', String(rows));

    // Hide the background circular text immediately so it doesn't bleed through
    const circleSvg = document.querySelector('.wrapped-path-svg');
    if (circleSvg) {
      circleSvg.style.transition = 'opacity 0.4s ease';
      circleSvg.style.opacity = '0';
    }

    for (let i = 0; i < totalTiles; i++) {
      const img = document.createElement('img');
      img.decoding = 'async'; // Previene DOM thrashing
      img.src = covers[i % covers.length];
      img.alt = '';
      // Nasce già nello stato "caduto" (vedi .entering nel CSS): la rivelazione
      // qui sotto la riporta a scala/opacità normali con lo stesso stagger
      // diagonale che userà per uscire — stesso movimento, verso opposto.
      img.className = 'entering';
      const rotation = (Math.random() - 0.5) * 60; // random spin, riusata anche in uscita
      img.style.setProperty('--fall-rotate', `${rotation}deg`);
      explosionContainer.appendChild(img);
    }

    // ENTRATA: stagger diagonale (riga+colonna) che rivela le copertine una a una.
    requestAnimationFrame(() => {
      const images = explosionContainer.querySelectorAll('img');
      images.forEach((img, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const delay = (col + row) * (isMobile ? 50 : 80) + Math.random() * 30;
        img.style.transitionDelay = `${delay}ms`;
        requestAnimationFrame(() => {
          img.classList.remove('entering');
        });
      });
    });

    // Dopo che la griglia si è assemblata (stagger max ~640ms + 0.8s di transizione)
    // e una breve sosta per farla vedere, le facciamo cadere via: stesso stagger,
    // stessa rotazione per coppia entrata/uscita, così "se ne vanno come sono arrivate".
    setTimeout(() => {
      const images = explosionContainer.querySelectorAll('img');
      images.forEach((img, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const delay = (col + row) * (isMobile ? 50 : 80) + Math.random() * 30;
        img.style.transitionDelay = `${delay}ms`;
        requestAnimationFrame(() => {
          img.classList.add('falling');
        });
      });

      // After all covers have fallen, callback
      setTimeout(() => {
        explosionContainer.classList.add('hidden');
        explosionContainer.innerHTML = '';
        callback();
      }, 2200);
    }, 1600);
  }, 500);
}

// --- EVENTS ---
startBtn.addEventListener('click', async () => {
  // MUST be synchronous with user gesture!
  if (!audioCtx) setupAudioContext();
  if (audioCtx.state === 'suspended') await audioCtx.resume();

  if(document.documentElement.requestFullscreen) {
    document.documentElement.requestFullscreen().catch(e => console.log(e));
  }

  triggerCoverExplosion(() => {
    introOverlay.style.opacity = '0';
    introOverlay.style.pointerEvents = 'none';
    setTimeout(() => {
      introOverlay.style.display = 'none';
      wrappedUi.classList.remove('hidden');
      
      if (!isPlaying) {
        playTrack(currentTrackIndex);
      }
    }, 1500);
  });
});

function nextTrack() {
  if (btnSkip && btnSkip.disabled) return;
  if (currentSource) {
    currentSource.onended = null;
    try { currentSource.stop(); } catch(e) {}
  }
  currentTrackIndex++;
  playTrack(currentTrackIndex);
}

function prevTrack() {
  if (currentTrackIndex > 0) {
    if (currentSource) {
      currentSource.onended = null;
      try { currentSource.stop(); } catch(e) {}
    }
    currentTrackIndex--;
    playTrack(currentTrackIndex);
  }
}

let lastMediaSessionPos = -1;

function updateWrappedMediaSession(track) {
  if (!('mediaSession' in navigator)) return;

  let artworks = [];
  if (track && track.cover) {
    try {
      const absCover = new URL(track.cover, window.location.href).href;
      const mime = absCover.endsWith('.png') ? 'image/png' : (absCover.endsWith('.webp') ? 'image/webp' : 'image/jpeg');
      const sizes = ['96x96', '128x128', '192x192', '256x256', '384x384', '512x512'];
      artworks = sizes.map(s => ({
        src: absCover,
        sizes: s,
        type: mime
      }));
    } catch (e) {
      artworks = [{ src: track.cover, sizes: '512x512', type: 'image/jpeg' }];
    }
  } else {
    try {
      artworks = [
        { src: new URL('../assets/media-session-192.png', window.location.href).href, sizes: '192x192', type: 'image/png' },
        { src: new URL('../assets/media-session-512.png', window.location.href).href, sizes: '512x512', type: 'image/png' }
      ];
    } catch (e) {}
  }

  navigator.mediaSession.metadata = new MediaMetadata({
    title: track ? track.title : 'Radio Carducci Wrapped',
    artist: track ? track.artist : 'Radio Carducci Staff',
    album: 'Carducci Wrapped · 2026',
    artwork: artworks
  });

  navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
  lastMediaSessionPos = 0;

  if ('setPositionState' in navigator.mediaSession) {
    try {
      navigator.mediaSession.setPositionState({
        duration: 30,
        playbackRate: isPlaying ? 1 : 0,
        position: 0
      });
    } catch (e) {}
  }
}

function initWrappedMediaSession() {
  if (!('mediaSession' in navigator)) return;

  navigator.mediaSession.setActionHandler('play', () => {
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume();
      isPlaying = true;
      navigator.mediaSession.playbackState = 'playing';
    }
  });

  navigator.mediaSession.setActionHandler('pause', () => {
    if (audioCtx && audioCtx.state === 'running') {
      audioCtx.suspend();
      isPlaying = false;
      navigator.mediaSession.playbackState = 'paused';
    }
  });

  navigator.mediaSession.setActionHandler('stop', () => {
    if (currentSource) {
      currentSource.onended = null;
      try { currentSource.stop(); } catch(e) {}
    }
    isPlaying = false;
    navigator.mediaSession.playbackState = 'none';
  });

  try {
    navigator.mediaSession.setActionHandler('nexttrack', () => nextTrack());
    navigator.mediaSession.setActionHandler('previoustrack', () => prevTrack());
  } catch(e) {}
}

initWrappedMediaSession();

btnSkip.addEventListener('click', () => {
  nextTrack();
});

// Touch swipe navigation for mobile phones & tablets
let touchStartX = 0;
let touchStartY = 0;
window.addEventListener('touchstart', (e) => {
  if (e.touches && e.touches.length === 1) {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
  }
}, { passive: true });

window.addEventListener('touchend', (e) => {
  if (e.changedTouches && e.changedTouches.length === 1) {
    const dx = e.changedTouches[0].clientX - touchStartX;
    const dy = e.changedTouches[0].clientY - touchStartY;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.3) {
      if (dx < 0) {
        nextTrack();
      } else {
        prevTrack();
      }
    }
  }
}, { passive: true });

// Keyboard arrows navigation
window.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowRight' || e.key === ' ') {
    nextTrack();
  } else if (e.key === 'ArrowLeft') {
    prevTrack();
  }
});

btnLike.addEventListener('click', () => {
  const track = playlist[currentTrackIndex];
  if (!track) return;

  const key = trackKey(track);
  let rawStorage = localStorage.getItem('rc_liked_tracks');
  let currentLikes = [];
  try {
    currentLikes = JSON.parse(rawStorage) || [];
  } catch (e) {
    currentLikes = [];
  }

  const existingIdx = currentLikes.findIndex(item => {
    if (typeof item === 'string') return item === key;
    return item.src === key || item.title === track.title;
  });

  const spotifyUrl = track.spotifyUrl || `https://open.spotify.com/search/${encodeURIComponent(track.artist + ' ' + track.title)}`;
  const speaker = getSpeakerForTrack(track, currentTrackIndex);

  if (existingIdx !== -1) {
    currentLikes.splice(existingIdx, 1);
    btnLike.classList.remove('liked');
  } else {
    currentLikes.push({
      title: track.title,
      artist: track.artist,
      cover: track.cover || '',
      src: key,
      spotifyUrl: spotifyUrl,
      speaker: speaker,
      savedAt: Date.now()
    });
    btnLike.classList.add('liked');
    showMatchToast(speaker, track);
  }

  likedTracks = currentLikes.map(item => (typeof item === 'string' ? item : item.src));
  localStorage.setItem('rc_liked_tracks', JSON.stringify(currentLikes));

  try {
    window.dispatchEvent(new Event('rc-liked-tracks-updated'));
  } catch(e) {}
});

window.addEventListener('message', (e) => {
  if (e.data && (e.data.type === 'rc-stop-audio' || e.data === 'stop')) {
    if (audio) {
      audio.pause();
    }
    isPlaying = false;
    updatePlayBtn();
  }
});

loadPlaylist();
