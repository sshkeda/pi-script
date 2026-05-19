# pi-script

A [pi](https://github.com/earendil-works/pi-mono) extension that toggles a TypeScript-native single-tool mode. The model primarily calls one tool — `script_run` — and writes TypeScript against a generated `pi` SDK that delegates back through pi's normal tools.

## Install

```bash
# From git
pi install git:github.com/sshkeda/pi-script

# From local path
pi install /path/to/pi-script
```

## Usage

Toggle the mode from inside a pi session:

```text
/script on      # expose only script_run to the model
/script off     # restore the previous active tool set
/script status  # show mode and active tools
/script types   # show generated SDK types
/script tools   # list tools callable from scripts
```

Or activate it at launch via environment variable (useful for benchmark subprocesses):

```bash
PI_SCRIPT=1 pi --print --tools script_run "Do the task"
```

`PI_SCRIPT_MODE=1` is an alias.

## SDK example

The SDK is generated from currently registered Pi tools and delegates through native tool definitions when the core `invokeTool` patch is available, so child calls render as native nested tool executions.

```ts
const msg = pi.session.latestUserMessage();
const readme = await pi.read({ path: "README.md" });
const test = await pi.bash({ command: "npm test", background: true });
pi.print("started", test.details?.jobId);
return { user: msg.text, testJob: test.details?.jobId };
```

Production helpers reduce quote soup while preserving the one-tool workflow:

```ts
const py = pi.dedent`
  import json
  print(json.dumps({"ok": True}))
`;
await pi.file("tmp/check.py").write(py);
const run = await pi.exec(["python3", "tmp/check.py"]);
return { output: run.content[0].text.trim() };
```

Available helpers:

- `pi.dedent` — strip common indentation from strings/tagged templates.
- `pi.sh` — shell tagged template; interpolated values are POSIX shell quoted.
- `pi.shellQuote(value)` — quote one value for shell usage.
- `pi.exec(argv, opts)` — run a command vector via the bash tool with safe quoting.
- `pi.writeText(path, content)` — write text through the write tool.
- `pi.file(path).write` — file write helper, including tagged-template writes.
- `pi.bg` — start a background bash job.
- `pi.table(rows, columns?)` — return compact table-shaped data.
- `pi.parallel(tasks, { concurrency })` — run independent async tasks with a limit.
- `pi.importModule(specifier)` — load helper modules relative to the session cwd.

## How it works

- Model-visible output stays compact: final results use a `pi_context` envelope with call summaries, built-in truncation, and a full-output temp file when truncated.
- The TUI renderer shows a compact native-style `Pi Script: N calls` result, with expanded call details on demand.
- Script timeouts abort nested tool calls when possible and always clear timers.
- Static module syntax is rejected with a targeted error; use `await pi.importModule(...)` for helpers. String contents that look like imports are allowed.

## Safety note

Pi Script uses a Node VM/transpile runtime for local automation. It is not a hardened security sandbox. Treat scripts as trusted agent code and rely on pi's tool permissions/hooks for file and process effects.

## License

MIT
