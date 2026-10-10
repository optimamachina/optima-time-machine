/* Optima Time Machine — settings behaviour. */
(function () {
  'use strict';

  var Seeds = window.RTSeeds;
  var settings = Object.assign({}, Seeds.DEFAULT_SETTINGS);

  var CHECKS = [
    'enabled', 'strict', 'killShorts', 'searchOldOnly', 'channelPagesUnfiltered', 'subsUnfiltered', 'blockWatchPage',
    'allowEscapeHatch', 'takeOverHome', 'sidebarRelated', 'autoplayFromPool',
    'showYearBadge', 'crawlEnabled', 'crawlOnlyWhenIdle', 'crawlPlaylists',
    'seedSearches', 'learnInterests', 'aiExpansion'
  ];

  var NUMBERS = ['crawlDailyCap'];
  var TEXTS = ['geminiModel', 'aiModel'];

  /* API keys are kept in their own storage slot ("aiKeys"), never inside
   * settings: the settings object is read by the scripts on YouTube's pages
   * and written back whole from several places. Only this page and the
   * background worker ever read the keys. */
  var KEYS = ['geminiKey', 'anthropicKey'];
  var keys = {};

  /* The extension may only talk to the model's server once you switch the
   * feature on (optional host permissions). */
  var AI_HOSTS = { gemini: 'https://generativelanguage.googleapis.com/*', anthropic: 'https://api.anthropic.com/*' };
  function aiHost() { return AI_HOSTS[settings.aiProvider === 'anthropic' ? 'anthropic' : 'gemini']; }
  function askForHost() {
    // Must run straight from the click, before anything is awaited.
    return chrome.permissions.request({ origins: [aiHost()] }).catch(function () { return false; });
  }

  function $(id) { return document.getElementById(id); }

  async function send(type, payload) {
    try {
      return await chrome.runtime.sendMessage(Object.assign({ type: type }, payload || {}));
    } catch (e) {
      return null;
    }
  }

  /* ------------------------------------------------------------------ save */

  var savedTimer = null;
  function flashSaved(text) {
    var node = $('saved');
    node.textContent = text || 'saved';
    node.classList.add('show');
    clearTimeout(savedTimer);
    savedTimer = setTimeout(function () { node.classList.remove('show'); }, 1400);
  }

  var saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async function () {
      var clean = Object.assign({}, settings);
      KEYS.forEach(function (k) { delete clean[k]; });
      await chrome.storage.local.set({ settings: clean });
      flashSaved();
    }, 200);
  }

  /* ------------------------------------------------------------------ bind */

  function bindChecks() {
    CHECKS.forEach(function (key) {
      var node = $(key);
      if (!node) return;
      node.addEventListener('change', function () {
        if (key === 'aiExpansion' && node.checked) {
          askForHost().then(function (granted) {
            if (!granted) {
              node.checked = false;
              flashSaved('not switched on: the extension needs your ok to reach ' + aiHost().replace('/*', ''));
              return;
            }
            settings.aiExpansion = true;
            save();
            syncAiFields();
          });
          return;
        }
        if (key === 'aiExpansion' && !node.checked) {
          chrome.permissions.remove({ origins: [AI_HOSTS.gemini, AI_HOSTS.anthropic] }).catch(function () {});
        }
        settings[key] = node.checked;
        save();
        if (key === 'aiExpansion') syncAiFields();
        if (key === 'blockWatchPage') syncBlockFields();
      });
    });
  }

  function syncAiFields() {
    var on = !!settings.aiExpansion;
    var gemini = settings.aiProvider !== 'anthropic';
    $('geminiFields').hidden = !gemini;
    $('anthropicFields').hidden = gemini;
    TEXTS.concat(KEYS).forEach(function (id) { $(id).disabled = !on; });
    document.querySelectorAll('input[name="aiProvider"]').forEach(function (r) {
      r.checked = r.value === (gemini ? 'gemini' : 'anthropic');
    });
    $('runAi').disabled = !on;
  }

  function syncBlockFields() {
    $('allowEscapeHatch').disabled = !settings.blockWatchPage;
  }

  function bindCutoff() {
    var slider = $('cutoff');
    var out = $('yearOut');
    slider.addEventListener('input', function () { out.textContent = slider.value; fill(slider); });
    slider.addEventListener('change', function () {
      settings.cutoffYear = parseInt(slider.value, 10);
      save();
    });
  }

  function bindRate() {
    var slider = $('crawlPerMinute');
    var out = $('rateOut');
    slider.addEventListener('input', function () { out.textContent = slider.value; fill(slider); });
    slider.addEventListener('change', function () {
      settings.crawlPerMinute = parseInt(slider.value, 10);
      save();
    });
  }

  function bindNumbers() {
    NUMBERS.forEach(function (id) {
      $(id).addEventListener('change', function () {
        var n = parseInt(this.value, 10);
        settings[id] = isFinite(n) && n > 0 ? n : 0;
        this.value = settings[id];
        save();
      });
    });
  }

  // The groove fills blue up to the knob (optima.css reads --fill).
  function fill(slider) {
    var min = +slider.min, max = +slider.max;
    slider.style.setProperty('--fill', ((+slider.value - min) / (max - min) * 100) + '%');
  }

  function saveKeys() {
    chrome.storage.local.set({ aiKeys: keys }).then(function () { flashSaved(); });
  }

  function bindKeys() {
    KEYS.forEach(function (id) {
      $(id).addEventListener('change', function () {
        keys[id] = this.value.trim();
        saveKeys();
      });
    });
    $('forgetKeys').addEventListener('click', function () {
      keys = {};
      KEYS.forEach(function (id) { $(id).value = ''; });
      chrome.storage.local.remove('aiKeys').then(function () { flashSaved('keys forgotten'); });
    });
  }

  function bindText() {
    TEXTS.forEach(function (id) {
      $(id).addEventListener('change', function () {
        settings[id] = this.value.trim();
        save();
      });
    });
    document.querySelectorAll('input[name="aiProvider"]').forEach(function (r) {
      r.addEventListener('change', function () {
        if (!r.checked) return;
        settings.aiProvider = r.value;
        if (settings.aiExpansion) askForHost();
        save();
        syncAiFields();
      });
    });
  }

  /* ---------------------------------------------------------------- seeds */

  function tag(text, opts) {
    opts = opts || {};
    var t = document.createElement('span');
    t.className = 'tag' + (opts.cls ? ' ' + opts.cls : '');
    t.appendChild(document.createTextNode(text));
    if (opts.onRemove) {
      var x = document.createElement('button');
      x.type = 'button';
      x.className = 'tag-x';
      x.textContent = '×';
      x.setAttribute('aria-label', 'Remove ' + text);
      x.title = opts.removeTitle || 'Remove';
      x.addEventListener('click', function (ev) {
        ev.preventDefault();
        opts.onRemove(text);
      });
      t.appendChild(x);
    } else {
      t.classList.add('plain');
    }
    if (opts.onClick) {
      t.tabIndex = 0;
      t.setAttribute('role', 'button');
      t.addEventListener('click', function () { opts.onClick(text); });
      t.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); opts.onClick(text); }
      });
    }
    return t;
  }

  function isAdded(cluster, term) {
    if (cluster === Seeds.OWN_CLUSTER) return true;
    var list = (settings.addedSeeds || {})[cluster] || [];
    return list.map(Seeds.norm).indexOf(Seeds.norm(term)) !== -1;
  }

  function removeSeed(cluster, term) {
    var n = Seeds.norm(term);
    if (cluster === Seeds.OWN_CLUSTER) {
      settings.customSeeds = (settings.customSeeds || []).filter(function (t) { return Seeds.norm(t) !== n; });
    } else if (isAdded(cluster, term)) {
      var added = Object.assign({}, settings.addedSeeds || {});
      added[cluster] = (added[cluster] || []).filter(function (t) { return Seeds.norm(t) !== n; });
      if (!added[cluster].length) delete added[cluster];
      settings.addedSeeds = added;
    } else {
      var removed = (settings.removedSeeds || []).slice();
      if (removed.indexOf(n) === -1) removed.push(n);
      settings.removedSeeds = removed;
    }
    save();
    renderClusters();
  }

  function addSeed(cluster, term) {
    term = String(term || '').trim().replace(/\s+/g, ' ');
    if (!term) return;
    var n = Seeds.norm(term);
    var existing = Seeds.effectiveClusters(settings);

    for (var name in existing) {
      if (existing[name].map(Seeds.norm).indexOf(n) !== -1) {
        flashSaved('already in ' + name);
        return;
      }
    }

    // Re-adding a default term you crossed out earlier just uncrosses it.
    if (Seeds.SEED_CLUSTERS[cluster] && Seeds.SEED_CLUSTERS[cluster].map(Seeds.norm).indexOf(n) !== -1) {
      settings.removedSeeds = (settings.removedSeeds || []).filter(function (t) { return t !== n; });
    } else if (cluster === Seeds.OWN_CLUSTER) {
      settings.customSeeds = (settings.customSeeds || []).concat([term]);
    } else {
      var added = Object.assign({}, settings.addedSeeds || {});
      added[cluster] = (added[cluster] || []).concat([term]);
      settings.addedSeeds = added;
    }
    save();
    renderClusters();
  }

  function restoreCluster(cluster) {
    var defaults = (Seeds.SEED_CLUSTERS[cluster] || []).map(Seeds.norm);
    settings.removedSeeds = (settings.removedSeeds || []).filter(function (t) {
      return defaults.indexOf(t) === -1;
    });
    save();
    renderClusters();
  }

  function renderClusters() {
    var host = $('clusters');
    host.replaceChildren();
    var clusters = Seeds.effectiveClusters(settings);
    var disabled = settings.disabledClusters || [];

    var select = $('seedCluster');
    var chosen = select.value;
    select.replaceChildren();
    Object.keys(clusters).forEach(function (name) {
      var opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      select.appendChild(opt);
    });
    select.value = chosen && clusters[chosen] ? chosen : Seeds.OWN_CLUSTER;

    Object.keys(clusters).forEach(function (name) {
      var box = document.createElement('div');
      box.className = 'cluster';

      var head = document.createElement('div');
      head.className = 'cluster-head';

      var label = document.createElement('label');
      var check = document.createElement('input');
      check.type = 'checkbox';
      check.checked = disabled.indexOf(name) === -1;
      check.addEventListener('change', function () {
        var list = (settings.disabledClusters || []).slice();
        var i = list.indexOf(name);
        if (check.checked && i !== -1) list.splice(i, 1);
        if (!check.checked && i === -1) list.push(name);
        settings.disabledClusters = list;
        save();
      });
      label.appendChild(check);
      label.appendChild(document.createTextNode(name + ' '));
      var count = document.createElement('span');
      count.className = 'count';
      count.textContent = '(' + clusters[name].length + ')';
      label.appendChild(count);
      head.appendChild(label);

      var defaults = Seeds.SEED_CLUSTERS[name] || [];
      var removedHere = defaults.length - defaults.filter(function (t) {
        return (settings.removedSeeds || []).indexOf(Seeds.norm(t)) === -1;
      }).length;
      if (removedHere > 0) {
        var restore = document.createElement('a');
        restore.href = '#';
        restore.className = 'restore';
        restore.textContent = 'restore ' + removedHere + ' crossed out';
        restore.addEventListener('click', function (ev) {
          ev.preventDefault();
          restoreCluster(name);
        });
        head.appendChild(restore);
      }
      box.appendChild(head);

      var terms = document.createElement('div');
      terms.className = 'terms';
      if (!clusters[name].length) {
        terms.textContent = name === Seeds.OWN_CLUSTER
          ? 'nothing yet. add a term above.'
          : 'everything crossed out.';
      }
      clusters[name].forEach(function (term) {
        terms.appendChild(tag(term, {
          cls: isAdded(name, term) ? 'added' : '',
          removeTitle: 'cross out',
          onRemove: function () { removeSeed(name, term); }
        }));
      });
      box.appendChild(terms);
      host.appendChild(box);
    });
  }

  function renderHiddenChannels() {
    var host = $('hiddenChannels');
    host.replaceChildren();
    var list = settings.hiddenChannels || [];
    if (!list.length) { host.textContent = 'none.'; return; }
    list.forEach(function (key) {
      host.appendChild(tag(key, {
        cls: 'banned',
        onClick: function () {
          settings.hiddenChannels = (settings.hiddenChannels || []).filter(function (k) { return k !== key; });
          save();
          renderHiddenChannels();
        }
      }));
    });
  }

  function bindSeedAdd() {
    var input = $('seedInput');
    function go() {
      addSeed($('seedCluster').value, input.value);
      input.value = '';
      input.focus();
    }
    $('seedAdd').addEventListener('click', go);
    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); go(); }
    });
  }

  /* ---------------------------------------------------------------- status */

  function renderLearned(host, terms, onRemove) {
    host.replaceChildren();
    if (!terms || !terms.length) {
      host.textContent = 'nothing yet.';
      return;
    }
    terms.forEach(function (t) {
      var text = typeof t === 'string' ? t : t.term;
      host.appendChild(tag(text, { removeTitle: 'cross out', onRemove: onRemove }));
    });
  }

  function renderBanned(list) {
    var box = $('bannedBox');
    box.hidden = !list || !list.length;
    if (box.hidden) return;
    var host = $('banned');
    host.replaceChildren();
    list.forEach(function (term) {
      host.appendChild(tag(term, {
        cls: 'banned',
        onClick: async function () {
          await send('unbanTerm', { term: term });
          refreshStatus();
        }
      }));
    });
  }

  async function banTerm(term) {
    await send('banTerm', { term: term });
    refreshStatus();
  }

  function showAiSeeds(seeds) {
    var box = $('aiSeedsBox');
    box.hidden = !seeds || !seeds.length;
    if (!box.hidden) renderLearned($('aiSeeds'), seeds, banTerm);
  }

  function renderRecent(videos) {
    var host = $('recent');
    host.replaceChildren();
    if (!videos || !videos.length) {
      host.textContent = 'nothing found yet.';
      return;
    }
    videos.forEach(function (v) {
      var row = document.createElement('div');
      row.className = 'recent-row';

      var bad = !v.title || !v.year ||
        (settings.cutoffYear && v.year > settings.cutoffYear);
      if (bad) row.className += ' bad';

      var year = document.createElement('span');
      year.className = 'recent-year';
      year.textContent = v.year || '?';
      row.appendChild(year);

      var title = document.createElement('a');
      title.className = 'recent-title';
      title.href = 'https://www.youtube.com/watch?v=' + encodeURIComponent(v.id);
      title.target = '_blank';
      title.rel = 'noopener';
      title.textContent = v.title || '(no title — ' + v.id + ')';
      title.title = (v.title || '') + '  ' + v.id + (v.channel ? '  — ' + v.channel : '');
      row.appendChild(title);

      var src = document.createElement('span');
      src.className = 'recent-src';
      src.textContent = (v.source || '').split(':')[0];
      row.appendChild(src);

      host.appendChild(row);
    });
  }

  async function refreshRecent() {
    var res = await send('recent', { limit: 20 });
    if (res && res.ok) renderRecent(res.videos);
  }

  function describeCrawler(c) {
    var bits = [];
    if (c.frontier) bits.push(c.frontier.toLocaleString() + ' left to explore');
    if (c.lastActivity) bits.push('last: ' + c.lastActivity);
    if (c.backoffUntil) {
      bits.push('paused until ' + new Date(c.backoffUntil).toLocaleTimeString() +
        (c.backoffKind === 'rate' ? ' because YouTube refused a request' : ' after an error — Collect now clears this'));
    } else if (c.lastError) {
      bits.push(c.lastError);
    }
    if (!c.hasCreds) bits.push('open a YouTube tab once so background collecting can start');
    else if (settings.crawlOnlyWhenIdle) bits.push(c.idle ? 'you look away, so it is collecting' : 'waiting until you are away');
    return bits.join('. ');
  }

  async function refreshStatus() {
    var res = await send('status');
    if (!res || !res.ok) return;

    $('poolCount').textContent = (res.crawler.pool || 0).toLocaleString();
    $('dayUsed').textContent = (res.crawler.dayUsed || 0) + ' made today';

    var status = $('crawlStatus');
    status.textContent = describeCrawler(res.crawler);
    status.classList.toggle('error', !res.crawler.hasCreds || !!res.crawler.backoffUntil);

    var top = res.taste.topTerms || [];
    if (top.length) {
      renderLearned($('terms'), top.map(function (t) { return t.term; }), banTerm);
    } else {
      $('terms').textContent = 'Nothing yet — it needs a few watches before a pattern shows.';
    }
    var channels = res.taste.topChannels || [];
    var chost = $('channels');
    chost.replaceChildren();
    if (!channels.length) chost.textContent = 'nothing yet.';
    channels.forEach(function (c) {
      chost.appendChild(tag(c.channel + ' (' + c.watched + ')', {}));
    });
    showAiSeeds(res.taste.aiSeeds || []);
    renderBanned(res.taste.banned || []);

    if (res.taste.lastAiError) {
      $('aiStatus').textContent = res.taste.lastAiError;
      $('aiStatus').classList.add('error');
    }
    return res;
  }

  /* --------------------------------------------------------------- actions */

  function busy(button, fn) {
    button.addEventListener('click', async function () {
      button.disabled = true;
      try { await fn(); } finally { button.disabled = false; }
    });
  }

  function bindActions() {
    busy($('refreshRecent'), refreshRecent);

    busy($('scrub'), async function () {
      var res = await send('scrub');
      if (res && res.ok) {
        var r = res.report;
        var total = r.badId + r.noTitle + r.tooNew;
        $('dangerStatus').textContent = total === 0
          ? 'Nothing to clean up.'
          : 'Removed ' + total + ': ' + r.badId + ' with a broken id, ' +
            r.noTitle + ' with no title, ' + r.tooNew + ' past the cutoff.';
      } else {
        $('dangerStatus').textContent = 'Could not clean up the pool.';
      }
      refreshStatus();
      refreshRecent();
    });

    busy($('crawlNow'), async function () {
      var status = $('crawlStatus');
      status.classList.remove('error');
      status.textContent = 'collecting…';
      var res = await send('crawlNow');
      if (res && res.ok && res.result) {
        if (res.result.did) {
          status.textContent = 'Done: ' + (res.crawler.lastActivity || 'made a request') +
            (res.result.found ? ' (' + res.result.found + ' old videos found)' : '');
        } else {
          status.textContent = 'Did nothing: ' + (res.result.reason || 'unknown reason');
          status.classList.add('error');
        }
      } else {
        status.textContent = (res && res.error) || 'The collector did not answer.';
        status.classList.add('error');
      }
      refreshRecent();
      $('poolCount').textContent = ((res && res.crawler && res.crawler.pool) || 0).toLocaleString();
    });

    busy($('primePool'), async function () {
      var status = $('crawlStatus');
      status.classList.remove('error');
      status.textContent = 'Searching. This takes about twenty seconds…';
      var res = await send('primePool', { rounds: 5 });
      if (res && res.ok && res.added > 0) {
        status.textContent = 'Added ' + res.added + ' videos' +
          (res.terms && res.terms.length ? ' from: ' + res.terms.join(', ') : '') + '.';
      } else if (res && res.ok && res.found > 0) {
        status.textContent = 'Found ' + res.found +
          ' old videos but all were already in the pool. Try different terms.';
      } else {
        status.textContent = (res && res.reasons && res.reasons[0]) ||
          (res && res.error) ||
          'No results. Open youtube.com in another tab, let it load, then try again.';
        status.classList.add('error');
      }
      refreshStatus();
      refreshRecent();
    });

    busy($('runAi'), async function () {
      var status = $('aiStatus');
      if (!(await askForHost())) {
        status.textContent = 'not sent: the extension needs your ok to reach ' + aiHost().replace('/*', '');
        status.classList.add('error');
        return;
      }
      status.classList.remove('error');
      status.textContent = 'asking…';
      var res = await send('runAi');
      if (res && res.ok && res.result && res.result.ran) {
        status.textContent = 'Got ' + res.result.count + ' new search terms.';
        showAiSeeds(res.result.seeds || []);
      } else {
        status.textContent = (res && res.result && res.result.error) ||
          (res && res.error) || 'No terms came back.';
        status.classList.add('error');
      }
    });

    busy($('purge'), async function () {
      var res = await send('purge');
      $('dangerStatus').textContent = res && res.ok
        ? 'Removed ' + res.removed + ' videos past ' + settings.cutoffYear + '.'
        : 'Could not clear out the pool.';
      refreshStatus();
    });

    busy($('clearPool'), async function () {
      if (!confirm('Empty the pool? Collecting starts again from nothing.')) return;
      await send('clearPool');
      $('dangerStatus').textContent = 'pool emptied.';
      refreshStatus();
      refreshRecent();
    });
  }

  /* ------------------------------------------------------------------ init */

  function apply() {
    CHECKS.forEach(function (key) {
      var node = $(key);
      if (node) node.checked = !!settings[key];
    });

    $('cutoff').value = settings.cutoffYear;
    $('yearOut').textContent = settings.cutoffYear;

    $('crawlPerMinute').value = settings.crawlPerMinute;
    $('rateOut').textContent = settings.crawlPerMinute;
    fill($('cutoff'));
    fill($('crawlPerMinute'));

    NUMBERS.forEach(function (id) { $(id).value = settings[id] || 0; });
    TEXTS.forEach(function (id) { $(id).value = settings[id] || ''; });
    KEYS.forEach(function (id) { $(id).value = keys[id] || ''; });

    syncAiFields();
    syncBlockFields();
    renderClusters();
    renderHiddenChannels();
  }

  /* The popup and the worker write settings too. Take their changes without
   * touching text fields, which may be mid-edit. */
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'local' || !changes.settings || !changes.settings.newValue) return;
    var incoming = changes.settings.newValue;
    var same = TEXTS.every(function (id) { return (incoming[id] || '') === (settings[id] || ''); });
    Object.assign(settings, incoming);
    if (!same) return;
    CHECKS.forEach(function (key) {
      var node = $(key);
      if (node) node.checked = !!settings[key];
    });
    $('cutoff').value = settings.cutoffYear;
    $('yearOut').textContent = settings.cutoffYear;
    $('crawlPerMinute').value = settings.crawlPerMinute;
    $('rateOut').textContent = settings.crawlPerMinute;
    fill($('cutoff'));
    fill($('crawlPerMinute'));
    NUMBERS.forEach(function (id) { $(id).value = settings[id] || 0; });
    syncAiFields();
    syncBlockFields();
    renderClusters();
    renderHiddenChannels();
  });

  /* The sidebar tray marks the section you're reading. */
  function bindNav() {
    var links = Array.prototype.slice.call(document.querySelectorAll('.side .tray a'));
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        links.forEach(function (a) { a.classList.toggle('active', a.getAttribute('href') === '#' + e.target.id); });
      });
    }, { rootMargin: '-30% 0px -60% 0px' });
    document.querySelectorAll('main .panel').forEach(function (p) { io.observe(p); });
  }

  chrome.storage.local.get(['settings', 'aiKeys']).then(function (res) {
    settings = Object.assign({}, Seeds.DEFAULT_SETTINGS, (res && res.settings) || {});
    keys = Object.assign({}, (res && res.aiKeys) || {});
    // Keys from before 1.3.0 that never got moved: move them now.
    KEYS.forEach(function (k) {
      if (settings[k] && !keys[k]) keys[k] = settings[k];
      delete settings[k];
    });
    if (Object.keys(keys).length) chrome.storage.local.set({ aiKeys: keys });
    apply();
    bindKeys();
    bindNav();
    bindChecks();
    bindCutoff();
    bindRate();
    bindNumbers();
    bindText();
    bindSeedAdd();
    bindActions();
    refreshStatus();
    refreshRecent();
    setInterval(refreshStatus, 6000);
  });
})();
