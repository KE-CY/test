#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const methods = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [environment, productId] = process.argv.slice(2);

if (!environment || !productId) {
  console.error("Usage: npm run generate:nginx -- <lab|stg|prod> <product_id>");
  process.exit(1);
}

function readYaml(path) {
  return parse(readFileSync(path, "utf8"), { uniqueKeys: true });
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function pathRegex(path) {
  return path
    .split("/")
    .map((segment) => (/^\{[^}]+\}$/.test(segment) ? "[^/]+" : escapeRegex(segment)))
    .join("/");
}

const productDirectory = join(root, "products", productId);
const product = readYaml(join(productDirectory, "product.yaml"));
const openapi = readYaml(join(productDirectory, "environments", environment, "openapi.yaml"));
const server = new URL(openapi.servers[0].url);
const productSlug = product.product_id.toLowerCase();
const locations = [];

for (const [path, pathItem] of Object.entries(openapi.paths)) {
  const operations = Object.entries(pathItem).filter(([method]) => methods.has(method));
  const lines = [
    `location ~ "^${escapeRegex(product.base_path)}${pathRegex(path)}$" {`,
    `  set $upstream_host $${productSlug}_upstream;`,
    `  set $upstream_endpoint ${server.protocol}//$upstream_host;`,
    `  set $product ${productSlug};`,
    `  set $route "${product.base_path}${path}";`,
    '  set $scope "";',
    "",
  ];

  for (const [method, operation] of operations) {
    lines.push(`  if ($request_method = ${method.toUpperCase()}) {`, `    set $scope "\${product}.${operation["x-ha-gw-scope"]}";`, "  }", "");
  }

  lines.push(
    '  if ($scope = "") {',
    "    return 405;",
    "  }",
    "",
    `  rewrite "^${escapeRegex(product.base_path)}(/.*)$" $1 break;`,
    "",
    "  include /etc/nginx/snippets/authz-proxy.conf;",
    "}",
  );
  locations.push(lines.join("\n"));
}

process.stdout.write(`${locations.join("\n\n")}\n`);
