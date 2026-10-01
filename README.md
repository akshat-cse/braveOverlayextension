# Overlay Ink

A completely transparent, click-anywhere text canvas on top of a web page.
Built for **Brave** and other Chromium browsers (Manifest V3).

**v0.3.0: controls live in the standard extension popup, not in a bar on the page.**
Open the icon, switch On, choose your style, then close the popup and write anywhere.
Closing the controls never turns the canvas off.

## Install in Brave

1. Open `brave://extensions` and enable **Developer mode**.
2. Choose **Load unpacked** and select this repository folder.
3. Pin Overlay Ink from the extensions menu so its icon is next to the address bar.
4. Click the icon to open its popup, then use the **On/Off** switch.

After updating the files, click **Reload** on the extension card and refresh any website
that was already open. The popup asks for a page reload if it finds an older content script.

The extension cannot run on browser-internal pages, extension stores or the built-in PDF
viewer. Use an ordinary website. Chrome and Edge can load the same folder.

## Write with the whole page available

1. **Open the popup:** click the extension icon, or press <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>O</kbd>.
   Opening it does not toggle the overlay.
2. **Turn On:** choose Edit mode and your ink colour, text size and font.
3. **Close the popup:** click **Done · write on page**, its **✕**, press <kbd>Esc</kbd>
   inside it, or click back onto the page. Your canvas stays on, with no floating bar or
   persistent hint occupying the screen.
4. **Click anywhere and type:** the caret lands there. Click a different spot for another
   independent note; they are not one flowing text column.
5. **Reopen the icon** whenever you need controls. Select **View** to use the site normally
   while your notes stay visible, or switch **Off** to hide them. Your notes are kept.

The icon displays an **EDIT** or **VIEW** badge while the overlay is on. The On/Off switch
and all canvas controls are in the popup only; there is no separate floating control window.

### Colours and styles

All of these are in the popup:

| Control | Behaviour |
| --- | --- |
| Eight preset colour dots | Pick an ink colour in one click. |
| Rainbow colour well | Open the full native colour picker. |
| Hex colour field | Type a 3- or 6-digit colour, with or without `#`. Invalid values are not applied. |
| Text size | 12–240 px. |
| Font | Bundled handwriting, sans serif, serif or monospace. |
| Background | 0–100%; **0% is completely transparent** and is the default. |
| Text outline | Improve contrast on a busy page. |
| Clear all notes | Requires a second click to confirm. Deletion is currently final. |
| Reset defaults | Reset settings without changing existing notes' own styles. |

Style follows the selection. **Select an existing note, then open the icon:** the popup
says **Editing selected note**, and colour/size/font change that note only. The note stays
selected when you move focus into the popup, and closing it restores the note’s caret.
Choose **New notes instead** to deselect it
and set defaults for the next note. Background and outline affect the whole canvas.

Changes are sent immediately to the page, so closing the popup right after changing a
control does not discard an unsaved popup timer.

### Move, delete and switch modes

- Hover or select a note in Edit mode for its **⠿** drag grip and **✕** delete handle.
  These are the only small controls on the canvas; they are hidden in View mode.
- A new note left empty disappears when you move away from it.
- **Edit** gives clicks to the canvas so you can write without accidentally following a link.
- **View** is read-only and fully click-through, including over your writing. The underlying
  website can be clicked, scrolled and used normally; no toolbar needs to be avoided.
- On the page, <kbd>Esc</kbd> first deselects a note, and another <kbd>Esc</kbd> switches to View.
  Inside the popup, <kbd>Esc</kbd> just closes the popup.
- <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>H</kbd> hides an open overlay from the page.
- Reassign the popup shortcut at `brave://extensions/shortcuts` → Overlay Ink.

**Options & shortcuts** in the popup opens the defaults/help page. It is also available
by right-clicking the extension icon and choosing **Overlay Ink: options**.

## Storage and privacy

Notes and settings stay in `chrome.storage.local` in your browser profile. There is no
server, upload, analytics or remote font dependency in the extension. The canvas is currently
shared across tabs and websites, rather than saved separately for each site.

- `oiSettings`: mode, new-note colour/size/font, background opacity and outline.
- `oiBlocks`: `{ version: 2, blocks: [{ id, x, y, text, color, fontSize, font }] }`.
  Positions `x` and `y` are viewport fractions, so notes survive resizes sensibly.
- Legacy `oiText` from 0.1 is migrated into a positioned note and then emptied.
  Version 0.3 uses the same block format as 0.2, so existing canvas notes are preserved.

Clearing notes clears the shared canvas everywhere. Resetting defaults does not delete notes.

## How it works

```text
manifest.json          MV3 action.default_popup, content scripts and popup shortcut
common.js              settings, fonts, block normalisation and storage helpers
background.js          EDIT/VIEW badge and Options context menu (no direct action toggle)
content/overlay.js     transparent shadow-DOM canvas, placed notes and per-note handles
popup/                 standard action popup: On/Off, mode and all writing controls
options/               defaults, usage/shortcuts help, reset and clear
fonts/                 bundled Patrick Hand (SIL OFL)
icons/                 toolbar icons generated from tools/icon.svg
demo/                  web preview of the real canvas and the real popup
tools/                 headless tests, icon generator and uncached preview server
```

- The canvas has no background at all unless you explicitly raise the Background slider.
  Notes paint only their text, optional outline and editing handles.
- A shadow DOM isolates the extension from the website's styles. A high stacking layer
  keeps the canvas over ordinary site content without blocking anything in View mode.
- The content script boots on HTTP(S) pages, but builds no overlay DOM until you turn it on.
  The popup can also inject it into a page that was open before the extension was installed.
- The popup communicates via `chrome.tabs.sendMessage`. State replies include settings and
  the selected note's style; style changes explicitly target a note or new-note defaults.
- Each note is a plain-text `contenteditable`. Clicking within a note places the caret
  natively; paste strips formatting and bold/italic/underline shortcuts are suppressed.
- Permissions are `activeTab`, `scripting`, `storage` and `contextMenus`, with no additional
  `host_permissions` entry. The manifest's content-script matches cover HTTP(S) websites.

## Development and the live demo

```bash
npm install
npm test                 # canvas, native popup, background and demo integration checks
npm run test:preview      # HTTP cache/redirect regression checks (Python stdlib)
npm run icons            # regenerate icons/*.png from tools/icon.svg
python3 tools/preview-server.py 8080
# Open http://localhost:8080/ on your development machine.
```

The web preview displays **v0.3.0 · popup controls**. Click its purple icon to open the
same `popup/popup.html` used by Brave, not a duplicate set of demo controls. The demo-only
browser API bridge connects that iframe to the real `content/overlay.js`. The popup bridge
is inert in installed extension contexts and cannot replace Brave's extension APIs.

The preview sends `Cache-Control: no-store`, always serves fresh files rather than 304
responses, and versions its HTML asset URLs, including the popup iframe and its scripts.
Reload an already-open preview tab after edits to see the new build.

Tests use jsdom with a simulated browser API. They cover popup-only controls, closing and
reopening without toggling, retaining note selection across focus changes, per-note style,
defaults, immediate-save-on-close, placing/moving/deleting notes, read-only/click-through
View styles, storage sync, migration, blocked pages and the real popup/demo integration.
jsdom has no layout engine, so drag geometry is shimmed and real Brave installation remains
a manual check.

## Not implemented yet

- Freehand drawing/highlighting, arrows or shapes
- Undo/redo for deleting notes
- Per-site canvases
- Cross-device sync
- Ruled lines or sticky-note backgrounds

## Licence

Extension code: MIT. *Patrick Hand* by Patrick Wagesreiter: SIL Open Font License 1.1
(`fonts/OFL.txt`).
