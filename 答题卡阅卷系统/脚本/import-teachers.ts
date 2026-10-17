import { readFile } from "node:fs/promises";
import path from "node:path";
import * as XLSX from "xlsx";
import { getMysqlDb, initMariadbSchema, initializeDatabase } from "../源码/server/db";
import { UserRepository } from "../源码/server/repositories/UserRepository";

const input = process.argv[2];
if (!input) throw new Error("用法：npm run import:teachers -- teachers.xlsx|teachers.csv");

initializeDatabase();
await initMariadbSchema();
const buffer = await readFile(path.resolve(input));
const workbook = path.extname(input).toLowerCase() === ".csv"
  ? XLSX.read(buffer.toString("utf8"), { type: "string" })
  : XLSX.read(buffer, { type: "buffer" });
const sheet = workbook.Sheets[workbook.SheetNames[0]];
const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
const users = new UserRepository();
const db = getMysqlDb();
const pick = (row: Record<string, unknown>, names: string[]) => {
  const key = Object.keys(row).find(k => names.includes(k.trim().toLowerCase()));
  return key ? String(row[key] ?? "").trim() : "";
};
const output: Array<Record<string, string>> = [];
for (const row of rows) {
  const name = pick(row, ["姓名", "name", "教师", "老师"]);
  if (!name) continue;
  const username = pick(row, ["用户名", "username", "账号"]) || await users.generateTeacherUsername();
  const password = pick(row, ["密码", "password"]) || users.generateTeacherPassword();
  if (await users.usernameExists(username)) {
    output.push({ name, username, password, status: "skipped:username_exists" });
    continue;
  }
  await users.createUser({
    username,
    password,
    name,
    role_id: 2,
    subject: pick(row, ["科目", "subject", "主要科目"]),
    teacher_role: pick(row, ["教师角色", "teacher_role", "角色"]) || "teacher",
    initial_password: password
  });
  output.push({ name, username, password, status: "created" });
}
console.log(JSON.stringify({ total: rows.length, created: output.filter(row => row.status === "created").length, skipped: output.filter(row => row.status !== "created").length, accounts: output }, null, 2));
