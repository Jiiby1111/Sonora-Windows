// ai.js - On-device AI engine for Sonora
// Signal processing + lightweight ML heuristics. No network, no API keys.

(function () {
  'use strict';

  const GENRES = {
    rock: ['rock', 'hard rock', 'alternative rock'],
    pop: ['pop'],
    jazz: ['jazz'],
    'hip hop': ['hip hop', 'hiphop', 'rap'],
    metal: ['metal', 'heavy metal', 'death metal', 'metalcore'],
    electronic: ['electronic', 'edm', 'dance', 'electronica', 'idm'],
    house: ['house', 'deep house', 'progressive house'],
    techno: ['techno', 'minimal'],
    trance: ['trance'],
    dubstep: ['dubstep', 'brostep'],
    classical: ['classical', 'orchestral', 'baroque'],
    country: ['country'],
    blues: ['blues'],
    folk: ['folk', 'acoustic folk'],
    reggae: ['reggae', 'dub'],
    'r&b': ['r&b', 'rnb', 'rhythm and blues'],
    soul: ['soul', 'funk soul'],
    indie: ['indie', 'indie rock', 'indie pop'],
    punk: ['punk', 'punk rock', 'hardcore punk'],
    ambient: ['ambient', 'new age'],
    instrumental: ['instrumental']
  };

  const MOODS = {
    chill: { e: [0, 0.4], f: [0, 0.5] },
    relax: { e: [0, 0.4] },
    calm: { e: [0, 0.35], t: [0, 0.55] },
    mellow: { e: [0, 0.3], t: [0, 0.5] },
    sleepy: { e: [0, 0.2], t: [0, 0.3] },
    night: { e: [0, 0.3], t: [0, 0.5] },
    'late night': { e: [0, 0.3], t: [0, 0.5] },
    upbeat: { e: [0.5, 1], t: [0.55, 1] },
    happy: { e: [0.45, 1] },
    party: { e: [0.5, 1], t: [0.6, 1] },
    dance: { e: [0.5, 1], t: [0.6, 1] },
    workout: { e: [0.55, 1], t: [0.62, 1] },
    gym: { e: [0.55, 1], t: [0.62, 1] },
    pump: { e: [0.6, 1], t: [0.62, 1] },
    hype: { e: [0.6, 1], t: [0.6, 1] },
    energetic: { e: [0.6, 1] },
    fast: { t: [0.68, 1] },
    focus: { f: [0, 0.35] },
    study: { f: [0, 0.35] },
    work: { f: [0, 0.35], e: [0.15, 0.8] },
    ambientfocus: { f: [0, 0.25], e: [0, 0.4] },
    instrumental: { f: [0, 0.4] },
    sad: { e: [0, 0.3], t: [0, 0.45] },
    emotional: { e: [0, 0.35] },
    melancholic: { e: [0, 0.3], t: [0, 0.45] },
    loud: { e: [0.6, 1], b: [0.4, 1] },
    soft: { e: [0, 0.25] },
    quiet: { e: [0, 0.2] },
    acoustic: { b: [0, 0.4] },
    unplugged: { b: [0, 0.4] }
  };

  const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'for', 'and', 'to', 'my', 'some', 'with', 'me', 'please', 'give', 'show', 'make', 'want', 'need', 'songs', 'music', 'play', 'like']);

  function clamp01(x) { return Math.max(0, Math.min(1, x)); }

  function downmix(channels, sampleRate) {
    const frames = channels[0].length;
    const mono = new Float32Array(frames);
    if (channels.length === 1) {
      return channels[0];
    }
    for (let i = 0; i < frames; i++) {
      let sum = 0;
      for (let c = 0; c < channels.length; c++) sum += channels[c][i];
      mono[i] = sum / channels.length;
    }
    return mono;
  }

  function meanRMS(frames, start, end) {
    let sum = 0;
    const n = end - start;
    for (let i = start; i < end; i++) sum += frames[i] * frames[i];
    return Math.sqrt(sum / n);
  }

  function zeroCrossingRate(frames, step) {
    let crosses = 0;
    let prev = frames[0] >= 0;
    for (let i = step; i < frames.length; i += step) {
      const cur = frames[i] >= 0;
      if (cur !== prev) crosses++;
      prev = cur;
    }
    return crosses / (frames.length / step);
  }

  function envelope(frames, sampleRate) {
    const hop = Math.floor(sampleRate / 20); // 50ms window
    const env = [];
    for (let i = 0; i < frames.length; i += hop) {
      env.push(meanRMS(frames, i, Math.min(i + hop, frames.length)));
    }
    return env;
  }

  function estimateTempo(env) {
    const mean = env.reduce((a, b) => a + b, 0) / env.length;
    const e = env.map(v => v - mean);
    let best = { bpm: 120, score: -Infinity };
    for (let bpm = 200; bpm >= 60; bpm -= 2) {
      const lag = Math.round(1200 / bpm); // env is 20 frames/sec: 20*60/bpm
      if (lag >= e.length) continue;
      let s = 0;
      for (let i = 0; i + lag < e.length; i++) s += e[i] * e[i + lag];
      s /= (e.length - lag);
      if (s > best.score) best = { bpm, score: s };
    }
    return best.bpm;
  }

  function spectralFlux(env) {
    let diff = 0;
    for (let i = 1; i < env.length; i++) diff += Math.abs(env[i] - env[i - 1]);
    return diff / (env.length - 1);
  }

  function analyzeBuffer(buffer) {
    const sampleRate = buffer.sampleRate;
    const channels = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
    const mono = downmix(channels, sampleRate);

    // decimate for zcr (every 8th sample)
    const zcr = zeroCrossingRate(mono, Math.max(1, Math.floor(sampleRate / 5500)));

    const env = envelope(mono, sampleRate);
    const avgRMS = env.reduce((a, b) => a + b, 0) / env.length;
    const flux = spectralFlux(env);
    const bpm = estimateTempo(env);

    // dynamic range: p90 vs p10 of frame rms
    const sorted = env.slice().sort((a, b) => a - b);
    const p10 = sorted[Math.floor(sorted.length * 0.1)] || 0;
    const p90 = sorted[Math.floor(sorted.length * 0.9)] || 0;
    const dynamic = p90 > 0.0001 ? clamp01((p90 - p10) / (p90 + 0.0001)) : 0;

    const features = {
      duration: buffer.duration,
      energy: clamp01(avgRMS / 0.45),
      tempo: bpm,
      tempoScore: clamp01(bpm / 180),
      brightness: clamp01(zcr * 4),
      flux: clamp01(flux * 30),
      dynamic: dynamic
    };
    return features;
  }

  function classify(features) {
    const tags = [];
    if (features.energy < 0.35) tags.push('Chill');
    if (features.energy > 0.55 && features.tempoScore > 0.55) tags.push('Upbeat');
    if (features.energy > 0.6 && features.brightness > 0.45) tags.push('Energetic');
    if (features.flux < 0.3) tags.push('Focus');
    if (features.energy < 0.25 && features.tempoScore < 0.4) tags.push('Mellow');
    if (features.dynamic > 0.6) tags.push('Dynamic');
    if (features.tempoScore < 0.35) tags.push('Slow');
    if (features.tempoScore > 0.8) tags.push('Fast');
    return tags;
  }

  function featureVector(f, meta) {
    return [
      clamp01(f.duration / 600),
      f.energy,
      f.tempoScore,
      f.brightness,
      f.flux,
      f.dynamic,
      meta && meta.year ? clamp01((meta.year - 1950) / 75) : 0.5
    ];
  }

  function cosineSimilarity(aVec, bVec) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < aVec.length; i++) {
      dot += aVec[i] * bVec[i];
      na += aVec[i] * aVec[i];
      nb += bVec[i] * bVec[i];
    }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  }

  function parseQuery(raw) {
    const q = String(raw || '').toLowerCase();
    const tokens = q.split(/[^a-z0-9&]+/).filter(t => t && !STOPWORDS.has(t));
    const query = { genres: new Set(), moods: [], decade: null, artist: null, text: tokens };

    tokens.forEach(token => {
      if (/^(19|20)\d0s$/.test(token)) {
        query.decade = parseInt(token.slice(0, 2) + '0', 10);
        return;
      }
      for (const g in GENRES) {
        if (GENRES[g].includes(token)) { query.genres.add(g); return; }
      }
      if (!query.artist && token === 'by') { query._nextBy = true; return; }
      if (query._nextBy && !query.artist) { query.artist = token; query._nextBy = false; return; }
      if (MOODS[token]) query.moods.push(token);
    });

    if (q.includes(' by ')) {
      const m = q.match(/\bby\s+([a-z0-9& .'-]+)$/);
      if (m) query.artist = m[1].replace(/\s+and\s+[a-z .]+$/, '').trim();
    }
    return query;
  }

  function scoreQuery(song, query, features) {
    let score = 0.2;
    const f = features || song.features;
    if (!f) return score;

    if (query.genres.size) {
      const lowerGenre = ((song.genre || '') + ' ' + (song.album || '')).toLowerCase();
      let matched = false;
      query.genres.forEach(g => {
        const alts = GENRES[g] || [g];
        if (alts.some(a => lowerGenre.includes(a))) matched = true;
      });
      if (matched) score += 0.35; else score -= 0.1;
    }

    if (query.decade !== null && song.year) {
      const dec = Math.floor(song.year / 10) * 10;
      if (Math.abs(dec - query.decade) <= 10) score += 0.3;
    }

    query.moods.forEach(mood => {
      const specs = MOODS[mood];
      if (!specs) return;
      let closeness = 0;
      for (const key in specs) {
        const [lo, hi] = specs[key];
        const val = f.duration && key === 'e' ? f.energy : f[key];
        const width = Math.max(hi - lo, 0.2);
        const dist = val < lo ? (lo - val) / width : val > hi ? (val - hi) / width : 0;
        closeness += clamp01(1 - dist);
      }
      score += closeness / (Object.keys(specs).length || 1) * 0.4;
    });

    const titleArtist = ((song.title || '') + ' ' + (song.artist || '') + ' ' + (song.name || '')).toLowerCase();
    query.text.forEach(token => {
      if (titleArtist.includes(token)) score += 0.12;
    });

    if (query.artist && song.artist && song.artist.toLowerCase().includes(query.artist)) score += 0.4;

    return clamp01(score);
  }

  function genreKey(song) {
    return (song.genre || '').toLowerCase().trim() || 'unknown';
  }

  function recommendAffinity(songs, stats) {
    const plays = stats || {};
    const hasPlays = Object.keys(plays).length > 0;
    const genreFreq = {};
    const artistFreq = {};
    songs.forEach(s => {
      const cnt = plays[s.path] || 0;
      if (cnt > 0) {
        const g = genreKey(s);
        genreFreq[g] = (genreFreq[g] || 0) + cnt;
        artistFreq[s.artist || 'Unknown'] = (artistFreq[s.artist || 'Unknown'] || 0) + cnt;
      }
    });
    const maxGen = Math.max(1, ...Object.values(genreFreq));
    const maxArt = Math.max(1, ...Object.values(artistFreq));

    const scored = songs.map(s => {
      let score = 0.3;
      if (hasPlays) {
        const gAff = (genreFreq[genreKey(s)] || 0) / maxGen;
        const aAff = (artistFreq[s.artist || 'Unknown'] || 0) / maxArt;
        score += gAff * 0.4 + aAff * 0.35;
      }
      if (!plays[s.path]) score += 0.12; // exploration bonus
      if (s.features) {
        score += s.features.energy * 0.05;
      }
      return { song: s, score: clamp01(score) };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored;
  }

  window.SonoraAI = {
    analyzeBuffer,
    classify,
    featureVector,
    cosineSimilarity,
    parseQuery,
    scoreQuery,
    recommendAffinity,
    GENRES,
    MOODS
  };
})();