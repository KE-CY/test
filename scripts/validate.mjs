#!/usr/bin/env node

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { parse } from "yaml";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const root = resolve(process.argv[2] ?? join(scriptDirectory, ".."));
const environments = new Set(["lab", "stg", "prod"]);
const methods = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);
const errors = [];

function loadYaml(path) {
  try {
    return parse(readFileSync(path, "utf8"), { uniqueKeys: true });
  } catch (error) {
    errors.push(`${relative(root, path)}: invalid YAML: ${error.message.split("\n")[0]}`);
    return null;
  }
}

function directories(path) {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    errors.push(`${relative(root, path)}/: directory is missing`);
    return [];
  }
}

function validOpenApiPath(path) {
  if (path === "/") return true;
  if (!path.startsWith("/") || path.endsWith("/")) return false;

  return path
    .slice(1)
    .split("/")
    .every(
      (segment) =>
        /^[a-z0-9][a-z0-9._~-]*$/.test(segment) || /^\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(segment),
    );
}

const ajv = new Ajv2020({ allErrors: true });
addFormats(ajv);
const validateProduct = ajv.compile(JSON.parse(readFileSync(join(root, "schemas/product.schema.json"), "utf8")));

function validateSchema(validate, value, path) {
  if (validate(value)) return;

  for (const error of validate.errors) {
    errors.push(`${relative(root, path)}${error.instancePath}: ${error.message}`);
  }
}

const productsDirectory = join(root, "products");
const productDirectories = directories(productsDirectory);
if (productDirectories.length === 0) errors.push("products/: at least one product is required");

const productIds = new Map();
const basePaths = new Map();

for (const productDirectoryName of productDirectories) {
  const productDirectory = join(productsDirectory, productDirectoryName);
  const productPath = join(productDirectory, "product.yaml");
  const product = loadYaml(productPath);
  validateSchema(validateProduct, product, productPath);
  if (!product || typeof product !== "object") continue;

  const { product_id: productId, base_path: basePath, scopes } = product;
  if (productId !== productDirectoryName) errors.push(`${relative(root, productPath)}: directory must match product_id`);

  const scopeCodes = new Set();
  for (const scope of Array.isArray(scopes) ? scopes : []) {
    const scopeCode = scope?.code;
    if (scopeCodes.has(scopeCode)) {
      errors.push(`${relative(root, productPath)}: duplicate scope code ${JSON.stringify(scopeCode)}`);
    } else {
      scopeCodes.add(scopeCode);
    }
  }

  if (productIds.has(productId)) {
    errors.push(`${relative(root, productPath)}: product_id duplicates ${productIds.get(productId)}`);
  } else {
    productIds.set(productId, relative(root, productPath));
  }

  if (basePaths.has(basePath)) {
    errors.push(`${relative(root, productPath)}: base_path duplicates ${basePaths.get(basePath)}`);
  } else {
    basePaths.set(basePath, relative(root, productPath));
  }

  const environmentsDirectory = join(productDirectory, "environments");
  const environmentDirectories = directories(environmentsDirectory);
  if (environmentDirectories.length === 0) {
    errors.push(`${relative(root, environmentsDirectory)}/: at least one environment is required`);
  }

  for (const environment of environmentDirectories) {
    const environmentDirectory = join(environmentsDirectory, environment);
    if (!environments.has(environment)) {
      errors.push(`${relative(root, environmentDirectory)}/: unsupported environment`);
      continue;
    }

    const openapiPath = join(environmentDirectory, "openapi.yaml");
    const openapi = loadYaml(openapiPath);
    if (!openapi || typeof openapi !== "object") continue;

    if (!/^3\.(?:0|1)(?:\.\d+)?$/.test(String(openapi.openapi))) {
      errors.push(`${relative(root, openapiPath)}: OpenAPI version must be 3.0 or 3.1`);
    }

    const servers = openapi.servers;
    if (!Array.isArray(servers) || servers.length !== 1) {
      errors.push(`${relative(root, openapiPath)}: servers must contain exactly one URL`);
    } else {
      const serverUrl = servers[0]?.url;
      try {
        const parsedServerUrl = new URL(serverUrl);
        if (!["http:", "https:"].includes(parsedServerUrl.protocol)) throw new Error();
        if (parsedServerUrl.username || parsedServerUrl.password || parsedServerUrl.search || parsedServerUrl.hash) {
          throw new Error();
        }
        if (parsedServerUrl.pathname !== "/") {
          errors.push(`${relative(root, openapiPath)}: server URL must not include a path`);
        }
        if (serverUrl.endsWith("/")) {
          errors.push(`${relative(root, openapiPath)}: server URL must not end with /`);
        }
      } catch {
        errors.push(`${relative(root, openapiPath)}: server URL must be an absolute HTTP(S) URL`);
      }
    }

    const paths = openapi.paths;
    if (!paths || typeof paths !== "object" || Array.isArray(paths)) {
      errors.push(`${relative(root, openapiPath)}: paths must be an object`);
      continue;
    }

    let operationCount = 0;
    const operationIds = new Set();
    for (const [path, pathItem] of Object.entries(paths)) {
      if (!validOpenApiPath(path)) {
        errors.push(`${relative(root, openapiPath)}: invalid or non-lowercase path ${JSON.stringify(path)}`);
      }
      if (!pathItem || typeof pathItem !== "object" || Array.isArray(pathItem)) continue;
      for (const method of Object.keys(pathItem).filter((key) => methods.has(key))) {
        operationCount += 1;
        const operation = pathItem[method];
        const operationId = operation?.operationId;
        if (typeof operationId !== "string" || operationId.length === 0) {
          errors.push(`${relative(root, openapiPath)}: ${method.toUpperCase()} ${path} requires operationId`);
        } else if (operationIds.has(operationId)) {
          errors.push(`${relative(root, openapiPath)}: duplicate operationId ${JSON.stringify(operationId)}`);
        } else {
          operationIds.add(operationId);
        }

        const scopeCode = operation?.["x-ha-gw-scope"];
        if (typeof scopeCode !== "string" || scopeCode.length === 0) {
          errors.push(`${relative(root, openapiPath)}: ${method.toUpperCase()} ${path} requires x-ha-gw-scope`);
        } else if (!scopeCodes.has(scopeCode)) {
          errors.push(`${relative(root, openapiPath)}: ${method.toUpperCase()} ${path} uses undefined scope ${JSON.stringify(scopeCode)}`);
        }
      }
    }
    if (operationCount === 0) errors.push(`${relative(root, openapiPath)}: at least one operation is required`);
  }
}

if (errors.length > 0) {
  console.error(errors.map((error) => `- ${error}`).join("\n"));
  process.exit(1);
}

console.log(`Registry validation passed (${productDirectories.length} product${productDirectories.length === 1 ? "" : "s"}).`);
