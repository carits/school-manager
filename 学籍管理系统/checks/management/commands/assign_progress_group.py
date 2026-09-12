from collections import Counter
from pathlib import Path

import openpyxl
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from checks.models import Batch, Student
from checks.services import audit


def clean(value):
    if value is None:
        return ''
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    return str(value).strip()


class Command(BaseCommand):
    help = 'Assign students from a class-and-name workbook to a separate public progress group.'

    def add_arguments(self, parser):
        parser.add_argument('path')
        parser.add_argument('group', choices=['benbu'])
        parser.add_argument('--apply', action='store_true')

    def handle(self, *args, **options):
        path = Path(options['path']).resolve()
        if not path.is_file() or path.suffix.lower() != '.xlsx':
            raise CommandError('The supplied .xlsx file does not exist.')
        batch = Batch.objects.filter(active=True).first()
        if not batch:
            raise CommandError('There is no active batch.')
        try:
            workbook = openpyxl.load_workbook(path, read_only=True, data_only=True)
            sheet = workbook.active
            rows = sheet.iter_rows(values_only=True)
            headers = [clean(value) for value in next(rows, ())]
            class_index = headers.index('班级编号')
            name_index = headers.index('姓名')
        except (ValueError, OSError, KeyError) as exc:
            raise CommandError('工作簿必须包含“班级编号”和“姓名”两列。') from exc
        pairs = []
        for row_number, row in enumerate(rows, 2):
            class_name = clean(row[class_index] if class_index < len(row) else '')
            name = clean(row[name_index] if name_index < len(row) else '')
            if not class_name and not name:
                continue
            pairs.append((row_number, class_name, name))
        workbook.close()
        duplicates = [pair for pair, count in Counter((c, n) for _, c, n in pairs).items() if count > 1]
        matches = []
        anomalies = []
        for row_number, class_name, name in pairs:
            query = Student.objects.filter(batch=batch, class_name=class_name, name=name)
            if not class_name or not name:
                anomalies.append(f'第 {row_number} 行：班级或姓名为空')
            elif query.count() != 1:
                anomalies.append(f'第 {row_number} 行：{class_name} {name} 匹配到 {query.count()} 人')
            else:
                matches.append(query.get().pk)
        if duplicates:
            anomalies.append('名单存在重复班级和姓名：' + '、'.join(f'{c} {n}' for c, n in duplicates))
        self.stdout.write(f'名单 {len(pairs)} 人，精确匹配 {len(matches)} 人，异常 {len(anomalies)} 项。')
        for anomaly in anomalies:
            self.stdout.write(anomaly)
        if anomalies:
            raise CommandError('存在异常，未修改任何学生分组。')
        if not options['apply']:
            self.stdout.write('预览通过；添加 --apply 后写入。')
            return
        with transaction.atomic():
            Student.objects.filter(batch=batch, progress_group=options['group']).update(progress_group='regular')
            updated = Student.objects.filter(batch=batch, pk__in=matches).update(progress_group=options['group'])
            audit('system', '设置进度名单分组', batch.pk, {'group': options['group'], 'count': updated})
        self.stdout.write(self.style.SUCCESS(f'已将 {updated} 名学生设为 {options["group"]} 分组。'))
