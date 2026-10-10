/* Time Machine for YouTube — the pool.
 *
 * Everything that survives the wall gets written here. Two stores:
 *
 *   videos   — the pool itself. `degree` counts how many distinct related
 *              lists a video has turned up in, which is a decent proxy for
 *              how central it is in your corner of old YouTube.
 *   frontier — video ids whose own related lists haven't been walked yet.
 *              This is the crawler's to-do list.
 *   edges    — for a video, the old videos YouTube listed beside it.
 *   related  — the sidebar the extension built for a video, kept for a few
 *              days so revisiting it costs YouTube nothing.
 */
(function (root) {
  'use strict';

  var DB_NAME = 'timemachine';
  var DB_VERSION = 2;
  var dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = function (ev) {
        var db = ev.target.result;

        if (!db.objectStoreNames.contains('videos')) {
          var v = db.createObjectStore('videos', { keyPath: 'id' });
          v.createIndex('year', 'year');
          v.createIndex('degree', 'degree');
          v.createIndex('addedAt', 'addedAt');
          v.createIndex('shown', 'shown');
          v.createIndex('watched', 'watched');
          v.createIndex('channelId', 'channelId');
        }

        if (!db.objectStoreNames.contains('frontier')) {
          var f = db.createObjectStore('frontier', { keyPath: 'id' });
          f.createIndex('done', 'done');
          f.createIndex('priority', 'priority');
        }

        if (!db.objectStoreNames.contains('edges')) {
          db.createObjectStore('edges', { keyPath: 'key' });
        }

        if (!db.objectStoreNames.contains('related')) {
          db.createObjectStore('related', { keyPath: 'key' });
        }
      };

      req.onsuccess = function () {
        var db = req.result;
        // Step aside if a newer version of the extension needs to upgrade.
        db.onversionchange = function () { db.close(); dbPromise = null; };
        resolve(db);
      };
      req.onerror = function () { dbPromise = null; reject(req.error); };
    });
    return dbPromise;
  }

  function tx(store, mode) {
    return open().then(function (db) {
      return db.transaction(store, mode).objectStore(store);
    });
  }

  function wrap(request) {
    return new Promise(function (resolve, reject) {
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error); };
    });
  }

  function done(t) {
    return new Promise(function (resolve, reject) {
      t.oncomplete = function () { resolve(); };
      t.onerror = function () { reject(t.error); };
      t.onabort = function () { reject(t.error); };
    });
  }

  /* ---------------------------------------------------------------- videos */

  var VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

  /* Last line of defence. Whatever the extraction layer thinks it found, a
   * pool entry has to be a real video: an 11-character id and a title. */
  function isStorable(rec) {
    return !!rec &&
      typeof rec.id === 'string' &&
      VIDEO_ID_RE.test(rec.id) &&
      typeof rec.title === 'string' &&
      rec.title.trim().length > 0;
  }

  function putVideos(records, sourceId) {
    if (!records || !records.length) return Promise.resolve(0);
    var clean = records.filter(isStorable);
    if (!clean.length) return Promise.resolve(0);
    return open().then(function (db) {
      var t = db.transaction(['videos', 'frontier'], 'readwrite');
      var vs = t.objectStore('videos');
      var fs = t.objectStore('frontier');
      var added = 0;
      var now = Date.now();

      clean.forEach(function (rec) {
        var getReq = vs.get(rec.id);
        getReq.onsuccess = function () {
          var existing = getReq.result;
          if (existing) {
            existing.degree = (existing.degree || 0) + 1;
            if (!existing.title && rec.title) existing.title = rec.title;
            if (!existing.channel && rec.channel) existing.channel = rec.channel;
            if (!existing.channelId && rec.channelId) existing.channelId = rec.channelId;
            if (!existing.year && rec.year) existing.year = rec.year;
            if (!existing.views && rec.views) existing.views = rec.views;
            if (existing.viewCount == null && rec.viewCount != null) existing.viewCount = rec.viewCount;
            if (!existing.duration && rec.duration) existing.duration = rec.duration;
            existing.lastSeen = now;
            vs.put(existing);
          } else {
            added++;
            vs.put({
              id: rec.id,
              title: rec.title || '',
              channel: rec.channel || '',
              channelId: rec.channelId || null,
              thumb: rec.thumb || ('https://i.ytimg.com/vi/' + rec.id + '/hqdefault.jpg'),
              year: rec.year || null,
              ts: rec.ts || null,
              ago: rec.ago || null,
              views: rec.views || null,
              viewCount: rec.viewCount == null ? null : rec.viewCount,
              duration: rec.duration || null,
              degree: 1,
              shown: 0,
              watched: 0,
              exact: 0,
              source: sourceId || 'feed',
              addedAt: now,
              lastSeen: now,
              lastShown: 0
            });
            // The id may already sit in the frontier from an earlier run. A
            // ConstraintError would abort the whole transaction and lose the
            // batch, so swallow it and move on.
            var addReq = fs.add({ id: rec.id, done: 0, priority: 1, addedAt: now });
            addReq.onerror = function (ev) {
              ev.preventDefault();
              ev.stopPropagation();
            };
          }
        };
      });

      return done(t).then(function () { return added; });
    });
  }

  function getVideo(id) {
    return tx('videos', 'readonly').then(function (s) { return wrap(s.get(id)); });
  }

  /* Several at once, in the order asked for. Missing ids are skipped. */
  function getVideos(ids) {
    if (!ids || !ids.length) return Promise.resolve([]);
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction('videos', 'readonly');
        var s = t.objectStore('videos');
        var out = new Array(ids.length);
        ids.forEach(function (id, i) {
          var r = s.get(id);
          r.onsuccess = function () { out[i] = r.result || null; };
        });
        t.oncomplete = function () { resolve(out.filter(Boolean)); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error); };
      });
    });
  }

  function updateVideo(id, mutate) {
    return open().then(function (db) {
      var t = db.transaction('videos', 'readwrite');
      var s = t.objectStore('videos');
      var g = s.get(id);
      g.onsuccess = function () {
        var rec = g.result;
        if (!rec) return;
        mutate(rec);
        s.put(rec);
      };
      return done(t);
    });
  }

  /* One transaction for a whole page of cards, rather than one per card. */
  function markShown(ids) {
    if (!ids || !ids.length) return Promise.resolve();
    var now = Date.now();
    return open().then(function (db) {
      var t = db.transaction('videos', 'readwrite');
      var s = t.objectStore('videos');
      ids.forEach(function (id) {
        var g = s.get(id);
        g.onsuccess = function () {
          var rec = g.result;
          if (!rec) return;
          rec.shown = (rec.shown || 0) + 1;
          rec.lastShown = now;
          s.put(rec);
        };
      });
      return done(t);
    });
  }

  function deleteVideo(id) {
    return open().then(function (db) {
      var t = db.transaction(['videos', 'frontier'], 'readwrite');
      t.objectStore('videos').delete(id);
      t.objectStore('frontier').delete(id);
      return done(t);
    });
  }

  function countVideos() {
    return tx('videos', 'readonly').then(function (s) { return wrap(s.count()); });
  }

  function countChannel(channelId) {
    if (!channelId) return Promise.resolve(0);
    return tx('videos', 'readonly').then(function (s) {
      return wrap(s.index('channelId').count(IDBKeyRange.only(channelId)));
    }).catch(function () { return 0; });
  }

  /* Pull a working set to rank in memory.
   *
   * Records come back in video-id order, so taking the first N would show
   * the same slice forever and silently bury the rest. Reservoir sampling
   * gives every video an equal chance, at the cost of one full pass — a few
   * tens of milliseconds even well past the default pool target.
   */
  function sample(limit, filter) {
    var cap = limit || 4000;
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction('videos', 'readonly');
        var s = t.objectStore('videos');
        var reservoir = [];
        var seen = 0;

        var cursorReq = s.openCursor();
        cursorReq.onsuccess = function () {
          var c = cursorReq.result;
          if (!c) return resolve(reservoir);

          var rec = c.value;
          if (!filter || filter(rec)) {
            if (reservoir.length < cap) {
              reservoir.push(rec);
            } else {
              var j = Math.floor(Math.random() * (seen + 1));
              if (j < cap) reservoir[j] = rec;
            }
            seen++;
          }
          c.continue();
        };
        cursorReq.onerror = function () { reject(cursorReq.error); };
      });
    });
  }

  /* Newest arrivals, for the diagnostics panel. */
  function recent(n) {
    return open().then(function (db) {
      return new Promise(function (resolve) {
        var t = db.transaction('videos', 'readonly');
        var idx = t.objectStore('videos').index('addedAt');
        var out = [];
        var c = idx.openCursor(null, 'prev');
        c.onsuccess = function () {
          var cur = c.result;
          if (!cur || out.length >= (n || 20)) return resolve(out);
          out.push(cur.value);
          cur.continue();
        };
        c.onerror = function () { resolve(out); };
      });
    });
  }

  /* Remove entries that should never have been stored: bad ids, no title,
   * or a year past the wall. Returns what it cleaned up, by reason. */
  function scrub(cutoffYear) {
    return open().then(function (db) {
      var t = db.transaction('videos', 'readwrite');
      var s = t.objectStore('videos');
      var report = { badId: 0, noTitle: 0, tooNew: 0 };
      var c = s.openCursor();
      c.onsuccess = function () {
        var cur = c.result;
        if (!cur) return;
        var v = cur.value;
        if (!VIDEO_ID_RE.test(v.id || '')) { report.badId++; cur.delete(); }
        else if (!v.title || !String(v.title).trim()) { report.noTitle++; cur.delete(); }
        else if (v.year && cutoffYear && v.year > cutoffYear) { report.tooNew++; cur.delete(); }
        cur.continue();
      };
      return done(t).then(function () { return report; });
    });
  }

  function purgeAfter(cutoffYear) {
    return open().then(function (db) {
      var t = db.transaction('videos', 'readwrite');
      var s = t.objectStore('videos');
      var removed = 0;
      var c = s.openCursor();
      c.onsuccess = function () {
        var cur = c.result;
        if (!cur) return;
        if (cur.value.year && cur.value.year > cutoffYear) {
          cur.delete();
          removed++;
        }
        cur.continue();
      };
      return done(t).then(function () { return removed; });
    });
  }

  function clearAll() {
    return open().then(function (db) {
      var t = db.transaction(['videos', 'frontier', 'edges', 'related'], 'readwrite');
      t.objectStore('videos').clear();
      t.objectStore('frontier').clear();
      t.objectStore('edges').clear();
      t.objectStore('related').clear();
      return done(t);
    });
  }

  /* ------------------------------------------------------ edges & related */

  var EDGE_CAP = 80;

  /* Remember that YouTube listed these old videos beside `from`. */
  function addEdges(from, ids) {
    if (!from || !ids || !ids.length) return Promise.resolve();
    return open().then(function (db) {
      var t = db.transaction('edges', 'readwrite');
      var s = t.objectStore('edges');
      var g = s.get(from);
      g.onsuccess = function () {
        var rec = g.result || { key: from, ids: [] };
        ids.forEach(function (id) {
          if (id !== from && rec.ids.indexOf(id) === -1) rec.ids.push(id);
        });
        if (rec.ids.length > EDGE_CAP) rec.ids = rec.ids.slice(-EDGE_CAP);
        rec.at = Date.now();
        s.put(rec);
      };
      return done(t);
    });
  }

  function getEdges(id) {
    return tx('edges', 'readonly').then(function (s) { return wrap(s.get(id)); })
      .then(function (rec) { return (rec && rec.ids) || []; })
      .catch(function () { return []; });
  }

  function getRelated(key) {
    return tx('related', 'readonly').then(function (s) { return wrap(s.get(key)); })
      .catch(function () { return null; });
  }

  function putRelated(rec) {
    return open().then(function (db) {
      var t = db.transaction('related', 'readwrite');
      t.objectStore('related').put(rec);
      return done(t);
    });
  }

  /* -------------------------------------------------------------- frontier */

  function nextFrontier(n) {
    return open().then(function (db) {
      return new Promise(function (resolve) {
        var t = db.transaction('frontier', 'readonly');
        var idx = t.objectStore('frontier').index('done');
        var out = [];
        var c = idx.openCursor(IDBKeyRange.only(0));
        c.onsuccess = function () {
          var cur = c.result;
          if (!cur || out.length >= (n || 1)) return resolve(out);
          out.push(cur.value);
          cur.continue();
        };
        c.onerror = function () { resolve(out); };
      });
    });
  }

  function markFrontierDone(id) {
    return open().then(function (db) {
      var t = db.transaction('frontier', 'readwrite');
      var s = t.objectStore('frontier');
      var g = s.get(id);
      g.onsuccess = function () {
        var rec = g.result || { id: id, priority: 1, addedAt: Date.now() };
        rec.done = 1;
        rec.doneAt = Date.now();
        s.put(rec);
      };
      return done(t);
    });
  }

  function frontierSize() {
    return open().then(function (db) {
      return new Promise(function (resolve) {
        var t = db.transaction('frontier', 'readonly');
        var idx = t.objectStore('frontier').index('done');
        var r = idx.count(IDBKeyRange.only(0));
        r.onsuccess = function () { resolve(r.result); };
        r.onerror = function () { resolve(0); };
      });
    });
  }

  var api = {
    putVideos: putVideos,
    getVideo: getVideo,
    getVideos: getVideos,
    addEdges: addEdges,
    getEdges: getEdges,
    getRelated: getRelated,
    putRelated: putRelated,
    updateVideo: updateVideo,
    markShown: markShown,
    deleteVideo: deleteVideo,
    countVideos: countVideos,
    countChannel: countChannel,
    sample: sample,
    purgeAfter: purgeAfter,
    recent: recent,
    scrub: scrub,
    isStorable: isStorable,
    clearAll: clearAll,
    nextFrontier: nextFrontier,
    markFrontierDone: markFrontierDone,
    frontierSize: frontierSize
  };

  root.RTDb = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
