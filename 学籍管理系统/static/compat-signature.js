(function () {
  'use strict';
  var canvas = document.getElementById('signature-pad');
  var input = document.getElementById('signature-input');
  var form = document.getElementById('confirm-form');
  if (!canvas || !input || !form || !canvas.getContext) return;
  try {
    var context = canvas.getContext('2d');
    var ratio = 1;
    var drawing = false;
    var hasInk = false;
    var resizeTimer = null;

    function setup(preserve) {
      var old = null;
      if (preserve && canvas.width && canvas.height) {
        old = document.createElement('canvas');
        old.width = canvas.width;
        old.height = canvas.height;
        old.getContext('2d').drawImage(canvas, 0, 0);
      }
      var rect = canvas.getBoundingClientRect();
      ratio = Math.max(window.devicePixelRatio || 1, 1);
      canvas.width = Math.max(1, Math.round(rect.width * ratio));
      canvas.height = Math.max(1, Math.round(rect.height * ratio));
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      if (old) context.drawImage(old, 0, 0, old.width, old.height, 0, 0, canvas.width, canvas.height);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.strokeStyle = '#142f47';
      context.lineWidth = 2.4;
      context.lineCap = 'round';
      context.lineJoin = 'round';
    }

    function point(source) {
      var rect = canvas.getBoundingClientRect();
      return { x: source.clientX - rect.left, y: source.clientY - rect.top };
    }

    function begin(source) {
      var p = point(source);
      drawing = true;
      hasInk = true;
      context.beginPath();
      context.moveTo(p.x, p.y);
      context.lineTo(p.x + 0.2, p.y + 0.2);
      context.stroke();
    }

    function move(source) {
      if (!drawing) return;
      var p = point(source);
      context.lineTo(p.x, p.y);
      context.stroke();
    }

    function stop() { drawing = false; }

    setup(false);
    canvas.setAttribute('data-ready', '1');
    var unavailable = document.querySelector('[data-signature-unavailable]');
    if (unavailable) unavailable.hidden = true;

    if (window.PointerEvent && canvas.setPointerCapture) {
      canvas.addEventListener('pointerdown', function (event) {
        event.preventDefault();
        try { canvas.setPointerCapture(event.pointerId); } catch (ignore) { /* Capture is optional. */ }
        begin(event);
      });
      canvas.addEventListener('pointermove', function (event) { if (drawing) { event.preventDefault(); move(event); } });
      canvas.addEventListener('pointerup', stop);
      canvas.addEventListener('pointercancel', stop);
      canvas.addEventListener('lostpointercapture', stop);
    } else {
      canvas.addEventListener('touchstart', function (event) {
        if (!event.touches || !event.touches.length) return;
        event.preventDefault();
        begin(event.touches[0]);
      }, false);
      canvas.addEventListener('touchmove', function (event) {
        if (!drawing || !event.touches || !event.touches.length) return;
        event.preventDefault();
        move(event.touches[0]);
      }, false);
      canvas.addEventListener('touchend', stop, false);
      canvas.addEventListener('touchcancel', stop, false);
      canvas.addEventListener('mousedown', function (event) { event.preventDefault(); begin(event); });
      document.addEventListener('mousemove', function (event) { if (drawing) move(event); });
      document.addEventListener('mouseup', stop);
    }

    var clear = document.getElementById('clear-signature');
    if (clear) clear.addEventListener('click', function () {
      hasInk = false;
      input.value = '';
      setup(false);
      var error = document.getElementById('signature-error');
      if (error) error.hidden = true;
    });

    form.addEventListener('submit', function (event) {
      if (!hasInk) {
        event.preventDefault();
        var error = document.getElementById('signature-error');
        if (error) error.hidden = false;
        try { canvas.focus(); } catch (ignore) { /* Error text is still visible. */ }
        return;
      }
      input.value = canvas.toDataURL('image/png');
    });

    function resize() {
      if (resizeTimer) window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(function () { setup(hasInk); }, 180);
    }
    window.addEventListener('resize', resize);
    window.addEventListener('orientationchange', resize);
  } catch (ignore) {
    canvas.removeAttribute('data-ready');
  }
}());
