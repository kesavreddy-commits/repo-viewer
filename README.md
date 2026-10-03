# repo-view

A Claude Code mod that docks a repo browser beside the transcript in the terminal: the CLI's
answer to the desktop app's file pane.

- **Tree** of the whole repo (`.gitignore` respected), folders first, with git marks
  (`M` `A` `?` `D` `R` `U`) and a magenta `●` on every file Claude edited this session.
- **Finder**: fuzzy file search (`regtsx` → `hooks/register.tsx`), Enter opens the top match.
- **Viewer**: syntax-highlighted code with line numbers, paged for long files; markdown rendered
  (or raw); `git diff HEAD` of the file; PNGs drawn inline in kitty/Ghostty.
- **Follows Claude**: a file Claude edits opens in the pane as it changes (toggle with `f`).
- **`show_file` tool**: ask Claude to "show me the auth middleware" and it opens there.

## Run it

Double-click `repo-view.command` in Finder (or `./repo-view.command ~/some/repo`), or:

```bash
claude --plugin-dir ~/claudecodemods/mod1 --settings '{"tui":"fullscreen"}'
```

Fullscreen docks the pane on the right (from 110 columns; it opens by itself from 144).
Without it, the pane sits above the prompt. `/tui fullscreen` makes fullscreen permanent.

| Command | Does |
| --- | --- |
| `/files` or `/repo` | toggle the pane |
| `/files <path>` | open a file, or reveal a folder |
| `/files <query>` | fuzzy-find |

In the pane (ctrl+x tab, or a click, gives it the keyboard; Esc hands it back):

| Key | Tree | Viewer |
| --- | --- | --- |
| ↑ ↓ / Tab | move between rows | |
| Enter | open file / expand folder | |
| `g` `c` `f` | refresh, collapse all, follow on/off | |
| `b` `n` `p` | | back, next page, previous page |
| `r` `d` `t` | | raw/rendered markdown, diff, reveal in tree |
| ctrl+x ← → | resize the pane | resize the pane |

Options (`/config`, or `pluginConfigs.repo-view` in settings): `autoOpen` (default on),
`follow` (default on).

## Develop

```bash
npx -y -p typescript@5 tsc -p .     # typecheck
claude plugin validate .            # what the engine will refuse
claude plugin test .                # tests/ against an in-memory repo
```

`hooks/register.tsx` wires events and does all I/O (the engine follows `$` only within one
file); `hooks/repo.ts` parses and pages; `hooks/tree.tsx` and `hooks/viewer.tsx` draw.
See `SPEC.md` for the module contracts.
