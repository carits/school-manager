import { ensureDefaultAdmin, getMysqlDb, initMariadbSchema, initializeDatabase } from "../源码/server/db";

initializeDatabase();
await initMariadbSchema();
const result = await ensureDefaultAdmin();
const db = getMysqlDb();
const admin = await db.get<{ username: string; password_change_required: number }>("SELECT username, password_change_required FROM users WHERE id = ?", result.adminId);
console.log(JSON.stringify({ ...result, username: admin?.username ?? "admin", passwordChangeRequired: Boolean(admin?.password_change_required) }, null, 2));
