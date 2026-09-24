# 延迟服务核对

独立的延时服务手机信息核对系统。家长使用姓名、身份证号和验证码登录，只核对联系电话，不要求签字；手机号有误时可以修改。班主任通过 `/yanchi/progress/` 按班级查看完成情况、未完成名单和手机号有误名单。

## 导入真实名单

服务器上执行：

```bash
python manage.py migrate
python manage.py import_intentions /path/to/延时服务参加意向收集表_按班级填写.xlsx --title 延时服务手机核对
```

真实 Excel、`.env`、数据库和导出文件不得提交到 GitHub。

## 部署

使用 `deploy/compose.yml`，服务仅绑定服务器回环地址，再由 Nginx 配置 `/yanchi/`。学籍系统 `/xueji/` 与本系统使用不同数据库、Session 和容器。停用学籍系统时只停止对外 Web 服务，保留数据卷和备份。
