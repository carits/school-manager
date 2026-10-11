# Linux 答题卡批阅系统

这是 `school-manager` 下独立的答题卡设计、PDF 识别和教师批阅服务，对外路径为 `/answer-card/`。

## 本地开发

```bash
npm ci
npm run typecheck
npm run build
npm run server
```

本地默认使用 SQLite；需要 MariaDB 时设置 `PROJECTX_MARIADB_HOST`、`PROJECTX_MARIADB_USER`、`PROJECTX_MARIADB_PASSWORD` 和 `PROJECTX_MARIADB_DATABASE`。

## Linux 原生识别器

需要 OpenCV 4.13、CMake 和 nlohmann-json：

```bash
npm run native:build:linux
```

服务端只使用 `resources/native/linux-x64/answer-card-recognizer`，不包含 Windows 扫描端、TWAIN 或 `.exe/.dll` 运行时。

## PDF 批阅

服务端使用 Poppler 的 `pdfinfo` 和 `pdftoppm` 校验、分页并渲染 PDF，前端上传原始 PDF，不在浏览器中转换。主要接口：

- `POST /api/cards/:cardId/submissions/pdf`
- `GET /api/grading/jobs/:jobId`
- `GET /api/grading/jobs/:jobId/events`
- `POST /api/reviews/:submissionId/answers/:itemId`
- `GET /api/grading/jobs/:jobId/export`

## Compose 部署

```bash
cp .env.example .env
# 设置两个数据库密码
docker compose -f compose.yml up -d --build
```

Nginx 使用 `deploy/nginx-location.conf`，监听本机 `5176`，不会改动学籍系统的 `/xueji/` 路由。

首次启动会创建空数据库和管理员。教师可用 `npm run import:teachers -- teachers.xlsx` 导入，账号密码只在终端输出，不写入仓库。
