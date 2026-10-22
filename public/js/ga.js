// Loads Google Analytics only when a Measurement ID is set in Admin > Settings.
(function () {
  var s = document.currentScript, id = s && new URL(s.src).searchParams.get('id');
  if (!id || !/^G-[A-Z0-9]+$/.test(id)) return;
  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }
  gtag('js', new Date());
  gtag('config', id, { anonymize_ip: true });
})();
