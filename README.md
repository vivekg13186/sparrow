# Sparrow
 
![Sparrow](/src-tauri/icons/128x128.png)

A lightweight notepad built on Tauri + Vue + Monaco.

![Sparrow](/screenshot.png)


## Features

**Editing**

- VS Code–style editor (Monaco) with syntax highlighting and code formatting
- Multi-tab UI with a type-and-search tab dropdown
- 2-column split view (compare two files side by side)
- Find, replace, go-to-line
- Spell check for `.md` and `.txt` (powered by CSpell)

**Files**

- File explorer with extension-aware icons
- Markdown live preview
- CSV / XLSX table editor (Tabulator)
- Image / SVG / PDF preview
- Whiteboard (`.sbw`) — free-hand drawing, shapes, text; export PNG / SVG / PDF

**Tools**

- Built-in terminals (PTY-backed via xterm.js)
- HTTP client for `.http` files (REST Client–compatible)
- Snippets — text snippets and **prompt snippets** that run through AI
- Quick Actions — saved shell commands or Python scripts with template variables (`{file}`, `{dir}`, `{selection}`, …)
- AI assist over a text selection (OpenAI or Anthropic)

## Keyboard shortcuts

`Cmd/Ctrl` means **Cmd** on macOS, **Ctrl** on Windows / Linux.

**Files**

| Action | Shortcut |
| --- | --- |
| New tab | `Cmd/Ctrl + N` |
| Open file | `Cmd/Ctrl + O` |
| Save | `Cmd/Ctrl + S` |
| Save As… | `Cmd/Ctrl + Shift + S` |
| Quit | `Cmd/Ctrl + Q` |

**Tab navigation**

`Cmd/Ctrl` means **Cmd** on macOS, **Ctrl** on Windows / Linux. `Option` on
macOS is the same physical key as `Alt` elsewhere — Sparrow accepts either.

| Action | Shortcut |
| --- | --- |
| Next tab (wraps) | `Ctrl + Tab` <br> `Cmd/Ctrl + Alt + →` <br> `Ctrl + PageDown` |
| Previous tab (wraps) | `Ctrl + Shift + Tab` <br> `Cmd/Ctrl + Alt + ←` <br> `Ctrl + PageUp` |
| Jump to tab N (1 – 9) | `Cmd/Ctrl + 1` … `Cmd/Ctrl + 9` |
| Close active tab | `Cmd/Ctrl + W` |
| Open type-and-search tab picker | click the active filename in the header bar |

The tab dropdown and header trigger show a small numeric badge (`1`–`9`)
on each tab, so the `Cmd/Ctrl + N` shortcut to jump to it is visible at
a glance. Tabs past the ninth have no badge — they're reachable via the
arrow shortcuts above or via the dropdown search.

**Editing**

| Action | Shortcut |
| --- | --- |
| Undo / Redo | `Cmd/Ctrl + Z` / `Cmd/Ctrl + Shift + Z` |
| Cut / Copy / Paste | `Cmd/Ctrl + X` / `C` / `V` |
| Select All | `Cmd/Ctrl + A` |
| Find | `Cmd/Ctrl + F` |
| Replace | `Cmd/Ctrl + H` |
| Go to line | `Cmd/Ctrl + G` |
| Format Document | `Shift + Alt + F` |
| Format Selection | `Cmd/Ctrl + K`, then `Cmd/Ctrl + F` |

The editor is Monaco, so most VS Code shortcuts also work — multi-cursor (`Cmd/Ctrl + click`), comment toggle (`Cmd/Ctrl + /`), move line (`Alt + ↑/↓`), select-next-occurrence (`Cmd/Ctrl + D`), etc.

**Tools**

| Action | Shortcut |
| --- | --- |
| New Terminal | `Cmd/Ctrl + T` |
| File Explorer | `Cmd/Ctrl + Shift + E` |
| AI Assist (on selection) | `Cmd/Ctrl + Shift + A` |
| Submit prompt inside the AI dialog | `Cmd/Ctrl + Enter` |

**Dialog / dropdown navigation**

| Action | Shortcut |
| --- | --- |
| Tab dropdown — move highlight | `↑` / `↓` |
| Tab dropdown — select | `Enter` |
| Dismiss any modal | `Esc` |

## How to use

### Snippets

Snippets come in two flavors:

- **Text snippets** — saved blocks of text that get pasted at the cursor.
- **Prompt snippets** — saved AI instructions; running one sends the current selection to the AI as context and replaces it with the response.

**Save a text snippet**

1. Select the text you want to save in any editor tab.
2. Click the **bookmark+** icon in the toolbar (or pick **Tools → Save Selection as Snippet**).
3. Give it a name (e.g. `for-loop`, `license-header`). Description and content are pre-filled; edit if you want.
4. Leave the type as **Text snippet** and hit **Save**.

**Save a prompt snippet**

1. Click the **bookmark** icon to open the Snippets library.
2. Click **+ New**.
3. Pick **Prompt snippet**, give it a name (e.g. `Refactor for clarity`, `Add docstrings`, `Translate to Spanish`).
4. In the **Prompt instruction** box, write what you want the AI to do, like:
   > Rewrite this code to be more concise without changing its behavior.
5. Hit **Save**.

**Run a snippet**

1. Open the Snippets library (bookmark toolbar button or **Tools → Snippets…**).
2. Click a row — text snippets paste at the cursor (or replace the selection), prompt snippets run through the AI and the response replaces the selection.

Hover any row to reveal the trash icon and delete a snippet.

### Quick Actions (tasks)

Quick Actions are saved tasks that come in two flavors:

- **Shell command** — runs in a new terminal tab (e.g. `npm test`, `git status`, `cargo check`).
- **Python script** — runs a `.py` file with the current selection piped to `stdin` and the script's `stdout` replaces the selection. Use this for in-place text transformations (formatters, find-and-replace, casing changes, JSON pretty-printing, …).

Both flavors expand **template variables** at run time, derived from the active tab and selection:

| Placeholder | Expands to |
| --- | --- |
| `{file}` | full path of the active editor tab's saved file |
| `{dir}` | directory of `{file}` (or the active File Explorer's folder) |
| `{filename}` | basename including extension |
| `{basename}` | filename without the trailing extension |
| `{ext}` | extension without the leading dot |
| `{selection}` | current text selection in the editor |

Wrap them in quotes if the path may contain spaces: `eslint "{file}"`.

**Create a shell action**

1. Click the **Zap** icon in the toolbar (or **Tools → Quick Actions…**).
2. Click **+ New**.
3. Pick **Shell command**, name it (e.g. `Run tests`), and type the command (e.g. `npm test`).
4. Hit **Save**.

**Create a Python action**

1. Same start: Zap → **+ New** → pick **Python script**.
2. Click **Browse** to pick your `.py` file.
3. Optionally add extra `argv` args. They support the same template variables.
4. Hit **Save**.

Inside a Python script you can read context from env vars: `SPARROW_FILE`, `SPARROW_DIR`, `SPARROW_FILENAME`, `SPARROW_BASENAME`, `SPARROW_EXT`, `SPARROW_LANGUAGE`, `SPARROW_HAS_SELECTION`.

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

**Run an action**

Open the Quick Actions library and click a row. Shell actions spawn a new terminal tab and run the substituted command; Python actions filter the selection through the script and replace it with the output. The library shows an `sh` / `py` pill on each row so you know which is which.

### AI Assist (and prompt snippets)

Sparrow can call OpenAI or Anthropic to act on selected text. Set this up once, then either use it ad-hoc or save reusable prompts as prompt snippets.

**One-time setup**

1. Open **Tools → AI Settings…**.
2. Pick a provider (OpenAI or Anthropic).
3. Paste your API key. It's stored in a private file under your app config dir, never in `localStorage` and never sent anywhere except to the chosen provider.
4. Optionally tweak the model (defaults: `gpt-4o-mini` / `claude-3-5-sonnet-latest`), system prompt, or max tokens.
5. Hit **Save**.

**Run AI on a selection**

1. Select some text in any editor tab.
2. Press `Cmd/Ctrl + Shift + A` (or click the purple **Sparkles** icon in the toolbar, or **Tools → AI Assist**).
3. A modal shows your selection in a code-styled preview. Type an instruction like:
   > Rewrite this in passive voice.
   > Convert this JSON to YAML.
   > Add type annotations to this function.
4. Hit **Run** (or `Cmd/Ctrl + Enter`). The reply replaces the selection.

If nothing is selected, the reply is inserted at the cursor wrapped in `--- AI assist ---` / `--- end ---` marker lines so you can see and easily clean up the boundary.

**Reusable prompts**

If you find yourself typing the same instruction over and over (`Refactor for clarity`, `Translate to Spanish`, etc.), save it as a prompt snippet (see [Snippets](#snippets) above). Then one click in the Snippets library runs it against the current selection.

## Note

This is a personal project, built with Claude AI in a day; the feature list is a personal wishlist. If you'd like a new feature, open an issue and I'll try to add it.
