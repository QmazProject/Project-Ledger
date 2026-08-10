# CodeLedger Protocol

Before changing code, analyze the user request (CLI: `codeledger prompt "<task>"`; MCP: `codeledger_analyze_prompt`), then query CodeLedger pre-change intelligence (CLI: `codeledger plan "<task>"`; MCP: `codeledger_get_plan`) and context (MCP: `codeledger_get_context`). Review relevant symbols, history, issues, decisions, impact, risk, constraints, acceptance criteria, and suggested tests before inspecting broad source areas. State your proposed files, implementation, and tests, then submit it for alignment (CLI: `codeledger handshake "<task>" --ai-plan "<plan>"`; MCP: `codeledger_task_handshake`). If the handshake warns, revise the plan before editing. Prefer targeted inspection; avoid repository-wide scans when CodeLedger says they are unnecessary. After changing code, refresh/record changed files (CLI: `codeledger refresh --changed`; MCP: `codeledger_refresh`), review any scope `WARNING`, run affected tests, and record verification evidence. If verification fails after a previous pass, query regressions (MCP: `codeledger_get_regressions`).

## Before writing new code: what already exists, and what a change would reach

`plan` answers two questions the source alone does not, and both change what you should do next.

**`shared_dependencies` / `blast_radius`** — the symbol you are about to change is used elsewhere. The report names the files and the areas a change reaches. Read them before editing. Do not treat a small or empty dependent list as proof a change is contained: check `blast_radius.confidence` and `coverage_caveat` first, because a shallowly analysed file records its edges conservatively and `LOW` confidence means the evidence is incomplete, not that the change is safe.

**`scope_ambiguity`** — the request touches something shared and never says how widely it should apply. Ask the user which scope they meant, offering the affected areas. Do not silently pick one, and do not change all of them on the assumption that wider is safer. When the request already names a scope, no question is raised and none should be invented.

`handshake` adds a third: **`duplicate_implementation`** means your plan creates something this project appears to already have, and lists the existing symbols to inspect. Read them and reuse or extend them if they fit. It is a recommendation, not a rejection — a new implementation is sometimes right, and when it is, say why rather than proceeding silently.

## Continuing work from a previous session

Your context window is temporary; this project's memory is not. At the **start** of a session, before reading source files, ask whether this task has been worked on before (CLI: `codeledger resume "<task>"`; MCP: `codeledger_get_resume` with the user's request as `task`). Selection is by relevance, so an unrelated previous task is never loaded — a `NO_RELEVANT_CHECKPOINT` answer means start fresh. When a checkpoint is returned, read `next_action` first, then `failed_attempts`: those are approaches already known not to work, and repeating them is the specific waste this exists to prevent. Everything in a resume package has been re-checked against the current source; anything that no longer holds is listed under `stale_items` and must not be trusted.

Before a session **ends**, or when your context is running low, record a checkpoint (MCP: `codeledger_get_session_state`, then `codeledger_record_checkpoint`). CodeLedger assembles what it observed — changes, files, symbols, verifications — but it cannot see your conversation, so you must supply `goal`, `current_state`, what was accomplished, what failed, what is unresolved, and the single `next_action` that would most help whoever continues. If your runtime reports context usage, pass `context_window` and `context_used`; if it does not, omit them and everything still works.

A checkpoint is a summary, and summaries rank below source code, the filesystem, tests, and recorded changes. Never let one override what the code currently says.

## Working alongside another agent

More than one agent may be editing this project. At the start of a turn, ask what changed while you were not looking (CLI: `codeledger since --agent <your name>`; MCP: `codeledger_get_changes_since` with your own agent name). It reports the files and symbols another agent changed since you last recorded anything, so you do not overwrite work you cannot see. If another agent is live, check for overlap before editing (MCP: `codeledger_check_conflicts` with your name and the files/symbols you intend to touch). A shared symbol is a stronger warning than a shared file: re-read that symbol before changing it.

Claim your own edits by calling `codeledger_refresh` (MCP) or `codeledger refresh --changed --agent <your name> --request "<task>"` after you finish. An agent refreshing on its own behalf is the only HIGH-confidence record of who changed what. The `watch` process observes the filesystem, which cannot show which process wrote a file, so everything it records is `unknown` at LOW confidence — never assume a LOW-confidence change was yours, and never treat one as evidence that nobody else is working.

## If a task did not work the first time

Before retrying a request that produced no visible result, ask what the previous attempt actually did (CLI: `codeledger progress "<task>"`; MCP: `codeledger_get_progress`). Do not re-read the repository to work it out. The answer is one of:

- `NO_EFFECT` — earlier attempts changed no symbol, only text or nothing. The edit is not reaching the code that runs. Confirm which file is actually imported and executed before editing again.
- `REPEATING` — the same symbols have been edited repeatedly and verification still fails. Editing them again is unlikely to help. Re-read the failure output, widen the search with `codeledger impact <symbol>`, or ask the user whether the request describes the real problem.
- `UNVERIFIED` — real symbols changed but nothing was verified. Record evidence with `codeledger verify-run project project TEST -- <command>`.
- `VERIFIED` — verification passed after the last attempt. Stop editing and report it.

A refresh reports `effect` for every attempt: `symbols-changed`, `text-only`, or `none`. Treat anything other than `symbols-changed` as a task that has not been done yet, whatever the edit appeared to do.

For automatic lifecycle tracking, run the agent through `codeledger run --agent <name> --request "<task>" -- <agent command>`, or run `codeledger watch --agent <name>` in a second terminal while the agent edits this project. MCP-capable agents may launch `codeledger mcp --root <project>`.
