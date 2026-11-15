// websandbox kit client helpers: CSRF header on same-origin fetch, confirm dialogs, auto-submit selects.
(function () {
  var meta = document.querySelector('meta[name="csrf-token"]');
  var token = meta && meta.content;
  var orig = window.fetch;
  if (orig && token) window.fetch = function (input, init) {
    init = init || {};
    var method = (init.method || (input && input.method) || 'GET').toUpperCase();
    var url = typeof input === 'string' ? input : input && input.url;
    if (method !== 'GET' && method !== 'HEAD' && (!url || new URL(url, location.href).origin === location.origin)) {
      var h = new Headers(init.headers || {}); if (!h.has('X-CSRF-Token')) h.set('X-CSRF-Token', token); init.headers = h;
    }
    return orig.call(this, input, init);
  };
  document.addEventListener('submit', function (e) {
    var m = e.target.getAttribute && e.target.getAttribute('data-confirm');
    if (m && !window.confirm(m)) e.preventDefault();
  }, true);
  document.addEventListener('change', function (e) {
    if (e.target.matches && e.target.matches('[data-autosubmit]')) e.target.form && e.target.form.submit();
  });
})();
