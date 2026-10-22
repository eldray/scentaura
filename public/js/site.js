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
  if (ab && side) ab.addEventListener('click', function () { side.classList.toggle('open'); });

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
})();
