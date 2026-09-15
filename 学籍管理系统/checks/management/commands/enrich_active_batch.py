from collections import Counter, defaultdict
from pathlib import Path
import re

import openpyxl
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from checks.crypto import encrypt, identity
from checks.enrichment import SOURCE_HEADERS, candidate_values, clean, mask_value
from checks.models import Batch, Student
from checks.schema import BY_KEY, valid_id
from checks.services import audit


class Command(BaseCommand):
    help = "Safely fill blank fields in the active batch from the school summary workbook."

    def add_arguments(self, parser):
        parser.add_argument("path")
        parser.add_argument("--apply", action="store_true")
        parser.add_argument("--report")
        parser.add_argument(
            "--trust-student-id",
            action="store_true",
            help="Treat the source student ID as authoritative and match changed IDs by a unique name.",
        )

    def handle(self, *args, **options):
        path = Path(options["path"]).resolve()
        if not path.is_file() or path.suffix.lower() != ".xlsx":
            raise CommandError("The supplied .xlsx file does not exist.")
        batch = Batch.objects.filter(active=True).first()
        if not batch:
            raise CommandError("There is no active batch.")

        try:
            workbook = openpyxl.load_workbook(path, read_only=True, data_only=True)
            sheet = workbook["学生信息汇总"]
        except Exception as exc:
            raise CommandError("无法读取工作表“学生信息汇总”。") from exc
        rows = sheet.iter_rows(values_only=True)
        headers = [clean(value) for value in next(rows, ())]
        missing = SOURCE_HEADERS - set(headers)
        if missing:
            raise CommandError("源表缺少字段：" + "、".join(sorted(missing)))
        source = []
        for row_number, cells in enumerate(rows, 2):
            if not any(value is not None for value in cells):
                continue
            source.append((row_number, dict(zip(headers, cells))))
        workbook.close()

        source_identities = Counter(
            identity(clean(row.get("学生姓名")), clean(row.get("学生身份证号")).upper())
            for _, row in source
        )
        students = {
            student.identity_hash: student
            for student in Student.objects.filter(batch=batch)
        }
        students_by_name = defaultdict(list)
        for student in students.values():
            students_by_name[student.name].append(student)
        source_names = Counter(clean(row.get("学生姓名")) for _, row in source)
        changes = []
        anomalies = []
        field_counts = Counter()
        matched = set()

        for row_number, row in source:
            name = clean(row.get("学生姓名"))
            student_id = clean(row.get("学生身份证号")).upper()
            ident = identity(name, student_id)
            base_reason = ""
            student = None
            if not name:
                base_reason = "学生姓名为空"
            elif not student_id:
                base_reason = "学生身份证号为空"
            elif options["trust_student_id"] and not re.fullmatch(r"[A-Za-z0-9()（）\- ]{3,40}", student_id):
                base_reason = "学生身份证号包含不支持的字符"
            elif not options["trust_student_id"] and not valid_id(student_id):
                base_reason = "学生身份证号格式或校验位异常"
            elif source_identities[ident] != 1:
                base_reason = "源表姓名与身份证号组合重复"
            elif ident in students:
                student = students[ident]
            elif (
                options["trust_student_id"]
                and source_names[name] == 1
                and len(students_by_name.get(name, [])) == 1
            ):
                student = students_by_name[name][0]
            else:
                base_reason = "无法与现有名单精确匹配，且姓名不能唯一对应"
            if not base_reason and (student.status != "new" or student.revision != 0):
                base_reason = "该学生已经开始核对，未自动写入"
            if base_reason:
                anomalies.append((row_number, name, student_id, "整行", base_reason, ""))
                field_counts["整行跳过"] += 1
                continue

            matched.add(student.pk)
            candidates, skipped = candidate_values(row)
            credential_patch = {}
            if student.identity_hash != ident:
                credential_patch = {
                    "I": "居民身份证" if valid_id(student_id) else "其他",
                    "J": student_id,
                    "identity_hash": ident,
                }
                field_counts["I:学校确认更新"] += 1
                field_counts["J:学校确认更新"] += 1
                # These values were derived from the superseded credential in
                # the original import. Use the same authoritative source row.
                for key in ("C", "D"):
                    if key in candidates:
                        credential_patch[key] = candidates.pop(key)
                        field_counts[f"{key}:学校确认更新"] += 1
            for key, reason, value in skipped:
                anomalies.append((row_number, name, student_id, key, reason, mask_value(key, value)))
                field_counts[f"{key}:跳过"] += 1

            current = {**student.original, **student.school}
            patch = {}
            for key, value in candidates.items():
                existing = clean(current.get(key))
                if existing:
                    if existing != clean(value):
                        anomalies.append((row_number, name, student_id, key, "系统已有值与源表不同，未覆盖", mask_value(key, value)))
                        field_counts[f"{key}:冲突"] += 1
                    else:
                        field_counts[f"{key}:已有相同值"] += 1
                    continue
                patch[key] = value
                field_counts[f"{key}:写入"] += 1
            if patch or credential_patch:
                changes.append((student, patch, credential_patch))

        for student in students.values():
            if student.pk not in matched:
                field_counts["现有名单未匹配"] += 1

        if options["report"]:
            self._write_report(Path(options["report"]), batch, len(source), len(matched), changes, field_counts, anomalies)

        if options["apply"]:
            with transaction.atomic():
                for student, patch, credential_patch in changes:
                    update_fields = ["school_cipher", "class_name"]
                    if credential_patch:
                        original = student.original
                        for key in ("I", "J", "C", "D"):
                            if key in credential_patch:
                                original[key] = credential_patch[key]
                        student.original_cipher = encrypt(original)
                        student.identity_hash = credential_patch["identity_hash"]
                        update_fields.extend(["original_cipher", "identity_hash"])
                    school = student.school
                    school.update(patch)
                    student.school_cipher = encrypt(school)
                    if patch.get("V"):
                        student.class_name = patch["V"]
                    student.save(update_fields=update_fields)
                audit("system-enrichment", "补充基本情况信息", batch.pk, {
                    "source_file": path.name,
                    "source_rows": len(source),
                    "matched_students": len(matched),
                    "updated_students": len(changes),
                    "trusted_student_ids": options["trust_student_id"],
                    "credential_updates": field_counts["J:学校确认更新"],
                    "anomaly_items": len(anomalies),
                    "field_counts": dict(field_counts),
                })

        mode = "APPLIED" if options["apply"] else "DRY-RUN"
        self.stdout.write(
            f"{mode}: source={len(source)} matched={len(matched)} "
            f"updated={len(changes)} anomalies={len(anomalies)}"
        )
        for key in sorted(field_counts):
            self.stdout.write(f"{key}={field_counts[key]}")

    def _write_report(self, path, batch, source_rows, matched_rows, changes, counts, anomalies):
        path.parent.mkdir(parents=True, exist_ok=True)
        workbook = openpyxl.Workbook()
        summary = workbook.active
        summary.title = "导入汇总"
        summary.append(["项目", "数量"])
        for label, value in [
            ("批次", batch.title), ("源表学生数", source_rows), ("精确匹配学生数", matched_rows),
            ("将更新学生数", len(changes)), ("跳过或冲突项目数", len(anomalies)),
        ]:
            summary.append([label, value])
        summary.append([])
        summary.append(["字段结果", "数量"])
        for key, value in sorted(counts.items()):
            label = key
            if ":" in key:
                field, result = key.split(":", 1)
                label = f"{BY_KEY.get(field, {}).get('label', field).replace('*', '')}：{result}"
            summary.append([label, value])
        summary.freeze_panes = "A2"
        summary.column_dimensions["A"].width = 40
        summary.column_dimensions["B"].width = 18

        detail = workbook.create_sheet("未导入项目")
        detail.append(["源表行号", "学生姓名", "学生证件号（脱敏）", "字段", "原因", "源值（脱敏）"])
        for row_number, name, student_id, key, reason, value in anomalies:
            label = BY_KEY.get(key, {}).get("label", key).replace("*", "")
            masked_student_id = mask_value("J", student_id)
            detail.append([row_number, name, masked_student_id, label, reason, value])
        detail.freeze_panes = "A2"
        detail.auto_filter.ref = f"A1:F{max(1, detail.max_row)}"
        for column, width in zip("ABCDEF", [12, 14, 24, 24, 42, 30]):
            detail.column_dimensions[column].width = width
        for sheet in workbook.worksheets:
            for cell in sheet[1]:
                cell.font = openpyxl.styles.Font(bold=True, color="FFFFFF")
                cell.fill = openpyxl.styles.PatternFill("solid", fgColor="1F4E78")
            for row in sheet.iter_rows():
                for cell in row:
                    cell.alignment = openpyxl.styles.Alignment(vertical="top", wrap_text=True)
        workbook.save(path)
