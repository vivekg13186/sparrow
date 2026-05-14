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
