# Iteration Loop

## Run the loop

```bash
make verify
```

This runs:
1. Frontend build
2. UI tests (Vitest + Testing Library)
3. Rust tests (`cargo test` for Tauri backend modules)
4. Claude PTY smoke test (`scripts/claude_pty_smoke.py`) that verifies interactive startup and submit behavior

## Artifacts

- Logs: `/Users/rfu/Claude Desk/artifacts/e2e/*.log`
- Failure screenshots (best-effort):
  - `/Users/rfu/Claude Desk/artifacts/e2e/landing.png`
  - `/Users/rfu/Claude Desk/artifacts/e2e/slash-palette.png`
- Diagnosis report:
  - `/Users/rfu/Claude Desk/artifacts/last_diagnosis.md`

## How diagnosis works

When any verify step fails, the loop:
1. Writes command output logs.
2. Attempts to capture screenshots from the built app preview.
3. Writes a concise diagnosis with:
   - failing step
   - likely root-cause files
   - suggested next patch directions

## Interpreting `last_diagnosis.md`

- `Failing step`: where the loop broke.
- `Likely root causes`: highest-priority files to inspect.
- `Failure excerpt`: tail of command output to start debugging quickly.

If all checks pass, `last_diagnosis.md` states that no failures were detected.
