# 学籍信息核对

独立 Django 系统。家长入口 `/xueji/`，工作台 `/xueji/manage/`，账户管理 `/xueji/admin/`。

当前生产入口为 `https://carits.top/xueji/`。活动批次为“2026级新生学籍核对（735人）”，由 `F:\xueji\中雅实验学校_仅保留735人.xlsx` 生成并于 2026-09-11 导入。旧的 5 条虚构演示记录保留在非活动批次，不参与家长身份匹配。

## 已确定的字段规则

`assets/template.xlsx` 是用户提供的原模板；`assets/schema.json` 保存准确的列名和下拉选项。86 列均保留在导出中。25 个星号字段中，学籍流水号不展示，家长端可见的 24 个星号字段必须逐项核对；班级只读，全国学籍号和其余 22 个星号字段由家长直接核对或修改。另有 60 个非星号项目，允许保持空值。

分组：学生身份 15 项、学籍及在校情况 17 项、户籍与住址 27 项、成员一信息 13 项、成员二信息 13 项。家长逐项选择“已确认”或“未确认”，星号项目的最终值必须满足必填和格式校验，非星号项目可以留空。老师维护班级，家长提交的其他更正直接生效。提交后家长可从结果页主动进入新一轮核对，历史提交和签名不删除；再次提交前，最终导出继续采用最近一次已提交值，不采用未提交草稿。

## 演示使用

- 姓名：演示学生甲、演示学生乙、演示学生丙、演示学生丁、演示学生戊。
- 对应证件号码：`DEMO2026001` 至 `DEMO2026005`，证件类型为“其他”。
- 乙的现住址为空、丙的全国学籍号为空，用于家长补全测试。
- 所有号码及地址均为虚构。演示模式拒绝上传外部名单。
- 管理员账号由 `bootstrap_admin` 生成，随机密码只写入私有凭据文件。

公网 HTTP 演示期间，管理路径拒绝公网访问。Windows 运行 `open-admin.ps1`，通过 SSH 隧道打开本机 `http://127.0.0.1:18091/xueji/manage/`。该隧道要求本机现有 SSH 密钥。服务器管理员凭据见交付的私有 `deployment-admin.txt`；`credentials.txt` 仅供本地开发。不要将凭据提交到 Git。

## 本地开发

Python 3.12。创建虚拟环境后安装 `requirements.txt`，执行：

```text
python scripts/init_local.py
python manage.py migrate
python manage.py collectstatic --noinput
python manage.py seed_demo
python manage.py bootstrap_admin --credential-file credentials.txt
python manage.py runserver 127.0.0.1:8091
python manage.py test checks
```

所有密钥均独立生成，禁止使用 OJ 密钥。SQLite 仅供本地开发；服务器使用独立 PostgreSQL 容器。

## 服务器部署与回滚

服务器目录 `/opt/student-check`。独立 Compose v2 位于 `bin/docker-compose`，不替换系统 Docker 或 Compose。

以下服务器部署与备份命令以 root 执行（通过现有 `ecs-user` 的 sudo），密钥与备份目录只允许 root 读取。

1. 执行 `deploy/preflight.sh`：验证至少 4 GiB 空间，备份 OJ 数据库和 Nginx，并验证校验和及 PostgreSQL 归档目录。
2. 执行 `deploy/init_env.py` 创建权限为 600 的独立 `.env`。
3. `docker build -t student-check-web:1 .`；`bin/docker-compose up -d db`。
4. `bin/docker-compose run --rm web python manage.py migrate`，再执行 `seed_demo`。
5. `bin/docker-compose up -d web`，确认 `/xueji/health/` 返回正常。
6. 以 root 执行 `deploy/enable_nginx.py`；脚本检查配置并平滑重载，失败自动恢复配置并停止新 Web 服务。
7. 验证 OJ 根目录仍跳转到登录页，OJ API 和评测进程仍正常。

后续发布先备份，再构建新的镜像标签。保存上一版本标签和环境文件；出错时切回上一镜像，使用匹配的数据库备份处理不兼容迁移。首次部署的 Nginx 配置副本在 `backups/nginx-before-*.conf`。撤下系统时恢复对应 Nginx 配置、执行 `nginx -t` 后平滑重载，停止本项目容器；不要使用 `down -v` 删除数据库。

## 正式上线

当前采用 Let’s Encrypt 为 `carits.top`、`www.carits.top` 和公网 IP 签发的受信任短期证书，`student-check-cert-renew.timer` 每日检查续期。正式数据上线需要完成：

1. 使用当前 `https://carits.top/xueji/`，并保持域名证书和自动续期正常。
2. Nginx 保持 HTTP 到 HTTPS 跳转及现有 OJ 路由。
3. `.env` 设置正确的 `PUBLIC_URL`、`HTTPS_ENABLED=1`、`DEMO_MODE=0`，并同步 `ALLOWED_HOSTS`。
4. 重建 Web 容器以加载配置，运行 `python manage.py check --deploy`，验证 Secure Cookie、证书、导入权限和 HTTP 重定向。
5. 管理员上传真实名单，先预览再确认导入。每次导入创建独立批次；内容重复、流水号重复、身份重复及公式或数值型号码会拒绝导入。
6. 检查名单并设为当前批次，补齐班级。重新下载二维码，用实际手机及微信扫码验证，再发给家长。

没有 HTTPS 时配置校验禁止启动正式模式。二维码只编码固定入口，不编码姓名、证件号或登录凭据。

## 导入导出

只接受原模板的 `新生1` 工作表及完整列顺序。单批次最多 5000 人，上传最大 10 MB。姓名、证件类型、证件号、学籍流水号不能为空。其他星号项可以暂缺，由家长或老师补齐。身份证、学籍号等必须为文本格式，防止 Excel 先行丢失精度。

后台批次卡片可直接下载“学校自行核对表”，包含当前批次全部学生、完整 86 列及系统当前采用的学校/家长数据。“学籍最终数据”同样保留全部 86 列、隐藏字典页和数据验证；民族、户口所在地、现住址、成员一户口所在地等字段保留 Excel 下拉选项。家长端这些字段使用可搜索下拉列表，只能选择模板字典值。“家长修改明细”含历次提交的原值、新值和学校问题说明。“未完成名单”包括未开始、核对中及重新开放后未再次提交的学生。所有导出字符串强制文本类型，防止公式注入。

学校基本情况汇总表可通过 `python manage.py enrich_active_batch <文件> --report <报告文件>` 先做只读预检，确认后增加 `--apply`。默认仅填补当前批次的空字段，要求姓名和学生身份证号精确匹配，不覆盖已有值或已经开始核对的学生；学校明确确认汇总表学生身份证号为准时，可增加 `--trust-student-id`，按唯一姓名更新已变化的登录证件号及对应性别、出生日期。不符合模板选项、格式异常及源表明确标注“可能失真”的父母身份证号均写入脱敏异常报告。2026-09-11 已从“2026年秋季学生基本情况信息汇总 (2).xlsx”向全部 735 名学生补充可靠字段，并以该表学生身份证号更新登录凭据。

学校下载“自行核对表”并离线修复地址后，可执行 `python manage.py apply_school_fixes <文件> --report <报告文件>`，确认预检后增加 `--apply`。该命令按姓名和学生身份证号精确匹配，只覆盖六项地址字段：户口所在地、现住址、成员一户口所在地的行政区划和具体地址；已经开始核对的学生默认整行跳过，确认学校修复必须覆盖时增加 `--allow-started`。直辖市简写会转换为模板字典选项，例如“北京市海淀区”转换为“北京北京市海淀区”。2026-09-11 已应用 v2 修复表，735 名学生六项地址字段与学校修复版完全一致。

姓名和班级作为管理检索字段保存；整行原始数据、学校维护值、草稿、提交及操作详情以 Fernet 认证加密保存。身份查询使用独立 HMAC-SHA256 密钥。公开页面显示证件号的脱敏值，认证后的家长可主动展开。

## 备份和运维

`deploy/backup.sh` 备份数据库和 `.env` 密钥、校验归档并清理过期 Session、预览及限流计数。`student-check-backup.timer` 每日服务器时间 03:20 执行，保留约 7 天日备份。首次 OJ 备份不参与轮转。

`deploy/restore_drill.sh <database.dump>` 将备份恢复到独立的演练数据库，验证学生记录能解密，再删除演练库。绝不覆盖运行数据库。数据库备份必须与加密密钥一起保管。当前备份存于同机，另行复制到学校受控的异地存储可覆盖整机丢失风险。

服务有容器健康检查、异常重启和日志轮转。Web 限制为 512 MB/0.75 CPU，数据库为 256 MB/0.4 CPU。`bin/docker-compose ps` 查看状态；`journalctl -u student-check-backup.service` 查看备份结果。日志不应输出表单正文和证件号。

## 验证

单元与集成测试：`python manage.py test checks`。浏览器验收脚本 `scripts/ui_qa.cjs` 使用本地独立测试会话及虚构学生，检查手机布局、五步表单、提交与后台。服务器演示负载命令 `python manage.py load_demo` 创建 50 个临时虚构学生和会话，并发读取和保存草稿，校验完成后只清理本次测试记录。
