# 旧答题卡 PDF 工作流

本次只替换 /answer-card/ 旧页面及其独立 API，review 继续由原生产容器、数据库和原静态资源承接。使用同机独立旧模块数据库是为了防止旧阅卷修改影响 review 账号、评分和任务。用户已授权直接替换旧入口，取消8443验收入口。所有开发、构建和部署均在服务器完成。

- 实施源码：/home/ecs-user/school-manager-answer-card-legacy-preview，分支 codex/legacy-custom-pdf。最初历史源码快照提交 a660e12，基于 6b57ade07e81 和原未提交文件；受保护 review 源码在该快照中原样保留。
- 原服务源码：/home/ecs-user/school-manager-answer-card。共享构建配置默认不启用旧模块私有 API；旧构建显式设置 VITE_LEGACY_ONLY=1。
- 旧运行容器 legacy-old-app，127.0.0.1:5180；数据库 legacy-old-db/school_manager_legacy。拒绝连接生产数据库。
- 状态/凭据：原目录 answer-card/deploy/legacy，目录700、环境文件600；不入Git。独立文件卷和两个专用Docker网络。DB网络 internal；外网侧为发布HTTP端口所需，环境没有外部服务凭据，AI/微信/清理任务关闭。
- 旧登录 Cookie legacy_old_auth_token，独立 HOME 会话目录；退出、改密只作用于旧库。账号快照含759个账号，16班、715条学生关联、1旧卡；旧库原有考试0、成绩0。初始密码字段和外部凭据不复制。
- 资源：app .8CPU/1088MiB，db .15CPU/384MiB，保护服务 .05CPU/64MiB；合计1CPU/1.5GiB。识别单工作线程，OpenCV/Tesseract线程1。构建临时停止旧app并限制资源，受保护服务保持运行。容器日志有上限，旧PDF目录8GiB保护。

## 使用

/answer-card/custom-pdf/ 依次完成模板、扫描与确认、主观题阅卷、成绩汇总。
上传原模板PDF或标准ZIP（根目录 answer_card.pdf/template.json），可另选配置JSON。拖框配置四定位点、二维码/条码/考号/OCR身份区、选项及主观题区域，跨页主观题添加多个区域。坐标以应用PDFRotate后的页面左上角归一化保存。
发布版本不可编辑；修改用“复制为新版本”。原设计卡上传PDF时冻结对应卡版本，包括明确的原多选规则。
创建考试时指定班级；扫描PDF永久按SHA256保存，批次绑定发布版本，同考试同版本同PDF返回原批次。扫描顺序生成候选页组，管理员必须人工确认所属学生和页组；冲突、缺页、重复页、定位失败不允许生成任务。
低置信、空白、多涂、缺答案进入人工处理；重识别只更新auto，不覆盖已确认final。管理员明确生成主观题任务后，按题给教师分配份数，教师领取并输入分数提交。跨页图动态裁切缓存。全部确认和评分完成后才能发布或导出Excel，缺项保持null。

语文第七周PDF和配置导入为草稿：2页19题，标准答案未填写者须校对补齐；未自动发布或拿扫描结果当最终成绩。PDF版式和区域应在页面预览中核对后发布。

## 构建和回退

python3 answer-card/deploy/legacy/build.py
python3 answer-card/deploy/legacy/runtime.py
仅在其他生产部署结束、review实际登录与API路径验证完成后运行 switch.py --switch。它保留原 /answer-card/api、review、assets 和此前生产 legacy-assets 路由，只有旧页面/legacy-api转5180。nginx -t通过后平滑reload。
回退：switch.py --rollback，要求Nginx仍与本次切换后的校验值一致，否则拒绝覆盖并发改动。回退只恢复入口；需要停旧服务用 docker stop legacy-old-app，绝不重启生产容器。

保护服务 school-manager-legacy-guard 每30秒检查review HTTP、内存和磁盘。新增5xx、连续三次慢于基线2倍且>500ms、可用内存<800MiB、磁盘余量<8GiB时暂停旧识别；守护状态过期90秒也暂停。构建脚本同样检查保护状态。该限额不保证同机零性能波动。

## 数据迁移与验收

schema.sql 只创建 legacy_pdf_* 表，由 PROJECTX_LEGACY_ONLY=1 启动时在私有库执行。snapshot-summary.json是脱敏迁移统计；完整SQL、关联清单、原源码差异和校验值留在权限700状态目录。排除 review_task_*、问卷、会话、外部订阅/凭据；本次引用文件0、缺失0。
模板页方向可保存为0/90/180/270度；只旋转派生参考图，原PDF摘要不变，导出ZIP保留方向设置。实际语文原稿两页均180度，四角定位点已校准；身份/选项和主观区域仍需按预览核对，答案由老师补齐。

test-setup.cjs/test-flow.cjs仅允许在私有容器执行；生成随机私有测试账号，覆盖46项已验证的流程与隔离检查：重启恢复、前导零、A3旋转、非连续题号、跨页裁切、完全/部分分、人工确认、缺答案、缺页、定位失败、重复上传/生成/评分、双教师分配和权限、改分审计、发布门禁、原PDF摘要、Excel一致。native-test.cjs验证A4原设计卡兼容。browser-test.cjs通过真实Chromium验证界面。测试数据上线前清理，生产身份/阅卷数据不导入、不修正。

## 部署完成记录

2026-10-13 已在另一任务完成 review 部署后切换旧入口。公开旧首页、自定义 PDF 和 review 浏览器检查通过；旧页请求独立 legacy-api，review 请求原 api，均无脚本错误。deployment.json 保存镜像、源码版本、资源限制、快照统计、保护校验和回退命令。

切换前后受保护容器 ID、镜像、启动时间、review 页面资源及保护源码校验值一致。只改 Nginx 旧页面与独立 API 路由并平滑重载，没有替换或重启保护容器。临时浏览器及测试账号/考试/批次已清理，保留真实语文草稿和不可变原件。

主机内核不支持额外的 swap 限制，容器内存上限已设置，保护服务持续监控主机可用内存。四个继承的 Docker/native 基线未提交文件原样保留，本次限额构建没有使用这些文件。

2026-10-13 补充：旧「答题卡设计」列表同时显示自定义 PDF 草稿/发布模板与缩略图；点击卡片深链到对应配置。英语原版（61题100分）和语文清晰原版（21题120分、作文排除灰色禁答区）已由 admin 上传。旧扫描版草稿保留，未删除。新模板标准答案留空。gallery 的真实浏览器点击、图片与模板选择检查通过；仅替换 legacy-old-app 镜像，review容器、源文件和Nginx未改。见 pdf-gallery-deployment.json。

### Grade 7 monthly exams (2026-10-13)

Created the Chinese (120 points) and English (100 points) formal exams under admin and associated them with the Grade 7 Week 7 monthly exam group. Both use the published original PDF templates and a frozen roster of 715 students in all 16 Grade 7 classes. Standard answer keys remain pending. The PDF bridge now preserves the template subject, including English. See monthly-exams-deployment.json for identifiers and verification. Only the legacy runtime was rebuilt; the protected review container was not recreated.

### Custom PDF scrolling and normal confirmation

The standalone PDF page now scrolls within the viewport. Bulk normal confirmation saves eligible identity bindings and normally recognized objective results independently, lists each remaining exception, and preserves confirmed/manual answers. Missing keys keep scores null. Duplicate identities, low-confidence identities, missing pages and incomplete grading still block finalization. The regression script uses temporary records in the independent legacy DB and removes them. A duplicate upload of the existing scan reused its batch and created no template. See scan-fix-deployment.json.

### Custom PDF gallery versions

PDF publications use internal native cards to bind legacy exams. The gallery now displays the PDF tile once and hides the internal card using the explicit template card reference. It defaults to the latest version in each PDF family, while a history toggle keeps older versions accessible. Native designer cards and independent draft templates remain available. No database records, scan references or exam bindings were removed. See gallery-dedup-deployment.json for verification.

### Subjective task generation feedback

The legacy batch view now displays pending identities/ownership, page problems, unconfirmed objective answers and missing scores beside the generate button. Missing batch scoring keys have a direct editor link; pending papers have confirmation links. A request displays a busy state and its success or failure inline. The preflight is read-only and the server keeps its transaction validation. The existing Chinese batch remains unchanged and blocked until confirmation and scoring keys are complete. See generation-feedback-deployment.json for live-browser verification.

### Exam answers and one answer card per template family

Standard scoring keys are now saved by exam in legacy_pdf_exam_keys. The existing reference-answer editor synchronizes valid objective option strings within its transaction only in the legacy runtime; incompatible reference text remains visible but cannot supply a guessed score. An exam-specific scoring editor is available before scans are uploaded. Saving keys never clones a template, changes its PDF, or changes an exam's card binding. Confirmed answer values are preserved and audited scores are recomputed; missing keys keep scores incomplete.

The gallery, template selector and scan selector share one family grouping. Historical and archived records do not count as new cards. Internal native cards for archived/historical custom PDF versions are omitted from the normal card list; direct record access and history remain available. The unused Chinese scanned draft and the English answer-bearing transition version are archived. English exam 22 was restored to its original v1 card after moving all 45 objective keys to the exam, with 61 reference answers and the 715-student roster preserved. No template definitions, original PDFs or scan identities/final answer values changed. All work and tests were performed on the server. See exam-keys-deployment.json and exam-key-schema.sql.


2026-10-13 confirmation correction: objective selections are accepted and scored from recognition without mandatory per-question review. Blank and single-choice multi-fill receive zero when a key exists; missing keys remain unscored. Recognition status and original values remain visible, and existing human edits are preserved. Identity/page ownership checks, roster/duplicate checks, and stale-version protection remain enforced. Answers can be edited after subjective tasks exist without moving their ownership; resulting question scores and incomplete totals are updated transactionally. The confirmation panel displays progress, success and errors beside the button. Repeated identical confirmation does not change record versions. Only the isolated legacy runtime is deployed.


### 选择题识别 v2（2026-10-13）
采用纸面亮度校正、模板印刷掩膜、受限局部对齐和分布检测；身份识别不变。
真实样本 53 份 / 2385 题，30 份校准、23 份验证；详见 objective-v2-acceptance.json。
原件、模板、身份及教师评分不随选择题重新识别改变。疑似擦痕自动采用候选，允许人工修改，无强制复核。
重新识别入口 POST /api/scan-batches/:id/reprocess-objective；进度在批次查询 objectiveRun。
任务按页持久保存派生输出，最终事务提交；人工和未知历史答案不覆盖，自动结果重算时撤销已有发布。
迁移工具 objective-v2-migrate.cjs 必须在 legacy-old-app 内执行，拒绝生产数据库。
回退工具 objective-v2-rollback.cjs 默认只预览；OBJECTIVE_RUN_ID 指定任务，APPLY_ROLLBACK=1 才执行。
回退只恢复仍处于该任务写入版本的自动答案，保留后续人工修改及教师评分，不自动发布成绩。
独立实例备份位于私有 data/objective-v2-before.json，原镜像见 objective-v2-runtime-before.json。
构建脚本 objective-v2-build.py 包装实际 resources/legacy-worker.py，复用已安装原生识别器。

## Authorized Chinese 19-question replacement and QR assistance

`chinese-replace-19.ts` targets only legacy-old-db/school_manager_legacy and exam 21. It requires a private consistent backup, rendered authoritative PDF, and completely staged 86-page recognition; it rejects stale page/result/identity versions or existing teacher tasks/scores. One database transaction replaces the PDF within the original logical card, preserves the original scan and identities, archives obsolete layout results in audit, updates 19 questions/120 points and final DOCX reference answers, and rescales compatible objective answers. The prior PDF version remains historical. Full private source backups and staged files remain under the server state directory, outside Git.

37 compatible historical answers have protected provenance; 9 disagree with new recognition and were deliberately retained for optional correction. These are not scored as teacher results. No final grade is published while subjective items are incomplete. The original PDF and all student bindings are unchanged.

QR assistance is separate from identity QR recognition. The template editor can frame a complete printed QR code, save or clear it on either draft or published PDFs, and shows it in magenta. Settings have an audited revision and do not modify the immutable PDF definition or create a card/version. A new scan batch freezes the settings; existing batches freeze settings on their first subsequent page recognition. Settings edits never automatically rerun or modify prior results. Four corner markers remain mandatory; a detected QR validates the corner-derived position, disagreement rejects that candidate, and an unreadable QR falls back to four corners. A QR cannot rescue missing markers. Administrator/grade-leader access, rectangle validation, actual blank-PDF QR detection, stale-revision rejection, and idempotent save are enforced.

Only the Chinese PDF has been configured. The English PDF has no QR and remains unchanged.

## Per-paper front/back correction

On the scan batch confirmation screen, a two-page student paper offers “交换本卷正反面并重新识别”. The operation requires a current paper version and both page versions, swaps both roles in one transaction, retains the original source page numbers/files and student binding, invalidates derived alignment and ownership confirmation, clears only automatic final answers for recalculation, and preserves manual or unknown-provenance finals. Existing subjective tasks on that paper block the operation; tasks on other papers do not. An active batch job or other pending pages blocks a conflicting swap. A persistent request UUID in the audit prevents retries or double clicks from swapping twice, including after recognition completes. Scan jobs resume through the existing durable job mechanism. Pending recognition blocks final publication; changed scores withdraw publication. No template/card version is created.

The endpoint is administrator/grade-leader only:
`POST /api/scan-batches/:id/papers/:paper/swap-faces`
with `requestId`, `version`, and `pages: [{id,version},...]`.

`face-swap-test.cjs` creates a temporary two-page test exam using referenced original scan files and cleans only its own records/files after acceptance. Run when user recognition work is idle; `face-swap-resume.cjs` resumes validation of the private fixture if the test was interrupted while waiting for the worker queue.

## Swap queue priority and performance diagnosis (2026-10-13)

Scan jobs dispatch one page at a time with concurrency one. A face swap persists priority 100 and an urgent-paper list in the existing batch job. It yields only after the current page commits, processes the corrected paper ahead of ordinary pending pages, then resets priority and resumes ordinary work. Objective-only jobs persist staging progress and yield between pages to urgent scan jobs; their final batch commit remains atomic. Swapping a ready paper is allowed while other papers in its batch are pending; the target paper itself must not be processing. Active objective jobs and existing subjective tasks for the target paper remain protected. Startup recovers queued/running jobs without losing priority. No template revision is generated.

Performance diagnosis used read-only production job/audit aggregates and disposable rendering files inside the old container. At measurement there were 25 queued jobs, one running job and 2,184 remaining pages. 119 recent recognition intervals averaged 8.40 seconds/page (median 8, p90 9). The app reached its 0.8 CPU limit; available host memory was about 2.3 GiB and disk about 15 GiB. The resource guard reported protected review latency about 22 ms and no pause.

An English front-page rendering experiment used the existing 150-DPI grayscale settings. Current pdftoppm PNG rendering consumed 5.333 CPU seconds (13.612 seconds wall time during live queue contention). Rendering grayscale PGM and converting via OpenCV PNG compression level 1 consumed 0.262 CPU seconds (0.676 wall seconds), with every decoded pixel equal to the current cached page. Direct embedded-JPEG extraction consumed 0.183 CPU seconds, but differed by mean 5.041 gray levels and was rejected for production use. These are single-page experiment results, not a promised whole-batch speedup.

## Subjective-first PDF processing (deployed 2026-10-14)

The initial upload stage saves the immutable original, renders lossless 150-DPI grayscale pages, aligns pages and matches roster identities. It never detects objective selections. Identity and page ownership confirmation no longer need objective answers or keys. Generate all ready papers, or select individual papers: generation commits per paper and reports newly generated, existing and skipped papers with reasons. Other incomplete/conflicting papers do not block a ready paper.

A single scheduler owns durable legacy_pdf_stage_jobs. Correction/swap pages have priority 300; initial page/identity work 200; objective work 10. Each page commits progress before scheduling again. Jobs persist fingerprints, algorithm/version, FIFO sequence, attempts, lease, progress and errors. The previous batch job remains a compatibility projection and handles explicitly requested atomic objective reprocessing; its old scan executor is removed. Resource pauses stop all new claims. Existing completed pages/results/teacher tasks are retained; pending scan pages are migrated to preprocessing. Existing objective reprocessing progress remains durable.

Default objective mode is background_auto, triggered only after the paper has subjective tasks. Manual mode stays stopped until explicitly started. PUT /api/scan-batches/:id/objective-mode accepts {mode:background_auto|manual}; POST /api/scan-batches/:id/objective-control accepts {action:start|pause|resume}. Pause finishes the current page but claims no next page. Normal first recognition commits per paper; explicit batch reprocessing keeps its all-pages atomic commit. Manual blanks, manual and unknown historical answers are protected; current teacher scores are re-read in the commit transaction. Answer key edits rescore without image recognition. Changed grades withdraw publication; incomplete totals remain NULL and cannot be exported/published. Score submission distinguishes the current question totalScore from nullable paperTotalScore.

Custom scans require an exam binding. All 16 Chinese and 14 English uploaded batches were verified against their respective existing monthly exams (21/22), with no binding changes necessary. The PDF management page now has no separate teacher marking UI: it links directly to /answer-card/exam-manage?examId=... after exam authorization. A unique matching exam is automatically selected for new uploads. PUT /api/scan-batches/:id/exam accepts examId and expectedExamId to reassociate to an exam using the same logical PDF card/template. The transaction preserves originals/page geometry/final answers, uses the target exam keys, moves compatible objective score records and unclaimed/unscored crop references, invalidates dependent pending work and audits the transition. Conflicting roster/duplicate score records or teacher claims/scores/assignments reject the move rather than silently overwrite them. Existing teacher work stays in its original exam; no protected review tasks are moved. The lazy crop image endpoint resolves the current PDF crop after authorization instead of trusting a not-yet-generated cache placeholder; ungraded block maximums come from the bound immutable template, and score history includes reviewer/round metadata. Generated legacy_pdf crops use the existing exam online review pool, permission/assignment system, images and score submission. Reassociation requires same-template compatibility; it does not create a card, a PDF version or a new exam. Administrators assign teachers in Exam management -> exam -> online review -> assignments. Teachers use the corresponding exam to claim and score. The separate /answer-card/review/ application and review_task_* database remain protected and untouched.

Rendering uses pdftoppm grayscale PGM then lossless PNG compression 1. One persistent Python worker caches templates/print masks by file hash, short-circuits identity methods after a unique roster match and reports render/alignment/identity/objective timings; confirmed correction binding avoids repeated identity OCR. Resolution and objective algorithm thresholds are unchanged. Worker failure recovers from durable tasks.

Acceptance artifacts:
- subjective-first-render-acceptance.json: eight real Chinese/English pages pixel/choice equality; preprocessing omits objective detection.
- subjective-first-template-acceptance.json: both templates, A3/A4 and four rotations.
- subjective-first-api-acceptance.json: real multipart upload, partial-batch generation without keys, same-template reassociation/target-key rescore and stale/teacher-work protection, two-teacher claims/scoring, pause/resume, manual/unknown answer and teacher-score preservation, rescore without re-recognition, incomplete export rejection and completed Excel consistency.
- subjective-first-recovery-acceptance.json: restart retains task ID/input/progress/pause and teacher/manual results; no duplicate tasks.
- face-swap-acceptance.json: urgent page-boundary preemption, correction-only preprocessing, original references/manual results/other-paper teacher marks protected.
- subjective-first-duplicate-acceptance.json: concurrent identical upload creates one batch and one preprocessing task per page.
- subjective-first-benchmark.json: same four source pages and the same 0.8 CPU/1088 MiB app limit, old one-shot worker versus new persistent worker; selected options identical. About 22.38 seconds old versus 5.49 seconds new for render+complete recognition. Initial preprocessing totals about 4.91 seconds. The API fixture produced its first teacher-ready paper in about 10.6 seconds in the latest complete online-review run including test exam reassociation (6.4 seconds in the initial run), with the existing queue excluded by fixture-only priority. These small-sample measurements are not a whole-batch timing guarantee.

Build and tests run only on the server with the existing combined 1 CPU/1.5 GiB quotas and health guard. Before deployment the retained image school-manager-legacy:before-subjective-first-20261013 and a repeatable-read, 64,888-record snapshot of 12 legacy tables were saved privately under the old service data directory. No credentials/sessions were copied into the snapshot.

subjective-first-rollback.py --check validates the backup and isolated old DB/volumes. Actual rollback stops only legacy-old-app, pauses new objective claims, preserves stage progress and newly created teacher tasks/scores, audits the transition and starts the retained image. It does not restore the old database snapshot over new work. New stage work remains preserved until forward recovery; old scanning is not allowed to reinterpret already preprocessed pages.

See subjective-first-deployment.json for deployed image, protected-service/hash checks and resource readings. Do not apply these migrations or rollback tools to the protected review application/database.

Runtime recovery also retries quota measurements if files disappear during a directory walk, preserves a committed page task when a later projection update fails, and marks early page failures retryable. Unreadable derived page PNGs are regenerated losslessly from the immutable PDF; existing eligible unreadable-cache failures are requeued without touching teacher tasks. The duplicate-upload acceptance additionally covers deliberate corruption of a fixture page cache.
