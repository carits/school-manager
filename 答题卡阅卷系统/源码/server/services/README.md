# 业务服务说明

## 职责

保存导入、切图、身份与选项处理、分配、评分、汇总及人工智能建议等核心逻辑。

## 文件导航

| 文件 | 职责 |
| --- | --- |
| [LegacyPdfService.ts](./LegacyPdfService.ts) | 原件、批次、模板、识别状态与主观题生成 |
| [LegacyPaperSerialService.ts](./LegacyPaperSerialService.ts) | 稳定流水号与原答卷关联 |
| [LegacyReviewGroupService.ts](./LegacyReviewGroupService.ts) | 合并题块范围、队列、图片和评分流程 |
| [LegacyReviewGroupScoreService.ts](./LegacyReviewGroupScoreService.ts) | 合并正式总分与历史小题的汇总口径 |
| [AiScoreSuggestionService.ts](./AiScoreSuggestionService.ts) | 单题参考分、理由、输入摘要和采用记录 |
| [ReviewService.ts](./ReviewService.ts) | 通用阅卷业务 |

## 修改与验收

正式分与建议分分开保存；空值与零分严格区分；不得把旧小题历史分和合并总分重复相加。重试与并发操作需要保持评分历史和审计一致。

具体构建和隔离回归命令见项目根目录“使用说明/开发与测试说明.md”。
