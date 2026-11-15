// wiki.wa client script: search-box title suggestions (ARIA combobox over
// /w/api.php?action=opensearch) and the TOC hide/show toggle. Pages work without it.
(function () {
  'use strict';
  var input = document.getElementById('searchInput');
  var list = document.getElementById('searchSuggestions');
  var form = document.getElementById('searchform');
  if (input && list && form) {
    var items = [], active = -1, timer = null, seq = 0;
    var close = function () { list.hidden = true; list.innerHTML = ''; items = []; active = -1; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); };
    var setActive = function (i) {
      if (active >= 0 && items[active]) items[active].setAttribute('aria-selected', 'false');
      active = i;
      if (active >= 0 && items[active]) { items[active].setAttribute('aria-selected', 'true'); input.setAttribute('aria-activedescendant', items[active].id); }
      else input.removeAttribute('aria-activedescendant');
    };
    var render = function (q, titles, urls) {
      list.innerHTML = '';
      items = [];
      titles.forEach(function (t, i) {
        var li = document.createElement('li');
        li.id = 'suggestion-' + i;
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', 'false');
        var a = document.createElement('a');
        a.href = new URL(urls[i], location.href).pathname;
        a.textContent = t;
        a.tabIndex = -1;
        li.appendChild(a);
        list.appendChild(li);
        items.push(li);
      });
      var li = document.createElement('li');
      li.id = 'suggestion-fulltext';
      li.className = 'suggestions-special';
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', 'false');
      var a = document.createElement('a');
      a.href = '/w/index.php?search=' + encodeURIComponent(q) + '&title=Special%3ASearch&fulltext=1';
      a.tabIndex = -1;
      a.appendChild(document.createTextNode('Search for pages containing '));
      var b = document.createElement('strong');
      b.textContent = q;
      a.appendChild(b);
      li.appendChild(a);
      list.appendChild(li);
      items.push(li);
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      active = -1;
    };
    var fetchSuggestions = function () {
      var q = input.value.trim();
      if (!q) { close(); return; }
      var my = ++seq;
      fetch('/w/api.php?action=opensearch&format=json&limit=10&search=' + encodeURIComponent(q))
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) { if (d && my === seq && input.value.trim() === q) render(q, d[1] || [], d[3] || []); })
        .catch(function () {});
    };
    input.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(fetchSuggestions, 80); });
    input.addEventListener('keydown', function (e) {
      if (list.hidden || !items.length) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive((active + 1) % items.length); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(active <= 0 ? items.length - 1 : active - 1); }
      else if (e.key === 'Escape') { close(); }
      else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); location.href = items[active].querySelector('a').href; }
    });
    list.addEventListener('mousedown', function (e) { e.preventDefault(); }); // keep focus; the click follows the link
    input.addEventListener('blur', function () { setTimeout(close, 150); });
    document.addEventListener('click', function (e) { if (!form.contains(e.target)) close(); });
  }
})();
