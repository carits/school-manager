(function () {
  'use strict';

  function fire(element, name) {
    var event = document.createEvent('Event');
    event.initEvent(name, true, false);
    element.dispatchEvent(event);
  }

  function addClass(element, name) {
    if (element && !element.classList.contains(name)) element.classList.add(name);
  }

  function removeClass(element, name) {
    if (element && element.classList.contains(name)) element.classList.remove(name);
  }

  window.XuejiCompat = { fire: fire, addClass: addClass, removeClass: removeClass };

  function updateCard(card) {
    var radios = card.querySelectorAll('input[type="radio"]');
    var checked = null;
    var i;
    for (i = 0; i < radios.length; i += 1) {
      removeClass(radios[i].parentNode, 'is-selected');
      if (radios[i].checked) checked = radios[i];
    }
    if (checked) addClass(checked.parentNode, 'is-selected');
    var note = card.querySelector('.readonly-note');
    if (note) note.hidden = !!checked && checked.value === 'confirmed';
  }

  var cards = document.querySelectorAll('[data-field]');
  var cardIndex;
  for (cardIndex = 0; cardIndex < cards.length; cardIndex += 1) {
    (function (card) {
      var radios = card.querySelectorAll('input[type="radio"]');
      var values = card.querySelectorAll('[data-direct-value]');
      var i;
      updateCard(card);
      for (i = 0; i < radios.length; i += 1) {
        radios[i].addEventListener('change', function () { updateCard(card); });
      }
      function markUnconfirmed() {
        var radio = card.querySelector('input[type="radio"][value="unconfirmed"]');
        if (radio) {
          radio.checked = true;
          updateCard(card);
        }
      }
      for (i = 0; i < values.length; i += 1) {
        values[i].addEventListener('input', markUnconfirmed);
        values[i].addEventListener('change', markUnconfirmed);
      }
    }(cards[cardIndex]));
  }

  var captcha = document.querySelector('[data-refresh-captcha]');
  if (captcha) captcha.addEventListener('click', function () {
    var image = document.getElementById('captcha-image');
    if (image) image.src = '/xueji/captcha/?t=' + String(new Date().getTime());
  });

  var confirms = document.querySelectorAll('[data-confirm]');
  var confirmIndex;
  for (confirmIndex = 0; confirmIndex < confirms.length; confirmIndex += 1) {
    confirms[confirmIndex].addEventListener('click', function (event) {
      if (!window.confirm(this.getAttribute('data-confirm'))) event.preventDefault();
    });
  }

  var exportLinks = document.querySelectorAll('[data-export-download]');
  var exportStatus = document.querySelector('[data-export-status]');
  var exportIndex;
  for (exportIndex = 0; exportIndex < exportLinks.length; exportIndex += 1) {
    exportLinks[exportIndex].addEventListener('click', function () {
      var link = this;
      var original = link.getAttribute('data-export-label') || link.textContent;
      link.setAttribute('data-export-label', original);
      link.setAttribute('aria-busy', 'true');
      addClass(link, 'export-busy');
      link.textContent = '正在生成，请稍候…';
      if (exportStatus) {
        exportStatus.hidden = false;
        exportStatus.textContent = '正在生成 Excel，请保持页面打开。通常需要几秒钟，请勿重复点击。';
      }
      window.setTimeout(function () {
        link.textContent = original;
        link.removeAttribute('aria-busy');
        removeClass(link, 'export-busy');
        if (exportStatus) exportStatus.textContent = '如果浏览器尚未提示保存，请再次点击对应文件。';
      }, 15000);
    });
  }

  var firstError = document.querySelector('[data-first-error]');
  if (firstError) window.setTimeout(function () {
    try { firstError.scrollIntoView(true); } catch (ignore) { window.location.hash = firstError.id; }
    window.setTimeout(function () {
      try { firstError.focus(); } catch (ignore) { /* The visible error remains usable. */ }
    }, 60);
  }, 30);

  function isEditor(element) {
    if (!element || !element.tagName) return false;
    var tag = element.tagName.toLowerCase();
    if (tag === 'textarea' || tag === 'select') return true;
    if (tag !== 'input') return false;
    var type = (element.type || 'text').toLowerCase();
    return type !== 'radio' && type !== 'checkbox' && type !== 'button' && type !== 'submit' && type !== 'hidden';
  }

  document.addEventListener('focus', function (event) {
    if (isEditor(event.target)) addClass(document.body, 'form-control-active');
  }, true);
  document.addEventListener('blur', function () {
    window.setTimeout(function () {
      if (!isEditor(document.activeElement)) removeClass(document.body, 'form-control-active');
    }, 80);
  }, true);

  if (window.visualViewport) {
    var largestHeight = window.visualViewport.height;
    window.visualViewport.addEventListener('resize', function () {
      if (window.visualViewport.height > largestHeight) largestHeight = window.visualViewport.height;
      if (window.visualViewport.height < largestHeight * 0.76) addClass(document.body, 'visual-keyboard-open');
      else removeClass(document.body, 'visual-keyboard-open');
    });
  }
}());
