import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { writeFile, unlink } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMock, script, text, toolCall } from "../../pi-mock/dist/index.js";

const EXTENSION = new URL("../index.ts", import.meta.url).pathname;
const BACKGROUND_BASH = new URL("../../pi-background-bash/extensions/background-bash.ts", import.meta.url).pathname;
const PI_BINARY = process.env.PI_SCRIPT_TEST_PI_BINARY ?? execFileSync("which", ["-a", "pi"], { encoding: "utf8" })
  .split("\n")
  .find((path) => path && !path.includes("/node_modules/.bin/")) ?? "pi";

async function withMock(options, fn) {
  const cwd = mkdtempSync(join(tmpdir(), "pi-script-test-"));
  const mock = await createMock({ brain: script(text("unused")), piProvider: "anthropic", piModel: "claude-sonnet-4-20250514", piBinary: PI_BINARY, cwd, extensions: [EXTENSION], startupTimeoutMs: 20_000, ...options });
  try {
    await fn(mock, cwd);
  } finally {
    await mock.close();
    rmSync(cwd, { recursive: true, force: true });
  }
}

test("pi-script mode, SDK tool calls, and background-bash delegation", async () => {
  await withMock({}, async (mock) => {
    assert.ok((await mock.getRegisteredTools()).includes("script_run"));
    assert.equal((await mock.getActiveTools()).includes("script_run"), false);

    const onResult = await mock.invokeCommand("script", "on");
    assert.deepEqual(await mock.getActiveTools(), ["script_run"]);
    assert.ok(onResult.statusUpdates.some((update) => update.key === "pi-script" && update.text === undefined));

    const offResult = await mock.invokeCommand("script", "off");
    assert.ok(offResult.statusUpdates.some((update) => update.key === "pi-script" && update.text === undefined));
    const active = await mock.getActiveTools();
    assert.equal(active.includes("script_run"), false);
    assert.ok(active.includes("read"));
  });

  await withMock({}, async (mock, cwd) => {
    writeFileSync(join(cwd, "hello.txt"), "hello from pi-script\n");
    await mock.invokeCommand("script", "on");

    const result = await mock.invokeTool("script_run", {
      code: `
        const user = pi.session.latestUserMessage();
        const read = await pi.read({ path: "hello.txt" });
        pi.print("read complete");
        return { cwd: pi.session.cwd(), userText: user.text, body: read.content[0].text };
      `,
    });

    assert.equal(result.ok, true, result.error);
    const details = result.result?.details;
    assert.equal(details.returnValue.body.includes("hello from pi-script"), true);
    assert.deepEqual(details.prints, ["read complete"]);
    assert.equal(details.calls[0].name, "read");
  });

  const helper = new URL("../tmp-pi-script-helper.mjs", import.meta.url);
  await writeFile(helper, "export function upper(value) { return String(value).toUpperCase(); }\n");
  try {
    await withMock({}, async (mock) => {
      await mock.invokeCommand("script", "on");
      const result = await mock.invokeTool("script_run", {
        code: `
          const helper = await pi.importModule("${helper.pathname}");
          return helper.upper("local sdk works");
        `,
      });
      assert.equal(result.ok, true, result.error);
      assert.equal(result.result?.details?.returnValue, "LOCAL SDK WORKS");
    });
  } finally {
    await unlink(helper).catch(() => {});
  }

  const cwd = mkdtempSync(join(tmpdir(), "pi-script-bg-test-"));
  const code = `
    const run = await pi.bash({ command: "sleep 0.2; echo 42", background: true });
    return run.details;
  `;
  const mock = await createMock({ brain: script(toolCall("script_run", { code }), text("done")), piProvider: "anthropic", piModel: "claude-sonnet-4-20250514", piBinary: PI_BINARY, cwd, extensions: [BACKGROUND_BASH, EXTENSION], startupTimeoutMs: 20_000 });
  try {
    await mock.invokeCommand("script", "on");
    const events = await mock.run("start background bash from pi-script", 20_000);
    const starts = events.filter((event) => event.type === "tool_execution_start");
    const scriptStart = starts.find((event) => event.toolName === "script_run");
    const bashStart = starts.find((event) => event.toolName === "bash");
    assert.ok(scriptStart);
    assert.ok(bashStart);
    assert.ok(bashStart.toolCallId.startsWith(`${scriptStart.toolCallId}.`));

    const serialized = JSON.stringify(events);
    assert.match(serialized, /\"name\":\"bash\"/);
    assert.doesNotMatch(serialized, /builtin-fallback/);
    assert.match(serialized, /Bash job bg_\d+ started in background|outcome.?:.?running/);
    const match = serialized.match(/bg_\d+/);
    assert.ok(match);
    await mock.waitFor((event) => JSON.stringify(event).includes("background_bash_result") && JSON.stringify(event).includes(match[0]), 10_000);
  } finally {
    await mock.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});
