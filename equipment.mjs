import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const EQUIPMENT_DB = process.env.NOTION_EQUIPMENT_DB;

initializeApp({
  credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
});
const db = getFirestore();

// Notion 栏位名称，必须和 Notion 里的一模一样
const P = {
  code: "ID",
  category: "Category",
  kit: "Kit",
  status: "Status",
  location: "Location",
  quantity: "Quantity",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kuala_Lumpur" }).format(new Date());

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

// 不管栏位是文字、选单、数字还是唯一 ID，都读成文字
const val = (p) => {
  if (!p) return "";
  switch (p.type) {
    case "title":
      return p.title.map((t) => t.plain_text).join("").trim();
    case "rich_text":
      return p.rich_text.map((t) => t.plain_text).join("").trim();
    case "select":
      return p.select ? p.select.name : "";
    case "status":
      return p.status ? p.status.name : "";
    case "multi_select":
      return p.multi_select.map((o) => o.name).join(", ");
    case "number":
      return p.number == null ? "" : String(p.number);
    case "unique_id":
      return p.unique_id
        ? `${p.unique_id.prefix ? p.unique_id.prefix + "-" : ""}${p.unique_id.number}`
        : "";
    default:
      return "";
  }
};

async function setNotionStatus(page, name) {
  const prop = page.properties[P.status];
  if (!prop || (prop.type !== "select" && prop.type !== "status")) return false;
  await notion(`/pages/${page.id}`, "PATCH", {
    properties: { [P.status]: { [prop.type]: { name } } },
  });
  return true;
}

async function main() {
  const pages = await queryAll(EQUIPMENT_DB);

  const existing = {};
  // Notion 页面 id -> app 器材文档 id（在 app 手动新增、已同步到 Notion 的器材）
  const byNotion = {};
  (await db.collection("equipment").get()).docs.forEach((d) => {
    existing[d.id] = d.data();
    if (d.data().notionPageId) byNotion[d.data().notionPageId] = d.id;
  });

  // 目前实际借出去的数量（已批准、归还待确认），按器材 id 统计
  const outMap = {};
  const loans = await db
    .collection("loanRequests")
    .where("status", "in", ["approved", "returning"])
    .get();
  loans.docs.forEach((d) => {
    if ((d.data().startDate || "") > today) return;
    (d.data().items || []).forEach((i) => {
      outMap[i.itemId] = (outMap[i.itemId] || 0) + (i.qty || 0);
    });
  });

  let updated = 0;
  let written = 0;
  let missingQty = 0;
  let backfilled = 0;
  const seen = new Set();

  for (const page of pages) {
    const pr = page.properties;
    const titleProp = Object.values(pr).find((v) => v.type === "title");
    const name = titleProp ? val(titleProp) : "";
    if (!name) continue;
    seen.add(page.id);

    const docId = byNotion[page.id] || page.id;
    const isMapped = docId !== page.id;
    const old = existing[docId];

    const status = val(pr[P.status]);
    if (!pr[P.quantity]) missingQty++;
    const qtyRaw = val(pr[P.quantity]);
    const total = qtyRaw
      ? Math.max(1, parseInt(qtyRaw, 10) || 1)
      : isMapped && old && old.total
      ? old.total
      : 1;
    const out = outMap[docId] || 0;

    // 只有 Available（或空白），或是 app 自己借出去造成的 Checked Out，才可以借
    const free =
      status === "" || status === "Available" || (status === "Checked Out" && out > 0);

    const data = {
      name,
      code: val(pr[P.code]),
      category: val(pr[P.category]),
      kit: val(pr[P.kit]),
      location: val(pr[P.location]),
      total,
      notionStatus: status,
      blocked: !free,
      removed: false,
      // app 手动新增的器材保持原样，不改成「来自 Notion」
      ...(isMapped ? { syncedName: name, syncedTotal: total } : { source: "notion" }),
    };

    if (!old || Object.keys(data).some((k) => old[k] !== data[k])) {
      await db.doc(`equipment/${docId}`).set(data, { merge: true });
      updated++;
    }

    // 回写 Status：只有 app 的借用状态改变时才写，不会盖掉你手动设的状态
    const computed = out >= total ? "Checked Out" : "Available";
    const prev = old ? old.appState : undefined;
    if (prev === undefined) {
      await db.doc(`equipment/${docId}`).set({ appState: computed }, { merge: true });
    } else if (prev !== computed) {
      const writable = status === "" || status === "Available" || status === "Checked Out";
      if (writable && status !== computed && (await setNotionStatus(page, computed))) {
        written++;
      }
      await db.doc(`equipment/${docId}`).set({ appState: computed }, { merge: true });
    }
  }

  // Notion 里已经删掉的器材：在 app 里隐藏，借用记录保留
  let removed = 0;
  for (const [id, old] of Object.entries(existing)) {
    const pid = old.notionPageId || id;
    if ((old.source === "notion" || old.notionPageId) && !seen.has(pid) && !old.removed) {
      await db.doc(`equipment/${id}`).set({ removed: true, blocked: true }, { merge: true });
      removed++;
    }
  }

  // 补漏：app 手动新增、还没同步到 Notion 的器材，碰一下让 Cloud Function 去建立
  for (const [id, old] of Object.entries(existing)) {
    if (old.source !== "notion" && !old.notionPageId && !old.removed && old.name) {
      await db.doc(`equipment/${id}`).set({ syncTouch: Date.now() }, { merge: true });
      backfilled++;
    }
  }

  if (missingQty > 0) {
    console.warn(`⚠ ${missingQty} 件器材没有 ${P.quantity} 栏位，数量先当成 1`);
  }
  console.log(
    `器材同步：Notion ${seen.size} 件，更新 ${updated} 件，回写状态 ${written} 件，隐藏 ${removed} 件，补送到 Notion ${backfilled} 件`
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
