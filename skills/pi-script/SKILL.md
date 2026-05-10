---
name: pi-script
version: 0.2.0
description: >
  Use Pi Script well: write compact TypeScript for script_run, avoid quote soup,
  recover from script/tool errors, keep context efficient, and prefer native nested tool paths.
---

# Pi Script

Use this skill when /script on is active, when the only model-visible tool is
script_run, or when debugging Pi Script tool orchestration.

## Mental model

Pi Script is one Pi tool with one parameter:

```json
{ "code": "TypeScript body" }
```

Inside that single code string, use the global pi SDK to call normal Pi tools.
Treat script_run as Pi's tool protocol expressed in TypeScript, not arbitrary Node execution.

## Core rules

- Keep scripts short and single-purpose. Prefer one clear script per observation/action batch.
- Use the global pi object only. Do not use raw fs, child_process, process,
  fetch, require, or static import statements in script bodies.
- For reusable helpers, call await pi.importModule("./path/to/helper.js") rather
  than putting large helper code in the script body.
- Return a small JSON-serializable summary. Do not return full file contents or huge
  command output unless the user explicitly needs it.
- Use pi.print(...) only for progress or important model-visible facts.
- Use pi.log(...) for debug notes that should stay out of model context.

## Avoid quote soup

Nested shell/Python/JS inside the JSON code parameter can get ugly. Prefer these patterns:

### Write files, then run them

Good for generated scripts or larger snippets:

```ts
const py = String.raw`
import json
print(json.dumps({"ok": True}))
`;
await pi.write({ path: ".pi/tmp/check.py", content: py });
const run = await pi.bash({ command: "python3 .pi/tmp/check.py", timeout: 30 });
return { output: run.content[0]?.text };
```

### Use files instead of nested quote soup

For complex shell, write a small .sh file first:

```ts
const sh = String.raw`
set -euo pipefail
cd ../pi-stat422
python3 scripts/run_needle_mode_compare.py \
  --provider pi-codex \
  --model gpt-5.4-mini
`;
await pi.write({ path: ".pi/tmp/run-bench.sh", content: sh });
await pi.bash({ command: "bash .pi/tmp/run-bench.sh", timeout: 300, background: true });
return { started: true };
```

### Avoid static module syntax in script bodies

Current Pi Script MVP rejects static module syntax. If you need runtime helpers, use:

```ts
const helper = await pi.importModule("./helper.js");
return helper.summarize(await pi.ls({ path: "." }));
```

## Tool calls and native path

- Prefer convenience wrappers like pi.read(args), pi.edit(args), and pi.bash(args).
- Child calls should emit native nested tool events when the Pi core patch is active.
- If a result's call summary shows [builtin-fallback], the script used a compatibility
  fallback instead of a native registered tool definition. That is acceptable for tests
  but not ideal for production behavior. Re-run after /reload or report it as a Pi
  core/extension lookup issue if it persists.
- Background bash should go through the active bash tool:

```ts
const run = await pi.bash({ command: "npm test", background: true, timeout: 120 });
return { jobId: run.details?.jobId };
```

When the background result arrives as pi-background-bash context, treat it as the final bash result.

## Error recovery

If a Pi Script fails with a TypeScript/syntax/runtime error:

1. Read the diagnostic line/column and fix only that problem first.
2. Do not rewrite the whole script unless the design is wrong.
3. For multi-step scripts, wrap risky independent operations and return structured results:

```ts
const results = [];
for (const path of paths) {
  try {
    const result = await pi.read({ path });
    results.push({ path, ok: true, preview: result.content[0]?.text?.slice(0, 120) });
  } catch (error) {
    results.push({ path, ok: false, error: String(error) });
  }
}
return { results };
```

4. For destructive operations (write, edit, bash with mutations), prefer validating
   inputs first, then perform the mutation in a small script.

## Context efficiency

- Do not duplicate tool outputs in return if the called tool already returned them.
  Return counts, paths, job ids, and short summaries.
- Use pi.parallel(tasks, { concurrency: N }) for many independent reads/checks, but
  keep N modest (3-8) to avoid noisy failures.
- If you need large output later, return a path to a file or ask the underlying tool to
  save/read the full output rather than stuffing it into the Pi Script return value.

## Desired language direction

The design goal is still one tool, one parameter. Prefer improving the language/SDK
inside code rather than adding more tool parameters. If Pi Script grows, favor a
small TypeScript dialect/profile with Pi-native helpers over a brand-new language:

```ts
await $bash`npm test`;
await $file("tmp.py").write`
  print("hello")
`;
return $table(rows);
```

Do not invent new loop/condition/function syntax. Keep TypeScript for control flow;
add only Pi-specific helpers for shell, files, background jobs, module loading, and rendering.
