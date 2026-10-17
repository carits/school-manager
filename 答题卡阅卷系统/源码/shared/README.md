# 共享模型与计算说明

## 职责

前后端共用题卡模型、评分规则、排名、进度结构及模板校验。

## 文件导航

| 文件 | 职责 |
| --- | --- |
| [types.ts](./types.ts) | 公共类型与业务数据结构 |
| [legacyPdf.ts](./legacyPdf.ts) | 自定义扫描模板与客观题计分 |
| [externalTemplate.ts](./externalTemplate.ts) | 外部模板相关逻辑 |
| [examPdfProgress.ts](./examPdfProgress.ts) | 扫描批次进度类型 |
| [ranking.ts](./ranking.ts) | 排名计算规则 |

## 修改与验收

公共结构变化要同步检查界面、接口、数据库映射与导出。题号、满分、多选规则和缺分状态应从统一模型读取，避免前后端各算一套。

具体构建和隔离回归命令见项目根目录“使用说明/开发与测试说明.md”。
