// websandbox forum: progressive enhancement. Every action also works as a plain form post.
(function () {
  // votes: POST /sv/<id>.json | /cv/<id>.json, update the widget in place
  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (!form.matches || !form.matches('form.vote')) return;
    var btn = e.submitter;
    if (!btn || btn.name !== 'choice') return;
    e.preventDefault();
    var body = new URLSearchParams({ choice: btn.value });
    fetch(form.getAttribute('action') + '.json', { method: 'POST', body: body, headers: { Accept: 'application/json' }, credentials: 'same-origin' })
      .then(function (r) {
        if (r.status === 401) { location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search); return null; }
        return r.ok ? r.json() : Promise.reject(r.status);
      })
      .then(function (d) {
        if (!d) return;
        var up = form.querySelector('.vote__up'); var down = form.querySelector('.vote__down');
        form.classList.toggle('vote--user-upvoted', d.choice === 1);
        form.classList.toggle('vote--user-downvoted', d.choice === -1);
        form.querySelector('.vote__net-score').textContent = d.netScore;
        var what = form.dataset.vote === 'comment' ? ' comment' : ' submission';
        up.value = d.choice === 1 ? '0' : '1'; up.setAttribute('aria-pressed', String(d.choice === 1)); up.setAttribute('aria-label', (d.choice === 1 ? 'Remove upvote' : 'Upvote') + what);
        down.value = d.choice === -1 ? '0' : '-1'; down.setAttribute('aria-pressed', String(d.choice === -1)); down.setAttribute('aria-label', (d.choice === -1 ? 'Remove downvote' : 'Downvote') + what);
      })
      .catch(function () { form.submit(); });
  });

  // submit form: show the fields of the chosen post type
  var sf = document.getElementById('submission-form');
  if (sf) {
    var sync = function () {
      var t = sf.querySelector('input[name=type]:checked');
      if (!t) return;
      var link = sf.querySelector('.type-link'); var img = sf.querySelector('.type-image');
      if (link) link.hidden = t.value !== 'link';
      if (img) img.hidden = t.value !== 'image';
    };
    sf.addEventListener('change', function (e) { if (e.target.name === 'type') sync(); });
    sync();
  }

  // close the user menu when clicking elsewhere
  document.addEventListener('click', function (e) {
    document.querySelectorAll('details.user-menu[open]').forEach(function (d) { if (!d.contains(e.target)) d.removeAttribute('open'); });
  });
})();
