# repoviewer

Browse, read and edit your whole repo in a pane beside Claude Code, right in the terminal.

![repoviewer: the tree, a file, rendered markdown and the editor, docked beside Claude Code](docs/demo.gif)

The Claude desktop app has a file pane; the CLI didn't. **repoviewer** is a Claude Code
[mod](https://code.claude.com/docs/en/plugins/mods/overview) that docks one on the right:

- **Tree** of the repo (`.gitignore` respected) with git marks (`M A ? D R U`) and a magenta `●` on
  every file Claude edited this session.
- **Arrow keys**: `↑ ↓` move, `→` opens a folder or file, `←` steps back out, and `←` at the top
  level hands the keys back to Claude's prompt.
- **Viewer**: syntax highlighting with line numbers, rendered markdown, `git diff` per file, PNGs
  (kitty / Ghostty).
- **Editor**: `→` on an open file edits it in place. `ctrl+s` saves, `ctrl+q` is done, `ctrl+z` undoes.
  A save never silently overwrites a file that changed on disk.
- **Follows Claude**: files open as Claude edits them, and Claude can show you a file
  ("show me the auth middleware") with its `show_file` tool.
- **Fuzzy finder**: `regtsx` → `hooks/register.tsx`, Enter opens it.

Typing anywhere outside the finder and the editor goes straight to Claude's prompt.

If it's useful, a ⭐ helps others find it.

## Install

**Requires Claude Code 2.1.259 or newer, in fullscreen mode (`/tui fullscreen`)** for the pane to
dock on the right; otherwise it sits above the prompt.

```bash
claude plugin marketplace add kesavreddy-commits/repoviewer
```

```bash
claude plugin install kesav@repoviewer
```

## Use

| | |
| --- | --- |
| `/files` (or `/repo`) | toggle the pane |
| `/files <path>` | open a file, or reveal a folder |
| `/files <text>` | fuzzy-find |
| click the tree | gives it the arrow keys; `Esc` gives them back |

The pane takes 40% of a wide terminal (at least 44 columns, and Claude keeps at least 70); drag the
divider to change it. There are no settings to configure: it remembers whether you left the pane open
and whether `follow` was on.

It works in the desktop app's Code tab too; VS Code gets a click-only tree.

## Privacy and safety

repoviewer reads your repo and shows it to you, and changes nothing unless you save a file. In detail:

- **Nothing leaves your machine.** No network calls, no telemetry. When Claude uses the `show_file`
  tool, all it gets back is one line, like "Showing hooks/register.tsx in the repo pane."
- **It only runs `git`, and only to read:** `rev-parse` and `symbolic-ref` to find the repo and branch,
  `ls-files` for the tree (respecting `.gitignore`), `status` for the change marks, and `diff` to show
  a file's changes. It never commits, checks out or changes your repo.
- **It only writes the file you save.** Pressing `ctrl+s` in the editor writes that file at its own path,
  keeping its line endings, and refuses if the file changed on disk in the meantime. It never touches its
  own folder, your settings or any config file unless you open one and save it yourself. Beyond that it
  remembers two small things in its own plugin storage: whether you left the pane open, and whether
  `follow` is on.
- **Typing in the pane goes to Claude's prompt**, just as if you'd typed it there.

It adds the commands `/files`, `/repo` and `/repoviewer`, and a `show_file` tool Claude can use to open
a file for you. It doesn't replace or change any of Claude Code's own tools or commands.

<details>
<summary>Every hook it uses, and what each one does</summary>

- `session.start`: registers the commands and the tool, reads the file list, and opens the pane unless
  you left it closed. While the pane is open, it re-reads `git status` every 8 seconds.
- `classic.SessionStart` (after `/clear`, resume or fork): passes the event on, then re-reads the file list.
- `command.run`: answers its own `/files`, `/repo` and `/repoviewer` only: toggle the pane, or jump to a
  file, folder or search. No other command reaches it.
- `ui.message`: handles the pane's own key presses (move, open, edit, save, typed text); everything else
  passes on.
- `tool.call` on `show_file`: its own tool, as above.
- `tool.call` on every other tool: lets the tool run unchanged first. After a successful Edit, Write or
  NotebookEdit, it marks that file and opens it in the pane if `follow` is on. The tool's result is
  returned unchanged.
- `turn.complete`: passes the event on, then refreshes the file list and git marks.
- `ui.render`: draws its own pane only.

</details>

## Develop

```bash
git clone https://github.com/kesavreddy-commits/repoviewer && cd repoviewer
```

```bash
claude --plugin-dir . --settings '{"tui":"fullscreen"}'
```

```bash
claude plugin test .
```

`hooks/register.tsx` wires the events and does all file and git I/O; `hooks/nav.tsx` is the
keyboard `Client` (tree), `hooks/navfile.tsx` the viewer and editor inside it, `hooks/editor.ts` the
text buffer, `hooks/repo.ts` the parsing; `tree.tsx` and `viewer.tsx` draw the chrome. Run
`/plugin-types` once for editor types, then `npx -p typescript tsc -p .`.

## Contributors

- [Kesav Reddy Eswaravaka](https://github.com/kesavreddy-commits)

## License

MIT - Add a reference to my name, Kesav E. and my GitHub username if using this repo for a video please!
