// Shared site behaviour: mobile nav toggle, contact form submit, scroll reveal.

// PLACEHOLDER: paste the deployed Google Apps Script /exec URL here once available.
const APPS_SCRIPT_URL = 'PLACEHOLDER_APPS_SCRIPT_EXEC_URL';

(function navToggle() {
  var toggle = document.getElementById('navToggle');
  var nav = document.getElementById('mainNav');
  if (!toggle || !nav) return;

  toggle.addEventListener('click', function () {
    var isOpen = nav.classList.toggle('is-open');
    toggle.setAttribute('aria-expanded', String(isOpen));
  });
})();

(function contactForm() {
  var form = document.getElementById('contactForm');
  if (!form) return;

  var submitBtn = document.getElementById('submitBtn');
  var status = document.getElementById('formStatus');

  form.addEventListener('submit', function (e) {
    e.preventDefault();

    // Honeypot: bots fill every field, humans never see this one.
    var honeypot = form.querySelector('#website');
    if (honeypot && honeypot.value) {
      return;
    }

    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Sending…';
    status.textContent = '';
    status.removeAttribute('data-state');

    var formData = new FormData(form);

    fetch(APPS_SCRIPT_URL, { method: 'POST', body: formData })
      .then(function (res) {
        if (!res.ok) throw new Error('Request failed');
        status.textContent = 'Thanks, a partner will be in touch.';
        status.setAttribute('data-state', 'success');
        form.reset();
      })
      .catch(function () {
        status.textContent = 'Something went wrong — email us at hello@braintrustcollectives.example';
        status.setAttribute('data-state', 'error');
      })
      .finally(function () {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Send message';
      });
  });
})();

(function scrollReveal() {
  var items = document.querySelectorAll('.reveal');
  if (!items.length) return;

  if (!('IntersectionObserver' in window) ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    items.forEach(function (el) { el.classList.add('is-visible'); });
    return;
  }

  var observer = new IntersectionObserver(
    function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.15 }
  );

  items.forEach(function (el) { observer.observe(el); });
})();
