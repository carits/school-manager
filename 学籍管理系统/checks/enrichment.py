import re
from datetime import date, datetime

from .schema import BY_KEY, text_value, valid_id, validate_value


SOURCE_HEADERS = {
    "班级", "学生姓名", "性别", "民族", "出生日期", "学生身份证号",
    "户籍省市区", "户籍地址（规范）", "现住址（规范）", "是否有残疾证",
    "父亲姓名", "父亲电话", "父亲身份证原表值（可能失真）", "父亲户籍地址（规范）",
    "母亲姓名", "母亲电话", "母亲身份证原表值（可能失真）", "母亲户籍地址（规范）",
    "数据状态", "疑点",
}


def clean(value):
    if value is None:
        return ""
    if isinstance(value, (datetime, date)):
        return value.strftime("%Y-%m-%d")
    return str(value).strip()


def normalize_birth(value):
    return clean(value).replace("-", "").replace("/", "")


def matching_region(value, options):
    """Return an explicit template region or a full-address prefix; never guess."""
    value = clean(value)
    if not value:
        return ""
    if value in options:
        return value
    matches = [option for option in options if value.startswith(option)]
    if not matches:
        return ""
    return max(matches, key=len)


def valid_phone(value):
    value = clean(value)
    return bool(re.fullmatch(r"\+?[0-9 ()\-]{6,25}", value))


def candidate_values(row):
    """Build only values that are directly supported and valid in the source row."""
    values = {}
    skipped = []

    def add(key, value, *, required=False):
        value = clean(value)
        if not value:
            if required:
                skipped.append((key, "源表为空", ""))
            return
        error = validate_value(key, value, {**values, key: value})
        if error:
            skipped.append((key, error, value))
            return
        values[key] = value

    add("V", row.get("班级"), required=True)
    add("C", row.get("性别"), required=True)
    birth = normalize_birth(row.get("出生日期"))
    add("D", birth, required=True)
    add("G", row.get("民族"), required=True)

    student_id = clean(row.get("学生身份证号")).upper()
    if valid_id(student_id):
        if birth and birth != student_id[6:14]:
            skipped.append(("D", "出生日期与学生身份证号不一致", birth))
            values.pop("D", None)
        expected_gender = "男" if int(student_id[16]) % 2 else "女"
        if values.get("C") and values["C"] != expected_gender:
            skipped.append(("C", "性别与学生身份证号不一致", values["C"]))
            values.pop("C", None)

    regions = set(BY_KEY["Q"]["options"])
    household_region = matching_region(row.get("户籍省市区"), regions)
    if household_region:
        values["Q"] = household_region
    elif clean(row.get("户籍省市区")):
        skipped.append(("Q", "不在模板行政区划选项中", clean(row.get("户籍省市区"))))
    else:
        skipped.append(("Q", "源表为空", ""))
    add("R", row.get("户籍地址（规范）"), required=True)

    current_address = clean(row.get("现住址（规范）"))
    current_region = matching_region(current_address, regions)
    if current_region:
        values["Z"] = current_region
    elif current_address:
        skipped.append(("Z", "无法从规范现住址可靠识别行政区划", current_address))
    else:
        skipped.append(("Z", "源表为空", ""))
    add("AA", current_address, required=True)
    add("AV", row.get("是否有残疾证"), required=True)

    # The source has no guardian flag, so BR is deliberately left for the family.
    role = "父亲" if clean(row.get("父亲姓名")) else "母亲" if clean(row.get("母亲姓名")) else ""
    if role:
        values["BI"] = clean(row[f"{role}姓名"])
        values["BJ"] = role
        parent_address = clean(row.get(f"{role}户籍地址（规范）"))
        parent_region = matching_region(parent_address, regions)
        if parent_region:
            values["BO"] = parent_region
        elif parent_address:
            skipped.append(("BO", "无法从成员户籍地址可靠识别行政区划", parent_address))
        else:
            skipped.append(("BO", "源表为空", ""))
        add("BP", parent_address, required=True)
        phone = clean(row.get(f"{role}电话"))
        if valid_phone(phone):
            values["BQ"] = phone
        elif phone:
            skipped.append(("BQ", "联系电话格式异常", phone))
        else:
            skipped.append(("BQ", "源表为空", ""))
        parent_id = clean(row.get(f"{role}身份证原表值（可能失真）")).upper()
        if parent_id:
            skipped.append(("BT", "源字段明确标注“可能失真”，暂不导入", parent_id))
        else:
            skipped.append(("BT", "源表为空", ""))
    else:
        for key in ("BI", "BJ", "BO", "BP", "BQ", "BT"):
            skipped.append((key, "源表没有可用的父亲或母亲信息", ""))

    return values, skipped


def mask_value(key, value):
    value = clean(value)
    if key in {"J", "BT"} and len(value) >= 8:
        return value[:4] + "**********" + value[-4:]
    if key == "BQ" and len(value) >= 7:
        return value[:3] + "****" + value[-4:]
    if key in {"R", "AA", "BP"} and len(value) > 16:
        return value[:12] + "……"
    return value
