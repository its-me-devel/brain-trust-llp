// Shared site behaviour: mobile nav toggle, contact form submit, scroll reveal.

// PLACEHOLDER: paste the deployed Google Apps Script /exec URL here once available.
const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbycJF-BaIU9KUTJywpkFx9D4XyiwAlpkuvAxecG3ClwzkHz6IxgzUOjwyNqxJFJv8IJ/exec';

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
  var nameInput = document.getElementById('name');
  var nameError = document.getElementById('nameError');
  var emailInput = document.getElementById('email');
  var emailError = document.getElementById('emailError');
  var messageInput = document.getElementById('message');
  var messageError = document.getElementById('messageError');

  // Only letters, numbers, spaces and - . [ ] ( ) - kept in sync with
  // MESSAGE_ALLOWED_RE in apps-script/Code.gs.
  var MESSAGE_ALLOWED_RE = /^[A-Za-z0-9\s\-.[\]()]*$/;

  function generateSubmissionId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  }

  // Wires inline feedback (shown on blur, live once an error is already
  // showing) for a field, instead of relying solely on the browser's native
  // tooltip, which mobile browsers render inconsistently. By default
  // validity comes from the input's own `pattern`/`required` attributes;
  // pass `customValidator` for a field type=text validation can't express -
  // <textarea> doesn't support the `pattern` attribute at all, so message's
  // character-set check runs here and reports through setCustomValidity so
  // it still participates in form.checkValidity(). Returns a check()
  // function the submit handler can call to force the error into view.
  function wireInlineValidation(input, errorEl, customValidator) {
    if (!input || !errorEl) return null;

    function check() {
      var valid;
      if (customValidator) {
        valid = customValidator(input.value);
        input.setCustomValidity(valid ? '' : errorEl.textContent);
      } else {
        valid = input.checkValidity();
      }
      var show = !valid && input.value !== '';
      input.closest('.form-field').classList.toggle('has-error', show);
      errorEl.hidden = !show;
      return valid;
    }

    input.addEventListener('blur', check);
    input.addEventListener('input', function () {
      if (!errorEl.hidden) check();
    });
    return check;
  }

  var checkName = wireInlineValidation(nameInput, nameError);
  var checkEmail = wireInlineValidation(emailInput, emailError);
  var checkMessage = wireInlineValidation(messageInput, messageError, function (v) {
    return MESSAGE_ALLOWED_RE.test(v);
  });

  function submitOnce(formData) {
    return fetch(APPS_SCRIPT_URL, { method: 'POST', body: formData })
      .then(function (res) {
        if (!res.ok) throw new Error('Request failed: ' + res.status);
        return res.json();
      })
      .then(function (data) {
        // Apps Script Web Apps always respond 200, even on a logical
        // failure - the real outcome is in the JSON body, not the status.
        if (!data || data.result !== 'ok') throw new Error((data && data.message) || 'Request failed');
        return data;
      });
  }

  // Apps Script Web Apps are intermittently unreliable on their own - the
  // same request can succeed quickly one moment and hang for 20-30s before
  // failing the next, with no fault in this site's code. A couple of
  // retries absorbs a transient failure before a real visitor ever sees an
  // error. No client-side timeout/abort is used here deliberately: cutting
  // a slow-but-eventually-successful request short and retrying could
  // write the same submission to the Sheet twice.
  function submitWithRetry(formData, attemptsLeft) {
    return submitOnce(formData).catch(function (err) {
      if (attemptsLeft <= 0) throw err;
      status.textContent = 'Still trying - the connection can be slow sometimes…';
      return new Promise(function (resolve) { setTimeout(resolve, 1000); })
        .then(function () { return submitWithRetry(formData, attemptsLeft - 1); });
    });
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();

    // Honeypot: bots fill every field, humans never see this one.
    var honeypot = form.querySelector('#website');
    if (honeypot && honeypot.value) {
      return;
    }

    if (nameInput) nameInput.value = nameInput.value.trim();
    if (emailInput) emailInput.value = emailInput.value.trim();

    // Refresh custom-validity state (message) before asking the form
    // whether it's valid overall - setCustomValidity only reflects the
    // last time check() ran, which may predate this submit attempt if the
    // field was never blurred.
    if (checkName) checkName();
    if (checkEmail) checkEmail();
    if (checkMessage) checkMessage();

    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Sending…';
    status.textContent = '';
    status.removeAttribute('data-state');

    var formData = new FormData(form);
    // One id per submit action, reused across every retry of it - lets
    // Code.gs recognize a retry as the same submission (see submission_id
    // handling there) instead of writing a duplicate row when a request
    // actually succeeded server-side but its response never made it back.
    formData.append('submission_id', generateSubmissionId());

    submitWithRetry(formData, 2)
      .then(function (data) {
        status.textContent = 'Thanks, a partner will be in touch.';
        status.setAttribute('data-state', 'success');
        form.reset();
      })
      .catch(function () {
        status.textContent = 'Something went wrong - email us at hello@braintrustllp.com';
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
