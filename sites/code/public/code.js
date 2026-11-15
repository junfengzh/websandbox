// websandbox code hosting: small client helpers (dropdowns, copy buttons, dialogs, line links).
(function () {
  // close other <details class="dropdown"> when one opens / on outside click / Escape
  document.addEventListener('click', function (e) {
    document.querySelectorAll('details.dropdown[open]').forEach(function (d) { if (!d.contains(e.target)) d.removeAttribute('open'); });
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') document.querySelectorAll('details.dropdown[open]').forEach(function (d) { d.removeAttribute('open'); var s = d.querySelector('summary'); s && s.focus(); });
  });
  // copy to clipboard: <button data-clipboard-text="..."> or data-clipboard-target="#id"
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-clipboard-text],[data-clipboard-target]');
    if (!b) return;
    e.preventDefault();
    var t = b.getAttribute('data-clipboard-text');
    if (t == null) { var el = document.querySelector(b.getAttribute('data-clipboard-target')); t = el ? (el.value || el.textContent) : ''; }
    var done = function () { var o = b.getAttribute('title'); b.setAttribute('title', 'Copied'); b.classList.add('copied'); setTimeout(function () { b.setAttribute('title', o || 'Copy'); b.classList.remove('copied'); }, 1200); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(done, done); else done();
  });
  // <button data-open-dialog="#id"> opens a <dialog>; [data-close-dialog] closes it
  document.addEventListener('click', function (e) {
    var o = e.target.closest && e.target.closest('[data-open-dialog]');
    if (o) { var d = document.querySelector(o.getAttribute('data-open-dialog')); if (d && d.showModal) { e.preventDefault(); d.showModal(); var f = d.querySelector('input,textarea,select,button'); f && f.focus(); } return; }
    var c = e.target.closest && e.target.closest('[data-close-dialog]');
    if (c) { var dd = c.closest('dialog'); if (dd) { e.preventDefault(); dd.close(); } }
  });
  // highlight a line range from the hash (#L10 or #L10-20)
  function hl() {
    var m = /^#L(\d+)(?:-(\d+))?$/.exec(location.hash);
    document.querySelectorAll('tr.hll').forEach(function (r) { r.classList.remove('hll'); });
    if (!m) return;
    var a = +m[1], b = +(m[2] || m[1]);
    for (var i = a; i <= b; i++) { var r = document.getElementById('LC' + i); if (r) r.classList.add('hll'); }
  }
  window.addEventListener('hashchange', hl); document.addEventListener('DOMContentLoaded', hl);
  // ref switcher <select data-ref-switch="/ns/proj/-/tree/{ref}/path">
  document.addEventListener('change', function (e) {
    var s = e.target;
    if (s.matches && s.matches('[data-ref-switch]')) location.href = s.getAttribute('data-ref-switch').replace('{ref}', s.value.split('/').map(encodeURIComponent).join('/'));
  });
  // web editor: keep Tab in the textarea
  document.addEventListener('keydown', function (e) {
    var t = e.target;
    if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && t.matches && t.matches('textarea.editor-textarea[data-tabs]')) {
      e.preventDefault(); var s = t.selectionStart, en = t.selectionEnd; t.value = t.value.slice(0, s) + '\t' + t.value.slice(en); t.selectionStart = t.selectionEnd = s + 1;
    }
  });
})();
