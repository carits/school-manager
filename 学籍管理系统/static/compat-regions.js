(function () {
  'use strict';
  var dataElement = document.getElementById('region-data');
  if (!dataElement) return;
  var regions;
  try { regions = JSON.parse(dataElement.textContent || dataElement.innerText); } catch (ignore) { return; }

  function option(value, label) {
    var element = document.createElement('option');
    element.value = value;
    element.appendChild(document.createTextNode(label));
    return element;
  }

  function clear(select, label) {
    while (select.firstChild) select.removeChild(select.firstChild);
    select.appendChild(option('', label));
  }

  function notify(input) {
    if (window.XuejiCompat) window.XuejiCompat.fire(input, 'input');
  }

  function initialize(picker) {
    var provinceSelect = picker.querySelector('[data-region-province]');
    var citySelect = picker.querySelector('[data-region-city]');
    var districtSelect = picker.querySelector('[data-region-district]');
    var valueInput = picker.querySelector('[data-region-value]');
    var currentHint = picker.querySelector('[data-region-current]');
    var i;
    if (!provinceSelect || !citySelect || !districtSelect || !valueInput) return;

    if (provinceSelect.options.length <= 1) {
      for (i = 0; i < regions.length; i += 1) provinceSelect.appendChild(option(String(i), regions[i].name));
    }

    function resetValue() {
      valueInput.value = '';
      if (currentHint) currentHint.hidden = true;
      notify(valueInput);
    }

    function fillCities(provinceIndex) {
      clear(citySelect, provinceIndex === '' ? '请先选择省份' : '请选择城市');
      clear(districtSelect, '请先选择城市');
      districtSelect.disabled = true;
      if (provinceIndex === '' || !regions[Number(provinceIndex)]) {
        citySelect.disabled = true;
        return;
      }
      var cities = regions[Number(provinceIndex)].cities;
      for (i = 0; i < cities.length; i += 1) citySelect.appendChild(option(String(i), cities[i].name));
      citySelect.disabled = false;
    }

    function fillDistricts(provinceIndex, cityIndex) {
      clear(districtSelect, cityIndex === '' ? '请先选择城市' : '请选择区县或镇街');
      if (provinceIndex === '' || cityIndex === '' || !regions[Number(provinceIndex)] || !regions[Number(provinceIndex)].cities[Number(cityIndex)]) {
        districtSelect.disabled = true;
        return;
      }
      var districts = regions[Number(provinceIndex)].cities[Number(cityIndex)].districts;
      for (i = 0; i < districts.length; i += 1) districtSelect.appendChild(option(districts[i].value, districts[i].name));
      districtSelect.disabled = false;
    }

    provinceSelect.addEventListener('change', function () {
      fillCities(provinceSelect.value);
      resetValue();
    });
    citySelect.addEventListener('change', function () {
      fillDistricts(provinceSelect.value, citySelect.value);
      resetValue();
    });
    districtSelect.addEventListener('change', function () {
      valueInput.value = districtSelect.value;
      if (currentHint) currentHint.hidden = true;
      notify(valueInput);
    });
    picker.setAttribute('data-region-ready', '1');
  }

  var pickers = document.querySelectorAll('[data-region-picker]');
  var index;
  for (index = 0; index < pickers.length; index += 1) {
    try { initialize(pickers[index]); } catch (ignore) { pickers[index].setAttribute('data-region-failed', '1'); }
  }
}());
