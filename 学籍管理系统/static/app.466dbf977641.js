document.querySelectorAll('[data-field]').forEach(card => {
  const update = () => {
    const note = card.querySelector('.readonly-note');
    if (note) note.hidden = card.querySelector('input[type=radio]:checked')?.value === 'confirmed';
  };
  card.querySelectorAll('input[type=radio]').forEach(input => input.addEventListener('change', update));
  card.querySelectorAll('[data-direct-value]').forEach(input => {
    const markUnconfirmed = () => {
      const radio = card.querySelector('input[type=radio][value=unconfirmed]');
      if (radio) radio.checked = true;
    };
    input.addEventListener('input', markUnconfirmed);
    input.addEventListener('change', markUnconfirmed);
  });
});

const regionDataElement = document.getElementById('region-data');
if (regionDataElement) {
  const regions = JSON.parse(regionDataElement.textContent);
  const byValue = new Map();
  regions.forEach((province, provinceIndex) => province.cities.forEach((city, cityIndex) =>
    city.districts.forEach(district => byValue.set(district.value, { provinceIndex, cityIndex, value: district.value }))
  ));
  const option = (value, label) => {
    const element = document.createElement('option');
    element.value = value;
    element.textContent = label;
    return element;
  };
  document.querySelectorAll('[data-region-picker]').forEach(picker => {
    const provinceSelect = picker.querySelector('[data-region-province]');
    const citySelect = picker.querySelector('[data-region-city]');
    const districtSelect = picker.querySelector('[data-region-district]');
    const valueInput = picker.querySelector('[data-region-value]');
    const currentHint = picker.querySelector('[data-region-current]');
    regions.forEach((province, index) => provinceSelect.appendChild(option(String(index), province.name)));

    const fillCities = provinceIndex => {
      citySelect.replaceChildren(option('', '请选择城市'));
      districtSelect.replaceChildren(option('', '请先选择城市'));
      districtSelect.disabled = true;
      if (provinceIndex === '') { citySelect.disabled = true; return; }
      regions[Number(provinceIndex)].cities.forEach((city, index) => citySelect.appendChild(option(String(index), city.name)));
      citySelect.disabled = false;
    };
    const fillDistricts = (provinceIndex, cityIndex) => {
      districtSelect.replaceChildren(option('', '请选择区县或镇街'));
      if (provinceIndex === '' || cityIndex === '') { districtSelect.disabled = true; return; }
      regions[Number(provinceIndex)].cities[Number(cityIndex)].districts.forEach(district =>
        districtSelect.appendChild(option(district.value, district.name))
      );
      districtSelect.disabled = false;
    };
    const clearValue = () => {
      valueInput.value = '';
      currentHint.hidden = true;
      valueInput.dispatchEvent(new Event('input', { bubbles: true }));
    };
    provinceSelect.addEventListener('change', () => { fillCities(provinceSelect.value); clearValue(); });
    citySelect.addEventListener('change', () => { fillDistricts(provinceSelect.value, citySelect.value); clearValue(); });
    districtSelect.addEventListener('change', () => {
      valueInput.value = districtSelect.value;
      currentHint.hidden = true;
      valueInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const selected = byValue.get(valueInput.value);
    if (selected) {
      provinceSelect.value = String(selected.provinceIndex);
      fillCities(provinceSelect.value);
      citySelect.value = String(selected.cityIndex);
      fillDistricts(provinceSelect.value, citySelect.value);
      districtSelect.value = selected.value;
    } else if (valueInput.value) {
      currentHint.textContent = `原有值：${valueInput.value}。请重新选择省、市、区县或镇街。`;
      currentHint.hidden = false;
    }
  });
}

document.querySelectorAll('input[list][data-long-options]').forEach(input => {
  const datalist = document.getElementById(input.getAttribute('list'));
  if (!datalist) return;
  const options = Array.from(datalist.options).map(option => option.value).filter(Boolean);
  const menu = document.createElement('div');
  menu.className = 'option-dropdown';
  menu.hidden = true;
  const list = document.createElement('div');
  menu.appendChild(list);
  input.after(menu);
  let activeIndex = -1;
  let blurredAt = 0;

  const render = () => {
    const filter = input.value.trim().toLowerCase();
    const matches = options.filter(option => option.toLowerCase().includes(filter));
    list.innerHTML = '';
    matches.slice(0, 100).forEach((option, index) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'option-item';
      item.textContent = option;
      item.addEventListener('mousedown', event => event.preventDefault());
      item.addEventListener('click', () => {
        input.value = option;
        close();
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });
      if (index === activeIndex) item.classList.add('active');
      list.appendChild(item);
    });
    if (!matches.length) {
      const empty = document.createElement('div');
      empty.className = 'option-empty';
      empty.textContent = '没有匹配选项，请换关键词';
      list.appendChild(empty);
    }
  };

  const open = () => {
    activeIndex = -1;
    render();
    menu.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  };
  const close = () => {
    menu.hidden = true;
    input.setAttribute('aria-expanded', 'false');
  };

  input.addEventListener('focus', open);
  input.addEventListener('click', open);
  input.addEventListener('input', open);
  input.addEventListener('keydown', event => {
    if (menu.hidden && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
      open();
      event.preventDefault();
      return;
    }
    if (menu.hidden) return;
    const buttons = Array.from(list.querySelectorAll('.option-item'));
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      activeIndex = Math.min(activeIndex + 1, buttons.length - 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      activeIndex = Math.max(activeIndex - 1, 0);
    } else if (event.key === 'Enter' || event.key === 'Tab') {
      if (activeIndex >= 0 && buttons[activeIndex]) {
        event.preventDefault();
        input.value = buttons[activeIndex].textContent;
        close();
      }
      return;
    } else if (event.key === 'Escape') {
      close();
      return;
    } else {
      return;
    }
    buttons.forEach((button, index) => button.classList.toggle('active', index === activeIndex));
    buttons[activeIndex]?.scrollIntoView({ block: 'nearest' });
  });
  input.addEventListener('blur', () => {
    blurredAt = Date.now();
    setTimeout(() => { if (Date.now() - blurredAt >= 180) close(); }, 200);
  });
});
document.querySelector('[data-refresh-captcha]')?.addEventListener('click', () => { document.getElementById('captcha-image').src = '/xueji/captcha/?t=' + Date.now(); });
document.querySelectorAll('[data-reveal]').forEach(button => button.addEventListener('click', async () => {
  const card = button.closest('[data-field]');
  const editor = card.querySelector('[data-sensitive-editor]');
  const input = editor.querySelector('[data-direct-value]');
  const loaded = card.querySelector('[data-sensitive-loaded]');
  button.disabled = true;
  try { const response = await fetch(button.dataset.reveal, { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error();
    const data = await response.json(); input.value = data.value; loaded.value = '1'; editor.hidden = false;
    button.hidden = true; input.focus();
  } catch { button.textContent = '会话可能已过期，请重新登录'; button.disabled = false; }
}));
document.querySelectorAll('[data-confirm]').forEach(button => button.addEventListener('click', event => { if (!window.confirm(button.dataset.confirm)) event.preventDefault(); }));

const firstErrorCard = document.querySelector('[data-first-error]');
if (firstErrorCard) {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    firstErrorCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
    firstErrorCard.focus({ preventScroll: true });
  }));
}

const signatureCanvas = document.getElementById('signature-pad');
const signatureInput = document.getElementById('signature-input');
const signatureForm = document.getElementById('confirm-form');
if (signatureCanvas && signatureInput && signatureForm) {
  const context = signatureCanvas.getContext('2d');
  let ratio = 1;
  const setupSignature = () => {
    const rect = signatureCanvas.getBoundingClientRect();
    ratio = Math.max(window.devicePixelRatio || 1, 1);
    signatureCanvas.width = Math.max(1, Math.round(rect.width * ratio));
    signatureCanvas.height = Math.max(1, Math.round(rect.height * ratio));
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.fillStyle = '#fff';
    context.fillRect(0, 0, rect.width, rect.height);
    context.strokeStyle = '#142f47';
    context.lineWidth = 2.4;
    context.lineCap = 'round';
    context.lineJoin = 'round';
  };
  setupSignature();
  signatureCanvas.dataset.ready = '1';
  let drawing = false;
  let hasInk = false;
  const point = event => {
    const rect = signatureCanvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  signatureCanvas.addEventListener('pointerdown', event => {
    drawing = true; hasInk = true; signatureCanvas.setPointerCapture(event.pointerId);
    const p = point(event); context.beginPath(); context.moveTo(p.x, p.y);
  });
  signatureCanvas.addEventListener('pointermove', event => {
    if (!drawing) return; const p = point(event); context.lineTo(p.x, p.y); context.stroke();
  });
  signatureCanvas.addEventListener('pointerup', () => { drawing = false; });
  signatureCanvas.addEventListener('pointercancel', () => { drawing = false; });
  document.getElementById('clear-signature')?.addEventListener('click', () => {
    setupSignature(); hasInk = false; signatureInput.value = '';
    const error = document.getElementById('signature-error'); if (error) error.hidden = true;
  });
  signatureForm.addEventListener('submit', event => {
    if (!hasInk) {
      event.preventDefault(); const error = document.getElementById('signature-error');
      if (error) error.hidden = false; signatureCanvas.focus(); return;
    }
    signatureInput.value = signatureCanvas.toDataURL('image/png');
  });
}
