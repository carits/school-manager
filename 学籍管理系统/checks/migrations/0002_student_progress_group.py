from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [('checks', '0001_initial')]

    operations = [
        migrations.AddField(
            model_name='student',
            name='progress_group',
            field=models.CharField(db_index=True, default='regular', max_length=32, verbose_name='进度名单分组'),
        ),
    ]
