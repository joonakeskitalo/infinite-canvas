# Jiiris 📐 — an infinite canvas for developers

Jiiris is a browser-based infinite canvas for working with UI screenshots. Paste in
screenshots, annotate them, check alignment with split lines, verify color contrast for
WCAG compliance, and preview your designs through color vision filters. Everything runs
locally in the browser.

## Getting started

```bash
npm start        # serve the app locally (npx serve .)
npm run bundle   # produce a single-file bundle in dist/
```

Then open the served URL in your browser. On first visit you'll see a welcome modal with a
tour of the tools, keyboard shortcuts, and tips. You can reopen it anytime from the menu
under **Help & Shortcuts**.

## Features

### Getting images onto the canvas

- Paste images directly from the clipboard (`Ctrl/⌘+V`)
- Drag and drop image files onto the canvas
- Import image files from disk (PNG, JPEG, HEIF/HEIC, WebP, and more)

### Canvas navigation

- Infinite pannable, zoomable canvas
- Pan with the Hand tool, `Space`+drag, or right-click+drag with any tool
- Zoom with `Ctrl/⌘`+scroll, `+`/`−`, or the zoom slider
- Zoom to 100% (`⌘+0`), fit all (`Shift+1`), or fit selection (`Shift+2`)
- Center the view on the selection or origin
- Optional rulers (`Shift+R`) and a configurable background grid
- Adjustable workspace background color

### Drawing & annotation tools

- **Pen** [B] — freehand drawing
- **Line** [L] and **Arrow** [A] — straight lines and arrows
- **Connector** [C] — connector arrows
- **Box** — bordered [R] and filled [F] rectangles
- **Text** [T] — canvas text with bold/italic/underline/strikethrough, font family, size, and alignment
- **Sticky Note** [N] — text notes with a colored background
- **Laser Pointer** [P] — click for dots, drag for freeform strokes that fade away
- **Eraser** [E] — remove objects
- Adjustable stroke color, width, line style (solid, dashed, dotted, dash-dot), and element opacity
- Recent color history and custom color palettes (importable/exportable as JSON)

### Alignment & layout

- Align selected elements left, right, center (horizontal/vertical), top, and bottom
- Distribute elements horizontally or vertically with configurable spacing
- Auto-arrange into rows, columns, or a mosaic grid
- Arrange by size or by name
- Z-order controls: bring to front/forward, send to back/backward
- Group/ungroup and lock/unlock elements
- Set exact width, height, and length via numeric inputs

### Developer & design utilities

- **Split Line** [W] — drop vertical/horizontal reference lines to spot alignment issues
- **Measure** [Y] — measure distances on the canvas
- **Marquee Select** [M] — select, move, cut, and copy image pixels
- **Stamp** [S] — copy element regions from an image and paste them back onto images
- **Contrast Checker** [K] — pick two colors and check the ratio against WCAG AA/AAA thresholds
- **Color Picker / Eyedropper** [I] — sample any pixel; shows hex, RGB, and HSL
- **Crop** — crop images with copyable/pasteable crop settings
- Read out and copy all colors within a marquee selection

### Accessibility previews

- Color vision filters: protanopia/protanomaly, deuteranopia/deuteranomaly,
  tritanopia/tritanomaly, achromatopsia/achromatomaly, plus low/high contrast and
  low-quality display simulations
- **Accessibility Preview** [J] — select an area to preview it through the filters
- **Filter Preview** mode (`Alt+P`) — view every filter on each image side by side

### Saving & exporting

- Save and open canvas files (`⌘+S` / `⌘+O`)
- Copy the canvas or selection to the clipboard as PNG (`⌘+E`)
- Download as PNG (`Shift+⌘+E`) or JPEG (`Shift+⌘+J`)
- Export at full or 50% scale, with or without a background margin
- Export just a marquee region when one is active
- Download pasted images as individual asset files (ZIP)

### Command palette

- Open with `Shift+Space` for fuzzy-search access to every tool, export option, and command

## Keyboard shortcuts

| Action              | Shortcut                                 |
| ------------------- | ---------------------------------------- |
| Undo / Redo         | `⌘+Z` / `Shift+⌘+Z`                      |
| Copy / Paste        | `⌘+C` / `⌘+V`                            |
| Duplicate           | `⌘+D`                                    |
| Select all          | `⌘+A`                                    |
| Group / Ungroup     | `⌘+G` / `Shift+⌘+G`                      |
| Lock / Unlock       | `⌘+L`                                    |
| Pan canvas          | `Space`+drag                             |
| Zoom in / out       | `Ctrl/⌘`+scroll or `+` / `−`             |
| Zoom to 100%        | `⌘+0`                                    |
| Zoom to fit all     | `Shift+1`                                |
| Zoom to selection   | `Shift+2`                                |
| Nudge selection     | Arrow keys (`Shift` = 10px, `⌘` = 100px) |
| Font size up / down | `Shift` + `+` / `−`                      |
| Delete selection    | `Delete` / `Backspace`                   |
| Save / Open file    | `⌘+S` / `⌘+O`                            |
| Toggle rulers       | `Shift+R`                                |
| Filter preview      | `Alt+P`                                  |
| Command palette     | `Shift+Space`                            |

On Windows/Linux, use `Ctrl` in place of `⌘`.

## Tips

- Hold `Shift` while drawing lines to lock orientation to horizontal, vertical, or 45°. This also enables grid snapping for the move tool.
- Right-click and drag to pan while any tool is active.
- Use the color vision filters to sanity-check accessibility before shipping.
