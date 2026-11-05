import admin from "firebase-admin";
import crypto from "node:crypto";

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const CONTENT_DB = process.env.NOTION_CONTENT_DB;
const PEOPLE_DB = process.env.NOTION_PEOPLE_DB;

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
});
const db = admin.firestore();

// Notion 栏位名称，必须和 Notion 里的一模一样
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

async function titlePropName(dbId) {
  const d = await notion(`/databases/${dbId}`);
  const found = Object.entries(d.properties).find(([, v]) => v.type === "title");
  if (!found) throw new Error("找不到标题栏位");
  return found[0];
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

const date = (s) => ({ date: s ? { start: s } : null });
const text = (s) => ({
  rich_text: s ? [{ text: { content: String(s).slice(0, 1900) } }] : [],
});

async function main() {
  const contentTitle = await titlePropName(CONTENT_DB);
  const peopleTitle = await titlePropName(PEOPLE_DB);

  // People：姓名 -> 页面 id
  const people = {};
  for (const p of await queryAll(PEOPLE_DB)) {
    const name = (p.properties[peopleTitle].title || [])
      .map((t) => t.plain_text)
      .join("");
    if (name) people[norm(name)] = p.id;
  }

  const warnings = [];
  const rel = (name, title) => {
    if (!name) return { relation: [] };
    const id = people[norm(name)];
    if (!id) {
      warnings.push(`「${title}」里的「${name}」在 People 找不到，没有连上`);
      return { relation: [] };
    }
    return { relation: [{ id }] };
  };

  const snap = await db.collection("contents").get();
  let created = 0;
  let updated = 0;
  let failed = 0;

  for (const d of snap.docs) {
    const c = d.data();
    if (!c.title) continue;

    const props = {
      [contentTitle]: { title: [{ text: { content: c.title } }] },
      [P.campaign]: { select: { name: `Team ${c.team}` } },
      [P.type]: { select: c.type ? { name: c.type } : null },
      [P.status]: { select: c.status ? { name: c.status } : null },
      [P.post]: date(c.postDate),
      [P.shoot]: date(c.shootDate),
      [P.draft]: date(c.editDate),
      [P.assignee]: rel(c.shooterName, c.title),
      [P.editor]: rel(c.editorName, c.title),
      [P.notes]: text(c.notes),
      [P.link]: { url: c.driveLink || null },
    };

    const hash = crypto.createHash("sha1").update(JSON.stringify(props)).digest("hex");
    if (c.notionPageId && c.notionHash === hash) continue;

    try {
      if (c.notionPageId) {
        await notion(`/pages/${c.notionPageId}`, "PATCH", { properties: props });
        await d.ref.update({ notionHash: hash });
        updated++;
      } else {
        const page = await notion("/pages", "POST", {
          parent: { database_id: CONTENT_DB },
          properties: props,
        });
        await d.ref.update({ notionPageId: page.id, notionHash: hash });
        created++;
      }
    } catch (e) {
      failed++;
      console.error(`「${c.title}」同步失败：`, e.message);
    }
  }

  warnings.forEach((w) => console.warn("⚠", w));
  console.log(`新建 ${created} 笔，更新 ${updated} 笔，失败 ${failed} 笔`);
  if (failed > 0) process.exitCode = 1;
}

main()
  .then(() => process.exit(process.exitCode || 0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
