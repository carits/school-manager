# 浏览器界面说明

## 职责

负责登录后的工作模式、考试列表、答题卡设计、教师阅卷和成绩界面。

## 文件导航

| 文件 | 职责 |
| --- | --- |
| [App.tsx](./App.tsx) | 应用框架、模式路由与可见功能 |
| [pages/LegacyPdfApp.tsx](./pages/LegacyPdfApp.tsx) | 自定义扫描模板、上传、确认与识别处理 |
| [components/GradePanel.tsx](./components/GradePanel.tsx) | 单题评分、保存、回看与图片阅读 |
| [components/ReviewGroupPanel.tsx](./components/ReviewGroupPanel.tsx) | 多小题合并阅卷、整组评分与参考信息 |
| [components/TeacherProgressPanel.tsx](./components/TeacherProgressPanel.tsx) | 管理员教师进度 |
| [util/reviewGroupImageCache.ts](./util/reviewGroupImageCache.ts) | 相邻图片预加载和缓存清理 |

## 修改与验收

界面只把服务端成功响应当成保存完成依据。切换时保持流水号、图片、评分和建议一致；手机滚动、返回重评、缩放和断线重试均需独立检查。

具体构建和隔离回归命令见项目根目录“使用说明/开发与测试说明.md”。
