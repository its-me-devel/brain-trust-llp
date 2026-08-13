// 2.5D scroll hero - home page only. CSS transforms on a single flat plane.
(function () {
  var hero = document.querySelector('.hero');
  var plane = document.getElementById('heroPlane');
  if (!hero || !plane) return;

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  if (reduceMotion.matches) return; // static logo, no listeners attached

  // PLACEHOLDER: if a layered/transparent logo becomes available, split this
  // single .hero-plane into two stacked planes (brain + hands) with their
  // own translateZ offsets for real parallax depth instead of one flat image.

  var ticking = false;

  function update() {
    ticking = false;
    var rect = hero.getBoundingClientRect();
    var heroHeight = rect.height || 1;
    // progress: 0 when hero top is at viewport top, 1 when hero has scrolled fully out
    var progress = Math.min(Math.max(-rect.top / heroHeight, 0), 1);

    var rotateY = progress * 12; // 0deg to 12deg as hero scrolls out
    var translateY = progress * -30; // drifts up slower than the page
    var scale = 1 - progress * 0.08; // 1.0 -> ~0.92

    plane.style.transform =
      'translateY(' + translateY + 'px) rotateY(' + rotateY + 'deg) scale(' + scale + ')';
  }

  function onScroll() {
    if (!ticking) {
      window.requestAnimationFrame(update);
      ticking = true;
    }
  }

  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);
  update();
})();
