# Overlay Ink

A transparent canvas you can write on, anywhere on top of any web page — a Brave /
Chrome (Manifest V3) extension.

Click the toolbar icon, a see-through layer appears, and then **you click wherever you
want to write and type there**. It behaves like a OneNote page over the site: each click
starts its own little text box in the colour you picked, so notes sit in the margin,
beside a paragraph, or in the corner — they never flow down the page in one column. The
page underneath stays completely visible; only your writing is drawn.

```
┌──────────────────────────────────────────────────────────────────┐
│  ⬤ ⬤ ⬤   example.com                                [ 🖊  EDIT ] │  ← toolbar icon shows the state
├──────────────────────────────────────────────────────────────────┤
│        ┌──────────────────────────────────────────────────┐      │
│        │ Edit│View │ ●●●●●●●● ⬤ #ff8800 │ Size──72px │ ✕ │      │  ← overlay toolbar
│        └──────────────────────────────────────────────────┘      │
│                                                                  │
│   Ask about the                          ⠿ ✕                    │
│   second draft                        ┌───────────────────────┐  │
│   before Friday                       │ and check page 14 too │  │  ← each note is placed where
│                                       └───────────────────────┘  │    you clicked, in its own colour
│                                                                  │
│        The page itself is fully visible — only the writing is    │
│        drawn on top of it.                                       │
└──────────────────────────────────────────────────────────────────┘
```

## Install in Brave

1. Open `brave://extensions`.
2. Turn on **Developer mode** (top-right switch).
3. Click **Load unpacked** and choose this folder.
4. The Overlay Ink icon appears in the toolbar — drag it next to the address bar if it is
   hidden behind the puzzle-piece menu.

Works the same in Chrome and Edge (`chrome://extensions`). PDF viewer pages are the one
place it cannot run — that is a browser limitation for every extension.

## Using it

**Toggle it on/off** — click the toolbar icon, or press <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>O</kbd>.
The icon shows a small **EDIT** / **VIEW** badge whenever the overlay is up, so you can
always tell at a glance.

**Write wherever you want** — with the overlay on, click any empty spot: the caret appears
exactly there and you type in place. Click somewhere else and you get a second note.
Nothing is tied to a fixed column, and text is plain, so it stays readable over whatever
is behind it.

**Move or delete a note** — hover a note (or click into it) and its two little handles
appear above it: <kbd>⠿</kbd> to drag it anywhere on the screen, <kbd>✕</kbd> to remove it.
A note you click away from while it is still empty simply disappears.

**Colour and style** — three ways to pick a colour, so there is no mistaking it:

| Control | What it does |
| --- | --- |
| The eight colour dots | One click sets the ink colour. |
| The dashed rainbow dot | Opens the full colour picker. |
| The hex field (`#ff8800`) | Type any colour code you like. |

Plus **Size** (12–240 px), four **fonts** (bundled handwriting, sans, serif, mono), and an
**outline** toggle so the writing stays readable on a busy page.

Crucially, style follows your selection: **with a note selected** (caret in it) the
controls restyle *that note* — so one canvas can hold a red reminder and a blue question.
**With nothing selected** they set the style for the *next* note you place.

**Edit / View** — Edit pauses the page so clicks land in your notes instead of navigating
away mid-sentence. View keeps everything on screen and hands every click back to the page,
so you can keep reading and scrolling with your notes floating on top. The overlay toolbar
stays usable in both modes and dims until you hover it. <kbd>Esc</kbd> deselects the note
you are in, and pressing it again switches to View.

**BG** — a faint panel behind everything. At 0% — the default — the overlay is *completely*
transparent, exactly as asked. (Individual notes never paint a background; only their
glyphs are drawn.)

**Alt**+<kbd>Shift</kbd>+<kbd>H</kbd> hides the overlay from anywhere on the page.

**The quick panel** — right-click the toolbar icon and choose *Overlay Ink: quick panel*.
It is the same controls in a small floating window, with an on/off switch, and changes you
make there appear live on the page. Its colour/size/font settings are the defaults for new
notes.

**Options** — right-click the toolbar icon → *Overlay Ink: options* (or *Extensions →
Overlay Ink → Details → Extension options*). That page sets the defaults every new note
starts with and explains the shortcuts. Reassign them here:
`brave://extensions/shortcuts` → Overlay Ink.

Right-clicking the icon also gives you *Overlay Ink: write on this page*, and the same item
appears in the right-click menu of any page.

## What it does not do (yet)

Deliberately a starter: transparent canvas, text notes placed anywhere, colours/sizes/fonts,
toggle from the toolbar, Edit/View, and the shortcuts. Natural next steps:

- Freehand drawing / highlighting with a pointer, not just text
- Arrows, boxes and underline shapes
- **Undo/redo** for notes (delete is currently final)
- Per-site notes instead of one shared canvas
- `chrome.storage.sync` so notes travel between machines
- Ruled lines or sticky-note backgrounds per note

Say which one you want and it builds on top of what is here.

## How it works

```
manifest.json          MV3 manifest: toolbar action, content script, shortcut
common.js              shared constants, settings + block model (content + pages)
background.js          toolbar click → toggle, badge, context menu, quick panel
content/overlay.js     the canvas: shadow DOM, placed text blocks, in-page toolbar
popup/                 the quick panel (same controls, per-tab switch)
options/               defaults, shortcuts help, reset/clear
fonts/                 Patrick Hand (SIL OFL) for the handwriting option
icons/                 toolbar icons, generated from tools/icon.svg
demo/                  the live demo page (below)
tools/                 smoke test, icon generator, demo server
```

A few decisions worth knowing about:

- **It really is transparent.** The click surface and the note layer have no background at
  all; a note is a bare text box whose only paint is the glyphs. The BG slider is the only
  thing that can paint anything, and it starts at 0.
- **A note is `contenteditable`, so clicking places the caret natively** — exactly where the
  pointer went, including in the middle of a line. Text is kept plain: pastes are stripped
  to text, and bold/italic shortcuts are ignored.
- **Positions are stored as fractions of the viewport**, so a note made in a maximised
  window still lands somewhere sensible in a small one, and survives a resize.
- **Everything lives in a shadow DOM** attached to a custom `<overlay-ink>` element, so
  neither your styles nor the page's can bleed into the overlay — and it cannot restyle
  the page.
- **Nothing is injected until you ask for it.** The content script boots on every page but
  only builds the DOM the first time the overlay is shown.
- **No host permissions.** The manifest asks for `activeTab`, `scripting`, `storage` and
  `contextMenus` — no "read data on all websites" access. `activeTab` is granted the moment
  you click the toolbar icon, which is exactly when the overlay needs it.
- **Edit mode pauses the page on purpose.** While placing and typing notes, clicks belong to
  the overlay, otherwise a stray click would navigate away mid-sentence.
- **Notes are local.** They live in `chrome.storage.local` in your own browser profile, and
  are shared across tabs. Nothing is sent anywhere; there is no network code in the
  extension at all.

## Development

```bash
npm install        # jsdom + resvg, dev only — the extension itself has no dependencies
npm test           # headless checks: the canvas model, styles, moving, deleting, sync
npm run test:preview  # check demo cache headers and fresh responses
npm run icons      # regenerate icons/*.png from tools/icon.svg
python3 tools/preview-server.py 8080   # serve the demo at http://localhost:8080/
```

`npm test` loads `content/overlay.js` into a jsdom page with a fake `chrome` API and drives
it the way a pointer, the panel and the options page do — clicking empty canvas to place
notes, typing, restyling one note without touching the others, dragging by the grip,
deleting, clearing, re-injection, storage races, migrating 0.1 notes into a block, and the
message flow the demo page uses.

### The demo page

`demo/index.html` runs the **real** content script on an ordinary web page with a small
stand-in for the browser APIs, so you can try the whole thing before installing anything:
the pretend browser bar at the top has a clickable Overlay Ink icon that behaves exactly
like the toolbar button, badge and all. The demo displays the current version, uses
versioned asset URLs, and the preview server disables caching so a reload picks up changes.

## Licence

Extension code: MIT. Handwriting font: *Patrick Hand* by Patrick Wagesreiter, SIL Open Font
License 1.1 (`fonts/OFL.txt`).
