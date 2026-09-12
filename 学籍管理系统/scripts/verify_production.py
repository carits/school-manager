from django.test import Client
from django.utils import timezone
from checks.models import Batch, Student
from checks.crypto import digest

batch = Batch.objects.get(active=True)
students = Student.objects.filter(batch=batch)
assert not batch.demo
assert students.count() == 735
assert students.values('identity_hash').distinct().count() == 735
for student in students.iterator():
    values = student.original
    assert values.get('B') and values.get('Y')
    assert values['Y'] == 'G' + values['J']
    assert values['D'] == values['J'][6:14]
    assert values['C'] == ('男' if int(values['J'][16]) % 2 else '女')
    assert values['Y'] not in student.original_cipher

student = students.first()
values = student.original
client = Client()
session = client.session
session['captcha'] = {'hash': digest('AB234'), 'time': timezone.now().timestamp()}
session.save()
response = client.post('/xueji/', {'name': values['B'], 'number': values['J'], 'captcha': 'AB234'}, secure=True)
assert response.status_code == 302 and '/xueji/check/1/' in response.url
print('Production validation passed: 735 encrypted student records; identity login passed; no values printed.')
