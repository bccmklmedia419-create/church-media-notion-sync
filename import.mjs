import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const CONTENT_DB = process.env.NOTION_CONTENT_DB;
const PEOPLE_DB = process.env.NOTION_PEOPLE_DB;
const DRY = process.env.DRY_RUN === "1"; // 1 = 只预览，不写入

initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = getFirestore();

// 栏位名称，和 sync.mjs 一样
const P = {
  campaign: "Campaign",
  type: "Type",
  status: "Status",
  post: "Due Date / Posting Date",
  shoot: "Shooting Date",
  draft: "Draft Date",
  assignee: "Assignee",
  editor: "Editor",
  notes: "Notes/Brief",
  link: "Files/Drive Link",
};

const TEAM_OF = { "team a": "A", "team b": "B", "core team": "C" };
const STATUS = [
  "Not Started", "Planning", "Shooting", "Passed to Editor", "Editing",
  "Waiting for Review", "Approved", "Published", "Cancelled",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => (s || "").trim().replace(/\s+/g, " ").toLowerCase();

async function notion(path, method = "GET", body) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch("https://api.notion.com/v1" + path, {
      method,
      headers: {
        Authorization: `Bearer ${NOTION_TOKEN}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429) {
      await sleep(1500 * (attempt + 1));
      continue;
    }
    if (!res.ok) throw new Error(`Notion ${res.status}: ${await res.text()}`);
    await sleep(350);
    return res.json();
  }
  throw new Error("Notion 请求太频繁，稍后再试");
}

async function queryAll(dbId) {
  const out = [];
  let cursor;
  do {
    const r = await notion(`/databases/${dbId}/query`, "POST", {
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    out.push(...r.results);
    cursor = r.has_more ? r.next_cursor : undefined;
  } while (cursor);
  return out;
}

const titleOf = (props) => {
  const t = Object.values(props).find((v) => v.type === "title");
  return ((t && t.title) || []).map((x) => x.plain_text).join("").trim();
};
const sel = (p) => (p && p.select ? p.select.name : "");
const dt = (p) => (p && p.date ? p.date.start.slice(0, 10) : "");
const rich = (p) => ((p && p.rich_text) || []).map((x) => x.plain_text).join("");

async function main() {
  // People：页面 id -> 姓名
  const peopleName = {};
  for (const p of await queryAll(PEOPLE_DB)) peopleName[p.id] = titleOf(p.properties);

  // 名册：姓名 -> uid
  const uidByName = {};
  (await db.collection("roster").get()).docs.forEach((d) => {
    uidByName[norm(d.data().name)] = d.id;
  });

  // 已经在 app 里的（用 notionPageId 判断，不会重复导入）
  const existing = new Set();
  (await db.collection("contents").get()).docs.forEach((d) => {
    if (d.data().notionPageId) existing.add(d.data().notionPageId);
  });

  // 一个栏位里可以连多个人
  const namesOfRel = (prop) =>
    ((prop && prop.relation) || []).map((r) => peopleName[r.id]).filter(Boolean);

  let added = 0, skipped = 0, noTeam = 0;
  for (const page of await queryAll(CONTENT_DB)) {
    if (existing.has(page.id)) { skipped++; continue; }
    const pr = page.properties;
    const title = titleOf(pr);
    if (!title) continue;

    const team = TEAM_OF[norm(sel(pr[P.campaign]))];
    if (!team) {
      console.log(`⚠ 跳过「${title}」：Campaign 不是 Team A / Team B / Core Team（现在是「${sel(pr[P.campaign]) || "空"}」）`);
      noTeam++;
      continue;
    }

    const shooterNames = namesOfRel(pr[P.assignee]);
    const editorNames = namesOfRel(pr[P.editor]);
    const shooterUids = shooterNames.map((n) => uidByName[norm(n)]).filter(Boolean);
    const editorUids = editorNames.map((n) => uidByName[norm(n)]).filter(Boolean);
    const status = sel(pr[P.status]);

    const data = {
      title,
      type: sel(pr[P.type]) || "Reels",
      team,
      status: STATUS.includes(status) ? status : "Planning",
      postDate: dt(pr[P.post]),
      shootDate: dt(pr[P.shoot]),
      editDate: dt(pr[P.draft]),
      shooterNames,
      shooterUids,
      shooterName: shooterNames[0] || "",
      shooterUid: shooterUids[0] || "",
      editorNames,
      editorUids,
      editorName: editorNames[0] || "",
      editorUid: editorUids[0] || "",
      notes: rich(pr[P.notes]),
      driveLink: (pr[P.link] && pr[P.link].url) || "",
      notionPageId: page.id,
      imported: true,
      createdBy: "notion-import",
      createdByName: "Notion",
      createdAt: FieldValue.serverTimestamp(),
    };

    console.log(`${DRY ? "（预览）" : ""}导入：${title} → ${team === "C" ? "Core Team" : "Team " + team}`);
    shooterNames.forEach((n) => {
      if (!uidByName[norm(n)]) console.log(`   ⚠ 拍摄「${n}」不在名册，没有连上账号`);
    });
    editorNames.forEach((n) => {
      if (!uidByName[norm(n)]) console.log(`   ⚠ 剪辑「${n}」不在名册，没有连上账号`);
    });
    if (!DRY) await db.collection("contents").add(data);
    added++;
  }
  console.log(`${DRY ? "（预览）" : ""}导入 ${added} 笔，已存在跳过 ${skipped} 笔，Campaign 不对 ${noTeam} 笔`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
