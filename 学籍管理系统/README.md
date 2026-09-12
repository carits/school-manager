# 学籍管理系统

面向学校新生学籍信息核对工作的独立 Django 系统。家长使用学校登记的姓名和证件号码验证身份，分步核对、补全资料并手写签名；学校管理员负责导入名单、查看进度、处理问题和导出结果。

## 主要功能

- 按原始 86 列 Excel 模板导入和导出，保留工作表、列顺序与字典选项。
- 家长端支持草稿恢复、逐项确认、手机签名，以及保留历史记录的再次核对。
- 班级由学校维护；全国学籍号和其他家长维护字段按必填规则补全或修改。
- 管理端提供导入预览、班级筛选、进度统计、修改历史、重新开放和多种 Excel 导出，包括逐项确认与手写签名。
- 独立保存学校原始值、家长草稿、提交版本和管理操作记录。
- 证件号码使用 Fernet 加密保存，身份检索使用独立 HMAC 密钥。
- 提供按班级查看的无登录进度页面，并支持独立名单分组。

## 仓库数据说明

本目录只包含源代码、静态资源和空白字段模板，不包含学生名单、数据库、家长提交、签名、管理员凭据、服务器环境文件或备份。`assets/template.xlsx` 的“新生1”工作表只有表头；其余工作表是行政区划和字典选项。

## 本地开发

建议使用 Python 3.12：

```powershell
python -m venv .venv
.\.venv\Scripts\python -m pip install -r requirements.txt
.\.venv\Scripts\python scripts\init_local.py
.\.venv\Scripts\python manage.py migrate
.\.venv\Scripts\python manage.py collectstatic --noinput
.\.venv\Scripts\python manage.py seed_demo
.\.venv\Scripts\python manage.py bootstrap_admin --credential-file credentials.txt
.\.venv\Scripts\python manage.py runserver 127.0.0.1:8091
```

打开 `http://127.0.0.1:8091/xueji/`。本地生成的密钥、SQLite 数据库和管理员凭据均已在 `.gitignore` 中排除。

## 测试

```powershell
.\.venv\Scripts\python manage.py test checks
```

测试只使用代码中明确标记的虚构信息。

## Docker 部署

复制代码到独立目录，生成 `.env` 后运行：

```text
docker compose up -d --build
docker compose exec web python manage.py migrate
docker compose exec web python manage.py collectstatic --noinput
docker compose exec web python manage.py bootstrap_admin --credential-file /tmp/admin-credentials.txt
```

生产环境必须设置独立的 `SECRET_KEY`、`DATA_KEY`、`LOOKUP_KEY` 和 `DB_PASSWORD`，并配置 `PUBLIC_URL`、`ALLOWED_HOSTS`、`HTTPS_ENABLED=1`、`DEMO_MODE=0`。Web 端口仅绑定回环地址，由 Nginx 将 `/xueji/` 转发到应用。

## 入口

- 家长入口：`/xueji/`
- 管理工作台：`/xueji/manage/`
- Django 管理：`/xueji/admin/`
- 班级核对进度：`/xueji/progress/`
- 独立名单进度：`/xueji/progress/benbu/`
- 健康检查：`/xueji/health/`
