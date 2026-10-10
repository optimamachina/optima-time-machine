/* Optima Time Machine — popup. */
(function () {
  'use strict';

  var Seeds = window.RTSeeds;
  var settings = Object.assign({}, Seeds.DEFAULT_SETTINGS);

  function $(id) { return document.getElementById(id); }

  chrome.storage.local.get('settings').then(function (res) {
    settings = Object.assign({}, Seeds.DEFAULT_SETTINGS, (res && res.settings) || {});
    $('year').textContent = settings.cutoffYear;
    $('enabled').checked = !!settings.enabled;
  });

  $('enabled').addEventListener('change', function () {
    settings.enabled = this.checked;
    chrome.storage.local.set({ settings: settings });
  });

  $('open').addEventListener('click', function () {
    chrome.runtime.openOptionsPage();
    window.close();
  });

  chrome.runtime.sendMessage({ type: 'status' }).then(function (res) {
    if (!res || !res.ok) return;
    $('pool').textContent = (res.crawler.pool || 0).toLocaleString();
    if (!res.crawler.hasCreds) {
      $('hint').textContent = 'open a youtube tab once to start collecting.';
    } else if (res.crawler.backoffUntil) {
      $('hint').textContent = 'collecting is paused until ' +
        new Date(res.crawler.backoffUntil).toLocaleTimeString() + '.';
    } else if (res.crawler.pool < 50) {
      $('hint').textContent = 'the pool is still small. watch a few old videos to get it going.';
    }
  }).catch(function () {});
})();
