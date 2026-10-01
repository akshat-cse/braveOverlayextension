# Overlay Ink

A transparent overlay you can write on, on top of any web page — a Brave / Chrome
(Manifest V3) extension.

Click the toolbar icon, a see-through layer appears with a small toolbar pinned to
the top of the screen, and you type. The page underneath is still visible: only your
text is drawn, nothing else. Everything you write is kept, so the same note follows
you from tab to tab, and you can hide the whole thing whenever you want.

```
┌──────────────────────────────────────────────────────────────┐
│  ⬤ ⬤ ⬤   example.com                            [ 🖊  EDIT ] │  ← toolbar icon shows the state
├──────────────────────────────────────────────────────────────┤
│        ┌────────────────────────────────────────────┐        │
│        │ Edit │ View │ ● ● ● ● ● ● ● ● │ Size ── 44px │        │  ← the overlay's own toolbar
│        │ Font ▾ │ BG ── 0% │ ⨁ │ Clear │    ✕      │        │
│        └────────────────────────────────────────────┘        │
│                                                              │
│      Remember to reply to Dr. Rao about the             ← your writing, in a colour you picked
│      second draft before Friday.                             │
│                                                              │
│   The page itself is completely visible — the overlay only   │
│   draws the text on top of it.                               │
└──────────────────────────────────────────────────────────────┘
```

## Install in Brave

1. Open `brave://extensions`.
2. Turn on **Developer mode** (top-right switch).
3. Click **Load unpacked** and choose this folder.
4. The Overlay Ink icon appears in the toolbar — drag it next to the address bar if
   it is hidden behind the puzzle-piece menu.

Works the same in Chrome and Edge (`chrome://extensions`). PDF viewer pages are the
one place it cannot run — that is a browser limitation for every extension.

## Using it

**Toggle it on/off** — click the toolbar icon, or press <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>O</kbd>.
The icon shows a small **EDIT** / **VIEW** badge whenever the overlay is up, so you can
always tell at a glance.

**The first thing you see** is the overlay in **Edit** mode with the caret already in
place — just start typing. The little toolbar on top is where the choices are:

| Control | What it does |
| --- | --- |
| **Edit / View** | Edit pauses the page so clicks land in your note. View leaves the note on screen and gives every click back to the page, so you can keep reading and scrolling normally. |
| **Colour swatches** | Eight ready-made ink colours, plus the dotted circle on the end for any colour you like. |
| **Size** | Text size, 12–240 px. |
| **Font** | Handwriting (bundled), sans, serif or mono. |
| **BG** | A faint panel behind the words. At 0% — the default — the overlay is *completely* transparent, exactly as you asked. |
| **⨁ (outline)** | A soft outline around the letters so the ink stays readable over busy pages. |
| **Clear** | Wipes the note text. Asks once ("Sure?") before it does. |
| **✕** | Hides the overlay. Your text is saved. |

**Esc** inside the note jumps from Edit to View — the quickest way to go from writing
to using the page again. **Alt**+<kbd>Shift</kbd>+<kbd>H</kbd> hides the overlay from
anywhere on the page.

**The quick panel** — right-click the toolbar icon and choose *Overlay Ink: quick
panel*. It is the same controls in a small floating window, with an on/off switch, and
changes you make there appear live in the overlay on the page.

**Options** — right-click the toolbar icon → *Overlay Ink: options* (or *Extensions →
Overlay Ink → Details → Extension options*). That page sets the defaults every new
overlay starts with and explains the shortcuts. You can also reassign them here:
`brave://extensions/shortcuts` → Overlay Ink.

Right-clicking the icon also gives you *Overlay Ink: write on this page*, and the same
item appears in the right-click menu of any page.

## What it does not do (yet)

This is the starter you asked for, so it deliberately stops at: transparent overlay,
text in a few colours/sizes/fonts, toggle from the toolbar, Edit/View, and the
shortcut. Natural next steps:

- Freehand drawing / highlighting with a pointer, not just typed text
- Arrows, boxes and underline shapes
- Per-site notes instead of one shared note
- `chrome.storage.sync` so notes travel between machines
- Ruled lines, sticky-note backgrounds, PDF-friendly text layers

Say which one you want and it builds on top of what is here.

## How it works

```
manifest.json          MV3 manifest: toolbar action, content script, shortcut
common.js              shared constants + settings normalisation (content + pages)
background.js          toolbar click → toggle, badge, context menu, quick panel
content/overlay.js     the overlay itself: shadow DOM, textarea, in-page toolbar
popup/                 the quick panel (same controls, per-tab switch)
options/               defaults, shortcuts help, reset/clear
fonts/                 Patrick Hand (SIL OFL) for the handwriting option
icons/                 toolbar icons, generated from tools/icon.svg
demo/                  the live demo page (below)
tools/                 smoke test, icon generator, demo server
```

A few decisions worth knowing about:

- **It really is transparent.** No full-screen panel, no tinted backdrop: a
  full-page `<textarea>` with `background: transparent` and nothing else, plus the
  small toolbar. The BG slider is the only thing that can paint anything, and it
  starts at 0.
- **Everything lives in a shadow DOM** attached to a custom `<overlay-ink>` element,
  so neither your styles nor the page's can bleed into the overlay — and the overlay
  cannot restyle the page.
- **Nothing is injected until you ask for it.** The content script boots on every page
  but only builds the DOM the first time the overlay is shown.
- **No host permissions.** The manifest asks for `activeTab`, `scripting`, `storage`
  and `contextMenus` — no "read data on all websites" access. `activeTab` is granted
  the moment you click the toolbar icon, which is exactly when the overlay needs it.
- **Edit mode pauses the page on purpose.** While writing, clicks belong to the note,
  otherwise a stray click would navigate away mid-sentence. The overlay's own toolbar
  stays clickable in both modes, and View mode hands the page back completely.
- **Your text is local.** It is stored with `chrome.storage.local` in your own browser
  profile. Nothing is sent anywhere; there is no network code in the extension at all.

## Development

```bash
npm install        # jsdom + resvg, dev only — the extension itself has no dependencies
npm test           # 61 headless checks: settings, toggling, typing, modes, messages
npm run icons      # regenerate icons/*.png from tools/icon.svg
python3 tools/preview-server.py 8080   # serve the demo at http://localhost:8080/
```

`npm test` loads `content/overlay.js` into a jsdom page with a fake `chrome` API and
drives it the way the toolbar, the panel and the options page do — including
re-injection, storage races and the badge/message flow the demo page uses.

### The demo page

`demo/index.html` runs the **real** content script on an ordinary web page with a small
stand-in for the browser APIs, so you can see and try the overlay before installing
anything: the pretend browser bar at the top has a clickable Overlay Ink icon that
behaves exactly like the toolbar button, badge and all.

## Licence

Extension code: MIT. Handwriting font: *Patrick Hand* by Patrick Wagesreiter, SIL Open
Font License 1.1 (`fonts/OFL.txt`).
