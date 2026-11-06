import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const PEOPLE_DB = process.env.NOTION_PEOPLE_DB;

initializeApp({
  credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
});
const db = getFirestore();

// Notion 栏位名称，必须和 People 里的一模一样
const P = {
  active: "Active",
  group: "Group",
  dept: "Department",
  role: "Role",
  email: "Email",
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

// select 或 multi_select 都当成名称清单
const names = (prop) => {
  if (!prop) return [];
  if (prop.select) return [prop.select.name];
  if (prop.multi_select) return prop.multi_select.map((o) => o.name);
  return [];
};

const emailOf = (prop) => {
  if (!prop) return "";
  if (typeof prop.email === "string") return prop.email.trim().toLowerCase();
  if (prop.rich_text) {
    return prop.rich_text.map((t) => t.plain_text).join("").trim().toLowerCase();
  }
  return "";
};

async function main() {
  // app 里已注册的成员
  const byEmail = {};
  const byName = {};
  (await db.collection("members").get()).docs.forEach((d) => {
    const m = { uid: d.id, ...d.data() };
    if (m.email) byEmail[m.email.trim().toLowerCase()] = m;
    if (m.name) byName[norm(m.name)] = m;
  });

  // 现有名册
  const roster = {};
  (await db.collection("roster").get()).docs.forEach((d) => {
    roster[d.id] = d.data();
  });

  let changed = 0;
  let same = 0;
  const unmatched = [];

  for (const page of await queryAll(PEOPLE_DB)) {
    const props = page.properties;
    const titleProp = Object.values(props).find((v) => v.type === "title");
    const name = ((titleProp && titleProp.title) || [])
      .map((t) => t.plain_text)
      .join("")
      .trim();
    if (!name) continue;

    // 没勾 Active 的略过（例如 [Deprecated] 那几行）
    if (props[P.active] && props[P.active].checkbox === false) continue;

        const groups = names(props[P.group]);
    const depts = names(props[P.dept]);
    const roles = names(props[P.role]);

    // SM Team A/B、MCP Team A/B/C；旧写法 Team A/B 且部门是 Social Media 也当成 SM
    let smTeam = "";
    let mcpTeam = "";
    for (const g of groups) {
      const mm = g.trim().match(/^(SM|MCP)\s*Team\s*([A-C])$/i);
      if (mm) {
        const kind = mm[1].toUpperCase();
        const letter = mm[2].toUpperCase();
        if (kind === "MCP") mcpTeam = letter;
        else if (letter !== "C") smTeam = letter;
        continue;
      }
      const old = g.trim().match(/^Team\s*([AB])$/i);
      if (old && depts.includes("Social Media")) smTeam = old[1].toUpperCase();
    }
    if (!smTeam && !mcpTeam) continue;
    const smLeader = !!smTeam && roles.includes("Team Leader");

    const email = emailOf(props[P.email]);
    const m = (email && byEmail[email]) || byName[norm(name)];
    if (!m) {
      unmatched.push(name);
      continue;
    }

    const r = roster[m.uid];
    const memberOk =
      (!smTeam || (m.smTeam === smTeam && !!m.smLeader === smLeader)) &&
      (!mcpTeam || m.mcpTeam === mcpTeam);
    const rosterOk = !smTeam || (r && r.smTeam === smTeam && r.name === m.name);
    if (memberOk && rosterOk) {
      same++;
      continue;
    }

    const upd = {};
    if (smTeam) {
      upd.smTeam = smTeam;
      upd.smLeader = smLeader;
    }
    if (mcpTeam) upd.mcpTeam = mcpTeam;
    if (!memberOk) await db.doc(`members/${m.uid}`).update(upd);
    if (!rosterOk) await db.doc(`roster/${m.uid}`).set({ name: m.name, smTeam });
    console.log(
      `更新：${m.name} →${smTeam ? " SM Team " + smTeam : ""}${smLeader ? "（组长）" : ""}${mcpTeam ? " MCP Team " + mcpTeam : ""}`
    );
    changed++;
  }

  if (unmatched.length > 0) {
    console.log(`⚠ 还没在 app 注册（或姓名和 Email 都对不上）：${unmatched.join("、")}`);
  }
  console.log(`成员同步：更新 ${changed} 人，没变 ${same} 人，没对上 ${unmatched.length} 人`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
