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

Pi Script is one Pi tool with one primary payload: TypeScript code for script_run.
Inside code, use the global pi SDK to call normal Pi tools. Treat script_run as
Pi's tool protocol expressed in TypeScript, not arbitrary Node execution.

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

## Production helpers

Use the built-in helpers instead of manually nesting shell/Python/JS quote soup.

### Generated files and command vectors

```ts
const py = pi.dedent`
  import json
  print(json.dumps({"ok": True}))
`;
await pi.file(".pi/tmp/check.py").write(py);
const run = await pi.exec(["python3", ".pi/tmp/check.py"], { timeout: 30 });
return { output: run.content[0]?.text?.trim() };
```

### Shell templates with safe interpolation

```ts
const branch = "feature/quote test";
const status = await pi.bash({ command: pi.sh`
  git status --short --branch ${branch}
` });
return { status: status.content[0]?.text };
```

### Background jobs

```ts
const job = await pi.bg`
  npm test
`;
return { job: job.details };
```

Useful helpers:

- pi.dedent — strip common indentation from strings/tagged templates.
- pi.sh — shell tagged template; interpolated values are POSIX shell quoted.
- pi.shellQuote(value) — quote one value for shell usage.
- pi.exec(argv, opts) — run a command vector through the bash tool.
- pi.writeText(path, content) and pi.file(path).write(...) — write via the write tool.
- pi.bg — start a background bash command.
- pi.table(rows, columns?) — return compact table-shaped data.
- pi.parallel(tasks, { concurrency }) — run independent async tasks with a limit.

## Tool calls and native path

- Prefer convenience wrappers like pi.read(args), pi.edit(args), pi.bash(args), and pi.exec(args).
- Child calls should emit native nested tool events when the Pi core patch is active.
- If a result's call summary shows [builtin-fallback], the script used a compatibility
  fallback instead of a native registered tool definition. Re-run after /reload or report
  it as a core/extension lookup issue if it persists.
- Background bash should go through the active bash tool using background:true or pi.bg.

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

4. For destructive operations, validate inputs first, then perform the mutation in a small script.
5. If script_run times out, nested tool calls should be aborted when the underlying tool honors AbortSignal.

## Context efficiency

- Do not duplicate tool outputs in return if the called tool already returned them.
  Return counts, paths, job ids, and short summaries.
- Use pi.parallel(tasks, { concurrency: N }) for many independent reads/checks, but
  keep N modest (3-8) to avoid noisy failures.
- If you need large output later, return a path to a file or ask the underlying tool to
  save/read the full output rather than stuffing it into the Pi Script return value.

## Language direction

Keep TypeScript for control flow. Prefer Pi-native SDK helpers over a brand-new language
or extra tool parameters. Do not invent new loop/condition/function syntax; add only helpers
for shell, files, background jobs, module loading, and rendering.
