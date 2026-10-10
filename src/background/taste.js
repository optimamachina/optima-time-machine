/* Time Machine for YouTube — learning what you're actually into.
 *
 * Two tiers, and the free one does most of the work.
 *
 * Local (always on): tally the meaningful words and channels from videos you
 * actually watch. A term only counts as an interest once it has turned up in
 * at least two different videos — one title's worth of words is noise, the
 * same words across several watches is a pattern. Recurring terms get
 * promoted into the seed pool.
 *
 * AI (opt-in, needs a key): term frequency can only find what you've already
 * seen. A model can make lateral jumps — it knows nu metal AMVs, Newgrounds
 * flash and early machinima are the same cultural neighbourhood even though
 * the words never co-occur. Gemini's free tier covers a daily run; Anthropic
 * is the paid alternative.
 */
(function (root) {
  'use strict';

  var Seeds = root.RTSeeds;

  var STOPWORDS = ('a an the and or but of to in on at for with from by is are was ' +
    'were be been it its this that these those my your his her their our i you he ' +
    'she we they me him them what when where who how why not no yes new old best ' +
    'video vid full hd hq part pt ep episode official music song feat ft ' +
    'com www http https youtube watch subscribe like comment please ' +
    'dont don\'t get got make made other stuff mine main just really very ' +
    'thing things some more most all about into over out off up down here there ' +
    'than then too can will one two first last way day').split(' ');

  var stop = Object.create(null);
  STOPWORDS.forEach(function (w) { stop[w] = true; });

  var MIN_VIDEOS = 2;

  function tokenize(text) {
    if (!text) return [];
    return String(text)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
      .split(/\s+/)
      .filter(function (w) {
        return w.length >= 3 && w.length <= 24 && !stop[w] && !/^\d+$/.test(w);
      });
  }

  function blank() {
    return { terms: {}, df: {}, channels: {}, watched: 0, lastAi: 0, aiSeeds: [], banned: [] };
  }

  async function loadTaste() {
    var res = await chrome.storage.local.get('taste');
    return Object.assign(blank(), (res && res.taste) || {});
  }

  async function saveTaste(t) {
    await chrome.storage.local.set({ taste: t });
  }

  function isBanned(t, term) {
    return (t.banned || []).indexOf(Seeds.norm(term)) !== -1;
  }

  /* Record a watch. Titles are weighted higher than channel names because a
   * channel is one signal repeated, whereas each title is fresh evidence.
   * `df` counts how many distinct videos a term has appeared in. */
  async function recordWatch(video) {
    if (!video) return;
    var t = await loadTaste();
    t.watched = (t.watched || 0) + 1;
    if (!t.df) t.df = {};

    var words = tokenize(video.title);
    var seenHere = Object.create(null);

    function bump(term, weight) {
      t.terms[term] = (t.terms[term] || 0) + weight;
      if (!seenHere[term]) {
        seenHere[term] = true;
        t.df[term] = (t.df[term] || 0) + 1;
      }
    }

    words.forEach(function (w) { bump(w, 2); });
    // Bigrams catch things unigrams miss: "stop motion", "tech deck".
    for (var i = 0; i < words.length - 1; i++) bump(words[i] + ' ' + words[i + 1], 3);

    if (video.channel) {
      t.channels[video.channel] = (t.channels[video.channel] || 0) + 1;
    }

    // Decay occasionally so old obsessions fade instead of ossifying.
    if (t.watched % 40 === 0) {
      for (var k in t.terms) {
        t.terms[k] *= 0.85;
        if (t.terms[k] < 0.6) { delete t.terms[k]; delete t.df[k]; }
      }
    }

    await saveTaste(t);
  }

  function recurring(t, k) {
    return ((t.df || {})[k] || 0) >= MIN_VIDEOS;
  }

  function topTerms(t, n) {
    return Object.keys(t.terms || {})
      .filter(function (k) { return recurring(t, k) && !isBanned(t, k); })
      .map(function (k) { return { term: k, score: t.terms[k], videos: t.df[k] }; })
      .sort(function (a, b) { return b.score - a.score; })
      .slice(0, n || 25);
  }

  function topChannels(t, n) {
    var c = t.channels || {};
    return Object.keys(c)
      .map(function (k) { return { channel: k, watched: c[k] }; })
      .sort(function (a, b) { return b.watched - a.watched; })
      .slice(0, n || 12);
  }

  async function learnedSeeds(limit) {
    var t = await loadTaste();
    var top = topTerms(t, 60)
      .filter(function (x) { return x.score >= 4; })
      .map(function (x) { return x.term; });
    var ai = (t.aiSeeds || []).filter(function (s) { return !isBanned(t, s); });
    return top.slice(0, limit || 30).concat(ai);
  }

  /* A term the user crossed out never comes back — not from counting, not
   * from the model. */
  async function banTerm(term) {
    var t = await loadTaste();
    var n = Seeds.norm(term);
    if (!n) return;
    if (!t.banned) t.banned = [];
    if (t.banned.indexOf(n) === -1) t.banned.push(n);
    delete t.terms[n];
    if (t.df) delete t.df[n];
    t.aiSeeds = (t.aiSeeds || []).filter(function (s) { return Seeds.norm(s) !== n; });
    await saveTaste(t);
  }

  async function unbanTerm(term) {
    var t = await loadTaste();
    var n = Seeds.norm(term);
    t.banned = (t.banned || []).filter(function (b) { return b !== n; });
    await saveTaste(t);
  }

  /* -------------------------------------------------------- AI expansion */

  function providerKey(cfg) {
    return cfg.aiProvider === 'anthropic' ? cfg.anthropicKey : cfg.geminiKey;
  }

  function shouldRunAi(cfg, t) {
    if (!cfg.aiExpansion || !providerKey(cfg)) return false;
    if ((t.watched || 0) < 8) return false;
    var sinceLast = Date.now() - (t.lastAi || 0);
    return sinceLast > 20 * 60 * 60 * 1000; // roughly once a day
  }

  /* Exactly what leaves the computer when you ask a model: the cutoff year
   * and up to 30 recurring words from titles you watched. No titles, no
   * channel names, no video ids, nothing about you. */
  function buildPrompt(cfg, t) {
    var top = topTerms(t, 30).map(function (x) { return x.term; });

    return 'Someone browses only YouTube videos uploaded in ' + cfg.cutoffYear + ' or earlier. ' +
      'These are words that keep coming up in what they watch.\n\n' +
      'Terms: ' + top.join(', ') + '\n\n' +
      'Suggest 25 YouTube search queries likely to surface videos from that era that this ' +
      'person would like but probably has not found yet. Favour lateral moves within the same ' +
      'cultural neighbourhood over near-duplicates of the terms above. Prefer the vocabulary ' +
      'people actually used in video titles at the time, including misspellings and slang. ' +
      'Return ONLY a JSON array of strings. No preamble, no markdown fences.';
  }

  async function askAnthropic(cfg, prompt) {
    var res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': cfg.anthropicKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: cfg.aiModel || Seeds.DEFAULT_SETTINGS.aiModel,
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    if (!res.ok) {
      var body = await res.text();
      throw new Error('Anthropic API ' + res.status + ': ' + body.slice(0, 200));
    }
    var data = await res.json();
    return (data.content || [])
      .filter(function (b) { return b.type === 'text'; })
      .map(function (b) { return b.text; })
      .join('\n');
  }

  async function askGemini(cfg, prompt) {
    var model = cfg.geminiModel || Seeds.DEFAULT_SETTINGS.geminiModel;
    var url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
      encodeURIComponent(model) + ':generateContent';
    var res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': cfg.geminiKey
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: { type: 'array', items: { type: 'string' } }
        }
      })
    });
    if (!res.ok) {
      var body = await res.text();
      throw new Error('Gemini API ' + res.status + ': ' + body.slice(0, 200));
    }
    var data = await res.json();
    var parts = data && data.candidates && data.candidates[0] &&
      data.candidates[0].content && data.candidates[0].content.parts;
    return (parts || []).map(function (p) { return p.text || ''; }).join('\n');
  }

  function parseTerms(text) {
    text = String(text || '').replace(/```json|```/g, '').trim();
    var arr;
    try {
      arr = JSON.parse(text);
    } catch (e) {
      var m = text.match(/\[[\s\S]*\]/);
      try { arr = m ? JSON.parse(m[0]) : []; } catch (e2) { arr = []; }
    }
    if (!Array.isArray(arr)) arr = [];
    return arr
      .filter(function (s) { return typeof s === 'string' && s.length > 1 && s.length < 80; })
      .map(function (s) { return s.trim(); })
      .slice(0, 30);
  }

  /* The keys live in their own storage slot, apart from the settings the
   * YouTube-page scripts read, and only this worker reads them. */
  var AI_HOSTS = { gemini: 'https://generativelanguage.googleapis.com/*', anthropic: 'https://api.anthropic.com/*' };

  async function expandWithAi(cfg, force) {
    var stored = await chrome.storage.local.get('aiKeys');
    cfg = Object.assign({}, cfg, (stored && stored.aiKeys) || {});
    var t = await loadTaste();
    if (!cfg.learnInterests) {
      return { ran: false, error: 'Learning from what you watch is off, so there is nothing to base suggestions on. Switch it on first if you want this.' };
    }
    if (!force && !shouldRunAi(cfg, t)) return { ran: false, reason: 'not due' };
    if (!providerKey(cfg)) {
      return { ran: false, error: 'no API key for ' + (cfg.aiProvider === 'anthropic' ? 'Anthropic' : 'Gemini') };
    }
    // Network access to the model's server is only granted when you switch
    // this on (optional_host_permissions); without it nothing is sent.
    var host = AI_HOSTS[cfg.aiProvider === 'anthropic' ? 'anthropic' : 'gemini'];
    if (!(await chrome.permissions.contains({ origins: [host] }))) {
      return { ran: false, error: 'the extension is not allowed to reach ' + host.replace('/*', '') + ' yet: switch "ask a model" off and on again and allow it' };
    }

    var prompt = buildPrompt(cfg, t);
    try {
      var text = cfg.aiProvider === 'anthropic'
        ? await askAnthropic(cfg, prompt)
        : await askGemini(cfg, prompt);
      var clean = parseTerms(text).filter(function (s) { return !isBanned(t, s); });
      t.aiSeeds = clean;
      t.lastAi = Date.now();
      t.lastAiError = null;
      await saveTaste(t);
      return { ran: true, count: clean.length, seeds: clean };
    } catch (err) {
      t.lastAi = Date.now();
      t.lastAiError = String(err && err.message || err);
      await saveTaste(t);
      return { ran: false, error: t.lastAiError };
    }
  }

  var api = {
    recordWatch: recordWatch,
    learnedSeeds: learnedSeeds,
    loadTaste: loadTaste,
    saveTaste: saveTaste,
    topTerms: topTerms,
    topChannels: topChannels,
    tokenize: tokenize,
    banTerm: banTerm,
    unbanTerm: unbanTerm,
    expandWithAi: expandWithAi,
    MIN_VIDEOS: MIN_VIDEOS
  };

  root.RTTaste = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
