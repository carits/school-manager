import tempfile
from pathlib import Path

import openpyxl
from django.core.management import call_command
from django.test import SimpleTestCase, TestCase

from .crypto import digest, encrypt, identity
from .enrichment import candidate_values, matching_region
from .models import Batch, Student


class EnrichmentTests(SimpleTestCase):
    def test_region_requires_template_value_or_address_prefix(self):
        options = {"湖南省长沙市雨花区", "湖南省长沙市天心区"}
        self.assertEqual(matching_region("湖南省长沙市雨花区", options), "湖南省长沙市雨花区")
        self.assertEqual(matching_region("湖南省长沙市雨花区某街道1号", options), "湖南省长沙市雨花区")
        self.assertEqual(matching_region("长沙市雨花区某街道1号", options), "")

    def test_candidate_values_rejects_distorted_parent_id(self):
        row = {
            "班级": "2601", "性别": "男", "出生日期": "2013-11-26", "民族": "汉族",
            "学生身份证号": "430528201311260091", "户籍省市区": "湖南省长沙市雨花区",
            "户籍地址（规范）": "湖南省长沙市雨花区某街道", "现住址（规范）": "湖南省长沙市雨花区某小区",
            "是否有残疾证": "否", "父亲姓名": "测试父亲", "父亲电话": "13800138000",
            "父亲身份证原表值（可能失真）": "430528198001010000", "父亲户籍地址（规范）": "湖南省长沙市雨花区某街道",
            "母亲姓名": "", "母亲电话": "", "母亲身份证原表值（可能失真）": "", "母亲户籍地址（规范）": "",
        }
        values, skipped = candidate_values(row)
        self.assertNotIn("BT", values)
        self.assertNotIn("BS", values)
        self.assertTrue(any(key == "BT" and "可能失真" in reason for key, reason, _ in skipped))
        self.assertEqual(values["V"], "2601")
        self.assertEqual(values["Z"], "湖南省长沙市雨花区")


class TrustedStudentIdCommandTests(TestCase):
    def test_trusted_id_updates_original_login_credential_by_unique_name(self):
        old_id = "430528201311260091"
        new_id = "123456789012345"
        batch = Batch.objects.create(title="测试批次", fingerprint="f" * 64, active=True)
        student = Student.objects.create(
            batch=batch,
            source_row=2,
            serial_hash=digest("serial-1"),
            identity_hash=identity("测试学生", old_id),
            name="测试学生",
            original_cipher=encrypt({
                "A": "serial-1", "B": "测试学生", "C": "男", "D": "20131126",
                "G": "汉族", "H": "中国", "I": "居民身份证", "J": old_id,
                "K": "非港澳台侨", "V": "", "Y": "G" + old_id,
            }),
        )
        headers = [
            "班级", "学生姓名", "性别", "民族", "出生日期", "学生身份证号",
            "户籍省市区", "户籍地址（规范）", "现住址（规范）", "是否有残疾证",
            "父亲姓名", "父亲电话", "父亲身份证原表值（可能失真）", "父亲户籍地址（规范）",
            "母亲姓名", "母亲电话", "母亲身份证原表值（可能失真）", "母亲户籍地址（规范）",
            "数据状态", "疑点",
        ]
        values = [
            "2601", "测试学生", "女", "汉族", "2014-05-06", new_id,
            "湖南省长沙市雨花区", "湖南省长沙市雨花区某街道", "湖南省长沙市雨花区某小区", "否",
            "", "", "", "", "", "", "", "", "正常", "",
        ]
        workbook = openpyxl.Workbook()
        sheet = workbook.active
        sheet.title = "学生信息汇总"
        sheet.append(headers)
        sheet.append(values)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "source.xlsx"
            workbook.save(path)
            call_command("enrich_active_batch", str(path), apply=True, trust_student_id=True)
        student.refresh_from_db()
        self.assertEqual(student.original["J"], new_id)
        self.assertEqual(student.original["I"], "其他")
        self.assertEqual(student.original["C"], "女")
        self.assertEqual(student.original["D"], "20140506")
        self.assertEqual(student.identity_hash, identity("测试学生", new_id))
        self.assertEqual(student.class_name, "2601")
