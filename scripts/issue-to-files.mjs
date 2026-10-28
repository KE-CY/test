#!/usr/bin/env node
// 把 API 申請 issue（新增 / 更新 / 移除）的表單內容套用到 products/ 下的設定檔。
// 申請類型來自 issue 的 request:add / request:update / request:remove 標籤：
//   新增：第一次註冊的產品或環境，全欄位必填
//   更新：既有產品的後續調整，含新增 scope
//   移除：下架指定的環境，全部環境都移除等於整個產品下架
// OpenAPI 來源是拖曳到 issue 的附件，由這支腳本抓回來落檔。
// 格式錯誤一律 exit 1，由 workflow 回報到 issue。
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { parse, stringify } from "yaml";

const ENVIRONMENTS = ["lab", "stg", "prod"];
const METHODS = ["get", "put", "post", "delete", "patch", "head", "options", "trace"];
// ponytail: 測試用環境變數換掉附件來源，省掉一層 fetch 注入
const ATTACHMENT_HOST = process.env.ATTACHMENT_HOST ?? "https://github.com/";

const labels = JSON.parse(process.env.ISSUE_LABELS ?? "[]");
const request = ["add", "update", "remove"].find((name) => labels.includes(`request:${name}`));
if (!request) {
  console.error("- 這張 issue 沒有 request:add / request:update / request:remove 標籤，請用申請範本重新建立");
  process.exit(1);
}

// issue form 的內容是 "### <label>\n\n<value>" 的區塊，textarea 會多包一層 code fence
const fields = Object.fromEntries(
  (process.env.ISSUE_BODY ?? "")
    .split(/^### /m)
    .slice(1)
    .map((block) => {
      const [label, ...rest] = block.split("\n");
      const value = rest
        .join("\n")
        .trim()
        .replace(/^```[a-z]*\n?/, "")
        .replace(/\n?```$/, "")
        .trim();
      return [label.trim(), value];
    }),
);

const errors = [];
const optional = (label) => {
  const value = fields[label];
  return !value || value === "_No response_" ? "" : value;
};
const field = (label) => {
  const value = optional(label);
  if (!value) errors.push(`缺少「${label}」`);
  return value;
};
// 三種申請範本的欄位名稱不同，但語意是同一個
const pick = (...labels) => labels.map((label) => optional(label)).find(Boolean) ?? "";
const lines = (value) =>
  value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

const productId = field("產品編號");
const owner = field("產品負責人 email");
const basePath = field("對外路徑前綴");
const productPath = `products/${productId}/product.yaml`;
const environmentsPath = `products/${productId}/environments`;
const existing = existsSync(productPath) ? parse(readFileSync(productPath, "utf8")) : null;
const registered = existsSync(environmentsPath) ? readdirSync(environmentsPath) : [];
if (request !== "add" && !existing) {
  errors.push(`products/${productId} 還沒註冊，請改用「申請新增」`);
}

const environments = lines(pick("目標環境", "要更新的環境", "要移除的環境").replaceAll(",", "\n"));
for (const environment of environments) {
  if (!ENVIRONMENTS.includes(environment)) errors.push(`未知的環境「${environment}」`);
}

const listed = lines(pick("新增的 Scopes", "Scopes")).map((line) => {
  const [code, name, description] = line.split("|").map((part) => part.trim());
  if (!code || !name || !description) {
    errors.push(`scope 格式應為 \`code | 名稱 | 說明\`：\`${line}\``);
  }
  return { code, name, description };
});

const changes = [];
let scopes = existing?.scopes ?? [];
const same = (a, b) => a.name === b.name && a.description === b.description;

if (request === "add") {
  // 新增＝建立還不存在的產品或環境，所以環境、scope、OpenAPI 全部必填
  if (environments.length === 0) errors.push("申請新增必須選「目標環境」");
  if (listed.length === 0) errors.push("申請新增必須填「新增的 Scopes」");
  for (const environment of environments) {
    if (registered.includes(environment)) {
      errors.push(`${environment} 環境已經註冊過，後續調整請用「申請更新」`);
    }
  }
  // 既有產品開新環境時，原有的 scope 會被一起列出來，內容相同就視為沿用
  const additions = [];
  for (const scope of listed) {
    const current = scopes.find((item) => item.code === scope.code);
    if (!current) additions.push(scope);
    else if (!same(current, scope)) {
      errors.push(`scope ${scope.code} 已經註冊且內容不同，要改名稱或說明請用「申請更新」`);
    }
  }
  scopes = [...scopes, ...additions];
  if (additions.length > 0) changes.push(`新增 scope：${additions.map((scope) => scope.code).join("、")}`);
  if (environments.length > 0) changes.push(`新增環境：${environments.join("、")}`);
} else if (request === "update") {
  // 更新＝既有產品的後續調整，可以新增 scope，但不能刪東西
  for (const environment of environments) {
    if (!registered.includes(environment)) {
      errors.push(`${environment} 環境還沒註冊，請用「申請新增」`);
    }
  }
  const added = listed.filter((scope) => !scopes.some((item) => item.code === scope.code));
  const updated = listed.filter((scope) => scopes.some((item) => item.code === scope.code && !same(item, scope)));
  scopes = [...scopes.map((item) => listed.find((scope) => scope.code === item.code) ?? item), ...added];
  if (added.length > 0) changes.push(`新增 scope：${added.map((scope) => scope.code).join("、")}`);
  if (updated.length > 0) changes.push(`更新 scope：${updated.map((scope) => scope.code).join("、")}`);
  if (environments.length > 0) changes.push(`更新環境：${environments.join("、")}`);
  if (existing) {
    if (owner !== existing.owner) changes.push(`更新 owner：${existing.owner} → ${owner}`);
    if (basePath !== existing.base_path) {
      changes.push(`更新 base_path：${existing.base_path} → ${basePath}（既有呼叫方的路徑會改變）`);
    }
    if (changes.length === 0) errors.push("沒有任何要更新的內容：scope、環境、owner、base_path 都與現況相同");
  }
} else {
  // 移除＝下架選到的環境；全部環境都移除就連 product.yaml 一起刪掉
  if (!/- \[[xX]\]/.test(optional("移除確認"))) {
    errors.push("移除會讓這些環境的 API 下架，請勾選「移除確認」");
  }
  if (environments.length === 0) errors.push("申請移除必須選「要移除的環境」");
  for (const environment of environments) {
    if (existing && !registered.includes(environment)) errors.push(`${environment} 環境不存在`);
  }
  if (existing && environments.length > 0) {
    const remaining = registered.filter((environment) => !environments.includes(environment));
    changes.push(
      remaining.length === 0
        ? `移除整個產品 ${productId}（環境：${environments.join("、")}；scope ${scopes.length} 個）`
        : `移除環境：${environments.join("、")}（保留 ${remaining.join("、")}）`,
    );
  }
}

// 新增與移除不改產品層級欄位，填的值要與既有註冊相符，當成「有沒有搞錯產品」的確認
if (existing && request !== "update") {
  if (owner && owner !== existing.owner) {
    errors.push(`產品負責人 email 與 ${productId} 已註冊的不符（${existing.owner}），要變更請用「申請更新」`);
  }
  if (basePath && basePath !== existing.base_path) {
    errors.push(`對外路徑前綴與 ${productId} 已註冊的不符（${existing.base_path}），要變更請用「申請更新」`);
  }
}

// 拖曳上傳後 GitHub 會把附件寫成 markdown 連結，只接受附件、不接受外部連結
const attachmentUrl = (value) => value.match(/\((https?:\/\/[^\s)]+)\)/)?.[1] ?? "";

// 各環境的 server URL 與 operation 彼此獨立，所以一個環境一份 OpenAPI
const sources = new Map();
if (request !== "remove") {
  for (const environment of environments) {
    const upload = optional(`${environment} OpenAPI 檔案`);
    const url = attachmentUrl(upload);
    if (!upload) {
      errors.push(`${environment} 需要上傳 OpenAPI 檔案`);
    } else if (!url) {
      errors.push(`${environment} 的 OpenAPI 欄位沒有附件，請把 .yaml 檔拖曳到該欄位`);
    } else if (!url.startsWith(ATTACHMENT_HOST)) {
      errors.push(`${environment} 的 OpenAPI 只接受拖曳上傳的附件，不接受外部連結：${url}`);
    } else if (!/\.ya?ml$/i.test(new URL(url).pathname)) {
      errors.push(`${environment} 的 OpenAPI 只接受 .yaml，請不要上傳 .json 或其他格式`);
    } else {
      sources.set(environment, url);
    }
  }
  for (const environment of ENVIRONMENTS) {
    if (optional(`${environment} OpenAPI 檔案`) && !environments.includes(environment)) {
      errors.push(`上傳了 ${environment} 的 OpenAPI 卻沒勾選 ${environment} 環境`);
    }
  }
}

const documents = new Map();
for (const [environment, url] of sources) {
  // private repo 的附件要帶 token 才下載得到
  const headers = process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {};
  let text;
  try {
    const response = await fetch(url, { headers, redirect: "follow" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    text = await response.text();
  } catch (error) {
    errors.push(`抓不到 ${environment} 的 OpenAPI（${url}）：${error.message}`);
    continue;
  }
  if (text.trimStart().startsWith("{")) {
    errors.push(`${environment} 的 OpenAPI 只接受 YAML，${url} 回傳的是 JSON`);
    continue;
  }
  try {
    parse(text);
    documents.set(environment, text);
  } catch (error) {
    errors.push(`${environment} 的 OpenAPI 不是合法的 YAML：${error.message}`);
  }
}

if (errors.length > 0) {
  console.error(errors.map((error) => `- ${error}`).join("\n"));
  process.exit(1);
}

// 換掉整份 openapi.yaml 會連帶增減 operation，列出來讓審核看得到少了什麼
const operations = (text) =>
  Object.entries(parse(text)?.paths ?? {}).flatMap(([path, item]) =>
    Object.keys(item ?? {})
      .filter((method) => METHODS.includes(method))
      .map((method) => `${method.toUpperCase()} ${path}`),
  );

if (request === "remove") {
  const remaining = registered.filter((environment) => !environments.includes(environment));
  if (remaining.length === 0) {
    rmSync(`products/${productId}`, { recursive: true, force: true });
  } else {
    // 局部移除不動 product.yaml，避免 diff 出現與這次申請無關的格式變動
    for (const environment of environments) {
      rmSync(`${environmentsPath}/${environment}`, { recursive: true, force: true });
    }
  }
} else {
  for (const [environment, document] of documents) {
    const openapiPath = `${environmentsPath}/${environment}/openapi.yaml`;
    if (existsSync(openapiPath)) {
      const before = operations(readFileSync(openapiPath, "utf8"));
      const after = operations(document);
      const addedOperations = after.filter((operation) => !before.includes(operation));
      const removedOperations = before.filter((operation) => !after.includes(operation));
      if (addedOperations.length > 0) changes.push(`${environment} 新增 operation：${addedOperations.join("、")}`);
      if (removedOperations.length > 0) changes.push(`${environment} 移除 operation：${removedOperations.join("、")}`);
      if (addedOperations.length === 0 && removedOperations.length === 0) {
        changes.push(`${environment} operation 無增減`);
      }
    }
    mkdirSync(`${environmentsPath}/${environment}`, { recursive: true });
    writeFileSync(openapiPath, document.endsWith("\n") ? document : `${document}\n`);
  }
  mkdirSync(`products/${productId}`, { recursive: true });
  writeFileSync(
    productPath,
    // repo 既有的 product.yaml 在 scopes 前都空一行，跟著排版才不會每次 PR 都動到格式
    stringify({ product_id: productId, owner, base_path: basePath, scopes }).replace("\nscopes:", "\n\nscopes:"),
  );
}

const action = { add: "新增", update: "更新", remove: "移除" }[request];
const summary = changes.map((change) => `- ${change}`).join("\n");
const title = `申請${action} ${productId}${environments.length > 0 ? `（${environments.join(", ")}）` : ""}`;
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `product_id=${productId}\ntitle=${title}\nchanges<<CHANGES\n${summary}\nCHANGES\n`,
  );
}
console.log(`${title}\n${summary}`);
