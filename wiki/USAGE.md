# How to use

Walkthroughs for the features that have multiple modes / template
variables / setup steps and aren't fully obvious from the toolbar alone:
the **Command Palette**, **Snippets**, **Quick Actions** (tasks), and
**AI Assist**. Everything else — editor, file explorer, terminal,
markdown preview — works the way you'd expect from VS Code or a regular
IDE.

## Command Palette

Press `Cmd/Ctrl + Shift + P` from anywhere to open a VS Code–style
launcher. It's the fastest way to run something without hunting through
menus or remembering a shortcut.

The palette covers:

- **File** — New, Open, Save, Save As, Close tab, Quit.
- **Edit** — Find, Replace, Go to line, Select all, Format document,
  Format selection.
- **View** — Toggle theme, toggle markdown preview, toggle split view.
- **Tabs** — Next / Previous, Show all tabs.
- **Tools** — New terminal, File Explorer, AI Assist, AI Settings,
  Quick Actions, Snippets, Save selection as snippet, Check for updates.
- **Language** — One row per Monaco language; selecting it re-tags the
  active editor tab's syntax (the file extension is left untouched).
- **Run Action** — One row per saved Quick Action. Selecting a row
  runs it just like clicking it in the Zap dialog.
- **Snippet** / **Prompt** — One row per saved snippet. Text snippets
  paste at the cursor; prompt snippets send the selection to the AI
  and replace it with the response.

The search box does a whitespace-tokenized substring match against the
group + label, so `snip py` finds an `Insert snippet: python-shebang`
row and `set md` finds `Set language: Markdown`. Arrow keys move the
highlight, `Enter` runs it, `Esc` closes.

The palette rebuilds its list each time you open it, so brand-new
snippets and actions appear immediately — no app restart needed.

## Search in folder

Cross-file search powered by the same crates ripgrep is built from
(`grep-regex`, `grep-searcher`, `ignore`). Open via **Tools → Search in
Folder…**, the magnifier icon in the toolbar, `Cmd/Ctrl + Shift + F`, or
the Command Palette → "Search in folder…".

If you're sitting on a File Explorer or Git Browser tab when you invoke
search, the new tab inherits that folder as the search root. Otherwise
you pick one.

The tab has:

- A query input — type and matches appear after a 250 ms debounce.
- Toggles on the right: **Aa** (case sensitive), **\\b** (whole word),
  **.*** (treat the pattern as a regex; otherwise it's a literal).
- An **include** glob field below the query (e.g. `*.rs`,
  `src/**/*.ts`).
- A **.hidden** checkbox to include dotfiles / dotdirs.
- A results list grouped by file with line numbers, highlighted match
  spans, and a per-file expand/collapse chevron. Each line is a click
  target that opens the file in an editor tab and jumps the cursor to
  the matched line and column.

What's honored automatically: `.gitignore`, `.ignore`, parent-dir
`.gitignore`, global git ignore (`core.excludesFile`), and binary file
skipping. So a search inside a project doesn't drown in
`node_modules/` / `target/`. To override, flip the **.hidden** toggle
or write an include glob.

Limits: max 500 files in the response, max 50 matches per file. If a
search hits those caps the status line shows "truncated, narrow your
query".

## Git browser

Open a git repository in a dedicated tab via **Tools → Git Browser…** (or
the **GitBranch** icon in the toolbar, or the Command Palette → "Open Git
browser…"). The browser shells out to the system `git` binary so your
existing `.gitconfig`, credential helpers, and SSH keys all keep working.

What the browser covers (about 90% of daily git use):

- **Status overview** — current branch label, ahead/behind chips against
  the upstream, and two lists: Staged Changes and Changes.
- **Stage / unstage** — `+` on each unstaged row stages that file; `-` on
  each staged row unstages it. "Stage all" / "Unstage all" links at the
  top of each section operate on every file in the list.
- **Diff** — clicking a file path opens a unified-diff modal with adds
  (green), deletes (red), hunk headers, and context lines visually
  distinct.
- **Commit** — write a message in the textarea and hit **Commit**. The
  button is disabled until something's staged and the message is
  non-empty. `Cmd/Ctrl + Enter` while focused in the textarea commits
  too.
- **Pull / Push** — `git pull` and `git push` against the configured
  upstream. Success flashes a quick toast; errors (auth failures, merge
  conflicts) show inline.
- **Open in editor** — every row has an **Open** button that pipes the
  file path back through the usual `Open` flow, so you can fix issues
  in the editor without leaving the project.

What's deliberately out of scope: branch creation/switch, log graph,
merge-conflict resolution, stashes. For any of that, open a terminal in
the same folder (`Cmd/Ctrl + T`) and run git directly.

Refresh: the status auto-refreshes whenever the tab becomes active. A
manual refresh button lives in the top-right of the tab.

## Spell check and the Problems panel

Sparrow runs CSpell against markdown and plaintext tabs as you type. Issues
show three ways:

- **Inline squiggles** in the editor (Monaco's info-severity underlines).
- **Lightbulb / Quick Fix**: place the cursor on a flagged word and press
  `Cmd/Ctrl + .` (or click the lightbulb). The menu lists the top five
  suggestions — picking one replaces the word in place.
- **Problems panel**: a collapsible drawer above the status bar. Click the
  amber triangle badge in the status bar (or run **Show Problems panel**
  from the Command Palette). Each row shows the location, the misspelled
  word, and chip-style suggestion buttons. Click a row to jump there;
  click a chip to replace and recheck.

The panel is per-tab — switching tabs re-points the list at the new
buffer's issues. Toggle spell check entirely off with the **SpellCheck**
icon in the main toolbar.

## Markdown preview

The split markdown preview has a small toolbar with two utilities:

- **Copy as HTML** (clipboard icon) — copies the rendered HTML to the
  clipboard so you can paste it straight into an email, Notion, Confluence,
  or any rich-text target. Both `text/html` and a plain-text fallback are
  written, so terminal and editor pastes still see something sensible.
- **Export as PDF** (printer icon) — opens a print preview of just the
  rendered HTML (no editor chrome, light theme), then you pick **Save as
  PDF** in the system print dialog. The output is fully selectable text
  (not rasterized), so search and copy still work in the resulting PDF.

Both commands also live in the Command Palette under the **Preview** group
when a markdown tab is active.

## Hidden files (.env, .gitignore, …)

The native OS file picker hides dotfiles by default and there's no
cross-platform way for an app to force it open. Two ways to work around
that in Sparrow:

- **File Explorer tab**: lists every entry, including dotfiles. The
  "Show hidden" checkbox is on by default; toggle it off if you want to
  hide them temporarily — the preference is remembered.
- **Open file by path…**: Command Palette → "Open file by path…". Paste
  the absolute path (e.g. `/Users/you/project/.env`) and it opens straight
  away.

## Snippets

Snippets come in two flavors:

- **Text snippets** — saved blocks of text that get pasted at the cursor.
- **Prompt snippets** — saved AI instructions; running one sends the
  current selection to the AI as context and replaces it with the
  response.

### Save a text snippet

1. Select the text you want to save in any editor tab.
2. Click the **bookmark+** icon in the toolbar (or pick
   **Tools → Save Selection as Snippet**).
3. Give it a name (e.g. `for-loop`, `license-header`). Description and
   content are pre-filled; edit if you want.
4. Leave the type as **Text snippet** and hit **Save**.

### Save a prompt snippet

1. Click the **bookmark** icon to open the Snippets library.
2. Click **+ New**.
3. Pick **Prompt snippet**, give it a name (e.g. `Refactor for clarity`,
   `Add docstrings`, `Translate to Spanish`).
4. In the **Prompt instruction** box, write what you want the AI to do,
   like:
   > Rewrite this code to be more concise without changing its behavior.
5. Hit **Save**.

### Run a snippet

1. Open the Snippets library (bookmark toolbar button or
   **Tools → Snippets…**).
2. Click a row — text snippets paste at the cursor (or replace the
   selection); prompt snippets run through the AI and the response
   replaces the selection.

Hover any row to reveal the trash icon and delete a snippet.

## Quick Actions (tasks)

Quick Actions are saved tasks that come in two flavors:

- **Shell command** — runs in a new terminal tab (e.g. `npm test`,
  `git status`, `cargo check`).
- **Python script** — runs a `.py` file with the current selection piped
  to `stdin` and the script's `stdout` replaces the selection. Use this
  for in-place text transformations (formatters, find-and-replace,
  casing changes, JSON pretty-printing, …).

Both flavors expand **template variables** at run time, derived from
the active tab and selection:

| Placeholder | Expands to |
| --- | --- |
| `{file}` | full path of the active editor tab's saved file |
| `{dir}` | directory of `{file}` (or the active File Explorer's folder) |
| `{filename}` | basename including extension |
| `{basename}` | filename without the trailing extension |
| `{ext}` | extension without the leading dot |
| `{selection}` | current text selection in the editor |

Wrap them in quotes if the path may contain spaces: `eslint "{file}"`.

### Create a shell action

1. Click the **Zap** icon in the toolbar (or
   **Tools → Quick Actions…**).
2. Click **+ New**.
3. Pick **Shell command**, name it (e.g. `Run tests`), and type the
   command (e.g. `npm test`).
4. Hit **Save**.

### Create a Python action

1. Same start: Zap → **+ New** → pick **Python script**.
2. Click **Browse** to pick your `.py` file.
3. Optionally add extra `argv` args. They support the same template
   variables.
4. Hit **Save**.

Inside a Python script you can read context from env vars:
`SPARROW_FILE`, `SPARROW_DIR`, `SPARROW_FILENAME`, `SPARROW_BASENAME`,
`SPARROW_EXT`, `SPARROW_LANGUAGE`, `SPARROW_HAS_SELECTION`.

Two starter recipes:

```python
# uppercase.py — turn the selection into UPPERCASE
import sys
sys.stdout.write(sys.stdin.read().upper())
```

```python
# format_json.py — pretty-print the selection as JSON
import sys, json
sys.stdout.write(json.dumps(json.loads(sys.stdin.read()), indent=2))
```

### Run an action

Open the Quick Actions library and click a row. Shell actions spawn a
new terminal tab and run the substituted command; Python actions filter
the selection through the script and replace it with the output. The
library shows an `sh` / `py` pill on each row so you know which is which.

## AI Assist (and prompt snippets)

Sparrow can call OpenAI or Anthropic to act on selected text. Set this
up once, then either use it ad-hoc or save reusable prompts as prompt
snippets.

### One-time setup

1. Open **Tools → AI Settings…**.
2. Pick a provider (OpenAI or Anthropic).
3. Paste your API key. It's stored in a private file under your app
   config dir, never in `localStorage` and never sent anywhere except
   to the chosen provider.
4. Optionally tweak the model (defaults: `gpt-4o-mini` /
   `claude-3-5-sonnet-latest`), system prompt, or max tokens.
5. Hit **Save**.

### Run AI on a selection

1. Select some text in any editor tab.
2. Press `Cmd/Ctrl + Shift + A` (or click the purple **Sparkles** icon
   in the toolbar, or **Tools → AI Assist**).
3. A modal shows your selection in a code-styled preview. Type an
   instruction like:
   > Rewrite this in passive voice.
   > Convert this JSON to YAML.
   > Add type annotations to this function.
4. Hit **Run** (or `Cmd/Ctrl + Enter`). The reply replaces the
   selection.

If nothing is selected, the reply is inserted at the cursor wrapped in
`--- AI assist ---` / `--- end ---` marker lines so you can see and
easily clean up the boundary.

### Reusable prompts

If you find yourself typing the same instruction over and over
(`Refactor for clarity`, `Translate to Spanish`, etc.), save it as a
prompt snippet (see [Snippets](#snippets) above). Then one click in the
Snippets library runs it against the current selection.
