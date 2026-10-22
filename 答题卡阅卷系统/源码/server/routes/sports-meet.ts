import { Router } from "express";
import { getMysqlDb, type DbAdapter } from "../db";
import { rankSportsScores, teamPointTotals, parseSportsResult, type SportsEntryStatus, type SportsResultKind, type SportsEventKind } from "../../shared/sportsMeet";

const router = Router();
function id(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error("无效的 ID");
  return parsed;
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function json(data: unknown): string {
  return JSON.stringify(data ?? {});
}

async function recalculateEvent(db: DbAdapter, eventId: number): Promise<void> {
  const event = await db.get<{ result_kind: SportsResultKind }>("SELECT result_kind FROM sports_events WHERE id = ?", eventId);
  if (!event) throw new Error("项目不存在");
  const rows = await db.all<{ id: number; class_name: string; result_value: number | null; status: SportsEntryStatus }>(
    "SELECT id, class_name, result_value, status FROM sports_entries WHERE event_id = ?", eventId
  );
  const ranked = rankSportsScores(rows.map((row) => ({ id: row.id, className: row.class_name, result: row.result_value, status: row.status })), event.result_kind);
  for (const row of ranked) {
    await db.run("UPDATE sports_entries SET rank_no = ?, points = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", row.rank, row.points, row.id);
  }
}

router.get("/", async (_req, res) => {
  const db = getMysqlDb();
  const meets = await db.all("SELECT * FROM sports_meets ORDER BY start_date DESC, id DESC");
  res.json({ ok: true, data: meets });
});

router.post("/", async (req, res) => {
  const name = text(req.body?.name);
  if (!name) return res.status(400).json({ ok: false, error: "赛事名称不能为空" });
  const db = getMysqlDb();
  const result = await db.run("INSERT INTO sports_meets (name, start_date, end_date, status, scoring_json) VALUES (?, ?, ?, 'draft', ?)", name, text(req.body?.startDate) || null, text(req.body?.endDate) || null, json({ points: [9, 7, 6, 5, 4, 3, 2, 1] }));
  res.status(201).json({ ok: true, data: await db.get("SELECT * FROM sports_meets WHERE id = ?", result.lastInsertRowid) });
});

router.get("/:meetId", async (req, res) => {
  const db = getMysqlDb();
  const meetId = id(req.params.meetId);
  const meet = await db.get("SELECT * FROM sports_meets WHERE id = ?", meetId);
  if (!meet) return res.status(404).json({ ok: false, error: "赛事不存在" });
  const [events, participants, heats] = await Promise.all([
    db.all("SELECT * FROM sports_events WHERE meet_id = ? ORDER BY schedule_at, id", meetId),
    db.all("SELECT * FROM sports_participants WHERE meet_id = ? ORDER BY class_name, name", meetId),
    db.all("SELECT h.*, e.name AS event_name FROM sports_heats h JOIN sports_events e ON e.id = h.event_id WHERE e.meet_id = ? ORDER BY h.scheduled_at, h.id", meetId),
  ]);
  res.json({ ok: true, data: { meet, events, participants, heats } });
});

router.post("/:meetId/events", async (req, res) => {
  const meetId = id(req.params.meetId);
  const name = text(req.body?.name);
  const kind = (text(req.body?.kind, "track") || "track") as SportsEventKind;
  const resultKind = (text(req.body?.resultKind, kind === "track" || kind === "relay" ? "time" : "distance") || "time") as SportsResultKind;
  if (!name || !["track", "field", "relay"].includes(kind) || !["time", "distance", "height"].includes(resultKind)) return res.status(400).json({ ok: false, error: "项目参数无效" });
  const db = getMysqlDb();
  const result = await db.run("INSERT INTO sports_events (meet_id, name, kind, result_kind, grade_name, gender, unit, stage, schedule_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", meetId, name, kind, resultKind, text(req.body?.grade), text(req.body?.gender), text(req.body?.unit, resultKind === "time" ? "秒" : "米"), text(req.body?.stage, "决赛"), text(req.body?.scheduleAt) || null);
  res.status(201).json({ ok: true, data: await db.get("SELECT * FROM sports_events WHERE id = ?", result.lastInsertRowid) });
});

router.post("/:meetId/participants", async (req, res) => {
  const meetId = id(req.params.meetId);
  const name = text(req.body?.name);
  const className = text(req.body?.className);
  if (!name || !className) return res.status(400).json({ ok: false, error: "姓名和班级不能为空" });
  const db = getMysqlDb();
  const result = await db.run("INSERT INTO sports_participants (meet_id, name, class_name, grade_name, gender, bib_no, participant_type, team_members_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", meetId, name, className, text(req.body?.grade), text(req.body?.gender), text(req.body?.bibNo) || null, text(req.body?.type, "individual"), json(req.body?.teamMembers ?? []));
  res.status(201).json({ ok: true, data: await db.get("SELECT * FROM sports_participants WHERE id = ?", result.lastInsertRowid) });
});

router.post("/:meetId/import", async (req, res) => {
  const meetId = id(req.params.meetId);
  const sheet = text(req.body?.sheet);
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (!["events", "participants"].includes(sheet) || rows.length > 5000) return res.status(400).json({ ok: false, error: "导入数据无效" });
  const db = getMysqlDb();
  let imported = 0;
  const errors: Array<{ row: number; error: string }> = [];
  await db.transaction(async (tx) => {
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index] as Record<string, unknown>;
      try {
        if (sheet === "events") {
          const name = text(row.name || row["项目名称"]);
          const kind = text(row.kind || row["类别"], "track");
          const resultKind = text(row.resultKind || row["成绩类型"], kind === "field" ? "distance" : "time");
          if (!name || !["track", "field", "relay"].includes(kind) || !["time", "distance", "height"].includes(resultKind)) throw new Error("项目名称、类别或成绩类型无效");
          await tx.run("INSERT INTO sports_events (meet_id, name, kind, result_kind, grade_name, gender, unit, stage, schedule_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", meetId, name, kind, resultKind, text(row.grade || row["年级"]), text(row.gender || row["性别"]), text(row.unit || row["单位"], resultKind === "time" ? "秒" : "米"), text(row.stage || row["阶段"], "决赛"), text(row.scheduleAt || row["比赛时间"]) || null);
        } else {
          const name = text(row.name || row["姓名"] || row["队名"]);
          const className = text(row.className || row["班级"]);
          if (!name || !className) throw new Error("姓名/队名和班级不能为空");
          await tx.run("INSERT INTO sports_participants (meet_id, name, class_name, grade_name, gender, bib_no, participant_type, team_members_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", meetId, name, className, text(row.grade || row["年级"]), text(row.gender || row["性别"]), text(row.bibNo || row["编号"]) || null, text(row.type || row["类型"], "individual"), json(row.teamMembers ?? []));
        }
        imported += 1;
      } catch (error) {
        errors.push({ row: index + 2, error: error instanceof Error ? error.message : "数据无效" });
      }
    }
  });
  res.json({ ok: true, data: { imported, errors } });
});

router.post("/:meetId/heats", async (req, res) => {
  const meetId = id(req.params.meetId);
  const eventId = id(req.body?.eventId);
  const db = getMysqlDb();
  const event = await db.get("SELECT id FROM sports_events WHERE id = ? AND meet_id = ?", eventId, meetId);
  if (!event) return res.status(400).json({ ok: false, error: "项目不属于该赛事" });
  const result = await db.run("INSERT INTO sports_heats (event_id, stage, heat_no, scheduled_at) VALUES (?, ?, ?, ?)", eventId, text(req.body?.stage, "决赛"), Number(req.body?.heatNo) || 1, text(req.body?.scheduledAt) || null);
  res.status(201).json({ ok: true, data: await db.get("SELECT * FROM sports_heats WHERE id = ?", result.lastInsertRowid) });
});

router.post("/:meetId/events/:eventId/seed-entries", async (req, res) => {
  const meetId = id(req.params.meetId);
  const eventId = id(req.params.eventId);
  const db = getMysqlDb();
  const event = await db.get<{ id: number; grade_name: string | null; gender: string | null }>("SELECT id, grade_name, gender FROM sports_events WHERE id = ? AND meet_id = ?", eventId, meetId);
  if (!event) return res.status(404).json({ ok: false, error: "项目不存在" });
  const participants = await db.all<{ id: number; class_name: string }>("SELECT id, class_name FROM sports_participants WHERE meet_id = ? AND (? = '' OR grade_name = ? OR grade_name IS NULL) AND (? = '' OR gender = ? OR gender IS NULL)", meetId, event.grade_name ?? "", event.grade_name ?? "", event.gender ?? "", event.gender ?? "");
  await db.transaction(async (tx) => {
    for (const participant of participants) {
      const existing = await tx.get("SELECT id FROM sports_entries WHERE event_id = ? AND participant_id = ? AND heat_id IS NULL", eventId, participant.id);
      if (!existing) await tx.run("INSERT INTO sports_entries (event_id, participant_id, class_name, result_text, status, points) VALUES (?, ?, ?, '', 'valid', 0)", eventId, participant.id, participant.class_name);
    }
  });
  res.json({ ok: true, count: participants.length });
});

router.post("/:meetId/entries", async (req, res) => {
  const meetId = id(req.params.meetId);
  const entries = Array.isArray(req.body?.entries) ? req.body.entries : [req.body];
  const db = getMysqlDb();
  const result = await db.transaction(async (tx) => {
    for (const item of entries) {
      const eventId = id(item.eventId);
      const participantId = id(item.participantId);
      const event = await tx.get<{ result_kind: SportsResultKind }>("SELECT result_kind FROM sports_events WHERE id = ? AND meet_id = ?", eventId, meetId);
      if (!event) throw new Error("项目不属于该赛事");
      const participant = await tx.get<{ name: string; class_name: string }>("SELECT name, class_name FROM sports_participants WHERE id = ? AND meet_id = ?", participantId, meetId);
      if (!participant) throw new Error("参赛者不属于该赛事");
      const status = (text(item.status, "valid") || "valid") as SportsEntryStatus;
      if (!["valid", "dns", "dnf", "foul"].includes(status)) throw new Error("成绩状态无效");
      const value = status === "valid" ? parseSportsResult(item.result) : null;
      const existing = await tx.get<{ id: number }>("SELECT id FROM sports_entries WHERE event_id = ? AND participant_id = ? AND COALESCE(heat_id, 0) = COALESCE(?, 0)", eventId, participantId, item.heatId ? id(item.heatId) : null);
      if (existing) {
        await tx.run("UPDATE sports_entries SET class_name = ?, result_text = ?, result_value = ?, status = ?, lane_no = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", participant.class_name, text(item.result), value, status, Number(item.laneNo) || null, existing.id);
      } else {
        await tx.run("INSERT INTO sports_entries (event_id, participant_id, heat_id, lane_no, class_name, result_text, result_value, status, rank_no, points) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 0)", eventId, participantId, item.heatId ? id(item.heatId) : null, Number(item.laneNo) || null, participant.class_name, text(item.result), value, status);
      }
      await recalculateEvent(tx, eventId);
    }
    return true;
  });
  res.json({ ok: result });
});

router.get("/:meetId/results", async (req, res) => {
  const meetId = id(req.params.meetId);
  const db = getMysqlDb();
  const rows = await db.all("SELECT e.*, ev.name AS event_name, ev.kind, ev.result_kind, p.name AS participant_name, p.gender, p.grade_name FROM sports_entries e JOIN sports_events ev ON ev.id = e.event_id JOIN sports_participants p ON p.id = e.participant_id WHERE ev.meet_id = ? ORDER BY ev.schedule_at, ev.id, e.rank_no, e.id", meetId);
  const standings = teamPointTotals(rows.map((row: any) => ({ className: row.class_name, points: Number(row.points) || 0 })));
  res.json({ ok: true, data: { rows, standings } });
});

router.get("/:meetId/export", async (req, res) => {
  const meetId = id(req.params.meetId);
  const db = getMysqlDb();
  const rows = await db.all("SELECT ev.name AS 项目, ev.stage AS 阶段, p.name AS 姓名, e.class_name AS 班级, e.result_text AS 成绩, e.rank_no AS 名次, e.points AS 积分 FROM sports_entries e JOIN sports_events ev ON ev.id = e.event_id JOIN sports_participants p ON p.id = e.participant_id WHERE ev.meet_id = ? ORDER BY ev.schedule_at, ev.id, e.rank_no", meetId);
  res.json({ ok: true, data: rows });
});

export default router;
