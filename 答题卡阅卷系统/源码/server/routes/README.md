# 业务接口说明

## 职责

按登录、考试、分配、阅卷、成绩与导出组织接口，调用服务层完成业务操作。

## 文件导航

| 文件 | 职责 |
| --- | --- |
| [review.ts](./review.ts) | 教师阅卷和管理员进度 |
| [review-assign.ts](./review-assign.ts) | 题块分配 |
| [review-tasks.ts](./review-tasks.ts) | 独立阅卷任务接口 |
| [legacy-review-groups.ts](./legacy-review-groups.ts) | 旧版合并题块接口 |
| [export-scores.ts](./export-scores.ts) | 成绩工作簿导出与限时下载 |

## 修改与验收

新增接口同时检查登录、考试范围、教师分配、媒体权限及请求参数。写操作成功后再返回结果；接口错误不能被前端伪装为已保存。

具体构建和隔离回归命令见项目根目录“使用说明/开发与测试说明.md”。
