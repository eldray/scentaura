/* Small, dependency-free helpers. The site still works if this file fails to load. */
(function () {
  'use strict';
  var d = document;

  // Mobile menu
  var tg = d.querySelector('[data-nav-toggle]');
  var nav = d.getElementById('main-nav');
  if (tg && nav) tg.addEventListener('click', function () {
    var open = nav.classList.toggle('open');
    tg.setAttribute('aria-expanded', open ? 'true' : 'false');
  });

  // Product gallery
  var main = d.getElementById('main-img');
  d.querySelectorAll('.thumb').forEach(function (b) {
    b.addEventListener('click', function () {
      if (main) { main.src = b.getAttribute('data-full'); main.alt = b.getAttribute('data-alt') || ''; }
    });
  });

  // Header search: the icon opens the box, a second press searches
  var sb = d.querySelector('[data-search]');
  if (sb) {
    var inp = sb.querySelector('input'), btn = sb.querySelector('[data-search-btn]');
    var close = function () { sb.classList.remove('open'); };
    btn.addEventListener('click', function (e) {
      if (!sb.classList.contains('open')) { e.preventDefault(); sb.classList.add('open'); inp.focus(); inp.select(); }
      else if (!inp.value.trim()) { e.preventDefault(); close(); }
    });
    d.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
    d.addEventListener('click', function (e) { if (!sb.contains(e.target) && !inp.value) close(); });
    if (inp.value) sb.classList.add('open');
  }

  // Copy buttons (referral link)
  d.querySelectorAll('[data-copy]').forEach(function (b) {
    b.addEventListener('click', function () {
      var el = d.querySelector(b.getAttribute('data-copy'));
      if (!el) return;
      el.select();
      var done = function () { var t = b.textContent; b.textContent = 'Copied!'; setTimeout(function () { b.textContent = t; }, 1500); };
      if (navigator.clipboard) navigator.clipboard.writeText(el.value).then(done, function () { d.execCommand('copy'); done(); });
      else { d.execCommand('copy'); done(); }
    });
  });

  // Filters start folded on phones
  var fd = d.querySelector('.filters details');
  if (fd && window.matchMedia && window.matchMedia('(max-width: 860px)').matches) fd.removeAttribute('open');

  // Tables without form controls become stacked cards on phones (labels come from the column headings)
  d.querySelectorAll('table.table').forEach(function (t) {
    var heads = Array.prototype.map.call(t.querySelectorAll('thead th'), function (h) { return h.textContent.trim(); });
    if (!heads.length) return;
    t.classList.add('stack');
    if (t.querySelector('tbody input:not([type=hidden]):not([type=checkbox]), tbody select, tbody textarea')) t.classList.add('stack-form');
    t.querySelectorAll('tbody tr').forEach(function (tr) {
      Array.prototype.forEach.call(tr.children, function (td, i) { if (heads[i]) td.setAttribute('data-label', heads[i]); });
    });
  });

  // Give every form control an accessible name (placeholder, column heading, or field name)
  d.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]), select, textarea').forEach(function (el) {
    if ((el.labels && el.labels.length) || el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.title) return;
    var name = el.getAttribute('placeholder');
    var td = el.closest('td');
    if (!name && td) {
      var tr = td.parentElement, idx = Array.prototype.indexOf.call(tr.children, td);
      var table = el.closest('table'), th = table && table.querySelectorAll('thead th')[idx];
      if (th) name = th.textContent.trim();
    }
    if (!name && el.name) name = el.name.replace(/[_-]/g, ' ');
    if (name) el.setAttribute('aria-label', name);
  });

  // Sort box submits on change
  d.querySelectorAll('[data-autosubmit]').forEach(function (s) {
    s.addEventListener('change', function () { s.form.submit(); });
  });

  // Checkout: hide the address when the customer will collect the order
  var rate = d.querySelector('[data-rate-select]');
  var addr = d.querySelector('[data-address-fields]');
  function syncAddress() {
    if (!rate || !addr) return;
    var opt = rate.options[rate.selectedIndex];
    addr.hidden = !!(opt && opt.getAttribute('data-method') === 'pickup');
  }
  if (rate) { rate.addEventListener('change', syncAddress); syncAddress(); }

  // Admin: mobile menu
  var ab = d.querySelector('[data-admin-menu]');
  var side = d.querySelector('.admin-side');
  if (ab && side) {
    ab.addEventListener('click', function (e) { e.stopPropagation(); side.classList.toggle('open'); });
    d.addEventListener('click', function (e) { if (side.classList.contains('open') && !side.contains(e.target)) side.classList.remove('open'); });
    d.addEventListener('keydown', function (e) { if (e.key === 'Escape') side.classList.remove('open'); });
  }

  // Admin: confirm dangerous buttons
  d.querySelectorAll('form[data-confirm]').forEach(function (f) {
    f.addEventListener('submit', function (e) {
      if (!window.confirm(f.getAttribute('data-confirm'))) e.preventDefault();
    });
  });

  // Admin: add another line on the purchase form
  var addLine = d.querySelector('[data-add-line]');
  if (addLine) addLine.addEventListener('click', function () {
    var tpl = d.querySelector('[data-line-template]');
    var body = d.querySelector('[data-lines]');
    if (tpl && body) body.appendChild(tpl.content.cloneNode(true));
  });
  d.addEventListener('change', function (e) {
    var t = e.target;
    if (t && t.matches && t.matches('[data-variant-pick]')) {
      var cost = t.options[t.selectedIndex].getAttribute('data-cost');
      var row = t.closest('tr');
      var input = row && row.querySelector('[data-cost-input]');
      if (input && !input.value && cost) input.value = cost;
    }
  });

  // Checkout: show the MoMo number box only when Mobile Money is the chosen way to pay
  var momoField = d.querySelector('[data-momo-field]');
  if (momoField) {
    var syncMomo = function () {
      var sel = d.querySelector('input[name="paymentMethod"]:checked');
      momoField.hidden = !(sel && sel.value === 'momo');
    };
    d.addEventListener('change', function (e) { if (e.target && e.target.name === 'paymentMethod') syncMomo(); });
    syncMomo();
  }

  // Order page: while a MoMo approval is pending, ask the server every few seconds
  var wait = d.querySelector('[data-momo-poll]');
  if (wait && window.fetch) {
    var tries = 0, msg = wait.querySelector('[data-momo-msg]');
    var tick = function () {
      tries++;
      fetch(wait.getAttribute('data-momo-poll'), { headers: { Accept: 'application/json' } })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (j.status === 'success' || j.status === 'failed') { location.reload(); return; }
          if (tries >= 60) { if (msg) msg.textContent = 'Still waiting. If you approved the payment, refresh this page in a minute.'; return; }
          setTimeout(tick, 4000);
        })
        .catch(function () { if (tries < 60) setTimeout(tick, 6000); });
    };
    setTimeout(tick, 3000);
  }

  // Shop page: keep the sticky bar and filters just below the sticky site header
  var bar = d.querySelector('[data-shop-bar]');
  var hdr = d.querySelector('.site-header');
  if (bar && hdr) {
    var setVars = function () {
      d.documentElement.style.setProperty('--hdr', hdr.offsetHeight + 'px');
      d.documentElement.style.setProperty('--bar', bar.offsetHeight + 'px');
    };
    setVars(); window.addEventListener('resize', setVars); window.addEventListener('load', setVars);
  }

  // Heart button: save to wishlist without leaving the page (signed-in customers)
  d.addEventListener('submit', function (e) {
    var form = e.target;
    if (!form || !form.matches || !form.matches('[data-wish]') || form.hasAttribute('data-guest') || !window.fetch) return;
    e.preventDefault();
    var btn = form.querySelector('.wish-btn');
    fetch(form.action, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(new FormData(form)).toString(),
      credentials: 'same-origin'
    }).then(function (r) { if (!r.ok) throw new Error(); return r.json(); }).then(function (j) {
      btn.classList.toggle('is-saved', !!j.saved);
      btn.setAttribute('aria-pressed', j.saved ? 'true' : 'false');
      btn.title = j.saved ? 'Saved to wishlist' : 'Save to wishlist';
      btn.classList.remove('pop'); void btn.offsetWidth; btn.classList.add('pop');
    }).catch(function () { form.submit(); });
  });
})();
