// websandbox code hosting -- collaboration pages: user pickers (live search), label filter,
// label colour swatches, confirm dialogs, auto-submit selects. Everything works without JS too.
(function () {
  function debounce(fn, ms) { var t; return function () { var a = arguments, s = this; clearTimeout(t); t = setTimeout(function () { fn.apply(s, a); }, ms); }; }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  // <div data-user-picker data-field="assignee_ids[]" data-project-id="N"> with an <input type=search class="picker-search"> and <ul class="pick-list">
  document.addEventListener('input', debounce(function (e) {
    var inp = e.target;
    if (!inp.matches || !inp.matches('[data-user-picker] .picker-search')) return;
    var box = inp.closest('[data-user-picker]'); var list = box.querySelector('.pick-list'); var field = box.getAttribute('data-field');
    var q = inp.value.trim();
    list.querySelectorAll('li[data-remote]').forEach(function (li) { if (!li.querySelector('input:checked')) li.remove(); });
    list.querySelectorAll('li').forEach(function (li) { var t = li.textContent.toLowerCase(); li.hidden = q && t.indexOf(q.toLowerCase()) < 0 && !li.querySelector('input:checked'); });
    if (q.length < 1) return;
    fetch('/-/autocomplete/users.json?search=' + encodeURIComponent(q) + '&project_id=' + (box.getAttribute('data-project-id') || ''), { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.json(); }).then(function (users) {
        users.forEach(function (u) {
          if (list.querySelector('input[value="' + u.id + '"]')) { var ex = list.querySelector('input[value="' + u.id + '"]').closest('li'); ex.hidden = false; return; }
          var li = document.createElement('li'); li.setAttribute('data-remote', '1');
          li.innerHTML = '<label><input type="' + (box.getAttribute('data-single') ? 'radio' : 'checkbox') + '" name="' + esc(field) + '" value="' + u.id + '"> ' + esc(u.name) + ' <span class="muted">@' + esc(u.username) + '</span></label>';
          list.appendChild(li);
        });
      }).catch(function () {});
  }, 200));

  // filter a long checkbox list: <input class="list-filter" data-target="#id">
  document.addEventListener('input', function (e) {
    var inp = e.target;
    if (!inp.matches || !inp.matches('input.list-filter')) return;
    var q = inp.value.trim().toLowerCase();
    document.querySelectorAll(inp.getAttribute('data-target') + ' li').forEach(function (li) { li.hidden = q && li.textContent.toLowerCase().indexOf(q) < 0; });
  });

  // colour swatches -> input
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-set-color]');
    if (!b) return;
    e.preventDefault();
    var inp = document.querySelector(b.getAttribute('data-target'));
    if (inp) { inp.value = b.getAttribute('data-set-color'); inp.dispatchEvent(new Event('input', { bubbles: true })); }
  });
  document.addEventListener('input', function (e) {
    var t = e.target;
    if (t.matches && t.matches('[data-color-preview]')) { var p = document.querySelector(t.getAttribute('data-color-preview')); if (p) p.style.background = t.value; }
  });

  // <form data-confirm="Are you sure?">
  document.addEventListener('submit', function (e) {
    var f = e.target; var m = f.getAttribute && f.getAttribute('data-confirm');
    if (m && !window.confirm(m)) e.preventDefault();
  }, true);
  // <select data-autosubmit>
  document.addEventListener('change', function (e) {
    var s = e.target;
    if (s.matches && s.matches('select[data-autosubmit]') && s.form) s.form.submit();
  });
  // delete confirmation: enable the button when the typed text matches data-expect
  document.addEventListener('input', function (e) {
    var t = e.target;
    if (!t.matches || !t.matches('[data-confirm-input]')) return;
    var btn = document.querySelector(t.getAttribute('data-confirm-input'));
    if (btn) btn.disabled = t.value !== t.getAttribute('data-expect');
  });
  // reply toggles: <button data-toggle="#id">
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-toggle]');
    if (!b) return;
    e.preventDefault();
    var el = document.querySelector(b.getAttribute('data-toggle'));
    if (el) { el.hidden = !el.hidden; var f = el.querySelector('textarea,input'); if (!el.hidden && f) f.focus(); }
  });
})();
