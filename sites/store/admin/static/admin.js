// websandbox store back office: menu flyouts, grid selection + mass actions, small helpers.
(function () {
  'use strict';
  // ---- sidebar flyout menus
  function closeMenus(except) {
    document.querySelectorAll('.admin__menu .submenu').forEach(function (s) {
      if (s === except) return;
      s.hidden = true;
      var li = s.closest('li'); if (li) li.classList.remove('_show');
      var a = li && li.querySelector('.menu-toggle'); if (a) a.setAttribute('aria-expanded', 'false');
    });
  }
  document.addEventListener('click', function (e) {
    var t = e.target.closest && e.target.closest('.menu-toggle');
    if (t) {
      e.preventDefault();
      var sub = document.getElementById('submenu-' + t.getAttribute('data-menu'));
      var open = sub.hidden;
      closeMenus(sub);
      sub.hidden = !open;
      t.setAttribute('aria-expanded', open ? 'true' : 'false');
      t.closest('li').classList.toggle('_show', open);
      if (open) { var first = sub.querySelector('a'); if (first) first.focus(); }
      return;
    }
    if (e.target.closest && e.target.closest('[data-close-menu]')) { closeMenus(); return; }
    if (!(e.target.closest && e.target.closest('.admin__menu'))) closeMenus();
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeMenus(); });

  // ---- grids
  document.querySelectorAll('[data-grid]').forEach(function (g) {
    var form = g.querySelector('form.grid-mass-form');
    if (!form) return;
    var boxes = function () { return Array.prototype.slice.call(g.querySelectorAll('input[name="selected"]')); };
    var all = g.querySelector('input[data-select-page]');
    var allMatching = form.querySelector('input[name="select_all"]');
    var count = g.querySelector('[data-selected-count]');
    var total = +(g.getAttribute('data-total') || 0);
    function update() {
      var n = allMatching && allMatching.value === '1' ? total - boxes().filter(function (b) { return !b.checked; }).length : boxes().filter(function (b) { return b.checked; }).length;
      if (count) count.textContent = String(n);
    }
    if (all) all.addEventListener('change', function () { boxes().forEach(function (b) { b.checked = all.checked; }); if (!all.checked && allMatching) allMatching.value = '0'; update(); });
    g.addEventListener('change', function (e) { if (e.target.name === 'selected') update(); });
    var selSel = g.querySelector('select[data-select-mode]');
    if (selSel) selSel.addEventListener('change', function () {
      var v = selSel.value;
      if (v === 'all') { allMatching.value = '1'; boxes().forEach(function (b) { b.checked = true; }); }
      if (v === 'none') { allMatching.value = '0'; boxes().forEach(function (b) { b.checked = false; }); }
      if (v === 'page') { boxes().forEach(function (b) { b.checked = true; }); }
      if (v === 'unpage') { boxes().forEach(function (b) { b.checked = false; }); }
      selSel.value = '';
      update();
    });
    var actSel = form.querySelector('select[name="mass_action"]');
    var val = form.querySelector('[data-mass-value]');
    function syncVal() {
      if (!actSel || !val) return;
      var o = actSel.options[actSel.selectedIndex];
      var need = o && o.getAttribute('data-needs-value');
      val.hidden = !need;
      if (need) val.querySelector('input').placeholder = need;
    }
    if (actSel) { actSel.addEventListener('change', syncVal); syncVal(); }
    form.addEventListener('submit', function (e) {
      // excluded ids when "select all" is on
      form.querySelectorAll('input[name="excluded"]').forEach(function (x) { x.remove(); });
      if (allMatching && allMatching.value === '1') boxes().forEach(function (b) {
        if (!b.checked) { var h = document.createElement('input'); h.type = 'hidden'; h.name = 'excluded'; h.value = b.value; form.appendChild(h); }
      });
      var n = count ? +count.textContent : 1;
      if (!n) { e.preventDefault(); window.alert('Please select item(s).'); return; }
      var o = actSel && actSel.options[actSel.selectedIndex];
      if (actSel && !actSel.value) { e.preventDefault(); window.alert('Please select an action.'); return; }
      var c = o && o.getAttribute('data-confirm');
      if (c && !window.confirm(c.replace('%n', n))) e.preventDefault();
    });
    update();
  });

  // ---- reports being generated: poll until the job finished
  var wait = document.querySelector('[data-report-wait]');
  if (wait) setTimeout(function () { location.reload(); }, +wait.getAttribute('data-report-wait') || 800);

  // ---- url key suggestion from the product name on new products
  var nameIn = document.querySelector('input[data-urlkey-source]');
  var keyIn = document.querySelector('input[data-urlkey-target]');
  if (nameIn && keyIn && !keyIn.value) nameIn.addEventListener('input', function () {
    if (keyIn.getAttribute('data-touched')) return;
    keyIn.value = nameIn.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  });
  if (keyIn) keyIn.addEventListener('input', function () { keyIn.setAttribute('data-touched', '1'); });

  // ---- dependent fields: data-show-when="field=value1,value2"
  function syncDeps() {
    document.querySelectorAll('[data-show-when]').forEach(function (el) {
      var p = el.getAttribute('data-show-when').split('='); var f = document.querySelector('[name="' + p[0] + '"]');
      if (!f) return;
      var v = f.type === 'checkbox' ? (f.checked ? '1' : '0') : f.value;
      el.hidden = p[1].split(',').indexOf(v) < 0;
    });
  }
  document.addEventListener('change', syncDeps); syncDeps();
})();
