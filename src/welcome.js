/**
 * Welcome Modal — First-time introduction
 *
 * Shows a welcome/onboarding modal on the user's first visit.
 * Uses localStorage to remember if the modal has been dismissed.
 * Can be re-opened from the toolbar menu.
 */

import { isMacPlatform } from "./utils.js";

const STORAGE_KEY = "jiiris-welcomed";

function mod() {
  return isMacPlatform ? "⌘" : "Ctrl";
}

// SVG icons matching the toolbar icons for each tool
const TOOL_ICONS = {
  hand: `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2"/><path d="M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2"/><path d="M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/></svg>`,
  select: `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M7 2l12 11.2-5.3.7 3.5 6.6-2.5 1.3-3.6-6.6-4.1 3.5V2z"/></svg>`,
  pen: `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/></svg>`,
  line: `<svg width="20" height="20" fill="currentColor" viewBox="0 0 24 24"><path d="M4 20L20 4l1.5 1.5L5.5 21.5z"/></svg>`,
  arrow: `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 13V19H13"/><path d="M5 5L19 19"/></svg>`,
  connector: `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8.464 8.464l9.536 9.536"/><path d="M14 18h4v-4"/><path d="M8.414 8.414a2 2 0 1 0-2.828-2.828a2 2 0 0 0 2.828 2.828"/></svg>`,
  rectBorder: `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V5h14v14z"/></svg>`,
  rectFill: `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z"/></svg>`,
  text: `<svg width="20" height="20" fill="currentColor" viewBox="0 0 24 24"><path d="M5 4v3h5.5v12h3V7H19V4H5z"/></svg>`,
  stickyNote: `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="3" width="18" height="18" rx="2" fill="#f5e642" opacity="0.85"/><text x="12" y="16" text-anchor="middle" font-size="12" font-weight="bold" fill="#333">T</text></svg>`,
  eraser: `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/></svg>`,
  measure: `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.3 15.3a2.4 2.4 0 0 1 0 3.4l-2.6 2.6a2.4 2.4 0 0 1-3.4 0L2.7 8.7a2.41 2.41 0 0 1 0-3.4l2.6-2.6a2.41 2.41 0 0 1 3.4 0Z"/><path d="m14.5 12.5 2-2"/><path d="m11.5 9.5 2-2"/><path d="m8.5 6.5 2-2"/><path d="m17.5 15.5 2-2"/></svg>`,
  guideLine: `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="2" x2="12" y2="22" stroke-dasharray="4 2"/><line x1="6" y1="2" x2="6" y2="22" opacity="0.4" stroke-dasharray="4 2"/><line x1="18" y1="2" x2="18" y2="22" opacity="0.4" stroke-dasharray="4 2"/></svg>`,
  contrast: `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 18a6 6 0 0 0 0-12v12z"/></svg>`,
  eyedropper: `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 9-8.414 8.414A2 2 0 0 0 3 18.828v1.344a2 2 0 0 1-.586 1.414A2 2 0 0 1 3.828 21h1.344a2 2 0 0 0 1.414-.586L15 12"/><path d="m18 9 .4.4a1 1 0 1 1-3 3l-3.8-3.8a1 1 0 1 1 3-3l.4.4 3.4-3.4a1 1 0 1 1 3 3z"/><path d="m2 22 .414-.414"/></svg>`,
};

// ─── Animated tool showcase (single canvas carousel) ──────────────────────────

const SHOWCASE_SCENES = [
  {
    title: "Split Line Tool",
    key: "W",
    icon: TOOL_ICONS.guideLine,
    draw(ctx, W, H, t) {
      // Mock UI with text and buttons to check alignment against
      ctx.fillStyle = "#f5f5f5";
      ctx.fillRect(0, 0, W, H);

      // Header area
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, W, 40);
      ctx.strokeStyle = "#e0e0e0";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, 40);
      ctx.lineTo(W, 40);
      ctx.stroke();

      // Logo / nav text
      ctx.fillStyle = "#333";
      ctx.font = "bold 13px sans-serif";
      ctx.fillText("Dashboard", 30, 26);

      // Navigation links in header
      ctx.font = "12px sans-serif";
      ctx.fillStyle = "#666";
      ctx.fillText("Home", 160, 26);
      ctx.fillText("Settings", 220, 26);
      ctx.fillText("Profile", 300, 26);

      // Left-aligned text block
      const textX = 30;
      ctx.fillStyle = "#1a1a1a";
      ctx.font = "bold 16px sans-serif";
      ctx.fillText("Welcome back, user", textX, 75);
      ctx.font = "13px sans-serif";
      ctx.fillStyle = "#666";
      ctx.fillText("Here's your activity summary", textX, 97);

      // Cards row
      const card1X = 30;
      const card2X = 200;
      const card3X = 370;
      const cardY = 115;
      const cardW = 150;
      const cardH = 80;

      // Card 1
      ctx.fillStyle = "#fff";
      roundRect(ctx, card1X, cardY, cardW, cardH, 5);
      ctx.fill();
      ctx.strokeStyle = "#e0e0e0";
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = "#333";
      ctx.font = "bold 11px sans-serif";
      ctx.fillText("Revenue", card1X + 12, cardY + 22);
      ctx.fillStyle = "#007acc";
      ctx.font = "bold 18px sans-serif";
      ctx.fillText("$12,400", card1X + 12, cardY + 50);

      // Card 2
      ctx.fillStyle = "#fff";
      roundRect(ctx, card2X, cardY, cardW, cardH, 5);
      ctx.fill();
      ctx.strokeStyle = "#e0e0e0";
      ctx.stroke();
      ctx.fillStyle = "#333";
      ctx.font = "bold 11px sans-serif";
      ctx.fillText("Users", card2X + 12, cardY + 22);
      ctx.fillStyle = "#28a745";
      ctx.font = "bold 18px sans-serif";
      ctx.fillText("1,024", card2X + 12, cardY + 50);

      // Card 3
      ctx.fillStyle = "#fff";
      roundRect(ctx, card3X, cardY, cardW, cardH, 5);
      ctx.fill();
      ctx.strokeStyle = "#e0e0e0";
      ctx.stroke();
      ctx.fillStyle = "#333";
      ctx.font = "bold 11px sans-serif";
      ctx.fillText("Orders", card3X + 12, cardY + 22);
      ctx.fillStyle = "#fd7e14";
      ctx.font = "bold 18px sans-serif";
      ctx.fillText("328", card3X + 12, cardY + 50);

      // Button row
      const btnY = 210;
      ctx.fillStyle = "#007acc";
      roundRect(ctx, 30, btnY, 90, 28, 4);
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.font = "12px sans-serif";
      ctx.fillText("Export", 55, btnY + 18);

      ctx.fillStyle = "#fff";
      ctx.strokeStyle = "#007acc";
      ctx.lineWidth = 1.5;
      roundRect(ctx, 135, btnY, 90, 28, 4);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#007acc";
      ctx.fillText("Settings", 155, btnY + 18);

      // Guide line placements — vertical and horizontal
      // Each has: type (v/h), position, cursor target (where cursor clicks)
      const guides = [
        { type: "v", pos: 30, cx: 30, cy: 120, placeAt: 30, moveDur: 25 },
        { type: "h", pos: cardY, cx: 260, cy: cardY, placeAt: 90, moveDur: 30 },
        { type: "v", pos: card2X, cx: card2X, cy: 155, placeAt: 160, moveDur: 30 },
        { type: "h", pos: btnY, cx: 180, cy: btnY, placeAt: 230, moveDur: 25 },
        { type: "v", pos: card3X, cx: card3X, cy: 120, placeAt: 290, moveDur: 30 },
      ];

      const loopLen = 380;
      const lt = t % loopLen;

      // Draw placed guides
      for (const g of guides) {
        if (lt < g.placeAt) continue;
        const age = lt - g.placeAt;
        const alpha = Math.min(1, age / 12);
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.setLineDash([6, 4]);
        ctx.strokeStyle = "#ff4444";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        if (g.type === "v") {
          ctx.moveTo(g.pos, 0);
          ctx.lineTo(g.pos, H);
        } else {
          ctx.moveTo(0, g.pos);
          ctx.lineTo(W, g.pos);
        }
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
      }

      // Animate cursor moving between guide placements
      // Find which segment the cursor is in
      let cursorX = guides[0].cx;
      let cursorY = guides[0].cy;
      let showCursor = false;

      for (let i = 0; i < guides.length; i++) {
        const g = guides[i];
        const moveStart = i === 0 ? 0 : guides[i - 1].placeAt + 15;
        const moveEnd = g.placeAt;

        if (lt >= moveStart && lt <= g.placeAt + 10) {
          showCursor = true;
          if (lt < moveEnd) {
            // Moving toward this guide's position
            const prev = i === 0 ? { cx: W / 2, cy: H / 2 } : guides[i - 1];
            const progress = Math.min(1, (lt - moveStart) / g.moveDur);
            // Ease out
            const ease = 1 - Math.pow(1 - progress, 2);
            cursorX = prev.cx + (g.cx - prev.cx) * ease;
            cursorY = prev.cy + (g.cy - prev.cy) * ease;
          } else {
            // At the placement point
            cursorX = g.cx;
            cursorY = g.cy;
          }
          break;
        }
      }

      if (showCursor) {
        drawCursor(ctx, cursorX + 6, cursorY + 6);
      }
    },
  },
  {
    title: "Contrast Checker",
    key: "K",
    icon: TOOL_ICONS.contrast,
    draw(ctx, W, H, t) {
      const pairIdx = Math.floor(t / 100) % 4;
      const pairs = [
        { fg: "#1a1a1a", bg: "#ffffff", ratio: "21 : 1", pass: true },
        { fg: "#777777", bg: "#ffffff", ratio: "4.5 : 1", pass: true },
        { fg: "#aaaaaa", bg: "#ffffff", ratio: "2.3 : 1", pass: false },
        { fg: "#ffffff", bg: "#007acc", ratio: "4.6 : 1", pass: true },
      ];
      const p = pairs[pairIdx];

      // Background
      ctx.fillStyle = p.bg;
      ctx.fillRect(20, 20, W - 40, H - 70);
      ctx.strokeStyle = "#ddd";
      ctx.lineWidth = 1;
      ctx.strokeRect(20, 20, W - 40, H - 70);

      // Text samples
      ctx.fillStyle = p.fg;
      ctx.font = "bold 22px sans-serif";
      ctx.fillText("Heading Text", 40, 65);
      ctx.font = "15px sans-serif";
      ctx.fillText("Body text for readability check", 40, 95);
      ctx.font = "12px sans-serif";
      ctx.fillText("Small caption text", 40, 120);

      // Color swatches at bottom
      const swatchY = H - 40;
      ctx.fillStyle = p.fg;
      ctx.beginPath();
      ctx.arc(50, swatchY, 14, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#ccc";
      ctx.lineWidth = 1.5;
      ctx.stroke();

      ctx.fillStyle = p.bg;
      ctx.beginPath();
      ctx.arc(85, swatchY, 14, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      // Ratio display
      const badgeX = 130;
      ctx.font = "bold 16px sans-serif";
      ctx.fillStyle = p.pass ? "#28a745" : "#dc3545";
      ctx.fillText(p.ratio, badgeX, swatchY + 5);

      // Pass/Fail badge
      const badgeText = p.pass ? "✓ PASS" : "✗ FAIL";
      const textW = ctx.measureText(p.ratio).width;
      ctx.font = "bold 13px sans-serif";
      ctx.fillText(badgeText, badgeX + textW + 14, swatchY + 5);

      // Animated crosshair cursor picking colors from the text area
      const cursorProgress = (t % 100) / 100;
      // Move cursor between the two click points on the content area
      const cx1 = 60, cy1 = 60;   // first pick point (on heading text)
      const cx2 = 60, cy2 = 100;  // second pick point (on body text)
      const cx = cx1 + (cx2 - cx1) * cursorProgress;
      const cy = cy1 + (cy2 - cy1) * cursorProgress;
      drawCrosshairCursor(ctx, cx, cy);
    },
  },
  {
    title: "Accessibility Filter",
    key: "J",
    icon: `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/></svg>`,
    draw(ctx, W, H, t) {
      const filterIdx = Math.floor(t / 110) % 4;
      const filters = [
        { name: "Normal Vision", transform: (r, g, b) => [r, g, b] },
        { name: "Protanopia", transform: (r, g, b) => [0.56 * r + 0.44 * g, 0.55 * g + 0.45 * r, b] },
        { name: "Deuteranopia", transform: (r, g, b) => [0.63 * r + 0.37 * g, 0.7 * g + 0.3 * r, b] },
        { name: "Tritanopia", transform: (r, g, b) => [r, 0.7 * g + 0.3 * b, 0.56 * b + 0.44 * g] },
      ];
      const f = filters[filterIdx];

      const baseColors = [
        { r: 220, g: 50, b: 50, label: "Error" },
        { r: 50, g: 180, b: 50, label: "Success" },
        { r: 50, g: 80, b: 220, label: "Info" },
        { r: 255, g: 165, b: 0, label: "Warning" },
      ];

      // Draw a mock UI with colored status indicators
      ctx.fillStyle = "#f9f9f9";
      ctx.fillRect(0, 0, W, H);

      const cardW = (W - 60) / 4;
      const cardH = H - 80;
      for (let i = 0; i < baseColors.length; i++) {
        const c = baseColors[i];
        const [r, g, b] = f.transform(c.r, c.g, c.b);
        const x = 20 + i * (cardW + 12);
        const y = 35;

        // Card background
        ctx.fillStyle = "#fff";
        ctx.fillRect(x, y, cardW, cardH);
        ctx.strokeStyle = "#e0e0e0";
        ctx.lineWidth = 1;
        ctx.strokeRect(x, y, cardW, cardH);

        // Color bar at top
        ctx.fillStyle = `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`;
        ctx.fillRect(x, y, cardW, 30);

        // Status dot and label
        ctx.beginPath();
        ctx.arc(x + cardW / 2, y + 55, 8, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = "#333";
        ctx.font = "10px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(c.label, x + cardW / 2, y + cardH - 8);
        ctx.textAlign = "start";
      }

      // Filter name label at top
      ctx.fillStyle = "#007acc";
      ctx.font = "bold 12px sans-serif";
      ctx.fillText(f.name, 20, 22);

      // Indicator dots
      for (let i = 0; i < filters.length; i++) {
        ctx.beginPath();
        ctx.arc(W - 20 - (filters.length - 1 - i) * 14, 18, 4, 0, Math.PI * 2);
        ctx.fillStyle = i === filterIdx ? "#007acc" : "#ccc";
        ctx.fill();
      }

      // Eye/filter icon animation
      const pulse = 0.8 + 0.2 * Math.sin(t * 0.1);
      ctx.beginPath();
      ctx.arc(W - 70, 18, 6 * pulse, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(0,122,204,0.2)";
      ctx.fill();
    },
  },
  {
    title: "Annotation Tools",
    key: "A",
    icon: TOOL_ICONS.arrow,
    draw(ctx, W, H, t) {
      // Draw a mock UI screenshot
      ctx.fillStyle = "#f5f5f5";
      ctx.fillRect(0, 0, W, H);

      // Nav bar
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, W, 35);
      ctx.strokeStyle = "#e0e0e0";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, 35);
      ctx.lineTo(W, 35);
      ctx.stroke();
      ctx.fillStyle = "#333";
      ctx.font = "bold 12px sans-serif";
      ctx.fillText("My App", 20, 23);

      // Button
      ctx.fillStyle = "#007acc";
      roundRect(ctx, W * 0.6, 55, 80, 28, 4);
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.font = "12px sans-serif";
      ctx.fillText("Submit", W * 0.6 + 18, 74);

      // Input field
      ctx.fillStyle = "#fff";
      ctx.strokeStyle = "#ccc";
      roundRect(ctx, 30, 55, W * 0.5, 28, 4);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#999";
      ctx.font = "11px sans-serif";
      ctx.fillText("Enter email...", 40, 73);

      // Card
      ctx.fillStyle = "#fff";
      roundRect(ctx, 30, 100, W - 60, 70, 6);
      ctx.fill();
      ctx.strokeStyle = "#e0e0e0";
      ctx.stroke();
      ctx.fillStyle = "#ddd";
      ctx.fillRect(45, 115, 100, 10);
      ctx.fillRect(45, 133, 150, 8);
      ctx.fillRect(45, 148, 80, 8);

      // Animated arrows drawn by cursor
      const arrows = [
        { from: [W - 40, 170], to: [W * 0.6 + 80, 70], dur: 50, delay: 0 },
        { from: [25, 195], to: [40, 83], dur: 50, delay: 60 },
      ];

      const loopLen = 240;
      const lt = t % loopLen;

      for (const a of arrows) {
        const localT = lt - a.delay;
        if (localT <= 0) continue;
        const progress = Math.min(1, localT / a.dur);
        const [fx, fy] = a.from;
        const [tx, ty] = a.to;
        const cx = fx + (tx - fx) * progress;
        const cy = fy + (ty - fy) * progress;

        // Arrow line
        ctx.beginPath();
        ctx.moveTo(fx, fy);
        ctx.lineTo(cx, cy);
        ctx.strokeStyle = "#ff4444";
        ctx.lineWidth = 2.5;
        ctx.lineCap = "round";
        ctx.stroke();

        // Arrowhead
        if (progress > 0.2) {
          const angle = Math.atan2(ty - fy, tx - fx);
          const headLen = 10;
          ctx.beginPath();
          ctx.moveTo(cx, cy);
          ctx.lineTo(cx - headLen * Math.cos(angle - Math.PI / 6), cy - headLen * Math.sin(angle - Math.PI / 6));
          ctx.moveTo(cx, cy);
          ctx.lineTo(cx - headLen * Math.cos(angle + Math.PI / 6), cy - headLen * Math.sin(angle + Math.PI / 6));
          ctx.stroke();
        }

        // Show cursor at drawing tip
        if (progress < 1) {
          drawCursor(ctx, cx + 2, cy + 2);
        }
      }

      // Text note annotation — appears after arrows finish
      const noteDelay = 130;
      const noteText = "Fix button alignment";
      if (lt > noteDelay) {
        const noteChars = Math.min(noteText.length, Math.floor((lt - noteDelay) / 2.5));
        const noteX = W * 0.6 + 90;
        const noteY = 56;

        // Note background
        if (noteChars > 0) {
          const textWidth = ctx.measureText(noteText.slice(0, noteChars)).width;
          ctx.fillStyle = "#fff8d6";
          ctx.strokeStyle = "#e6c619";
          ctx.lineWidth = 1;
          roundRect(ctx, noteX - 6, noteY - 13, textWidth + 12, 20, 3);
          ctx.fill();
          ctx.stroke();

          // Note text
          ctx.fillStyle = "#333";
          ctx.font = "11px sans-serif";
          ctx.fillText(noteText.slice(0, noteChars), noteX, noteY);

          // Blinking cursor while typing
          if (noteChars < noteText.length && Math.floor(t / 18) % 2 === 0) {
            const cursorX = noteX + ctx.measureText(noteText.slice(0, noteChars)).width + 1;
            ctx.fillStyle = "#007acc";
            ctx.fillRect(cursorX, noteY - 11, 1.5, 14);
          }
        }
      }
    },
  },
];

// Utility: draw a pointer cursor shape
function drawCursor(ctx, x, y) {
  ctx.save();
  ctx.fillStyle = "#222";
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x, y + 14);
  ctx.lineTo(x + 4, y + 11);
  ctx.lineTo(x + 7, y + 17);
  ctx.lineTo(x + 10, y + 16);
  ctx.lineTo(x + 7, y + 10);
  ctx.lineTo(x + 11, y + 10);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();
}

// Utility: draw a crosshair cursor
function drawCrosshairCursor(ctx, x, y) {
  ctx.save();
  ctx.strokeStyle = "#333";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x - 7, y);
  ctx.lineTo(x + 7, y);
  ctx.moveTo(x, y - 7);
  ctx.lineTo(x, y + 7);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, y, 3, 0, Math.PI * 2);
  ctx.strokeStyle = "#007acc";
  ctx.stroke();
  ctx.restore();
}

// Utility: rounded rect path
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// ─── Carousel state ──────────────────────────────────────────────────────────

let _animFrameId = null;
let _currentScene = 0;
let _sceneStartTime = 0;
const SCENE_DURATION = 7000; // ms per scene

function buildAnimatedDemoContent() {
  const dots = SHOWCASE_SCENES.map((_, i) =>
    `<button class="welcome-showcase-dot${i === 0 ? " active" : ""}" data-scene="${i}" aria-label="Scene ${i + 1}"></button>`
  ).join("");

  return `
    <div class="welcome-showcase">
      <div class="welcome-showcase-canvas-wrap">
        <canvas class="welcome-showcase-canvas" width="700" height="280"></canvas>
      </div>
      <div class="welcome-showcase-footer">
        <div class="welcome-showcase-info">
          <span class="welcome-showcase-icon">${SHOWCASE_SCENES[0].icon}</span>
          <span class="welcome-showcase-title">${SHOWCASE_SCENES[0].title}</span>
          <span class="welcome-tool-key">${SHOWCASE_SCENES[0].key}</span>
        </div>
        <div class="welcome-showcase-dots">${dots}</div>
      </div>
    </div>
  `;
}

function startAnimatedDemos(container) {
  stopAnimatedDemos();
  const canvas = container.querySelector(".welcome-showcase-canvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;

  _currentScene = 0;
  _sceneStartTime = performance.now();

  function loop(now) {
    const elapsed = now - _sceneStartTime;

    // Auto-advance scene
    if (elapsed > SCENE_DURATION) {
      _currentScene = (_currentScene + 1) % SHOWCASE_SCENES.length;
      _sceneStartTime = now;
      updateSceneUI(container);
    }

    // Frame counter relative to scene start
    const sceneT = (now - _sceneStartTime) / 28; // slowed tick rate

    ctx.clearRect(0, 0, W, H);
    SHOWCASE_SCENES[_currentScene].draw(ctx, W, H, sceneT);

    _animFrameId = requestAnimationFrame(loop);
  }

  _animFrameId = requestAnimationFrame(loop);

  // Dot click navigation
  const dots = container.querySelectorAll(".welcome-showcase-dot");
  dots.forEach((dot) => {
    dot.addEventListener("click", () => {
      _currentScene = parseInt(dot.dataset.scene, 10);
      _sceneStartTime = performance.now();
      updateSceneUI(container);
    });
  });
}

function updateSceneUI(container) {
  const scene = SHOWCASE_SCENES[_currentScene];
  const info = container.querySelector(".welcome-showcase-info");
  if (info) {
    info.innerHTML = `
      <span class="welcome-showcase-icon">${scene.icon}</span>
      <span class="welcome-showcase-title">${scene.title}</span>
      <span class="welcome-tool-key">${scene.key}</span>
    `;
  }
  const dots = container.querySelectorAll(".welcome-showcase-dot");
  dots.forEach((d, i) => d.classList.toggle("active", i === _currentScene));
}

function stopAnimatedDemos() {
  if (_animFrameId) {
    cancelAnimationFrame(_animFrameId);
    _animFrameId = null;
  }
}

// ─── End animated demos ──────────────────────────────────────────────────────

function buildToolsContent() {
  const tools = [
    { key: "H", label: "Hand (Pan)", icon: TOOL_ICONS.hand },
    { key: "V", label: "Select", icon: TOOL_ICONS.select },
    { key: "B", label: "Pen (Draw)", icon: TOOL_ICONS.pen },
    { key: "L", label: "Line", icon: TOOL_ICONS.line },
    { key: "A", label: "Arrow", icon: TOOL_ICONS.arrow },
    { key: "C", label: "Connector", icon: TOOL_ICONS.connector },
    { key: "R", label: "Box (Border)", icon: TOOL_ICONS.rectBorder },
    { key: "F", label: "Box (Fill)", icon: TOOL_ICONS.rectFill },
    { key: "T", label: "Text", icon: TOOL_ICONS.text },
    { key: "N", label: "Sticky Note", icon: TOOL_ICONS.stickyNote },
    { key: "E", label: "Eraser", icon: TOOL_ICONS.eraser },
    { key: "Y", label: "Measure", icon: TOOL_ICONS.measure },
    { key: "W", label: "Split Line", icon: TOOL_ICONS.guideLine },
    { key: "S", label: "Stamp", icon: TOOL_ICONS.stamp || "📋" },
    { key: "K", label: "Contrast Checker", icon: TOOL_ICONS.contrast },
    { key: "I", label: "Color Picker", icon: TOOL_ICONS.eyedropper },
  ];

  const items = tools.map((t) => `
    <div class="welcome-tool-item">
      <span class="welcome-tool-icon">${t.icon}</span>
      <span class="welcome-tool-label">${t.label}</span>
      <span class="welcome-tool-key">${t.key}</span>
    </div>
  `).join("");

  return `<div class="welcome-tools-grid">${items}</div>`;
}

function buildShortcutsContent() {
  const m = mod();
  return `
    <div class="welcome-shortcuts-grid">
      <div class="welcome-shortcut-item">
        <span class="welcome-shortcut-keys">${m}+Z</span>
        <span class="welcome-shortcut-label">Undo</span>
      </div>
      <div class="welcome-shortcut-item">
        <span class="welcome-shortcut-keys">${m}+Shift+Z</span>
        <span class="welcome-shortcut-label">Redo</span>
      </div>
      <div class="welcome-shortcut-item">
        <span class="welcome-shortcut-keys">${m}+C / ${m}+V</span>
        <span class="welcome-shortcut-label">Copy / Paste</span>
      </div>
      <div class="welcome-shortcut-item">
        <span class="welcome-shortcut-keys">${m}+D</span>
        <span class="welcome-shortcut-label">Duplicate</span>
      </div>
      <div class="welcome-shortcut-item">
        <span class="welcome-shortcut-keys">${m}+A</span>
        <span class="welcome-shortcut-label">Select All</span>
      </div>
      <div class="welcome-shortcut-item">
        <span class="welcome-shortcut-keys">${m}+G</span>
        <span class="welcome-shortcut-label">Group</span>
      </div>
      <div class="welcome-shortcut-item">
        <span class="welcome-shortcut-keys">Space + Drag</span>
        <span class="welcome-shortcut-label">Pan canvas</span>
      </div>
      <div class="welcome-shortcut-item">
        <span class="welcome-shortcut-keys">${isMacPlatform ? "⌘" : "Ctrl"}+Scroll</span>
        <span class="welcome-shortcut-label">Zoom in/out</span>
      </div>
      <div class="welcome-shortcut-item">
        <span class="welcome-shortcut-keys">+ / −</span>
        <span class="welcome-shortcut-label">Zoom in/out</span>
      </div>
      <div class="welcome-shortcut-item">
        <span class="welcome-shortcut-keys">${m}+0</span>
        <span class="welcome-shortcut-label">Zoom to 100%</span>
      </div>
      <div class="welcome-shortcut-item">
        <span class="welcome-shortcut-keys">Shift+1</span>
        <span class="welcome-shortcut-label">Zoom to fit all</span>
      </div>
      <div class="welcome-shortcut-item">
        <span class="welcome-shortcut-keys">Shift+2</span>
        <span class="welcome-shortcut-label">Zoom to selection</span>
      </div>
      <div class="welcome-shortcut-item">
        <span class="welcome-shortcut-keys">Shift + / −</span>
        <span class="welcome-shortcut-label">Font size up/down</span>
      </div>
      <div class="welcome-shortcut-item">
        <span class="welcome-shortcut-keys">Delete / Backspace</span>
        <span class="welcome-shortcut-label">Remove selected</span>
      </div>
      <div class="welcome-shortcut-item">
        <span class="welcome-shortcut-keys">Arrow Keys</span>
        <span class="welcome-shortcut-label">Nudge (Shift=10, ${m}=100)</span>
      </div>
      <div class="welcome-shortcut-item">
        <span class="welcome-shortcut-keys">${m}+S</span>
        <span class="welcome-shortcut-label">Save file</span>
      </div>
      <div class="welcome-shortcut-item">
        <span class="welcome-shortcut-keys">${m}+O</span>
        <span class="welcome-shortcut-label">Open file</span>
      </div>
      <div class="welcome-shortcut-item">
        <span class="welcome-shortcut-keys">Shift+R</span>
        <span class="welcome-shortcut-label">Toggle rulers</span>
      </div>
      <div class="welcome-shortcut-item">
        <span class="welcome-shortcut-keys">Alt+P</span>
        <span class="welcome-shortcut-label">Filter preview</span>
      </div>
    </div>
  `;
}

function buildTipsContent() {
  return `
    <ul class="welcome-tips-list">
      <li>Paste images directly from your clipboard onto the canvas</li>
      <li>Drag and drop image files to import them</li>
      <li>Hold <strong>Shift</strong> while drawing lines to snap to angles</li>
      <li>Right-click + drag to pan with any tool active</li>
      <li>Use the color vision filters to check accessibility</li>
    </ul>
  `;
}

/**
 * Show the welcome modal (used both for first-visit and re-open).
 */
function showWelcomeModal() {
  const overlay = document.getElementById("welcome-overlay");
  if (!overlay) return;

  overlay.style.display = "flex";

  // Populate tab content
  const toolsPanel = document.getElementById("welcome-tab-tools");
  const shortcutsPanel = document.getElementById("welcome-tab-shortcuts");
  const tipsPanel = document.getElementById("welcome-tab-tips");

  if (toolsPanel && !toolsPanel.dataset.inited) {
    toolsPanel.innerHTML = buildAnimatedDemoContent() + buildToolsContent();
    toolsPanel.dataset.inited = "1";
  }
  startAnimatedDemos(toolsPanel);
  if (shortcutsPanel) shortcutsPanel.innerHTML = buildShortcutsContent();
  if (tipsPanel) tipsPanel.innerHTML = buildTipsContent();

  // Reset to first tab
  const tabBtns = overlay.querySelectorAll(".welcome-tab-btn");
  const tabPanels = overlay.querySelectorAll(".welcome-tab-panel");
  tabBtns.forEach((b) => b.classList.remove("active"));
  tabPanels.forEach((p) => p.classList.remove("active"));
  tabBtns[0]?.classList.add("active");
  tabPanels[0]?.classList.add("active");
}

function setupModalListeners() {
  const overlay = document.getElementById("welcome-overlay");
  if (!overlay) return;

  const closeBtn = overlay.querySelector(".welcome-close-btn");
  const getStartedBtn = overlay.querySelector(".welcome-get-started-btn");
  const tabBtns = overlay.querySelectorAll(".welcome-tab-btn");
  const tabPanels = overlay.querySelectorAll(".welcome-tab-panel");

  // Tab switching
  tabBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      tabBtns.forEach((b) => b.classList.remove("active"));
      tabPanels.forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      const target = document.getElementById(btn.dataset.tab);
      if (target) target.classList.add("active");
    });
  });

  function dismiss() {
    overlay.style.display = "none";
    localStorage.setItem(STORAGE_KEY, "1");
    stopAnimatedDemos();
  }

  closeBtn.addEventListener("click", dismiss);
  getStartedBtn.addEventListener("click", dismiss);

  // Close on Escape
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && overlay.style.display === "flex") {
      dismiss();
    }
  });

  // Close when clicking overlay background
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) dismiss();
  });

  // Wire up the "Help" menu item to re-open the modal
  const helpBtn = document.getElementById("show-welcome-btn");
  if (helpBtn) {
    helpBtn.addEventListener("click", () => {
      showWelcomeModal();
      // Close the toolbar menu
      const toolbarMenu = document.getElementById("toolbar-menu");
      if (toolbarMenu) toolbarMenu.classList.remove("open");
      const menuBtn = document.getElementById("toolbar-menu-btn");
      if (menuBtn) menuBtn.classList.remove("menu-open");
    });
  }
}

export function initWelcomeModal() {
  setupModalListeners();

  // Show on first visit
  if (!localStorage.getItem(STORAGE_KEY)) {
    showWelcomeModal();
  }
}
