// No page zoom on any Hawkes Gen page (J, 2026-11-02: "make it so users can't zoom"). The viewport tag and
// touch-action: manipulation (no double-tap zoom) are in each page; this adds what they can't stop:
// iOS Safari's pinch (gesture events, it ignores user-scalable=no) and Ctrl+wheel / trackpad pinch on desktop.
// Nothing here stops propagation, so the timeline's own Ctrl+wheel zoom and finger gestures still run.
(function () {
  // Double-tap zoom: touch-action: manipulation on the page. :where() keeps it weaker than gen.css's stricter pan-x pan-y.
  var st = document.createElement('style');
  // App feel (J, 2026-11-02): no pull-to-refresh or rubber-banding on the page (panels that scroll keep their own),
  // no grey tap flash, and buttons and bars aren't text to select. :where() keeps every rule weaker than a page's own CSS,
  // so inputs, editable text and copyable text (messages, legal pages, recipes) stay selectable.
  st.textContent = ':where(html, body) { touch-action: manipulation; overscroll-behavior: none; }' +
    ':where(*) { -webkit-tap-highlight-color: transparent; }' +
    ':where(button, [role=button], [role=tab], [role=menuitem], summary, nav, header, .menu, .toolbar) { -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; }' +
    ':where(input, textarea, select, [contenteditable=""], [contenteditable="true"]) { -webkit-user-select: text; user-select: text; }';
  (document.head || document.documentElement).appendChild(st);
  var opt = { passive: false, capture: true };
  var stop = function (e) { if (e.cancelable) e.preventDefault(); };
  ['gesturestart', 'gesturechange', 'gestureend'].forEach(function (t) { window.addEventListener(t, stop, opt); });
  window.addEventListener('wheel', function (e) { if (e.ctrlKey) stop(e); }, opt);
  window.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && (e.key === '+' || e.key === '=' || e.key === '-' || e.key === '_' || e.key === '0')) stop(e);
  }, opt);
})();
