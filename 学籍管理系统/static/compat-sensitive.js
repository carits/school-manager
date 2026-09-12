(function () {
  'use strict';
  function initialize(button) {
    var originalText = button.textContent;
    button.addEventListener('click', function (event) {
      event.preventDefault();
      var card = button.parentNode;
      while (card && !card.getAttribute('data-field')) card = card.parentNode;
      if (!card) return;
      var editor = card.querySelector('[data-sensitive-editor]');
      var input = editor ? editor.querySelector('[data-direct-value]') : null;
      var loaded = card.querySelector('[data-sensitive-loaded]');
      var status = card.querySelector('[data-reveal-status]');
      if (!editor || !input || !loaded) return;
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      button.textContent = '正在读取…';
      if (status) status.hidden = true;

      var xhr = new XMLHttpRequest();
      xhr.open('GET', button.getAttribute('data-reveal'), true);
      xhr.timeout = 15000;
      xhr.setRequestHeader('Accept', 'application/json');
      function fail(message) {
        loaded.value = '0';
        button.disabled = false;
        button.removeAttribute('aria-busy');
        button.textContent = originalText;
        if (status) {
          status.textContent = message;
          status.setAttribute('role', 'alert');
          status.hidden = false;
        }
      }
      xhr.onload = function () {
        var contentType = xhr.getResponseHeader('Content-Type') || '';
        var expired = xhr.responseURL && (xhr.responseURL.indexOf('/xueji/?') !== -1 || /\/xueji\/$/.test(xhr.responseURL) || xhr.responseURL.indexOf('/xueji/login/') !== -1);
        if (xhr.status !== 200 || contentType.indexOf('application/json') === -1 || (xhr.responseURL && xhr.responseURL.indexOf('/xueji/admin/login/') !== -1)) {
          fail(xhr.status === 403 || expired ? '登录状态已失效，请重新验证身份。' : '号码读取失败，请稍后重试。');
          return;
        }
        try {
          var data = JSON.parse(xhr.responseText);
          input.value = String(data.value || '');
          loaded.value = '1';
          editor.hidden = false;
          button.hidden = true;
          if (status) {
            status.setAttribute('role', 'status');
            status.textContent = '完整号码已显示。需要修改时，请再点输入框。';
            status.hidden = false;
          }
          try { editor.scrollIntoView(true); } catch (ignore) { /* Field is already visible on most phones. */ }
        } catch (ignore) { fail('号码读取失败，请稍后重试。'); }
      };
      xhr.onerror = function () { fail('网络连接失败，请检查网络后重试。'); };
      xhr.ontimeout = function () { fail('读取超时，请检查网络后重试。'); };
      xhr.send(null);
    });
  }
  var buttons = document.querySelectorAll('[data-reveal]');
  var index;
  for (index = 0; index < buttons.length; index += 1) {
    try { initialize(buttons[index]); } catch (ignore) { /* Normal form submit remains available. */ }
  }
}());
