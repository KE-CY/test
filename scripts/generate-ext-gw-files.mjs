#!/usr/bin/env node
// 從 registry 產出對外 API 中心（104z-apps/ha-ext-gw）上架所需的檔案：
//   routes/<PRODUCT_ID>/product.yaml   原樣複製
//   routes/<PRODUCT_ID>/<base_path>.conf  由 generate-nginx.mjs 產生
//   overlays/<env>/*.values.yaml 的 upstreams.<PRODUCT_ID>
//
//   node scripts/generate-ext-gw-files.mjs <product_id> <104z-apps 路徑> [--write]
//
// 預設 dry-run 只印出會做什麼；加 --write 才真的落檔。
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, parseDocument, stringify } from "yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [productId, appsPath, ...flags] = process.argv.slice(2);
const write = flags.includes("--write");

if (!productId || !appsPath) {
  console.error("Usage: node scripts/generate-ext-gw-files.mjs <product_id> <104z-apps 路徑> [--write]");
  process.exit(1);
}

const gateway = join(appsPath, "ha-ext-gw");
if (!existsSync(gateway)) {
  console.error(`找不到 ${gateway}，請確認第二個參數是 104z-apps 的路徑`);
  process.exit(1);
}

function generateRoute(environment) {
  try {
    return execFileSync(process.execPath, [join(root, "scripts/generate-nginx.mjs"), environment, productId], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    console.error(`產生 ${productId} ${environment} 的 route 失敗：`);
    console.error(String(error.stderr).trim().split("\n").slice(0, 3).join("\n"));
    process.exit(1);
  }
}

const productDirectory = join(root, "products", productId);
const overlaysDirectory = join(gateway, "overlays");
const routeDirectory = join(gateway, "routes", productId);

// registry 裡找不到這個產品＝整個下架：刪掉 route 目錄，並把所有 overlay 的條目移除
if (!existsSync(productDirectory)) {
  if (!existsSync(routeDirectory)) {
    console.error(`${productId} 既不在 registry 也不在 104z-apps，沒有可做的事`);
    process.exit(1);
  }
  console.log(`  - ha-ext-gw/routes/${productId}/`);
  const removals = [];
  for (const environment of readdirSync(overlaysDirectory)) {
    const overlayDirectory = join(overlaysDirectory, environment);
    for (const file of readdirSync(overlayDirectory).filter((name) => name.endsWith(".values.yaml"))) {
      const path = join(overlayDirectory, file);
      const document = parseDocument(readFileSync(path, "utf8"));
      if (document.getIn(["upstreams", productId]) === undefined) continue;
      document.deleteIn(["upstreams", productId]);
      console.log(`  ~ ${path.slice(appsPath.length + 1)}（移除 upstreams.${productId}）`);
      removals.push([path, document.toString({ lineWidth: 0 })]);
    }
  }
  if (write) {
    rmSync(routeDirectory, { recursive: true, force: true });
    for (const [path, content] of removals) writeFileSync(path, content);
  }
  console.log(write ? "\n已寫入。" : "\n這是 dry-run，加 --write 才會落檔。");
  process.exit(0);
}
const product = parse(readFileSync(join(productDirectory, "product.yaml"), "utf8"));
const ENVIRONMENTS = ["lab", "stg", "prod"];
const environments = readdirSync(join(productDirectory, "environments"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && ENVIRONMENTS.includes(entry.name))
  .map((entry) => entry.name)
  .sort();
if (environments.length === 0) {
  console.error(`${productId} 底下沒有任何已註冊的環境`);
  process.exit(1);
}

// route 檔必須與環境無關：各環境產出的 conf 要一致，不一致代表 API 清單或 scope 有分歧
const confByEnvironment = new Map(
  environments.map((environment) => [
    environment,
    generateRoute(environment),
  ]),
);
const [baseline, ...others] = [...confByEnvironment];
const mismatched = others.filter(([, conf]) => conf !== baseline[1]).map(([environment]) => environment);
if (mismatched.length > 0) {
  console.error(
    `${productId} 的 ${baseline[0]} 與 ${mismatched.join("、")} 產出的 route 不同（API 清單或 scope 有分歧）。\n` +
      "104z-apps 一個產品只有一份與環境無關的 route，請先讓各環境一致。",
  );
  process.exit(1);
}

const slug = product.base_path.replace(/^\//, "");
const planned = [
  // 正規化後再複製：registry 裡手寫的舊檔可能有行尾空白或缺結尾換行
  [join(routeDirectory, "product.yaml"), stringify(product).replace("\nscopes:", "\n\nscopes:")],
  [join(routeDirectory, `${slug}.conf`), baseline[1]],
];

// overlay 只保留「已註冊環境」的條目：申請哪個環境就只動那個環境的 overlay，
// 環境下架時連帶把該環境的條目移除。沒註冊的環境不留佔位。
for (const environment of readdirSync(overlaysDirectory)) {
  const overlayDirectory = join(overlaysDirectory, environment);
  const registered = environments.includes(environment);
  const host = registered
    ? new URL(
        parse(readFileSync(join(productDirectory, "environments", environment, "openapi.yaml"), "utf8"))
          .servers[0].url,
      ).hostname
    : null;
  for (const file of readdirSync(overlayDirectory).filter((name) => name.endsWith(".values.yaml"))) {
    const path = join(overlayDirectory, file);
    const document = parseDocument(readFileSync(path, "utf8"));
    if (registered) {
      document.setIn(["upstreams", productId, "host"], host);
      document.setIn(["upstreams", productId, "port"], 443);
      document.setIn(["upstreams", productId, "keepalive"], 128);
      // 來源若是空的 flow map（upstreams: {}），setIn 之後會變成單行，強制回區塊式
      for (const nodePath of [["upstreams"], ["upstreams", productId]]) {
        const node = document.getIn(nodePath, true);
        if (node) node.flow = false;
      }
    } else {
      if (document.getIn(["upstreams", productId]) === undefined) continue;
      document.deleteIn(["upstreams", productId]);
    }
    // lineWidth: 0 關閉自動折行，否則會動到與這次上架無關的長行
    planned.push([path, document.toString({ lineWidth: 0 })]);
  }
}

for (const [path, content] of planned) {
  const before = existsSync(path) ? readFileSync(path, "utf8") : null;
  const relative = path.slice(appsPath.length + 1);
  if (before === content) {
    console.log(`  = ${relative}（無異動）`);
    continue;
  }
  console.log(`  ${before === null ? "+" : "~"} ${relative}`);
  if (write) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
}
console.log(write ? "\n已寫入。" : "\n這是 dry-run，加 --write 才會落檔。");
