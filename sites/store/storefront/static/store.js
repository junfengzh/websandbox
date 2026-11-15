// One Stop Market storefront: search autocomplete, product gallery, configurable swatches,
// region list by country. Plain JS, no dependencies.
(function () {
  'use strict';
  // ---- search autocomplete (GET /search/ajax/suggest/?q=)
  var input = document.getElementById('search');
  var box = document.getElementById('search_autocomplete');
  if (input && box) {
    var timer = null, seq = 0, active = -1;
    var opts = function () { return Array.prototype.slice.call(box.querySelectorAll('[role=option]')); };
    var close = function () { box.hidden = true; box.innerHTML = ''; input.setAttribute('aria-expanded', 'false'); active = -1; };
    var esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
    input.addEventListener('input', function () {
      clearTimeout(timer);
      var q = input.value.trim();
      if (q.length < 2) return close();
      timer = setTimeout(function () {
        var my = ++seq;
        fetch('/search/ajax/suggest/?q=' + encodeURIComponent(q), { headers: { Accept: 'application/json' } }).then(function (r) { return r.json(); }).then(function (d) {
          if (my !== seq) return;
          var html = '';
          (d.terms || []).forEach(function (t, i) { html += '<a role="option" id="qs-t' + i + '" href="/catalogsearch/result/?q=' + encodeURIComponent(t.title) + '"><span class="qs-option-name">' + esc(t.title) + '</span><span class="amount">' + t.num_results + '</span></a>'; });
          if ((d.products || []).length) { html += '<div class="group">Products</div>'; d.products.forEach(function (p, i) { html += '<a role="option" id="qs-p' + i + '" href="' + esc(p.url) + '">' + esc(p.name) + '</a>'; }); }
          if (!html) return close();
          box.innerHTML = html; box.hidden = false; input.setAttribute('aria-expanded', 'true'); active = -1;
        }).catch(close);
      }, 150);
    });
    input.addEventListener('keydown', function (e) {
      var o = opts(); if (!o.length || box.hidden) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault(); active = (active + (e.key === 'ArrowDown' ? 1 : -1) + o.length) % o.length;
        o.forEach(function (x, i) { x.setAttribute('aria-selected', i === active ? 'true' : 'false'); });
        input.setAttribute('aria-activedescendant', o[active].id);
      } else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); location.href = o[active].href; }
      else if (e.key === 'Escape') close();
    });
    document.addEventListener('click', function (e) { if (!box.contains(e.target) && e.target !== input) close(); });
  }
  // ---- gallery thumbnails
  var main = document.getElementById('gallery-main');
  document.querySelectorAll('.gallery-thumb').forEach(function (b) {
    b.addEventListener('click', function () {
      if (main) main.src = b.getAttribute('data-src');
      document.querySelectorAll('.gallery-thumb').forEach(function (x) { x.classList.toggle('active', x === b); });
    });
  });
  // ---- configurable swatches: show the selected label, update price, disable impossible combinations
  var wrap = document.getElementById('product-options-wrapper');
  if (wrap) {
    var kids = []; try { kids = JSON.parse(wrap.getAttribute('data-config') || '[]'); } catch (e) {}
    var priceEl = document.querySelector('.product-info-price .price-box .price');
    var sel = function () { var s = {}; wrap.querySelectorAll('fieldset[data-attribute-code]').forEach(function (f) { var c = f.querySelector('input:checked'); if (c) s[f.getAttribute('data-attribute-code')] = +c.value; }); return s; };
    var update = function () {
      var s = sel();
      wrap.querySelectorAll('fieldset[data-attribute-code]').forEach(function (f) {
        var code = f.getAttribute('data-attribute-code'); var c = f.querySelector('input:checked');
        f.querySelector('.swatch-attribute-selected-option').textContent = c ? c.parentNode.getAttribute('title') : '';
        f.querySelectorAll('input').forEach(function (inp) {
          var ok = kids.some(function (k) { if (k.attrs[code] !== +inp.value || !k.in_stock) return false; for (var o in s) if (o !== code && k.attrs[o] !== s[o]) return false; return true; });
          inp.parentNode.classList.toggle('disabled', !ok);
        });
      });
      var m = kids.filter(function (k) { for (var o in s) if (k.attrs[o] !== s[o]) return false; return true; });
      if (priceEl && m.length) { var p = Math.min.apply(null, m.map(function (k) { return k.price; })); priceEl.textContent = '$' + p.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
    };
    wrap.addEventListener('change', update); update();
  }
  // ---- region list follows the country select
  var country = document.getElementById('country_id'); var region = document.getElementById('region_id');
  if (country && region) {
    var all = []; try { all = JSON.parse(region.getAttribute('data-regions') || '[]'); } catch (e) {}
    var text = document.getElementById('region');
    var fill = function () {
      var cur = region.value; var list = all.filter(function (r) { return r[1] === country.value; });
      region.innerHTML = '<option value="">Please select a region, state or province.</option>' + list.map(function (r) { return '<option value="' + r[0] + '"' + (String(r[0]) === cur ? ' selected' : '') + '>' + r[2].replace(/</g, '&lt;') + '</option>'; }).join('');
      region.hidden = !list.length; if (text) text.hidden = !!list.length;
    };
    country.addEventListener('change', fill); fill();
  }
})();
