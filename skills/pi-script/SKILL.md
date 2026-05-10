---
name: pi-script
version: 0.1.0
description: >
  Use Pi Script well: write small TypeScript scripts for script_run, recover from
  script/type errors, keep context efficient, and avoid fallback/non-native tool paths.
---

# Pi Script

Use this skill when `/script on` is active, when the only model-visible tool is
`script_run`, or when debugging Pi Script tool orchestration.

## Core rules

- Treat `script_run` as Pi's tool protocol expressed in TypeScript, not arbitrary
  Node execution.
- Keep scripts short and single-purpose. Prefer one clear script per observation/action batch.
- Use the global `pi` object only. Do not use raw `fs`, `child_process`, `process`,
  `fetch`, `require`, or static `import` statements in script bodies.
- For reusable helpers, call `await pi.importModule("./path/to/helper.js")` rather
  than putting large helper code in the script body.
- Return a small JSON-serializable summary. Do not return full file contents or huge
  command output unless the user explicitly needs it.
- Use `pi.print(...)` only for progress or important model-visible facts.
- Use `pi.log(...)` for debug notes that should stay out of model context.

## Error recovery

If a Pi Script fails with a TypeScript/syntax/runtime error:

1. Read the diagnostic line/column and fix only that problem first.
2. Do not rewrite the whole script unless the design is wrong.
3. For multi-step scripts, wrap risky independent operations and return structured results:

```ts
const results = [];
for (const path of paths) {
  try {
    results.push({ path, ok: true, result: await pi.read({ path }) });
  } catch (error) {
    results.push({ path, ok: false, error: String(error) });
  }
}
return { results };
```

4. For destructive operations (`write`, `edit`, `bash` with mutations), prefer validating
   inputs first, then perform the mutation in a small script.

## Tool calls and native path

- Prefer convenience wrappers like `pi.read(args)`, `pi.edit(args)`, and `pi.bash(args)`.
- If a result's call summary shows `[builtin-fallback]`, the script used a compatibility
  fallback instead of a native registered tool definition. That is acceptable for tests
  but not ideal for production behavior. Re-run after `/reload` or report it as a Pi
  core/extension lookup issue if it persists.
- Background bash should go through the active `bash` tool:

```ts
const run = await pi.bash({ command: "npm test", background: true, timeout: 120 });
return { jobId: run.details?.jobId };
```

When the background result arrives as `<pi_context source="pi-background-bash" ...>`,
treat it as the final bash result.

## Context efficiency

- Do not duplicate tool outputs in `return` if the called tool already returned them.
  Return counts, paths, job ids, and short summaries.
- Use `pi.parallel(tasks, { concurrency: N })` for many independent reads/checks, but
  keep `N` modest (3-8) to avoid noisy failures.
- If you need large output later, return a path to a file or ask the underlying tool to
  save/read the full output rather than stuffing it into the Pi Script return value.
