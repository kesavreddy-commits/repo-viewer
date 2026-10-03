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

### Examples

1. **Browse:** type `/files`, click the tree, then use `→` to open `hooks/` and a file inside it, and `←`
   to come back out.
2. **Jump to a file:** `/files README.md` opens it rendered; `/files hooks` reveals the folder;
   `/files regtsx` filters the tree down to `hooks/register.tsx`.
3. **Ask Claude to show you something:** "Show me the file that handles the pane's keys." Claude opens
   it in the pane with the `show_file` tool.
4. **Watch Claude work:** with `follow on`, ask Claude to change something ("rename this function and
   update its callers"). Each file opens in the pane as it's edited, with a magenta `●` in the tree.
5. **Edit it yourself:** open a file, press `→` to edit, make a change, `ctrl+s` to save, `ctrl+q` when done.

It works in the desktop app's Code tab too; VS Code gets a click-only tree.

## Troubleshooting

- **The pane sits above the prompt, not on the right:** it docks only in fullscreen mode. Run
  `/tui fullscreen`.
- **The pane doesn't open when a session starts:** a terminal narrower than about 144 columns waits
  for you to ask, and if you closed the pane last time, it stays closed. `/files` opens it either way.
- **The arrow keys go to Claude's prompt:** click the tree first; it then has the arrow keys until you
  press `Esc` or `←` at the top level.
- **A file is missing from the tree:** it's ignored by `.gitignore`. Outside a git repo, folders like
  `node_modules` are skipped. A `+` after the file count means a very large repo's list was cut short.
  `/files <path>` still opens a file directly.
- **A save is refused with "changed on disk":** something else changed the file since you opened it.
  `ctrl+s` again overwrites it; `ctrl+q` leaves without saving.
- **Nothing happens at all:** check `claude plugin list` shows `kesav@repoviewer` enabled, and that
  Claude Code is 2.1.259 or newer (`claude --version`). `claude --debug` logs why a plugin didn't load.

Still stuck? [Open an issue](https://github.com/kesavreddy-commits/repoviewer/issues). For a security
problem, see [SECURITY.md](SECURITY.md) instead.

## Privacy and safety

repoviewer reads your repo and shows it to you, and changes nothing unless you save a file. In detail:

- **Nothing leaves your machine.** No network calls, no telemetry. Nothing it reads (your files, git
  output, the conversation) is sent anywhere. When Claude uses the `show_file` tool, all it gets back is
  one line, like "Showing hooks/register.tsx in the repo pane."
- **It only runs `git`, locally, and only to read.** These are the whole commands, run in your repo:

  ```
  git rev-parse --show-toplevel                 # where the repo is
  git symbolic-ref --short -q HEAD              # the branch
  git rev-parse --short HEAD                    # the commit, when there is no branch
  git --no-optional-locks ls-files -z --cached --others --exclude-standard   # the tree
  git --no-optional-locks status --porcelain=v1 -z --untracked-files=all     # the change marks
  git --no-optional-locks diff [HEAD] --no-color --no-ext-diff --no-textconv -- <file>   # a diff
  ```

  `<file>` is the file whose diff you opened. It never commits, checks out, fetches or changes your repo.
- **It only writes the file you save.** It's an editor, so it can save any file inside your repo that
  you open and edit, including build, start-up, settings or instruction files like `package.json`, a
  `Makefile` or `CLAUDE.md`. It writes only that file, at its own path, only when you press `ctrl+s`,
  and refuses if the file changed on disk in the meantime. It never writes outside the repo, never to its
  own folder, and never on its own. Beyond that it keeps two small values in its own plugin storage:
  whether you left the pane open, and whether `follow` is on.
- **It doesn't read the conversation.** It uses the end of each turn only as a signal to refresh the
  tree, and looks at Claude's Edit, Write and NotebookEdit calls only for the path of the file changed.
- **Typing in the pane goes to Claude's prompt**, just as if you'd typed it there.

It adds the commands `/files`, `/repo` and `/repoviewer`, and a `show_file` tool Claude can use to open
a file for you. It answers its own `show_file` calls (that's how a plugin serves its tool), and never
answers for, replaces or changes any other tool or command.

<details>
<summary>Every hook it uses, and what each one does</summary>

- `session.start`: registers the commands and the tool, reads the file list, and opens the pane unless
  you left it closed. While the pane is open, it re-reads `git status` every 8 seconds, and reads the
  file list again if `/clear`, `/resume` or `/branch` reset it.
- `command.run`: answers its own `/files`, `/repo` and `/repoviewer` only: toggle the pane, or jump to a
  file, folder or search. No other command reaches it.
- `ui.message`: handles the pane's own key presses (move, open, edit, save, typed text); everything else
  passes on.
- `tool.call` on `show_file`: answers its own tool by opening the file in the pane, and returns one line.
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

repoviewer is an independent project, not affiliated with or endorsed by Anthropic. Claude and Claude
Code are trademarks of Anthropic.
