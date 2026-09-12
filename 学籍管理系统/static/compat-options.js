(function () {
  'use strict';
  function fire(element, name) {
    if (window.XuejiCompat) window.XuejiCompat.fire(element, name);
  }

  function initialize(input) {
    var listId = input.getAttribute('list');
    var datalist = document.getElementById(listId);
    if (!datalist) return;
    var nodes = datalist.getElementsByTagName('option');
    var options = [];
    var i;
    for (i = 0; i < nodes.length; i += 1) if (nodes[i].value) options.push(nodes[i].value);
    var menu = document.createElement('div');
    var list = document.createElement('div');
    var menuId = 'menu-' + (input.id || String(new Date().getTime()));
    menu.className = 'option-dropdown';
    menu.id = menuId;
    menu.hidden = true;
    list.setAttribute('role', 'listbox');
    menu.appendChild(list);
    input.parentNode.insertBefore(menu, input.nextSibling);
    input.setAttribute('aria-controls', menuId);
    input.setAttribute('aria-autocomplete', 'list');
    var activeIndex = -1;
    var currentMatches = [];
    var blurTimer = null;

    function close() {
      menu.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      if (window.XuejiCompat) window.XuejiCompat.removeClass(document.body, 'option-menu-open');
    }

    function choose(value) {
      input.value = value;
      close();
      fire(input, 'input');
      fire(input, 'change');
    }

    function makeItem(value, index) {
      var item = document.createElement('button');
      item.type = 'button';
      item.className = 'option-item';
      item.setAttribute('role', 'option');
      item.appendChild(document.createTextNode(value));
      item.addEventListener('mousedown', function (event) { event.preventDefault(); });
      item.addEventListener('touchend', function (event) { event.preventDefault(); choose(value); }, false);
      item.addEventListener('click', function () { choose(value); });
      if (index === activeIndex) {
        item.classList.add('active');
        item.setAttribute('aria-selected', 'true');
      }
      return item;
    }

    function render() {
      var filter = String(input.value || '').toLowerCase();
      currentMatches = [];
      for (i = 0; i < options.length && currentMatches.length < 100; i += 1) {
        if (options[i].toLowerCase().indexOf(filter) !== -1) currentMatches.push(options[i]);
      }
      while (list.firstChild) list.removeChild(list.firstChild);
      for (i = 0; i < currentMatches.length; i += 1) list.appendChild(makeItem(currentMatches[i], i));
      if (!currentMatches.length) {
        var empty = document.createElement('div');
        empty.className = 'option-empty';
        empty.appendChild(document.createTextNode('没有匹配选项，请换关键词'));
        list.appendChild(empty);
      }
    }

    function open() {
      if (blurTimer) window.clearTimeout(blurTimer);
      activeIndex = -1;
      render();
      menu.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      if (window.XuejiCompat) window.XuejiCompat.addClass(document.body, 'option-menu-open');
    }

    input.addEventListener('focus', open);
    input.addEventListener('click', open);
    input.addEventListener('input', open);
    input.addEventListener('keydown', function (event) {
      var key = event.key || '';
      if (menu.hidden && (key === 'ArrowDown' || key === 'ArrowUp')) {
        open();
        event.preventDefault();
        return;
      }
      if (menu.hidden) return;
      if (key === 'ArrowDown') {
        activeIndex = Math.min(activeIndex + 1, currentMatches.length - 1);
        event.preventDefault();
      } else if (key === 'ArrowUp') {
        activeIndex = Math.max(activeIndex - 1, 0);
        event.preventDefault();
      } else if ((key === 'Enter' || key === 'Tab') && activeIndex >= 0 && currentMatches[activeIndex]) {
        choose(currentMatches[activeIndex]);
        if (key === 'Enter') event.preventDefault();
        return;
      } else if (key === 'Escape') {
        close();
        return;
      } else return;
      render();
      var active = list.querySelector('.active');
      if (active) try { active.scrollIntoView(false); } catch (ignore) { /* Optional convenience only. */ }
    });
    input.addEventListener('blur', function () { blurTimer = window.setTimeout(close, 360); });
    input.removeAttribute('list');
  }

  var inputs = document.querySelectorAll('input[data-long-options]');
  var index;
  for (index = 0; index < inputs.length; index += 1) {
    try { initialize(inputs[index]); } catch (ignore) { /* The original datalist remains usable if setup fails early. */ }
  }
}());
