import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "scripts", "issue-to-files.mjs");

const spec = (host, operation = "get") => `openapi: 3.0.3
info:
  title: PERF API
  version: 1.0.0
servers:
  - url: https://${host}
paths:
  /things:
    ${operation}:
      operationId: ${operation}Things
      x-ha-gw-scope: perf.organization.read
      responses:
        "200":
          description: Success
`;

// 腳本是用 fetch 抓附件，所以測試自己起一個 server 當附件來源
const server = createServer((request, response) => {
  if (request.url === "/lab.yaml") response.end(spec("lab.104.com.tw"));
  else if (request.url === "/lab-post.yaml") response.end(spec("lab.104.com.tw", "post"));
  else if (request.url === "/stg.yaml") response.end(spec("stg.104.com.tw"));
  else if (request.url === "/swagger.json") response.end(JSON.stringify({ openapi: "3.0.3" }));
  else {
    response.statusCode = 404;
    response.end("not found");
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}/`;
after(() => server.close());

const attachment = (name) => `[${name}](${origin}${name})`;
const section = (label, value) => `### ${label}\n\n${value || "_No response_"}\n\n`;

const ORGANIZATION = "perf.organization.read | 查詢組織 | 允許查詢組織資料";
const EMPLOYEE = "perf.employee.read | 查詢員工 | 允許查詢員工資料";

const uploads = ({ lab = "", stg = "", prod = "" }) =>
  section("lab OpenAPI 檔案", lab) + section("stg OpenAPI 檔案", stg) + section("prod OpenAPI 檔案", prod);

const common = ({ owner = "team-perf@104.com.tw", basePath = "/perf" }) =>
  section("產品編號", "P0078") + section("產品負責人 email", owner) + section("對外路徑前綴", basePath);

const addBody = (f = {}) =>
  common(f) +
  section("目標環境", f.environments ?? "lab") +
  section("新增的 Scopes", f.scopes ?? ORGANIZATION) +
  uploads({ lab: f.lab ?? attachment("lab.yaml"), stg: f.stg, prod: f.prod });

const updateBody = (f = {}) =>
  common(f) + section("要更新的環境", f.environments) + section("Scopes", f.scopes) + uploads(f);

const removeBody = (f = {}) =>
  common(f) +
  section("要移除的環境", f.environments ?? "lab") +
  section("移除確認", `- [${f.confirmed === false ? " " : "x"}] 我確認勾選環境的 API 會全部下架，且已通知使用這些 API 的對象`);

const registered = `product_id: P0078
owner: team-perf@104.com.tw
base_path: /perf

scopes:
  - code: perf.organization.read
    name: 查詢組織
    description: 允許查詢組織資料
  - code: perf.employee.read
    name: 查詢員工
    description: 允許查詢員工資料
`;

// 必須非同步執行：腳本會 fetch 這支測試自己起的 server，同步等待會死鎖
async function withRun(request, body, assertions, environments = []) {
  const cwd = mkdtempSync(join(tmpdir(), "issue-to-files-"));
  try {
    if (environments.length > 0) {
      mkdirSync(join(cwd, "products", "P0078"), { recursive: true });
      writeFileSync(join(cwd, "products", "P0078", "product.yaml"), registered);
      for (const environment of environments) {
        const dir = join(cwd, "products", "P0078", "environments", environment);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "openapi.yaml"), spec(`${environment}.104.com.tw`));
      }
    }
    const result = await promisify(execFile)(process.execPath, [script], {
      cwd,
      env: {
        ...process.env,
        ISSUE_BODY: body,
        ISSUE_LABELS: JSON.stringify(["api-registration", `request:${request}`]),
        ATTACHMENT_HOST: origin,
        GITHUB_OUTPUT: "",
      },
    }).catch((error) => error);
    await assertions(cwd, { status: result.code ?? 0, stdout: result.stdout, stderr: result.stderr });
  } finally {
    rmSync(cwd, { recursive: true });
  }
}

const product = (cwd) => parse(readFileSync(join(cwd, "products", "P0078", "product.yaml"), "utf8"));
const codes = (cwd) => product(cwd).scopes.map((scope) => scope.code);
const openapi = (cwd, environment) =>
  readFileSync(join(cwd, "products", "P0078", "environments", environment, "openapi.yaml"), "utf8");

// ── 申請新增 ──────────────────────────────────────────────

test("add registers a brand new product", async () => {
  await withRun("add", addBody({ environments: "lab, stg", stg: attachment("stg.yaml") }), (cwd, result) => {
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /申請新增 P0078（lab, stg）/);
    assert.match(result.stdout, /新增 scope：perf\.organization\.read/);
    assert.match(result.stdout, /新增環境：lab、stg/);
    assert.match(openapi(cwd, "lab"), /lab\.104\.com\.tw/);
    assert.match(openapi(cwd, "stg"), /stg\.104\.com\.tw/);
    assert.equal(
      readFileSync(join(cwd, "products", "P0078", "product.yaml"), "utf8"),
      `product_id: P0078
owner: team-perf@104.com.tw
base_path: /perf

scopes:
  - code: perf.organization.read
    name: 查詢組織
    description: 允許查詢組織資料
`,
    );
  });
});

test("add opens a new environment on a registered product and reuses its scopes", async () => {
  await withRun(
    "add",
    addBody({ environments: "stg", lab: "", stg: attachment("stg.yaml"), scopes: `${ORGANIZATION}\n${EMPLOYEE}` }),
    (cwd, result) => {
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /新增環境：stg/);
      assert.doesNotMatch(result.stdout, /新增 scope/);
      assert.deepEqual(codes(cwd), ["perf.organization.read", "perf.employee.read"]);
    },
    ["lab"],
  );
});

test("add refuses an environment that already exists", async () => {
  await withRun(
    "add",
    addBody({ environments: "lab" }),
    (cwd, result) => {
      assert.equal(result.status, 1);
      assert.match(result.stderr, /lab 環境已經註冊過，後續調整請用「申請更新」/);
    },
    ["lab"],
  );
});

test("add refuses a reused scope code whose content differs", async () => {
  await withRun(
    "add",
    addBody({ environments: "stg", lab: "", stg: attachment("stg.yaml"), scopes: "perf.organization.read | 組織 | 改了說明" }),
    (cwd, result) => {
      assert.equal(result.status, 1);
      assert.match(result.stderr, /已經註冊且內容不同，要改名稱或說明請用「申請更新」/);
    },
    ["lab"],
  );
});

test("add requires every field", async () => {
  await withRun("add", addBody({ owner: "", basePath: "", environments: "", scopes: "", lab: "" }), (cwd, result) => {
    assert.equal(result.status, 1);
    for (const message of [/缺少「產品負責人 email」/, /缺少「對外路徑前綴」/, /必須選「目標環境」/, /必須填「新增的 Scopes」/]) {
      assert.match(result.stderr, message);
    }
  });
});

test("add requires an upload for every selected environment", async () => {
  await withRun("add", addBody({ environments: "lab, stg" }), (cwd, result) => {
    assert.equal(result.status, 1);
    assert.match(result.stderr, /stg 需要上傳 OpenAPI 檔案/);
  });
});

// ── 申請更新 ──────────────────────────────────────────────

test("update adds a new scope to a registered product", async () => {
  await withRun(
    "update",
    updateBody({ scopes: "perf.salary.read | 查詢薪資 | 允許查詢薪資資料" }),
    (cwd, result) => {
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /新增 scope：perf\.salary\.read/);
      assert.deepEqual(codes(cwd), ["perf.organization.read", "perf.employee.read", "perf.salary.read"]);
    },
    ["lab"],
  );
});

test("update modifies a registered scope and leaves the others alone", async () => {
  await withRun(
    "update",
    updateBody({ scopes: "perf.organization.read | 組織查詢 | 允許查詢組織與部門資料" }),
    (cwd, result) => {
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /更新 scope：perf\.organization\.read/);
      assert.equal(product(cwd).scopes[0].name, "組織查詢");
      assert.equal(product(cwd).scopes[1].name, "查詢員工");
    },
    ["lab"],
  );
});

test("update replaces an environment OpenAPI and reports the operations", async () => {
  await withRun(
    "update",
    updateBody({ environments: "lab", lab: attachment("lab-post.yaml") }),
    (cwd, result) => {
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /lab 新增 operation：POST \/things/);
      assert.match(result.stdout, /lab 移除 operation：GET \/things/);
    },
    ["lab"],
  );
});

test("update adds a scope and the operation that uses it in one request", async () => {
  await withRun(
    "update",
    updateBody({
      environments: "lab",
      lab: attachment("lab-post.yaml"),
      scopes: "perf.salary.read | 查詢薪資 | 允許查詢薪資資料",
    }),
    (cwd, result) => {
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /新增 scope：perf\.salary\.read/);
      assert.match(result.stdout, /更新環境：lab/);
    },
    ["lab"],
  );
});

test("update changes the owner and the base path", async () => {
  await withRun(
    "update",
    updateBody({ owner: "api-center@104.com.tw", basePath: "/perf2" }),
    (cwd, result) => {
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /更新 owner：team-perf@104\.com\.tw → api-center@104\.com\.tw/);
      assert.match(result.stdout, /更新 base_path：\/perf → \/perf2（既有呼叫方的路徑會改變）/);
    },
    ["lab"],
  );
});

test("update refuses an unregistered product or environment", async () => {
  await withRun("update", updateBody({ scopes: ORGANIZATION }), (cwd, result) => {
    assert.equal(result.status, 1);
    assert.match(result.stderr, /還沒註冊，請改用「申請新增」/);
  });
  await withRun(
    "update",
    updateBody({ environments: "stg", stg: attachment("stg.yaml") }),
    (cwd, result) => {
      assert.equal(result.status, 1);
      assert.match(result.stderr, /stg 環境還沒註冊，請用「申請新增」/);
    },
    ["lab"],
  );
});

test("update refuses a request that changes nothing", async () => {
  await withRun(
    "update",
    updateBody({ scopes: ORGANIZATION }),
    (cwd, result) => {
      assert.equal(result.status, 1);
      assert.match(result.stderr, /沒有任何要更新的內容/);
    },
    ["lab"],
  );
});

// ── 申請移除 ──────────────────────────────────────────────

test("remove drops only the selected environment", async () => {
  await withRun(
    "remove",
    removeBody({ environments: "stg" }),
    (cwd, result) => {
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /申請移除 P0078（stg）/);
      assert.match(result.stdout, /移除環境：stg（保留 lab）/);
      assert.equal(existsSync(join(cwd, "products", "P0078", "environments", "stg")), false);
      assert.equal(existsSync(join(cwd, "products", "P0078", "environments", "lab")), true);
      // 局部移除不該動到 product.yaml
      assert.equal(readFileSync(join(cwd, "products", "P0078", "product.yaml"), "utf8"), registered);
    },
    ["lab", "stg"],
  );
});

test("remove takes the whole product down when every environment is selected", async () => {
  await withRun(
    "remove",
    removeBody({ environments: "lab, stg" }),
    (cwd, result) => {
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /移除整個產品 P0078（環境：lab、stg；scope 2 個）/);
      assert.equal(existsSync(join(cwd, "products", "P0078")), false);
    },
    ["lab", "stg"],
  );
});

test("remove refuses an environment that is not registered", async () => {
  await withRun(
    "remove",
    removeBody({ environments: "prod" }),
    (cwd, result) => {
      assert.equal(result.status, 1);
      assert.match(result.stderr, /prod 環境不存在/);
    },
    ["lab"],
  );
});

test("remove requires an environment", async () => {
  await withRun(
    "remove",
    removeBody({ environments: "" }),
    (cwd, result) => {
      assert.equal(result.status, 1);
      assert.match(result.stderr, /必須選「要移除的環境」/);
    },
    ["lab"],
  );
});

test("remove requires the confirmation", async () => {
  await withRun(
    "remove",
    removeBody({ confirmed: false }),
    (cwd, result) => {
      assert.equal(result.status, 1);
      assert.match(result.stderr, /請勾選「移除確認」/);
    },
    ["lab"],
  );
});

test("remove refuses a product whose owner does not match", async () => {
  await withRun(
    "remove",
    removeBody({ owner: "someone-else@104.com.tw" }),
    (cwd, result) => {
      assert.equal(result.status, 1);
      assert.match(result.stderr, /產品負責人 email 與 P0078 已註冊的不符/);
    },
    ["lab"],
  );
});

test("remove refuses an unregistered product", async () => {
  await withRun("remove", removeBody(), (cwd, result) => {
    assert.equal(result.status, 1);
    assert.match(result.stderr, /還沒註冊，請改用「申請新增」/);
  });
});

// ── 上傳與標籤 ────────────────────────────────────────────

test("rejects an external link, a pasted document and a JSON upload", async () => {
  await withRun("add", addBody({ lab: "[openapi.yaml](https://dp-perf.104dc-dev.com/openapi.yaml)" }), (cwd, result) => {
    assert.match(result.stderr, /只接受拖曳上傳的附件，不接受外部連結/);
  });
  await withRun("add", addBody({ lab: "openapi: 3.0.3" }), (cwd, result) => {
    assert.match(result.stderr, /沒有附件/);
  });
  await withRun("add", addBody({ lab: attachment("swagger.json") }), (cwd, result) => {
    assert.match(result.stderr, /只接受 \.yaml/);
  });
});

test("rejects an upload for an environment that was not selected", async () => {
  await withRun("add", addBody({ prod: attachment("stg.yaml") }), (cwd, result) => {
    assert.equal(result.status, 1);
    assert.match(result.stderr, /沒勾選 prod/);
  });
});

test("reports an unreachable upload", async () => {
  await withRun("add", addBody({ lab: attachment("missing.yaml") }), (cwd, result) => {
    assert.equal(result.status, 1);
    assert.match(result.stderr, /抓不到 lab 的 OpenAPI/);
  });
});

test("rejects an issue with no request label", async () => {
  await withRun("none", addBody(), (cwd, result) => {
    assert.equal(result.status, 1);
    assert.match(result.stderr, /沒有 request:add/);
  });
});
