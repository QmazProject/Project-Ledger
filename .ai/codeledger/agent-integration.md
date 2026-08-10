# CodeLedger Agent Integration

## One-time Codex setup

Run `codeledger setup-codex` from this project. It registers the local MCP server with Codex using the absolute project path. Start a new Codex session after setup if Codex was already running.

## Persistent workflow

Run `codeledger watch --agent codex` in a second terminal and leave it running while Codex works. The watcher records changed files and symbols without requiring `status` or `changes` after every task.

## MCP tools

Codex can call `codeledger_get_resume`, `codeledger_get_context`, `codeledger_find_symbol`, `codeledger_get_impact`, `codeledger_get_history`, `codeledger_get_recent_changes`, `codeledger_get_issues`, `codeledger_get_decisions`, `codeledger_record_change`, `codeledger_mark_verified`, `codeledger_get_session_state`, and `codeledger_record_checkpoint` during an ongoing conversation.

## Continuing across sessions

Call `codeledger_get_resume` at the start of a session and `codeledger_record_checkpoint` before it ends. The MCP server starts and ends its own session, so no setup is needed for this to work.
