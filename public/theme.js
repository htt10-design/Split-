// Design (Racing Green / Schwarz-Weiß) und Hell/Dunkel.
// Wird im <head> geladen, damit beim Start nichts aufflackert.
// Die Wahl wird pro Gerät gespeichert.
(function () {
  var KEY = 'split_theme';
  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function get() {
    var s = {};
    try { s = JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) {}
    return { theme: s.theme === 'mono' ? 'mono' : 'green', mode: ['light', 'dark'].indexOf(s.mode) >= 0 ? s.mode : 'auto' };
  }

  function apply() {
    var s = get();
    var mode = s.mode === 'auto' ? (mq && mq.matches ? 'dark' : 'light') : s.mode;
    var root = document.documentElement;
    root.setAttribute('data-theme', s.theme);
    root.setAttribute('data-mode', mode);
    var meta = document.querySelector('meta[name="theme-color"]');
    var bg = getComputedStyle(root).getPropertyValue('--bg').trim();
    if (meta && bg) meta.setAttribute('content', bg);
    document.dispatchEvent(new CustomEvent('split-theme', { detail: s }));
  }

  function set(partial) {
    var s = get();
    for (var k in partial) s[k] = partial[k];
    try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) {}
    apply();
  }

  if (mq) {
    if (mq.addEventListener) mq.addEventListener('change', apply);
    else if (mq.addListener) mq.addListener(apply);
  }
  window.SplitTheme = { get: get, set: set, apply: apply };
  apply();
})();
