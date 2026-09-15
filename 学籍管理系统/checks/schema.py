import json
import re
from datetime import date, datetime
from django.conf import settings
from .crypto import normalize

FIELDS = json.loads((settings.BASE_DIR / 'assets/schema.json').read_text(encoding='utf-8'))
REGION_KEYS = {'E', 'F', 'Q', 'Z', 'BO', 'CB'}
MACAU_REGIONS = [
    '澳门特别行政区澳门半岛花地玛堂区',
    '澳门特别行政区澳门半岛圣安多尼堂区',
    '澳门特别行政区澳门半岛大堂区',
    '澳门特别行政区澳门半岛望德堂区',
    '澳门特别行政区澳门半岛风顺堂区',
    '澳门特别行政区氹仔嘉模堂区',
    '澳门特别行政区路环圣方济各堂区',
    '澳门特别行政区路氹路氹城',
]
for field in FIELDS:
    if field['key'] in REGION_KEYS:
        field['options'] = [
            value for value in field['options']
            if value != '\u5cea泉镇' and not value.endswith('市辖区')
        ]
        field['options'].extend(value for value in MACAU_REGIONS if value not in field['options'])
BY_KEY = {f['key']: f for f in FIELDS}
VISIBLE = [f for f in FIELDS if f['key'] != 'A']
GROUP_NAMES = ['学生身份', '学籍及在校情况', '户籍与住址', '成员一信息', '成员二信息']
GROUPS = [
    [f for f in VISIBLE if f['key'] in {'B','C','D','E','F','G','H','I','J','K','L','M','N','O','P'}],
    [f for f in VISIBLE if f['key'] in {'Q','R','S','T','U','V','W','X','Y','Z','AA','AB','AC','AD','AE','AF','AG'}],
    [f for f in VISIBLE if f['key'] in {'AH','AI','AJ','AK','AL','AM','AN','AO','AP','AQ','AR','AS','AT','AU','AV','AW','AX','AY','AZ','BA','BB','BC','BD','BE','BF','BG','BH'}],
    [f for f in VISIBLE if f['key'] in {'BI','BJ','BK','BL','BM','BN','BO','BP','BQ','BR','BS','BT','BU'}],
    [f for f in VISIBLE if f['key'] in {'BV','BW','BX','BY','BZ','CA','CB','CC','CD','CE','CF','CG','CH'}],
]
SENSITIVE = {'J', 'BT'}

def check_status(field, item):
    """Return the direct-edit confirmation status, including legacy drafts."""
    result = item.get('result', '')
    if result in {'confirmed', 'unconfirmed'}:
        return result
    if result == 'correct':
        return 'confirmed'
    if result == 'incorrect':
        return 'unconfirmed' if field['readonly'] or 'value' not in item else 'confirmed'
    return 'unconfirmed'

def check_value(base, field, item):
    """Return the effective value without treating legacy `correct` blanks as edits."""
    key = field['key']
    if field['readonly']:
        return text_value(base.get(key, ''))
    if 'value' in item and (item.get('mode') == 'direct' or item.get('result') == 'incorrect'):
        return text_value(item.get('value', ''))
    return text_value(base.get(key, ''))

def text_value(value):
    if value is None: return ''
    if isinstance(value, (datetime, date)): return value.strftime('%Y%m%d')
    return str(value).strip()

def valid_id(number):
    if not re.fullmatch(r'\d{17}[\dX]', number): return False
    try: datetime.strptime(number[6:14], '%Y%m%d')
    except ValueError: return False
    weights = [7,9,10,5,8,4,2,1,6,3,7,9,10,5,8,4,2]
    return '10X98765432'[sum(int(n)*w for n,w in zip(number[:17], weights)) % 11] == number[-1]

def validate_value(key, value, values):
    value = text_value(value)
    field = BY_KEY[key]
    if not value and field['required']: return '请填写此项。'
    if not value: return None
    if len(value) > (500 if key in {'R','AA','BP'} else 100): return '内容过长，请检查。'
    if field['options'] and value not in field['options']: return '请从模板提供的选项中选择。'
    if key == 'D':
        try:
            parsed = datetime.strptime(value.replace('-',''), '%Y%m%d').date()
            if parsed > date.today() or parsed.year < 1900: return '出生日期不在有效范围内。'
        except ValueError: return '请输入有效出生日期。'
    if key in SENSITIVE:
        kind = values.get('I' if key == 'J' else 'BS')
        if kind == '居民身份证' and not valid_id(value.upper()): return '居民身份证号码的日期或校验位不正确。'
        if kind != '居民身份证' and not re.fullmatch(r'[A-Za-z0-9()（）\- ]{3,40}', value): return '请检查证件号码格式。'
    if key == 'BQ' and not re.fullmatch(r'\+?[0-9 ()\-]{6,25}', value): return '请输入有效联系电话。'
    return None

def validate_checks(base, checks, fields=VISIBLE):
    values = dict(base)
    errors = {}
    for f in fields:
        if not f['readonly']:
            values[f['key']] = check_value(base, f, checks.get(f['key'], {}))
    for f in fields:
        key = f['key']; item = checks.get(key, {})
        status = check_status(f, item)
        if f['readonly']:
            continue
        error = validate_value(key, values.get(key,''), values)
        if error:
            errors[key] = error
        elif f['required'] and status != 'confirmed':
            errors[key] = '请确认此项内容。'
        elif values.get(key, '') != text_value(base.get(key, '')) and status != 'confirmed':
            errors[key] = '内容已修改，请确认后再继续。'
    # Validate document types against the final group values, regardless of field order.
    for key in SENSITIVE & {f['key'] for f in fields}:
        if key not in errors:
            error = validate_value(key, values.get(key,''), values)
            if error: errors[key] = error
    if not errors and any(f['key']=='J' for f in fields) and values.get('I') == '居民身份证':
        number = values.get('J','').upper()
        if values.get('D','').replace('-','') != number[6:14]: errors['D'] = '出生日期与居民身份证号码不一致。'
        if values.get('C') != ('男' if int(number[16]) % 2 else '女'): errors['C'] = '性别与居民身份证号码不一致。'
    return values, errors
