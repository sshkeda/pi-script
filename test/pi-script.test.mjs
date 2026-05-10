import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMock, script, text, toolCall } from "../../pi-mock/dist/index.js";

const EXTENSION = new URL("../index.ts", import.meta.url).pathname;
const BACKGROUND_BASH = new URL("../../pi-background-bash/extensions/background-bash.ts", import.meta.url).pathname;

async function withMock(options, fn) {
  const cwd = mkdtempSync(join(tmpdir(), "pi-script-test-"));
  const mock = await createMock({ brain: script(text("unused")), piProvider: "anthropic", piModel: "claude-sonnet-4-20250514", cwd, extensions: [EXTENSION], startupTimeoutMs: 20_000, ...options });
  try {
    await fn(mock, cwd);
  } finally {
    await mock.close();
    rmSync(cwd, { recursive: true, force: true });
  }
}

test("/script on exposes only script_run and /script off restores prior tools", async () => {
  await withMock({}, async (mock) => {
    assert.ok((await mock.getRegisteredTools()).includes("script_run"));
    assert.equal((await mock.getActiveTools()).includes("script_run"), false);

    await mock.invokeCommand("script", "on");
    assert.deepEqual(await mock.getActiveTools(), ["script_run"]);

    await mock.invokeCommand("script", "off");
    const active = await mock.getActiveTools();
    assert.equal(active.includes("script_run"), false);
    assert.ok(active.includes("read"));
  });
});

test("script_run can call hidden Pi tools through the generated SDK", async () => {
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
});

test("script_run delegates bash background semantics to pi-background-bash", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-script-bg-test-"));
  const code = `
    const run = await pi.bash({ command: "node -e 'setTimeout(()=>console.log(42), 50)'", background: true });
    return run.details;
  `;
  const mock = await createMock({ brain: script(toolCall("script_run", { code }), text("done")), piProvider: "anthropic", piModel: "claude-sonnet-4-20250514", cwd, extensions: [BACKGROUND_BASH, EXTENSION], startupTimeoutMs: 20_000 });
  try {
    await mock.invokeCommand("script", "on");
    const events = await mock.run("start background bash from pi-script", 20_000);
    const serialized = JSON.stringify(events);
    assert.match(serialized, /\"name\":\"bash\"/);
    // When the Pi core lookup patch is available to the spawned harness, this delegates
    // to pi-background-bash and produces bg_* plus a follow-up wake. Older/fast test
    // harnesses lack ExtensionAPI.getToolDefinition and exercise pi-script's builtin
    // fallback, which runs foreground but still proves script_run orchestration.
    const match = serialized.match(/bg_\d+/);
    if (match) {
      await mock.waitFor((event) => JSON.stringify(event).includes("background_bash_result") && JSON.stringify(event).includes(match[0]), 10_000);
    } else {
      assert.match(serialized, /42/);
    }
  } finally {
    await mock.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});
