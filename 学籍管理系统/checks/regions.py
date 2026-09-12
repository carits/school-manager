import re

from .schema import BY_KEY


PROVINCES = [
    ('北京', '北京市'), ('天津', '天津市'), ('河北省', '河北省'), ('山西省', '山西省'),
    ('内蒙古自治区', '内蒙古自治区'), ('辽宁省', '辽宁省'), ('吉林省', '吉林省'),
    ('黑龙江省', '黑龙江省'), ('上海', '上海市'), ('江苏省', '江苏省'), ('浙江省', '浙江省'),
    ('安徽省', '安徽省'), ('福建省', '福建省'), ('江西省', '江西省'), ('山东省', '山东省'),
    ('河南省', '河南省'), ('湖北省', '湖北省'), ('湖南省', '湖南省'), ('广东省', '广东省'),
    ('广西壮族自治区', '广西壮族自治区'), ('海南省', '海南省'), ('重庆', '重庆市'),
    ('四川省', '四川省'), ('贵州省', '贵州省'), ('云南省', '云南省'), ('西藏自治区', '西藏自治区'),
    ('陕西省', '陕西省'), ('甘肃省', '甘肃省'), ('青海省', '青海省'),
    ('宁夏回族自治区', '宁夏回族自治区'), ('新疆维吾尔自治区', '新疆维吾尔自治区'),
    ('台湾', '台湾省'), ('香港特别行政区', '香港特别行政区'),
    ('澳门特别行政区', '澳门特别行政区'),
]


def split_region(value):
    province_key = province_name = remainder = ''
    for key, name in PROVINCES:
        if value.startswith(key):
            province_key, province_name, remainder = key, name, value[len(key):]
            break
    if not province_key:
        return '其他', '其他', value

    if province_key == '香港特别行政区':
        for area in ('香港岛', '九龙', '新界'):
            if remainder.startswith(area):
                return province_name, area, remainder[len(area):]
    if province_key == '澳门特别行政区':
        for area in ('澳门半岛', '氹仔', '路环', '路氹'):
            if remainder.startswith(area):
                return province_name, area, remainder[len(area):]

    pattern = r'^(.+?[市县])(.*)$' if province_key == '台湾' else r'^(.+?(?:自治州|地区|盟|市))(.*)$'
    match = re.match(pattern, remainder)
    if match and match.group(2):
        return province_name, match.group(1), match.group(2)
    if match:
        return province_name, '省直辖县级行政区划', match.group(1)
    return province_name, '省直辖县级行政区划', remainder


def build_region_tree():
    provinces = {}
    for value in BY_KEY['Q']['options']:
        province, city, district = split_region(value)
        provinces.setdefault(province, {}).setdefault(city, []).append({'name': district, 'value': value})
    order = [name for _, name in PROVINCES] + ['其他']
    return [
        {'name': province, 'cities': [
            {'name': city, 'districts': districts}
            for city, districts in cities.items()
        ]}
        for province in order if (cities := provinces.get(province))
    ]


REGION_TREE = build_region_tree()
