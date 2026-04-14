<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>PULSE CALLER · AI OPERATING SYSTEM</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&family=JetBrains+Mono:wght@300;400;500;700&display=swap" rel="stylesheet">
<style>
/* ═══════════════════════════════════════════════════════════════
   SUPREME DESIGN SYSTEM
   ═══════════════════════════════════════════════════════════════ */
:root {
  --void:     #04060b;
  --base:     #07090f;
  --surface:  #0b0e17;
  --surface2: #0f1420;
  --surface3: #131825;
  --border:   rgba(255,255,255,0.06);
  --border2:  rgba(255,255,255,0.12);

  --green:    #00e676;
  --green2:   #69f0ae;
  --cyan:     #18ffff;
  --blue:     #448aff;
  --purple:   #e040fb;
  --gold:     #ffd740;
  --orange:   #ff6d00;
  --red:      #ff1744;
  --pink:     #f50057;

  --text1:    #f0f4ff;
  --text2:    #c8d4f0;   /* secondary text — visible grey-white */
  --text3:    #8899bb;   /* labels/captions — dimmed but readable */

  --mono:     'JetBrains Mono', monospace;
  --sans:     'Space Grotesk', sans-serif;

  --sidebar-w: 320px;
  --chat-w:    400px;
  --header-h:  52px;
}

*, *::before, *::after { margin:0; padding:0; box-sizing:border-box; }

body {
  background: var(--void);
  color: var(--text1);
  font-family: var(--sans);
  height: 100vh;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

/* ── SCANLINE OVERLAY ── */
body::before {
  content:'';
  position:fixed;
  inset:0;
  background: repeating-linear-gradient(
    0deg,
    transparent,
    transparent 3px,
    rgba(0,0,0,0.08) 3px,
    rgba(0,0,0,0.08) 4px
  );
  pointer-events:none;
  z-index:9999;
  opacity:0.4;
}

/* ══════════════════════════════════════
   HEADER BAR
   ══════════════════════════════════════ */
.header {
  height: var(--header-h);
  background: var(--base);
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  padding: 0 16px;
  gap: 16px;
  flex-shrink: 0;
  position: relative;
  z-index: 100;
}

.logo-mark {
  display: flex;
  align-items: center;
  gap: 10px;
  text-decoration: none;
}
.logo-hex {
  width: 32px;
  height: 32px;
  background: linear-gradient(135deg, var(--cyan), var(--blue));
  clip-path: polygon(50% 0%,100% 25%,100% 75%,50% 100%,0% 75%,0% 25%);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  animation: hexPulse 4s ease-in-out infinite;
}
@keyframes hexPulse {
  0%,100%{filter:brightness(1);}
  50%{filter:brightness(1.3) drop-shadow(0 0 8px var(--cyan));}
}
.logo-text {
  font-family: var(--mono);
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 3px;
  color: var(--text1);
}
.logo-sub {
  font-family: var(--mono);
  font-size: 9px;
  color: var(--text3);
  letter-spacing: 2px;
}

.header-tabs {
  display: flex;
  gap: 2px;
  margin-left: 8px;
}
.htab {
  padding: 5px 14px;
  border-radius: 4px;
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 1.5px;
  cursor: pointer;
  border: 1px solid transparent;
  color: var(--text3);
  background: transparent;
  transition: all 0.15s;
  text-transform: uppercase;
  white-space: nowrap;
}
.htab:hover { color: var(--text2); border-color: var(--border2); }
.htab.active {
  color: var(--cyan);
  border-color: rgba(24,255,255,0.3);
  background: rgba(24,255,255,0.06);
}
.htab .dot {
  display: inline-block;
  width: 5px; height: 5px;
  border-radius: 50%;
  margin-right: 5px;
  vertical-align: middle;
}
.htab.active .dot { background: var(--cyan); box-shadow: 0 0 4px var(--cyan); }
.htab .badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: rgba(255,255,255,0.1);
  border-radius: 8px;
  padding: 0 5px;
  font-size: 8px;
  margin-left: 5px;
  min-width: 16px;
  height: 14px;
}
.htab.active .badge { background: rgba(24,255,255,0.2); color: var(--cyan); }

.header-right {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 10px;
}
.status-chip {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 20px;
  font-family: var(--mono);
  font-size: 9px;
  letter-spacing: 1.5px;
  border: 1px solid;
  white-space: nowrap;
}
.chip-green { border-color: rgba(0,230,118,0.3); color: var(--green); background: rgba(0,230,118,0.08); }
.chip-cyan  { border-color: rgba(24,255,255,0.3); color: var(--cyan);  background: rgba(24,255,255,0.08); }
.chip-orange{ border-color: rgba(255,109,0,0.3);  color: var(--orange);background: rgba(255,109,0,0.08); }
.chip-dim   { border-color: rgba(255,255,255,0.08); color: var(--text3); background: transparent; }
.pulse { width:6px;height:6px;border-radius:50%;animation:pulse 1.2s ease-in-out infinite; }
.pulse-g { background:var(--green); box-shadow:0 0 6px var(--green); }
.pulse-c { background:var(--cyan);  box-shadow:0 0 6px var(--cyan); }
.pulse-o { background:var(--orange);}
@keyframes pulse { 0%,100%{opacity:1;transform:scale(1);}50%{opacity:0.4;transform:scale(0.8);} }

.chat-toggle {
  padding: 6px 14px;
  border-radius: 6px;
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 1.5px;
  cursor: pointer;
  border: 1px solid rgba(224,64,251,0.4);
  color: var(--purple);
  background: rgba(224,64,251,0.08);
  transition: all 0.15s;
}
.chat-toggle:hover { background: rgba(224,64,251,0.15); }
.chat-toggle.active { background: rgba(224,64,251,0.2); box-shadow: 0 0 12px rgba(224,64,251,0.2); }

/* ══════════════════════════════════════
   MAIN LAYOUT — 3 COLUMNS
   Left: Promoted sidebar (fixed)
   Center: Main content (scrolls)
   Right: AI chat (slides in/out)
   ══════════════════════════════════════ */
.workspace {
  display: flex;
  flex: 1;
  overflow: hidden;
}

/* ── LEFT SIDEBAR: PROMOTED COINS (ALWAYS VISIBLE) ── */
.promoted-sidebar {
  width: var(--sidebar-w);
  flex-shrink: 0;
  background: var(--base);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.sidebar-header {
  padding: 14px 16px 10px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-shrink: 0;
}
.sidebar-title {
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 2px;
  color: var(--green);
  display: flex;
  align-items: center;
  gap: 8px;
  text-transform: uppercase;
}
.sidebar-title .live-dot {
  width: 6px; height: 6px;
  border-radius: 50%;
  background: var(--green);
  box-shadow: 0 0 6px var(--green);
  animation: pulse 1s ease-in-out infinite;
}
.sidebar-count {
  font-family: var(--mono);
  font-size: 10px;
  color: var(--text3);
}
.sidebar-refresh {
  background: transparent;
  border: 1px solid var(--border2);
  color: var(--text3);
  border-radius: 4px;
  padding: 3px 8px;
  font-family: var(--mono);
  font-size: 9px;
  cursor: pointer;
  transition: all 0.15s;
}
.sidebar-refresh:hover { color: var(--cyan); border-color: rgba(24,255,255,0.3); }

/* Filter chips in sidebar */
.sidebar-filters {
  padding: 8px 10px;
  display: flex;
  gap: 4px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
  flex-wrap: wrap;
}
.sfilter {
  padding: 2px 9px;
  border-radius: 3px;
  font-family: var(--mono);
  font-size: 8px;
  letter-spacing: 1px;
  cursor: pointer;
  border: 1px solid var(--border);
  color: var(--text3);
  background: transparent;
  transition: all 0.12s;
}
.sfilter:hover { color: var(--text2); border-color: var(--border2); }
.sfilter.active { color: var(--green); border-color: rgba(0,230,118,0.4); background: rgba(0,230,118,0.07); }

/* The scrollable coin list */
.promoted-list {
  flex: 1;
  overflow-y: auto;
  padding: 6px 0;
}
.promoted-list::-webkit-scrollbar { width: 3px; }
.promoted-list::-webkit-scrollbar-track { background: transparent; }
.promoted-list::-webkit-scrollbar-thumb { background: var(--border2); border-radius: 2px; }

/* Individual promoted coin card */
.pcoin {
  margin: 4px 8px;
  padding: 11px 13px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.15s;
  position: relative;
  overflow: hidden;
}
.pcoin::before {
  content:'';
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 2px;
  background: var(--accent-color, var(--green));
  opacity: 0.7;
}
.pcoin:hover {
  background: var(--surface2);
  border-color: var(--border2);
  transform: translateX(2px);
}
.pcoin.selected {
  background: var(--surface2);
  border-color: rgba(24,255,255,0.3);
}
.pcoin-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: 6px;
}
.pcoin-token {
  font-family: var(--mono);
  font-size: 13px;
  font-weight: 700;
  color: var(--text1);
  letter-spacing: 0.5px;
}
.pcoin-name {
  font-family: var(--mono);
  font-size: 9px;
  color: var(--text3);
  margin-top: 1px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 150px;
}
.pcoin-score {
  font-family: var(--mono);
  font-size: 20px;
  font-weight: 700;
  line-height: 1;
}
.pcoin-meta {
  display: flex;
  gap: 6px;
  margin-bottom: 7px;
  flex-wrap: wrap;
}
.pmeta-chip {
  font-family: var(--mono);
  font-size: 8px;
  padding: 2px 6px;
  border-radius: 3px;
  border: 1px solid;
  white-space: nowrap;
}
.pcoin-row {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 4px;
}
.pcoin-stat {
  background: rgba(0,0,0,0.3);
  border-radius: 4px;
  padding: 5px 6px;
  text-align: center;
}
.pcoin-stat-label {
  font-family: var(--mono);
  font-size: 7px;
  color: var(--text3);
  letter-spacing: 1px;
  text-transform: uppercase;
  margin-bottom: 2px;
}
.pcoin-stat-val {
  font-family: var(--mono);
  font-size: 11px;
  font-weight: 700;
}
.pcoin-sltp {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr 1fr;
  gap: 3px;
  margin-top: 6px;
}
.sltp-cell {
  text-align: center;
  padding: 4px 3px;
  border-radius: 3px;
  border: 1px solid;
}
.sltp-label { font-family:var(--mono);font-size:7px;color:var(--text3);display:block;margin-bottom:1px; }
.sltp-val   { font-family:var(--mono);font-size:9px;font-weight:700; }
.sl-cell  { border-color:rgba(255,23,68,0.2); background:rgba(255,23,68,0.06); }
.tp1-cell { border-color:rgba(24,255,255,0.15); background:rgba(24,255,255,0.04); }
.tp2-cell { border-color:rgba(255,215,64,0.15); background:rgba(255,215,64,0.04); }
.tp3-cell { border-color:rgba(0,230,118,0.15); background:rgba(0,230,118,0.04); }
.pcoin-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 7px;
  padding-top: 6px;
  border-top: 1px solid var(--border);
}
.pcoin-time { font-family:var(--mono);font-size:8px;color:var(--text3); }
.pcoin-links { display:flex;gap:6px; }
.pcoin-link { color:var(--text3);text-decoration:none;font-size:11px;transition:color 0.1s; }
.pcoin-link:hover { color:var(--cyan); }

/* Brand new badge */
.new-badge {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-family: var(--mono);
  font-size: 7px;
  letter-spacing: 1px;
  padding: 2px 6px;
  border-radius: 2px;
  background: rgba(255,23,68,0.15);
  border: 1px solid rgba(255,23,68,0.4);
  color: #ff6090;
  animation: newblink 1s ease-in-out infinite;
}
@keyframes newblink { 0%,100%{opacity:1;}50%{opacity:0.5;} }

.sidebar-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 200px;
  color: var(--text3);
  font-family: var(--mono);
  font-size: 10px;
  gap: 8px;
  letter-spacing: 1px;
}
.sidebar-empty .icon { font-size: 28px; opacity: 0.3; }

/* ══════════════════════════════════════
   CENTER MAIN CONTENT
   ══════════════════════════════════════ */
.main-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--void);
}

/* Tab content panels */
.tab-panel { display: none; flex: 1; overflow-y: auto; padding: 16px; }
.tab-panel.active { display: block; }
.tab-panel::-webkit-scrollbar { width: 4px; }
.tab-panel::-webkit-scrollbar-track { background: transparent; }
.tab-panel::-webkit-scrollbar-thumb { background: var(--border2); border-radius: 2px; }

/* ══════════════════════════════════════
   CARDS & COMPONENTS
   ══════════════════════════════════════ */
.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  overflow: hidden;
  margin-bottom: 14px;
}
.card-hdr {
  padding: 11px 16px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: var(--surface2);
}
.card-title {
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 2px;
  color: var(--text2);
  text-transform: uppercase;
  display: flex;
  align-items: center;
  gap: 8px;
}
.card-title .icon { font-size: 12px; }
.card-body { padding: 14px 16px; }

/* Grid systems */
.g2 { display:grid;grid-template-columns:1fr 1fr;gap:14px; }
.g3 { display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px; }
.g4 { display:grid;grid-template-columns:repeat(4,1fr);gap:12px; }
.g5 { display:grid;grid-template-columns:repeat(5,1fr);gap:10px; }
.g6 { display:grid;grid-template-columns:repeat(6,1fr);gap:10px; }

/* Stat tiles */
.stat-tile {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 14px 16px;
  position: relative;
  overflow: hidden;
  transition: border-color 0.2s;
}
.stat-tile::after {
  content:'';
  position:absolute;
  top:0;left:0;right:0;
  height:2px;
  background:var(--tile-color,var(--cyan));
}
.stat-tile:hover { border-color: var(--border2); }
.tile-label {
  font-family:var(--mono);font-size:8px;letter-spacing:2px;
  color:var(--text3);text-transform:uppercase;margin-bottom:8px;
}
.tile-value {
  font-family:var(--mono);font-size:26px;font-weight:700;
  color:var(--tile-color,var(--cyan));line-height:1;
}
.tile-sub {
  font-family:var(--mono);font-size:9px;
  color:var(--text3);margin-top:5px;
}
.tile-delta {
  font-family:var(--mono);font-size:9px;
  color:var(--green);margin-top:3px;
}

/* Tables */
.data-table {
  width:100%;border-collapse:collapse;
  font-family:var(--mono);font-size:11px;
}
.data-table th {
  text-align:left;padding:8px 12px;
  font-size:8px;letter-spacing:2px;color:var(--text3);
  text-transform:uppercase;border-bottom:1px solid var(--border);
  background:var(--surface2);white-space:nowrap;
}
.data-table td {
  padding:9px 12px;border-bottom:1px solid rgba(255,255,255,0.03);
  vertical-align:middle;white-space:nowrap;
  color:var(--text1);
}
.data-table tr:hover td { background:rgba(255,255,255,0.02);cursor:pointer; }
.data-table tr:last-child td { border-bottom:none; }

/* Progress bars */
.prog-track {
  height:6px;background:rgba(255,255,255,0.05);
  border-radius:3px;overflow:hidden;
}
.prog-fill {
  height:100%;border-radius:3px;
  transition:width 1s ease;
}

/* ══════════════════════════════════════
   OVERVIEW LAYOUT
   ══════════════════════════════════════ */
.overview-grid {
  display: grid;
  grid-template-columns: 1fr 260px;
  gap: 14px;
}
.overview-main { display:flex;flex-direction:column;gap:14px; }
.overview-side { display:flex;flex-direction:column;gap:14px; }

/* Regime card */
.regime-big {
  font-family: var(--mono);
  font-size: 28px;
  font-weight: 700;
  letter-spacing: 2px;
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}
.regime-dot-big {
  width:12px;height:12px;border-radius:50%;
  box-shadow:0 0 10px currentColor;
}

/* v8 intelligence mini-tiles */
.intel-row {
  display: grid;
  grid-template-columns: repeat(3,1fr);
  gap: 8px;
}
.intel-tile {
  background: var(--surface2);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 10px 12px;
}
.intel-label { font-family:var(--mono);font-size:7px;letter-spacing:2px;color:var(--text3);text-transform:uppercase;margin-bottom:5px; }
.intel-value { font-family:var(--mono);font-size:15px;font-weight:700; }
.intel-sub   { font-family:var(--mono);font-size:8px;color:var(--text3);margin-top:3px; }

/* ══════════════════════════════════════
   CALLS PAGE — CALL THESIS CARDS
   ══════════════════════════════════════ */
.calls-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(360px,1fr));
  gap: 12px;
}
.call-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 14px;
  cursor: pointer;
  transition: all 0.15s;
  position: relative;
  overflow: hidden;
}
.call-card::before {
  content:'';position:absolute;top:0;left:0;bottom:0;
  width:3px;background:var(--card-accent,var(--text3));
}
.call-card.win  { --card-accent: var(--green); }
.call-card.loss { --card-accent: var(--red); }
.call-card.pending { --card-accent: var(--gold); }
.call-card:hover { background:var(--surface2);transform:translateY(-1px); }
.call-header { display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px;padding-left:10px; }
.call-token { font-family:var(--mono);font-size:15px;font-weight:700;color:var(--text1); }
.call-meta  { font-family:var(--mono);font-size:8px;color:var(--text3);margin-top:2px; }
.call-badges { display:flex;gap:5px;align-items:center; }
.call-score-badge {
  display:inline-flex;align-items:center;justify-content:center;
  width:38px;height:24px;border-radius:4px;
  font-family:var(--mono);font-size:12px;font-weight:700;
}
.call-body { padding-left: 10px; }
.call-verdict {
  font-size:11px;color:var(--text1);
  font-style:italic;line-height:1.5;
  margin-bottom:8px;
}
.call-signals { display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px; }
.signal-tag {
  font-family:var(--mono);font-size:8px;padding:2px 7px;
  border-radius:3px;border:1px solid;
}
.bull-tag { border-color:rgba(0,230,118,0.3);color:var(--green);background:rgba(0,230,118,0.06); }
.bear-tag { border-color:rgba(255,23,68,0.3);color:var(--red);background:rgba(255,23,68,0.06); }
.ai-tag   { border-color:rgba(224,64,251,0.3);color:var(--purple);background:rgba(224,64,251,0.06); }

.call-levels {
  display:grid;grid-template-columns:1fr 1fr 1fr 1fr;
  gap:4px;margin-top:8px;padding-top:8px;
  border-top:1px solid var(--border);
}
.level-box { text-align:center;padding:5px;border-radius:4px;border:1px solid; }
.level-lbl { font-family:var(--mono);font-size:7px;color:var(--text3);display:block;margin-bottom:2px; }
.level-val { font-family:var(--mono);font-size:9px;font-weight:700; }

/* ══════════════════════════════════════
   AUDIT SECTION
   ══════════════════════════════════════ */
.audit-layout {
  display: grid;
  grid-template-columns: 300px 1fr;
  gap: 14px;
  height: calc(100vh - var(--header-h) - 32px);
  overflow: hidden;
}
.audit-list-panel {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.audit-search {
  padding: 10px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.audit-search input {
  width:100%;
  background:rgba(0,0,0,0.4);
  border:1px solid var(--border2);
  border-radius:6px;
  padding:7px 12px;
  color:var(--text1);
  font-family:var(--mono);
  font-size:11px;
  outline:none;
  transition:border-color 0.2s;
}
.audit-search input:focus { border-color:rgba(24,255,255,0.4); }
.audit-list-scroll { flex:1;overflow-y:auto; }
.audit-item {
  padding:10px 14px;
  border-bottom:1px solid var(--border);
  cursor:pointer;
  transition:background 0.1s;
  display:flex;justify-content:space-between;align-items:center;
}
.audit-item:hover { background:rgba(255,255,255,0.03); }
.audit-item.selected { background:rgba(24,255,255,0.05);border-left:2px solid var(--cyan); }
.audit-item-token { font-family:var(--mono);font-size:12px;font-weight:700;color:var(--text1); }
.audit-item-meta  { font-family:var(--mono);font-size:8px;color:var(--text3);margin-top:2px; }
.audit-item-dec   { font-family:var(--mono);font-size:9px;font-weight:600;text-align:right; }

.audit-detail-panel {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  overflow-y: auto;
  padding: 20px;
}
.audit-detail-panel::-webkit-scrollbar { width:4px; }
.audit-detail-panel::-webkit-scrollbar-thumb { background:var(--border2);border-radius:2px; }

.audit-score-big {
  font-family:var(--mono);font-size:64px;font-weight:700;line-height:1;
}
.audit-section-title {
  font-family:var(--mono);font-size:9px;letter-spacing:2.5px;
  color:var(--text3);text-transform:uppercase;
  padding:8px 0;border-bottom:1px solid var(--border);
  margin:16px 0 12px;
}
.audit-grid { display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:16px; }
.audit-field {
  background:rgba(0,0,0,0.3);border:1px solid var(--border);
  border-radius:6px;padding:9px 12px;
}
.audit-field-label { font-family:var(--mono);font-size:8px;letter-spacing:1px;color:var(--text3);text-transform:uppercase;margin-bottom:4px; }
.audit-field-value { font-family:var(--mono);font-size:12px;font-weight:600;color:var(--text1); }

.sub-score-row {
  display:grid;grid-template-columns:1fr 1fr;gap:8px;
}
.sub-score-item {
  display:flex;align-items:center;gap:10px;
  background:rgba(0,0,0,0.2);border-radius:6px;padding:9px 12px;
}
.sub-score-label { font-family:var(--mono);font-size:9px;color:var(--text3);flex:1; }
.sub-score-bar { flex:1; }
.sub-score-num { font-family:var(--mono);font-size:13px;font-weight:700;min-width:30px;text-align:right; }

/* Pipeline audit trail */
.pipeline-steps { display:flex;flex-direction:column;gap:8px; }
.pipeline-step {
  display:flex;align-items:flex-start;gap:12px;
  padding:10px 14px;
  background:rgba(0,0,0,0.2);border-radius:6px;
  border:1px solid var(--border);
}
.step-num {
  width:22px;height:22px;border-radius:50%;
  display:flex;align-items:center;justify-content:center;
  font-family:var(--mono);font-size:9px;font-weight:700;
  flex-shrink:0;border:1px solid;
}
.step-content { flex:1; }
.step-name { font-family:var(--mono);font-size:10px;font-weight:700;color:var(--text1);margin-bottom:3px; }
.step-detail { font-family:var(--mono);font-size:9px;color:var(--text2);line-height:1.5; }
.step-verdict { font-family:var(--mono);font-size:9px;margin-top:4px; }

/* Verdict box */
.verdict-box {
  background:rgba(24,255,255,0.04);
  border:1px solid rgba(24,255,255,0.15);
  border-radius:8px;padding:14px;
  font-size:12px;line-height:1.7;
  color:var(--text1);
  font-style:italic;
}

/* ══════════════════════════════════════
   AI AGENT CHAT PANEL (FLOATING OVERLAY)
   ══════════════════════════════════════ */
.chat-overlay {
  position: fixed;
  right: 0; top: var(--header-h); bottom: 0;
  width: var(--chat-w);
  background: var(--base);
  border-left: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  z-index: 200;
  transform: translateX(100%);
  transition: transform 0.3s cubic-bezier(0.4,0,0.2,1);
  box-shadow: -20px 0 60px rgba(0,0,0,0.5);
}
.chat-overlay.open { transform: translateX(0); }

.chat-header {
  padding: 14px 16px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-shrink: 0;
  background: var(--surface);
}
.chat-title {
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: 2px;
  color: var(--purple);
  display: flex;
  align-items: center;
  gap: 8px;
}
.chat-close {
  width:26px;height:26px;border-radius:4px;
  background:transparent;border:1px solid var(--border2);
  color:var(--text3);cursor:pointer;
  display:flex;align-items:center;justify-content:center;
  font-size:14px;transition:all 0.15s;
}
.chat-close:hover { border-color:var(--red);color:var(--red); }

.chat-quick-cmds {
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  flex-shrink: 0;
}
.qcmd {
  padding: 3px 9px;
  border-radius: 3px;
  font-family: var(--mono);
  font-size: 8px;
  letter-spacing: 0.5px;
  cursor: pointer;
  border: 1px solid var(--border2);
  color: var(--text3);
  background: transparent;
  transition: all 0.12s;
  white-space: nowrap;
}
.qcmd:hover { color: var(--purple); border-color: rgba(224,64,251,0.4); background: rgba(224,64,251,0.06); }

.chat-messages {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.chat-messages::-webkit-scrollbar { width:3px; }
.chat-messages::-webkit-scrollbar-thumb { background:var(--border2);border-radius:2px; }

.chat-msg { display:flex;gap:9px;align-items:flex-start; }
.chat-msg.user { flex-direction:row-reverse; }
.chat-avatar {
  width:28px;height:28px;border-radius:5px;
  display:flex;align-items:center;justify-content:center;
  font-size:12px;flex-shrink:0;
}
.avatar-bot { background:linear-gradient(135deg,var(--purple),var(--blue)); }
.avatar-user { background:rgba(24,255,255,0.15);border:1px solid rgba(24,255,255,0.3);font-size:10px;font-family:var(--mono);color:var(--cyan); }
.chat-bubble {
  max-width:78%;padding:9px 13px;border-radius:8px;
  font-size:12px;line-height:1.55;
}
.bubble-bot {
  background:rgba(224,64,251,0.07);
  border:1px solid rgba(224,64,251,0.15);
  color:var(--text1);
}
.bubble-user {
  background:rgba(24,255,255,0.07);
  border:1px solid rgba(24,255,255,0.2);
  color:var(--cyan);
}
.typing-dots { display:flex;gap:4px;align-items:center;padding:2px 0; }
.typing-dot {
  width:5px;height:5px;border-radius:50%;background:var(--purple);
  animation:typingBounce 1.2s ease-in-out infinite;
}
.typing-dot:nth-child(2){animation-delay:0.2s;}
.typing-dot:nth-child(3){animation-delay:0.4s;}
@keyframes typingBounce{0%,80%,100%{transform:scale(0.5);opacity:0.4;}40%{transform:scale(1);opacity:1;}}

.chat-input-row {
  padding: 10px;
  border-top: 1px solid var(--border);
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}
.chat-input {
  flex:1;background:rgba(0,0,0,0.4);
  border:1px solid var(--border2);border-radius:6px;
  padding:9px 12px;color:var(--text1);
  font-family:var(--mono);font-size:11px;
  outline:none;resize:none;height:40px;
  transition:border-color 0.2s;
}
.chat-input:focus { border-color:rgba(224,64,251,0.5); }
.chat-send {
  background:linear-gradient(135deg,rgba(224,64,251,0.2),rgba(68,138,255,0.2));
  border:1px solid rgba(224,64,251,0.4);color:var(--purple);
  border-radius:6px;padding:0 16px;
  font-family:var(--mono);font-size:10px;letter-spacing:1px;
  cursor:pointer;transition:all 0.15s;
}
.chat-send:hover { background:rgba(224,64,251,0.25); }
.chat-send:disabled { opacity:0.4;cursor:not-allowed; }

/* ══════════════════════════════════════
   BOTTOM STATUS BAR
   ══════════════════════════════════════ */
.statusbar {
  height: 26px;
  background: var(--base);
  border-top: 1px solid var(--border);
  display: flex;
  align-items: center;
  padding: 0 14px;
  gap: 16px;
  flex-shrink: 0;
  font-family: var(--mono);
  font-size: 9px;
  color: var(--text3);
  letter-spacing: 1px;
}
.sb-item { display:flex;align-items:center;gap:5px; }
.sb-dot { width:5px;height:5px;border-radius:50%; }
.sb-sep { width:1px;height:12px;background:var(--border); }
.sb-right { margin-left:auto;display:flex;gap:16px;align-items:center; }

/* ══════════════════════════════════════
   MISC UTILITIES
   ══════════════════════════════════════ */
.empty-state {
  display:flex;flex-direction:column;align-items:center;justify-content:center;
  padding:48px;color:var(--text3);font-family:var(--mono);
  font-size:10px;letter-spacing:1px;gap:8px;text-align:center;
}
.empty-icon { font-size:32px;opacity:0.25; }
.empty-hint { color:var(--text3);font-size:9px;margin-top:4px;line-height:1.6;opacity:0.7; }

.spinner { display:flex;gap:6px;align-items:center;justify-content:center;padding:32px; }
.spin-dot {
  width:6px;height:6px;border-radius:50%;
  animation:typingBounce 1.2s ease-in-out infinite;
}
.spin-dot:nth-child(2){animation-delay:0.2s;}
.spin-dot:nth-child(3){animation-delay:0.4s;}

.outcome-win  { color:var(--green);background:rgba(0,230,118,0.1);border:1px solid rgba(0,230,118,0.25);padding:2px 8px;border-radius:3px;font-family:var(--mono);font-size:9px; }
.outcome-loss { color:var(--red);background:rgba(255,23,68,0.1);border:1px solid rgba(255,23,68,0.25);padding:2px 8px;border-radius:3px;font-family:var(--mono);font-size:9px; }
.outcome-pend { color:var(--gold);background:rgba(255,215,64,0.1);border:1px solid rgba(255,215,64,0.25);padding:2px 8px;border-radius:3px;font-family:var(--mono);font-size:9px; }

/* ── AI BRAIN NEURAL VISUALIZATION ── */
.neural-network {
  position:relative;width:100%;height:200px;
  background:radial-gradient(ellipse at center, rgba(24,255,255,0.04) 0%, transparent 70%);
  border-radius:12px;overflow:hidden;border:1px solid rgba(24,255,255,0.1);
}
.neural-canvas { width:100%;height:100%;display:block; }
.brain-metric-ring {
  display:flex;align-items:center;justify-content:center;
  position:relative;
}
.ring-svg { transform:rotate(-90deg); }
.ring-value {
  position:absolute;text-align:center;
  font-family:var(--mono);font-weight:700;
}
.learning-pulse {
  animation:learningPulse 2s ease-in-out infinite;
}
@keyframes learningPulse {
  0%,100%{opacity:0.6;transform:scale(1);}
  50%{opacity:1;transform:scale(1.02);}
}
.neuron-dot {
  position:absolute;width:6px;height:6px;border-radius:50%;
  animation:neuronFire 3s ease-in-out infinite;
}
@keyframes neuronFire {
  0%{opacity:0.2;box-shadow:none;}
  50%{opacity:1;box-shadow:0 0 8px currentColor;}
  100%{opacity:0.2;box-shadow:none;}
}
.data-stream {
  position:absolute;height:1px;
  background:linear-gradient(90deg,transparent,currentColor,transparent);
  animation:dataStream 2s linear infinite;
}
@keyframes dataStream {
  0%{transform:translateX(-100%);}
  100%{transform:translateX(200%);}
}


/* ── AUTONOMOUS AGENT SYSTEM ── */
.agent-tab {
  font-family:var(--mono);font-size:9px;letter-spacing:1px;
  padding:6px 14px;border-radius:4px;cursor:pointer;
  background:transparent;border:1px solid var(--border2);color:var(--text3);
  transition:all 0.2s;
}
.agent-tab.active {
  background:rgba(68,138,255,0.12);border-color:rgba(68,138,255,0.4);color:var(--blue);
}
.agent-tab:hover:not(.active) { border-color:var(--border);color:var(--text2); }
.agent-tab-panel { transition:opacity 0.2s; }

.agent-msg-bot  { display:flex;gap:10px;align-items:flex-start; }
.agent-msg-user { display:flex;gap:10px;align-items:flex-start;flex-direction:row-reverse; }
.agent-avatar   { width:28px;height:28px;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:12px;flex-shrink:0; }
.agent-bubble-bot  { flex:1;background:rgba(68,138,255,0.08);border:1px solid rgba(68,138,255,0.2);border-radius:8px;padding:12px 14px;font-family:var(--mono);font-size:11px;color:var(--text2);line-height:1.6;white-space:pre-wrap;word-break:break-word; }
.agent-bubble-user { flex:1;background:rgba(0,230,118,0.06);border:1px solid rgba(0,230,118,0.2);border-radius:8px;padding:12px 14px;font-family:var(--mono);font-size:11px;color:var(--text2);line-height:1.6;text-align:right; }

.action-card {
  background:rgba(0,0,0,0.3);border:1px solid var(--border);border-radius:8px;padding:12px 14px;
}
.action-card.proposed { border-color:rgba(255,215,64,0.3); }
.action-card.applied  { border-color:rgba(0,230,118,0.3); }
.action-card.rolled   { border-color:rgba(255,23,68,0.3);opacity:0.6; }

.rec-card {
  background:rgba(0,0,0,0.3);border-radius:8px;padding:12px 14px;border-left:3px solid;
}
.rec-HIGH   { border-color:var(--red);background:rgba(255,23,68,0.04); }
.rec-MEDIUM { border-color:var(--gold);background:rgba(255,215,64,0.04); }
.rec-LOW    { border-color:var(--text3);background:rgba(0,0,0,0.2); }
.rec-DONE   { opacity:0.5;filter:grayscale(0.5); }

.typing-indicator { display:flex;gap:4px;align-items:center;padding:6px 0; }
.typing-dot-agent { width:5px;height:5px;border-radius:50%;background:var(--blue);animation:typingBounce 1s ease-in-out infinite; }
.typing-dot-agent:nth-child(2){animation-delay:0.15s;}
.typing-dot-agent:nth-child(3){animation-delay:0.3s;}
@keyframes typingBounce{0%,80%,100%{transform:scale(0.8);opacity:0.4;}40%{transform:scale(1.2);opacity:1;}}
/* Scrollbars */
::-webkit-scrollbar { width:4px;height:4px; }
::-webkit-scrollbar-track { background:transparent; }
::-webkit-scrollbar-thumb { background:rgba(255,255,255,0.1);border-radius:2px; }
::-webkit-scrollbar-thumb:hover { background:rgba(255,255,255,0.2); }

/* Modal */
.modal-bg {
  display:none;position:fixed;inset:0;
  background:rgba(0,0,0,0.8);z-index:500;
  backdrop-filter:blur(4px);
  align-items:center;justify-content:center;
}
.modal-bg.open { display:flex; }
.modal-box {
  background:var(--surface);
  border:1px solid var(--border2);
  border-radius:12px;
  width:900px;max-width:95vw;max-height:90vh;
  overflow-y:auto;
  animation:modalIn 0.2s ease;
}
@keyframes modalIn{from{opacity:0;transform:scale(0.95)translateY(-10px);}to{opacity:1;transform:scale(1)translateY(0);}}
.modal-hdr {
  padding:18px 22px;border-bottom:1px solid var(--border);
  display:flex;align-items:center;justify-content:space-between;
  position:sticky;top:0;background:var(--surface);z-index:1;
}
.modal-close {
  width:30px;height:30px;border-radius:5px;
  background:transparent;border:1px solid var(--border2);
  color:var(--text3);cursor:pointer;font-size:16px;
  display:flex;align-items:center;justify-content:center;
  transition:all 0.15s;
}
.modal-close:hover { border-color:var(--red);color:var(--red); }
.modal-body { padding:22px; }

/* Analytics specific */
.win-rate-row { display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid var(--border); }
.win-rate-row:last-child{border-bottom:none;}
.wr-label{font-family:var(--mono);font-size:10px;color:var(--text2);width:160px;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;}
.wr-bar-wrap{flex:1;}
.wr-track{height:18px;background:rgba(255,255,255,0.03);border-radius:3px;overflow:hidden;}
.wr-fill{height:100%;border-radius:3px;display:flex;align-items:center;padding-left:8px;}
.wr-stat{font-family:var(--mono);font-size:8px;color:var(--text3);margin-left:8px;white-space:nowrap;}

/* Calibration chart */
.cal-row{display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid var(--border);}
.cal-row:last-child{border-bottom:none;}
.cal-band{font-family:var(--mono);font-size:9px;color:var(--text3);width:60px;flex-shrink:0;}
.cal-wrap{flex:1;position:relative;}
.cal-track{height:22px;background:rgba(255,255,255,0.03);border-radius:3px;overflow:hidden;border:1px solid var(--border);}
.cal-fill{height:100%;border-radius:3px;display:flex;align-items:center;padding-left:8px;}
.cal-right-label{position:absolute;right:8px;top:50%;transform:translateY(-50%);font-family:var(--mono);font-size:9px;color:var(--text3);}
.cal-verdict{font-family:var(--mono);font-size:8px;color:var(--text3);width:60px;text-align:right;flex-shrink:0;}

/* Candidates filter bar */
.filter-bar {
  display:flex;gap:6px;align-items:center;
  padding:8px 0 12px;flex-wrap:wrap;
}
.fchip {
  padding:4px 12px;border-radius:4px;
  font-family:var(--mono);font-size:9px;letter-spacing:1px;
  cursor:pointer;border:1px solid var(--border2);
  color:var(--text3);background:transparent;
  transition:all 0.12s;text-transform:uppercase;
}
.fchip:hover { color:var(--text2);border-color:var(--border2); }
.fchip.active { color:var(--cyan);border-color:rgba(24,255,255,0.4);background:rgba(24,255,255,0.06); }

/* Smart money page */
.outcome-buttons { display:flex;gap:6px; }
.obtn {
  border-radius:4px;font-family:var(--mono);font-size:9px;
  padding:4px 10px;cursor:pointer;border:1px solid;
  transition:all 0.12s;
}
.obtn-win  { border-color:rgba(0,230,118,0.4);color:var(--green);background:rgba(0,230,118,0.06); }
.obtn-loss { border-color:rgba(255,23,68,0.4);color:var(--red);background:rgba(255,23,68,0.06); }
.obtn-neutral { border-color:var(--border2);color:var(--text3); }
.obtn:hover { filter:brightness(1.2); }

/* ══════════════════════════════════════
   MOBILE RESPONSIVE
   ══════════════════════════════════════ */
@media (max-width: 900px) {
  :root { --sidebar-w: 0px; --chat-w: 100vw; --header-h: 48px; }

  .promoted-sidebar { display:none; }
  .promoted-sidebar.mobile-open {
    display:flex;position:fixed;inset:0;z-index:400;
    width:100%;border-right:none;
  }

  .header {
    padding:0 10px;gap:6px;
    flex-wrap:nowrap;overflow:hidden;
    position:relative;
  }
  .logo-sub { display:none; }
  .logo-text { font-size:10px;letter-spacing:1px; }

  /* Nav tabs: hidden, slide down when open */
  .header-tabs { display:none; }
  .header-tabs.mobile-open {
    display:flex;position:fixed;top:var(--header-h);left:0;right:0;
    background:var(--base);border-bottom:1px solid var(--border);
    flex-direction:column;z-index:300;padding:8px;gap:4px;
    box-shadow:0 8px 24px rgba(0,0,0,0.6);
  }
  .htab { width:100%;text-align:left;padding:10px 14px; }

  /* Header right: stack into two rows on mobile */
  .header-right {
    flex-wrap:wrap;gap:4px;justify-content:flex-end;
    max-width:calc(100vw - 130px);
  }

  /* Hide lower-priority chips on mobile */
  #modeChip, #regimeChip { display:none !important; }

  /* Make remaining chips smaller */
  .status-chip { padding:3px 7px;font-size:8px;letter-spacing:0.5px; }
  .chat-toggle { padding:5px 10px;font-size:9px; }

  .mobile-menu-btn {
    display:flex;align-items:center;justify-content:center;
    width:32px;height:32px;border-radius:6px;flex-shrink:0;
    background:rgba(255,255,255,0.06);border:1px solid var(--border2);
    color:var(--text1);font-size:14px;cursor:pointer;
  }
  .mobile-promoted-btn {
    display:flex;align-items:center;gap:4px;
    padding:4px 8px;border-radius:4px;font-family:var(--mono);
    font-size:8px;letter-spacing:0.5px;cursor:pointer;flex-shrink:0;
    background:rgba(0,230,118,0.1);border:1px solid rgba(0,230,118,0.3);
    color:var(--green);
  }

  .tab-panel { padding:10px; }
  .g2,.g3,.g4,.g5,.g6 { grid-template-columns:1fr 1fr; }
  .g5,.g6 { grid-template-columns:repeat(3,1fr); }
  .calls-grid { grid-template-columns:1fr; }
  .overview-grid { grid-template-columns:1fr; }
  .overview-side { display:grid;grid-template-columns:1fr 1fr;gap:12px; }
  .audit-layout { grid-template-columns:1fr;height:auto;overflow:visible; }
  .audit-detail-panel { min-height:300px; }
  .audit-grid { grid-template-columns:1fr 1fr; }
  .intel-row { grid-template-columns:1fr 1fr; }
  .g2 { grid-template-columns:1fr; }
  .stat-tile .tile-value { font-size:20px; }
  .modal-box { width:100%;max-width:100%;margin:0;border-radius:0;min-height:100vh; }
  .chat-overlay { width:100%; }
  .data-table { font-size:10px; }
  .data-table th,.data-table td { padding:6px 8px; }
  .statusbar { display:none; }
  .promoted-list { max-height:calc(100vh - 120px); }
  .pcoin { margin:4px; }
  .forensic-grid { grid-template-columns:1fr 1fr !important; }
  .forensic-grid-3 { grid-template-columns:1fr 1fr !important; }
  .pipeline-steps .pipeline-step { flex-direction:column;gap:6px; }
  .sub-score-row { grid-template-columns:1fr !important; }
}

@media (max-width: 480px) {
  .g2,.g3,.g4,.g5,.g6 { grid-template-columns:1fr; }
  .g5,.g6 { grid-template-columns:1fr 1fr; }
  .audit-grid { grid-template-columns:1fr; }
  .pcoin-row { grid-template-columns:1fr 1fr 1fr; }
  .pcoin-sltp { grid-template-columns:1fr 1fr; }
  .call-card { padding:10px; }
  .call-token { font-size:13px; }
  .intel-row { grid-template-columns:1fr; }
  .overview-side { grid-template-columns:1fr; }
  .forensic-grid { grid-template-columns:1fr !important; }
}

/* Mobile menu buttons (hidden on desktop) */
.mobile-menu-btn,.mobile-promoted-btn { display:none; }
@media (max-width: 900px) {
  .mobile-menu-btn,.mobile-promoted-btn { display:flex; }
  .chat-toggle .chat-toggle-text { display:none; }
}
</style>
</head>
<body>

<!-- ═══════════════ HEADER ═══════════════ -->
<header class="header">
  <div class="logo-mark">
    <div class="logo-hex" style="background:linear-gradient(135deg,#18ffff,#9c27b0);font-size:16px">⚡</div>
    <div>
      <div class="logo-text" style="background:linear-gradient(90deg,#18ffff,#9c27b0);-webkit-background-clip:text;-webkit-text-fill-color:transparent;font-size:14px">PULSE CALLER</div>
      <div class="logo-sub">AI OPERATING SYSTEM · v8.0</div>
    </div>
  </div>

  <nav class="header-tabs">
    <button class="htab active" onclick="switchTab('overview')"><span class="dot"></span>OVERVIEW <span class="badge" id="tb-overview-badge"></span></button>
    <button class="htab" onclick="switchTab('promoted')"><span class="dot"></span>PROMOTED <span class="badge" id="tb-promoted-badge">0</span></button>
    <button class="htab" onclick="switchTab('calls')"><span class="dot"></span>CALLS <span class="badge" id="tb-calls-badge">0</span></button>
    <button class="htab" onclick="switchTab('audit')"><span class="dot"></span>AUDIT <span class="badge" id="tb-audit-badge">0</span></button>
    <button class="htab" onclick="switchTab('analytics')"><span class="dot"></span>ANALYTICS</button>
    <button class="htab" onclick="switchTab('ai')"><span class="dot"></span>AI BRAIN</button>
    <button class="htab" onclick="switchTab('smart')"><span class="dot"></span>SMART MONEY</button>
    <button class="htab" onclick="switchTab('scanner')"><span class="dot"></span>🔍 SCANNER</button>
    <button class="htab" onclick="switchTab('system')"><span class="dot"></span>SYSTEM</button>
  </nav>

  <div class="header-right">
    <button class="mobile-promoted-btn" onclick="toggleMobileSidebar()">🚀 <span id="sidebarCount2">—</span></button>
    <button class="mobile-menu-btn" onclick="toggleMobileMenu()" title="Menu">☰</button>
    <div class="status-chip chip-green" id="onlineChip"><div class="pulse pulse-g"></div>ONLINE</div>
    <div class="status-chip chip-cyan" id="heliusChip" style="display:none"><div class="pulse pulse-c"></div>HELIUS ⚡</div>
    <div class="status-chip chip-dim" id="modeChip">🚀 NEW_COINS</div>
    <div class="status-chip chip-dim" id="regimeChip">—</div>
    <button class="chat-toggle" id="chatToggleBtn" onclick="toggleChat()">💬 <span class="chat-toggle-text">AI AGENT</span></button>
  </div>
</header>

<!-- ═══════════════ WORKSPACE ═══════════════ -->
<div class="workspace">

  <!-- ═══ LEFT SIDEBAR: PROMOTED COINS (ALWAYS VISIBLE, NEVER GOES AWAY) ═══ -->
  <aside class="promoted-sidebar">
    <div class="sidebar-header">
      <div class="sidebar-title">
        <div class="live-dot"></div>
        PROMOTED
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <span class="sidebar-count" id="sidebarCount">0 tokens</span>
        <button class="sidebar-refresh" onclick="loadPromotedSidebar()">↻</button>
      </div>
    </div>
    <div class="sidebar-filters">
      <button class="sfilter active" onclick="sidebarFilter(this,'all')">ALL</button>
      <button class="sfilter" onclick="sidebarFilter(this,'prebond')">PRE-BOND</button>
      <button class="sfilter" onclick="sidebarFilter(this,'new')">BRAND NEW</button>
      <button class="sfilter" onclick="sidebarFilter(this,'hot')">HOT 🔥</button>
    </div>
    <div class="promoted-list" id="promotedSidebar">
      <div class="spinner">
        <div class="spin-dot" style="background:var(--green)"></div>
        <div class="spin-dot" style="background:var(--cyan)"></div>
        <div class="spin-dot" style="background:var(--purple)"></div>
      </div>
    </div>
  </aside>

  <!-- ═══ MAIN CONTENT ═══ -->
  <main class="main-content">

    <!-- OVERVIEW TAB -->
    <div class="tab-panel active" id="tab-overview">
      <!-- v8 Intelligence Row -->
      <div class="g6" style="margin-bottom:14px" id="v8Row">
        <div class="stat-tile" style="--tile-color:var(--cyan)"><div class="tile-label">HELIUS STREAM</div><div class="tile-value" style="font-size:14px" id="v8HeliusStatus">—</div><div class="tile-sub">detection speed</div></div>
        <div class="stat-tile" style="--tile-color:var(--purple)"><div class="tile-label">WALLET DB</div><div class="tile-value" id="v8WalletDbSize">—</div><div class="tile-sub" id="v8DbFresh">loading</div></div>
        <div class="stat-tile" style="--tile-color:var(--green)"><div class="tile-label">EVALUATIONS</div><div class="tile-value" id="statEvaluated">—</div><div class="tile-sub" id="statEval24h">—</div></div>
        <div class="stat-tile" style="--tile-color:var(--gold)"><div class="tile-label">WIN RATE</div><div class="tile-value" id="statWinRate">—</div><div class="tile-sub" id="statWL">—</div></div>
        <div class="stat-tile" style="--tile-color:var(--orange)"><div class="tile-label">MISSED 3X+</div><div class="tile-value" id="v8Missed">—</div><div class="tile-sub">last 24h</div></div>
        <div class="stat-tile" style="--tile-color:var(--blue)"><div class="tile-label">OPENAI GPT-4o</div><div class="tile-value" style="font-size:14px" id="v8OpenAI">—</div><div class="tile-sub">final decisions</div></div>
      </div>

      <div class="overview-grid">
        <div class="overview-main">
          <!-- Recent Calls Thesis Cards -->
          <div class="card">
            <div class="card-hdr">
              <div class="card-title"><span class="icon">📋</span>RECENT CALLS — WITH THESIS & TRADE LEVELS</div>
              <button onclick="switchTab('calls')" style="background:transparent;border:1px solid var(--border2);color:var(--text3);border-radius:4px;padding:4px 12px;font-family:var(--mono);font-size:9px;cursor:pointer;letter-spacing:1px">VIEW ALL →</button>
            </div>
            <div class="card-body" style="padding:12px">
              <div class="calls-grid" id="recentCallsCards">
                <div class="spinner"><div class="spin-dot" style="background:var(--green)"></div><div class="spin-dot" style="background:var(--cyan)"></div><div class="spin-dot" style="background:var(--purple)"></div></div>
              </div>
            </div>
          </div>
        </div>

        <div class="overview-side">
          <!-- Market Regime -->
          <div class="card">
            <div class="card-hdr"><div class="card-title"><span class="icon">🌡</span>MARKET REGIME</div><span style="font-family:var(--mono);font-size:9px;color:var(--text3)" id="regimeAge">—</span></div>
            <div class="card-body">
              <div class="regime-big" id="regimeDisplay">—</div>
              <div style="font-family:var(--mono);font-size:9px;color:var(--text3);margin-bottom:12px" id="regimeConf">—</div>
              <div style="display:flex;flex-direction:column;gap:6px;font-family:var(--mono);font-size:9px">
                <div style="display:flex;justify-content:space-between"><span style="color:var(--text3)">Activity</span><span id="regimeActivity">—</span></div>
                <div style="display:flex;justify-content:space-between"><span style="color:var(--text3)">Narrative</span><span id="regimeNarrative">—</span></div>
                <div style="display:flex;justify-content:space-between"><span style="color:var(--text3)">Launches</span><span id="regimeLaunches">—</span></div>
              </div>
              <div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--border)">
                <div style="font-family:var(--mono);font-size:8px;letter-spacing:2px;color:var(--text3);margin-bottom:6px">SCORE ADJUSTMENTS</div>
                <div id="regimeAdj" style="font-family:var(--mono);font-size:9px;display:flex;flex-direction:column;gap:4px"></div>
              </div>
            </div>
          </div>

          <!-- AI Status mini -->
          <div class="card">
            <div class="card-hdr"><div class="card-title"><span class="icon">🧠</span>AI OS STATUS</div><span class="status-chip chip-cyan" style="font-size:8px;padding:2px 8px" id="aiOsStatusChip">ALWAYS ON</span></div>
            <div class="card-body" style="padding:10px 14px">
              <div class="intel-row">
                <div class="intel-tile"><div class="intel-label">Total Calls</div><div class="intel-value" style="color:var(--green)" id="aiTotalCalls">—</div></div>
                <div class="intel-tile"><div class="intel-label">Resolved</div><div class="intel-value" style="color:var(--cyan)" id="aiResolved">—</div></div>
                <div class="intel-tile"><div class="intel-label">FT Model</div><div class="intel-value" style="font-size:12px" id="aiFtStatus">—</div></div>
              </div>
              <div style="margin-top:10px">
                <div style="display:flex;justify-content:space-between;font-family:var(--mono);font-size:8px;color:var(--text3);margin-bottom:5px"><span>WIN RATE TREND</span><span id="aiWinRatePct" style="color:var(--green)">—</span></div>
                <div class="prog-track"><div class="prog-fill" id="aiWinBar" style="background:linear-gradient(90deg,var(--green),var(--cyan));width:0%"></div></div>
              </div>
              <div style="margin-top:10px;font-family:var(--mono);font-size:9px;color:var(--text3);line-height:1.5" id="aiStatusMsg">In-context learning active — evaluating every scanned token with full outcome history.</div>
            </div>
          </div>

          <!-- Quick queues -->
          <div class="card">
            <div class="card-hdr"><div class="card-title"><span class="icon">📊</span>QUEUE STATUS</div></div>
            <div class="card-body" style="padding:8px 14px">
              <div style="display:flex;flex-direction:column;gap:6px;font-family:var(--mono);font-size:10px">
                <div style="display:flex;justify-content:space-between;align-items:center"><span style="color:var(--text3)">Watchlist</span><span style="color:var(--gold);font-weight:700" id="qWatchlist">—</span></div>
                <div style="display:flex;justify-content:space-between;align-items:center"><span style="color:var(--text3)">Retest Queue</span><span style="color:var(--orange);font-weight:700" id="qRetest">—</span></div>
                <div style="display:flex;justify-content:space-between;align-items:center"><span style="color:var(--text3)">Calls Posted</span><span style="color:var(--green);font-weight:700" id="qPosted">—</span></div>
                <div style="display:flex;justify-content:space-between;align-items:center"><span style="color:var(--text3)">Scan Interval</span><span id="qInterval">—</span></div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div><!-- /overview -->

    <!-- PROMOTED TAB — Full promoted feed -->
    <div class="tab-panel" id="tab-promoted">
      <div class="g4" style="margin-bottom:14px">
        <div class="stat-tile" style="--tile-color:var(--green)"><div class="tile-label">Scanned (1h)</div><div class="tile-value" id="feedTotal">—</div></div>
        <div class="stat-tile" style="--tile-color:var(--cyan)"><div class="tile-label">Promoted</div><div class="tile-value" id="feedPromoted">—</div><div class="tile-sub">Quick score ≥40</div></div>
        <div class="stat-tile" style="--tile-color:var(--text3)"><div class="tile-label">Skipped</div><div class="tile-value" id="feedSkipped">—</div></div>
        <div class="stat-tile" style="--tile-color:var(--text3)"><div class="tile-label">Deduped</div><div class="tile-value" id="feedDeduped">—</div></div>
      </div>
      <div style="display:flex;gap:8px;margin-bottom:12px;align-items:center;flex-wrap:wrap">
        <div style="font-family:var(--mono);font-size:9px;color:var(--text3);padding:6px 12px;background:rgba(24,255,255,0.05);border:1px solid rgba(24,255,255,0.1);border-radius:4px">
          ⚡ <span style="color:var(--cyan)">QUICK SCORE</span> = pre-AI estimate · Post threshold: <span style="color:var(--green)">38+</span> · Max MCap: <span style="color:var(--orange)">$150K</span>
        </div>
        <button onclick="loadPromotedFull()" style="background:transparent;border:1px solid var(--border2);color:var(--text3);border-radius:4px;padding:5px 12px;font-family:var(--mono);font-size:9px;cursor:pointer;letter-spacing:1px;margin-left:auto">↻ REFRESH</button>
      </div>
      <div id="promotedTabGrid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:10px">
        <div class="spinner"><div class="spin-dot" style="background:var(--green)"></div><div class="spin-dot" style="background:var(--cyan)"></div><div class="spin-dot" style="background:var(--purple)"></div></div>
      </div>
      <div class="card" style="margin-top:14px">
        <div class="card-hdr"><div class="card-title"><span class="icon">📋</span>PROMOTED HISTORY</div><span style="font-family:var(--mono);font-size:9px;color:var(--text3)" id="promotedHistoryCount">—</span></div>
        <div style="overflow-x:auto">
          <table class="data-table">
            <thead><tr><th>TOKEN</th><th>NEW?</th><th>AGE</th><th>STAGE</th><th>CURVE%</th><th>MCAP</th><th>LIQ</th><th>5M%</th><th>1H%</th><th>BUYS</th><th>BUY RATIO</th><th>VOL VEL</th><th>QUICK SCORE</th><th>REASON</th><th>LINKS</th></tr></thead>
            <tbody id="promotedHistoryBody"><tr><td colspan="15"><div class="spinner"><div class="spin-dot" style="background:var(--green)"></div><div class="spin-dot" style="background:var(--cyan)"></div><div class="spin-dot" style="background:var(--purple)"></div></div></td></tr></tbody>
          </table>
        </div>
      </div>
    </div><!-- /promoted -->

    <!-- CALLS TAB -->
    <div class="tab-panel" id="tab-calls">
      <div class="g4" style="margin-bottom:14px">
        <div class="stat-tile" style="--tile-color:var(--cyan)"><div class="tile-label">Total Calls</div><div class="tile-value" id="cTotal">—</div></div>
        <div class="stat-tile" style="--tile-color:var(--green)"><div class="tile-label">Wins</div><div class="tile-value" id="cWins">—</div></div>
        <div class="stat-tile" style="--tile-color:var(--red)"><div class="tile-label">Losses</div><div class="tile-value" id="cLosses">—</div></div>
        <div class="stat-tile" style="--tile-color:var(--gold)"><div class="tile-label">Win Rate</div><div class="tile-value" id="cWinRate">—</div></div>
      </div>
      <div class="calls-grid" id="callsGrid">
        <div class="spinner"><div class="spin-dot" style="background:var(--green)"></div><div class="spin-dot" style="background:var(--cyan)"></div><div class="spin-dot" style="background:var(--purple)"></div></div>
      </div>
    </div><!-- /calls -->

    <!-- AUDIT TAB -->
    <div class="tab-panel" id="tab-audit">
      <div class="audit-layout">
        <!-- Left: token list -->
        <div class="audit-list-panel">
          <div style="padding:10px 12px;border-bottom:1px solid var(--border);flex-shrink:0">
            <div style="font-family:var(--mono);font-size:10px;letter-spacing:2px;color:var(--cyan);margin-bottom:8px;text-transform:uppercase">🔬 AUDIT — SELECT TOKEN</div>
            <div style="display:flex;gap:4px;margin-bottom:8px;flex-wrap:wrap">
              <button class="fchip active" onclick="auditFilter(this,'all')">ALL</button>
              <button class="fchip" onclick="auditFilter(this,'POST')">POSTED</button>
              <button class="fchip" onclick="auditFilter(this,'IGNORE')">IGNORED</button>
              <button class="fchip" onclick="auditFilter(this,'WATCHLIST')">WATCHING</button>
            </div>
            <input id="auditSearch" oninput="filterAuditList()" placeholder="Search $TICKER or CA..." style="width:100%;background:rgba(0,0,0,0.4);border:1px solid var(--border2);border-radius:5px;padding:6px 10px;color:var(--text1);font-family:var(--mono);font-size:10px;outline:none">
          </div>
          <div class="audit-list-scroll" id="auditList">
            <div class="spinner"><div class="spin-dot" style="background:var(--green)"></div><div class="spin-dot" style="background:var(--cyan)"></div><div class="spin-dot" style="background:var(--purple)"></div></div>
          </div>
        </div>

        <!-- Right: detailed audit view -->
        <div class="audit-detail-panel" id="auditDetail">
          <div class="empty-state">
            <div class="empty-icon">🔬</div>
            <div>Select a token from the list to audit</div>
            <div class="empty-hint">Full AI pipeline breakdown · sub-scores · wallet intel · OpenAI decision · all trade levels</div>
          </div>
        </div>
      </div>
    </div><!-- /audit -->

    <!-- ANALYTICS TAB -->
    <div class="tab-panel" id="tab-analytics">
      <div class="g2">
        <!-- Confidence Calibration -->
        <div class="card">
          <div class="card-hdr"><div class="card-title"><span class="icon">🎯</span>CONFIDENCE CALIBRATION</div><span style="font-family:var(--mono);font-size:8px;color:var(--text3)">IS THE SCORE PREDICTING WINS?</span></div>
          <div class="card-body" id="calibrationChart"><div class="empty-state"><div class="empty-icon">🎯</div><div>Needs resolved WIN/LOSS calls</div></div></div>
        </div>
        <!-- Win Rate by Setup -->
        <div class="card">
          <div class="card-hdr"><div class="card-title"><span class="icon">🔮</span>WIN RATE BY SETUP TYPE</div></div>
          <div class="card-body" id="winBySetup"><div class="empty-state"><div class="empty-icon">📊</div><div>Mark calls as WIN or LOSS</div></div></div>
        </div>
      </div>
      <div class="g2">
        <!-- Loss Autopsy -->
        <div class="card">
          <div class="card-hdr"><div class="card-title"><span class="icon">🔬</span>LOSS AUTOPSY</div><span style="font-family:var(--mono);font-size:8px;color:var(--red)">WHY DID WE LOSE?</span></div>
          <div class="card-body" style="padding:0" id="lossAutopsy"><div class="empty-state"><div class="empty-icon">🔬</div><div>Needs LOSS outcomes</div><div class="empty-hint">Mark calls as LOSS in Smart Money tab</div></div></div>
        </div>
        <!-- Missed Winners -->
        <div class="card">
          <div class="card-hdr">
            <div class="card-title"><span class="icon">😢</span>MISSED WINNERS (AUTO-DETECTED)</div>
            <button onclick="fetch('/api/v8/force-missed-winner-scan',{method:'POST'}).then(()=>setTimeout(()=>loadAnalytics(),4000))" style="background:rgba(255,109,0,0.1);border:1px solid rgba(255,109,0,0.3);color:var(--orange);border-radius:3px;padding:3px 10px;font-family:var(--mono);font-size:8px;cursor:pointer;letter-spacing:1px">↻ SCAN NOW</button>
          </div>
          <div class="card-body" style="padding:0" id="missedWinnersList"><div class="empty-state"><div class="empty-icon">😢</div><div>No missed winners detected</div><div class="empty-hint">Learning loop checks every 6 hours</div></div></div>
        </div>
      </div>
      <!-- AI Improvement Recommendations -->
      <div class="card">
        <div class="card-hdr"><div class="card-title"><span class="icon">🧠</span>AI IMPROVEMENT RECOMMENDATIONS</div><span style="font-family:var(--mono);font-size:8px;color:var(--purple)">FROM MISSED WINNER ANALYSIS</span></div>
        <div class="card-body" id="aiRecommendations"><div class="empty-state"><div class="empty-icon">🧠</div><div>Run a missed winner scan to generate recommendations</div></div></div>
      </div>
      <!-- Score Heatmap -->
      <div class="card">
        <div class="card-hdr"><div class="card-title"><span class="icon">🔥</span>SCORE DISTRIBUTION HEATMAP</div></div>
        <div class="card-body">
          <div style="display:flex;justify-content:space-between;font-family:var(--mono);font-size:8px;color:var(--text3);margin-bottom:6px"><span>0</span><span>10</span><span>20</span><span>30</span><span>40</span><span>50</span><span>60</span><span>70</span><span>80</span><span>90</span></div>
          <div style="display:grid;grid-template-columns:repeat(10,1fr);gap:3px" id="scoreHeatmap"></div>
        </div>
      </div>
    </div><!-- /analytics -->

    <!-- AI BRAIN TAB -->
    <div class="tab-panel" id="tab-ai">
      <!-- NEURAL BRAIN VISUALIZATION -->
      <div class="card" style="border-color:rgba(24,255,255,0.3);margin-bottom:14px;overflow:hidden">
        <div style="position:relative;background:linear-gradient(135deg,rgba(4,6,11,0.95),rgba(10,15,30,0.95));padding:24px">
          <!-- Animated background grid -->
          <div style="position:absolute;inset:0;background-image:linear-gradient(rgba(24,255,255,0.03) 1px,transparent 1px),linear-gradient(90deg,rgba(24,255,255,0.03) 1px,transparent 1px);background-size:30px 30px;pointer-events:none"></div>

          <!-- Header -->
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;position:relative">
            <div style="display:flex;align-items:center;gap:14px">
              <div style="width:52px;height:52px;border-radius:50%;background:linear-gradient(135deg,rgba(24,255,255,0.15),rgba(156,39,176,0.15));border:2px solid rgba(24,255,255,0.4);display:flex;align-items:center;justify-content:center;font-size:22px;animation:hexPulse 3s ease-in-out infinite">🧠</div>
              <div>
                <div style="font-family:var(--sans);font-size:18px;font-weight:700;background:linear-gradient(90deg,#18ffff,#9c27b0);-webkit-background-clip:text;-webkit-text-fill-color:transparent">PULSE CALLER AI ENGINE</div>
                <div style="font-family:var(--mono);font-size:9px;color:var(--text3);letter-spacing:2px">v8.0 · MULTI-AGENT · ALWAYS LEARNING</div>
              </div>
            </div>
            <div style="text-align:right">
              <div class="status-chip chip-cyan learning-pulse" id="aiBigBadge" style="font-size:9px">⚡ AI OS ACTIVE</div>
            </div>
          </div>

          <!-- Neural network canvas -->
          <div class="neural-network" style="margin-bottom:20px;position:relative">
            <canvas class="neural-canvas" id="neuralCanvas"></canvas>
            <!-- Overlay stats -->
            <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:space-around;pointer-events:none">
              <div style="text-align:center">
                <div style="font-family:var(--mono);font-size:28px;font-weight:900;color:var(--cyan)" id="aiEvalsCount">—</div>
                <div style="font-family:var(--mono);font-size:8px;color:var(--text3);letter-spacing:2px">TOKENS SCANNED</div>
              </div>
              <div style="text-align:center">
                <div style="font-family:var(--mono);font-size:28px;font-weight:900;color:var(--green)" id="aiCallsCount">—</div>
                <div style="font-family:var(--mono);font-size:8px;color:var(--text3);letter-spacing:2px">CALLS POSTED</div>
              </div>
              <div style="text-align:center">
                <div style="font-family:var(--mono);font-size:28px;font-weight:900;color:var(--gold)" id="aiWrCount">—</div>
                <div style="font-family:var(--mono);font-size:8px;color:var(--text3);letter-spacing:2px">WIN RATE</div>
              </div>
              <div style="text-align:center">
                <div style="font-family:var(--mono);font-size:20px;font-weight:700;color:var(--purple)" id="aiSweetSpot">$10K–$25K</div>
                <div style="font-family:var(--mono);font-size:8px;color:var(--text3);letter-spacing:2px">GEM TARGET</div>
              </div>
            </div>
          </div>

          <!-- 6-step pipeline status — pre-rendered, no template literals -->
          <div style="display:grid;grid-template-columns:repeat(6,1fr);gap:6px;margin-bottom:16px">
            <div style="text-align:center;padding:8px 4px;background:#18ffff11;border:1px solid #18ffff33;border-radius:6px"><div style="font-size:14px">📡</div><div style="font-family:var(--mono);font-size:7px;color:#18ffff;margin-top:3px">Scanner</div><div style="width:6px;height:6px;border-radius:50%;background:#18ffff;margin:4px auto 0;box-shadow:0 0 4px #18ffff;animation:pulse 1.0s ease-in-out infinite"></div></div>
            <div style="text-align:center;padding:8px 4px;background:#9c27b011;border:1px solid #9c27b033;border-radius:6px"><div style="font-size:14px">👥</div><div style="font-family:var(--mono);font-size:7px;color:#9c27b0;margin-top:3px">Wallet DB</div><div style="width:6px;height:6px;border-radius:50%;background:#9c27b0;margin:4px auto 0;box-shadow:0 0 4px #9c27b0;animation:pulse 1.2s ease-in-out infinite"></div></div>
            <div style="text-align:center;padding:8px 4px;background:#ffd74011;border:1px solid #ffd74033;border-radius:6px"><div style="font-size:14px">🏛</div><div style="font-family:var(--mono);font-size:7px;color:#ffd740;margin-top:3px">Deployer</div><div style="width:6px;height:6px;border-radius:50%;background:#ffd740;margin:4px auto 0;box-shadow:0 0 4px #ffd740;animation:pulse 1.4s ease-in-out infinite"></div></div>
            <div style="text-align:center;padding:8px 4px;background:#ff6d0011;border:1px solid #ff6d0033;border-radius:6px"><div style="font-size:14px">🎥</div><div style="font-family:var(--mono);font-size:7px;color:#ff6d00;margin-top:3px">Livestream</div><div style="width:6px;height:6px;border-radius:50%;background:#ff6d00;margin:4px auto 0;box-shadow:0 0 4px #ff6d00;animation:pulse 1.6s ease-in-out infinite"></div></div>
            <div style="text-align:center;padding:8px 4px;background:#448aff11;border:1px solid #448aff33;border-radius:6px"><div style="font-size:14px">🧠</div><div style="font-family:var(--mono);font-size:7px;color:#448aff;margin-top:3px">Claude AI</div><div style="width:6px;height:6px;border-radius:50%;background:#448aff;margin:4px auto 0;box-shadow:0 0 4px #448aff;animation:pulse 1.8s ease-in-out infinite"></div></div>
            <div style="text-align:center;padding:8px 4px;background:#00e67611;border:1px solid #00e67633;border-radius:6px"><div style="font-size:14px">🤖</div><div style="font-family:var(--mono);font-size:7px;color:#00e676;margin-top:3px">OpenAI GPT-4o</div><div style="width:6px;height:6px;border-radius:50%;background:#00e676;margin:4px auto 0;box-shadow:0 0 4px #00e676;animation:pulse 2.0s ease-in-out infinite"></div></div>
          </div>

          <!-- W/L counts -->
          <div style="font-family:var(--mono);font-size:10px;color:var(--text3);text-align:center" id="aiWLCount">—</div>
        </div>

        <!-- Memory panel below -->
        <div class="card-body" style="background:var(--surface2)">
          <div id="aiMemoryPanel"><div class="spinner"><div class="spin-dot" style="background:var(--purple)"></div><div class="spin-dot" style="background:var(--cyan)"></div><div class="spin-dot" style="background:var(--green)"></div></div></div>
        </div>
      </div>

      <!-- ═══ AUTONOMOUS AGENT PANEL ═══ -->
      <div class="card" style="border-color:rgba(68,138,255,0.4);margin-bottom:14px;overflow:hidden">
        <!-- Header with tabs -->
        <div style="background:linear-gradient(135deg,rgba(68,138,255,0.08),rgba(156,39,176,0.06));padding:14px 18px;border-bottom:1px solid rgba(68,138,255,0.2)">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;flex-wrap:wrap;gap:8px">
            <div style="display:flex;align-items:center;gap:10px">
              <div style="width:36px;height:36px;border-radius:8px;background:linear-gradient(135deg,#448aff,#9c27b0);display:flex;align-items:center;justify-content:center;font-size:16px">🤖</div>
              <div>
                <div style="font-family:var(--mono);font-size:13px;font-weight:700;color:var(--blue)">AUTONOMOUS AGENT SYSTEM</div>
                <div style="font-family:var(--mono);font-size:8px;color:var(--text3);letter-spacing:1px">BOT A: HUNTER · BOT B: CRITIC · DUAL-AI · SELF-IMPROVING</div>
              </div>
            </div>
            <div style="display:flex;gap:6px;align-items:center">
              <div id="agentStatusBadge" style="font-family:var(--mono);font-size:8px;padding:3px 10px;border-radius:3px;background:rgba(0,230,118,0.1);border:1px solid rgba(0,230,118,0.3);color:var(--green)">⚡ READY</div>
              <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-family:var(--mono);font-size:9px;color:var(--text3)">
                <input type="checkbox" id="agentAutoApply" onchange="toggleAgentAutoApply(this)" style="accent-color:var(--cyan)">
                AUTO-APPLY LOW-RISK
              </label>
            </div>
          </div>
          <!-- Tab bar -->
          <div style="display:flex;gap:4px;flex-wrap:wrap">
            <button class="agent-tab active" id="atab-chat"    onclick="switchAgentTab('chat')"   >💬 CHAT</button>
            <button class="agent-tab"        id="atab-actions" onclick="switchAgentTab('actions')" >⚡ ACTIONS</button>
            <button class="agent-tab"        id="atab-rec"     onclick="switchAgentTab('rec')"     >📋 RECOMMENDED</button>
            <button class="agent-tab"        id="atab-data"    onclick="switchAgentTab('data')"    >📊 AGENT DATA</button>
          </div>
        </div>

        <!-- ── TAB: CHAT ── -->
        <div id="agent-tab-chat" class="agent-tab-panel" style="display:flex;flex-direction:column;height:480px">
          <!-- Quick action buttons -->
          <div style="padding:10px 14px;border-bottom:1px solid var(--border);display:flex;gap:6px;flex-wrap:wrap">
            <button onclick="runAutonomousAgent('analyze')" style="background:rgba(24,255,255,0.08);border:1px solid rgba(24,255,255,0.25);color:var(--cyan);border-radius:5px;padding:6px 12px;font-family:var(--mono);font-size:9px;cursor:pointer;letter-spacing:1px" title="Bot A analyzes data, Bot B validates">🔍 ANALYZE</button>
            <button onclick="runAutonomousAgent('optimize')" style="background:rgba(0,230,118,0.08);border:1px solid rgba(0,230,118,0.25);color:var(--green);border-radius:5px;padding:6px 12px;font-family:var(--mono);font-size:9px;cursor:pointer;letter-spacing:1px" title="Bot A proposes params, Bot B approves">⚡ OPTIMIZE</button>
            <button onclick="runAutonomousAgent('wallets')" style="background:rgba(156,39,176,0.08);border:1px solid rgba(156,39,176,0.25);color:var(--purple);border-radius:5px;padding:6px 12px;font-family:var(--mono);font-size:9px;cursor:pointer;letter-spacing:1px">👥 WALLETS</button>
            <button onclick="runAutonomousAgent('survivors')" style="background:rgba(255,215,64,0.08);border:1px solid rgba(255,215,64,0.25);color:var(--gold);border-radius:5px;padding:6px 12px;font-family:var(--mono);font-size:9px;cursor:pointer;letter-spacing:1px">🏆 SURVIVORS</button>
            <button onclick="runAutonomousAgent('review')" style="background:rgba(68,138,255,0.08);border:1px solid rgba(68,138,255,0.25);color:var(--blue);border-radius:5px;padding:6px 12px;font-family:var(--mono);font-size:9px;cursor:pointer;letter-spacing:1px">📋 24H REVIEW</button>
            <button onclick="triggerDailyReview()" style="background:rgba(255,109,0,0.08);border:1px solid rgba(255,109,0,0.25);color:var(--orange);border-radius:5px;padding:6px 12px;font-family:var(--mono);font-size:9px;cursor:pointer;letter-spacing:1px" title="Runs all 4 modes: analyze+optimize+wallets+survivors">🔄 FULL CYCLE</button>
          </div>
          <!-- Messages -->
          <div id="agentMessages" style="flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px;background:rgba(0,0,0,0.2)">
            <div style="display:flex;gap:10px;align-items:flex-start">
              <div style="width:28px;height:28px;border-radius:6px;background:linear-gradient(135deg,#448aff,#9c27b0);display:flex;align-items:center;justify-content:center;font-size:12px;flex-shrink:0">🤖</div>
              <div style="flex:1;background:rgba(68,138,255,0.08);border:1px solid rgba(68,138,255,0.2);border-radius:8px;padding:12px 14px;font-family:var(--mono);font-size:11px;color:var(--text2);line-height:1.6">
                Pulse Caller Agent System online. I analyze bot performance, wallet intelligence, and survivor token data — then propose parameter optimizations to improve call quality.<br><br>
                Use the buttons above to run specific analysis, or type a question below. I can:<br>
                • Review wins/losses and adjust scoring thresholds<br>
                • Analyze which early wallets appear in winners vs losers<br>
                • Identify survivor token patterns (>4h, >$500K)<br>
                • Propose and execute parameter changes (never API keys)<br>
                • Flag resources/APIs needed for better accuracy
              </div>
            </div>
          </div>
          <!-- Input -->
          <div style="padding:10px 14px;border-top:1px solid var(--border);display:flex;gap:8px">
            <input id="agentInput" placeholder="Ask the agent anything about performance, wallets, optimizations..." style="flex:1;background:rgba(0,0,0,0.4);border:1px solid var(--border2);border-radius:6px;padding:10px 14px;color:var(--text1);font-family:var(--mono);font-size:11px;outline:none" onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendAgentMessage();}">
            <button onclick="sendAgentMessage()" style="background:linear-gradient(135deg,rgba(68,138,255,0.2),rgba(156,39,176,0.15));border:1px solid var(--blue);color:var(--blue);border-radius:6px;padding:10px 20px;font-family:var(--mono);font-size:10px;cursor:pointer;letter-spacing:1px;white-space:nowrap" id="agentSendBtn">SEND ↵</button>
          </div>
        </div>

        <!-- ── TAB: ACTIONS ── -->
        <div id="agent-tab-actions" class="agent-tab-panel" style="display:none;padding:14px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-wrap:wrap;gap:8px">
            <div style="font-family:var(--mono);font-size:10px;color:var(--text3)">Proposed and applied parameter changes. Approve or rollback each action.</div>
            <button onclick="loadAgentHistory()" style="background:transparent;border:1px solid var(--border2);color:var(--text3);border-radius:4px;padding:5px 12px;font-family:var(--mono);font-size:9px;cursor:pointer">↻ REFRESH</button>
          </div>
          <div id="agentActionsList" style="display:flex;flex-direction:column;gap:8px;max-height:400px;overflow-y:auto">
            <div style="font-family:var(--mono);font-size:10px;color:var(--text3);text-align:center;padding:30px">No agent actions yet. Run ANALYZE PERFORMANCE or OPTIMIZE PARAMS to get started.</div>
          </div>
        </div>

        <!-- ── TAB: RECOMMENDED ── -->
        <div id="agent-tab-rec" class="agent-tab-panel" style="display:none;padding:14px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-wrap:wrap;gap:8px">
            <div style="font-family:var(--mono);font-size:10px;color:var(--text3)">Resources, APIs, and access the agents need to improve call accuracy.</div>
            <button onclick="addManualRecommendation()" style="background:rgba(0,230,118,0.08);border:1px solid rgba(0,230,118,0.3);color:var(--green);border-radius:4px;padding:5px 12px;font-family:var(--mono);font-size:9px;cursor:pointer">+ ADD RECOMMENDATION</button>
          </div>
          <div id="agentRecsList" style="display:flex;flex-direction:column;gap:8px;max-height:400px;overflow-y:auto">
            <div style="font-family:var(--mono);font-size:10px;color:var(--text3);text-align:center;padding:30px">No recommendations yet. Run ANALYZE PERFORMANCE and the agent will flag what it needs.</div>
          </div>
        </div>

        <!-- ── TAB: DATA ── -->
        <div id="agent-tab-data" class="agent-tab-panel" style="display:none;padding:14px">
          <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px;margin-bottom:16px">
            <div class="intel-tile"><div class="intel-label">EARLY WALLETS</div><div class="intel-value" style="color:var(--cyan)" id="adEarlyWallets">—</div><div class="intel-sub">First 150 buyers tracked</div></div>
            <div class="intel-tile"><div class="intel-label">SURVIVOR TOKENS</div><div class="intel-value" style="color:var(--gold)" id="adSurvivorTokens">—</div><div class="intel-sub">>4h & >$500K MCap</div></div>
            <div class="intel-tile"><div class="intel-label">AGENT ACTIONS</div><div class="intel-value" style="color:var(--blue)" id="adAgentActions">—</div><div class="intel-sub">Changes proposed/applied</div></div>
            <div class="intel-tile"><div class="intel-label">ACTIVE OVERRIDES</div><div class="intel-value" style="color:var(--purple)" id="adOverrides">—</div><div class="intel-sub">Live param changes</div></div>
          </div>
          <div style="background:rgba(0,0,0,0.3);border:1px solid var(--border);border-radius:8px;padding:14px;margin-bottom:12px">
            <div style="font-family:var(--mono);font-size:9px;color:var(--text3);letter-spacing:1px;margin-bottom:8px">ACTIVE PARAMETER OVERRIDES</div>
            <div id="adOverrideDetails" style="font-family:var(--mono);font-size:10px;color:var(--text2)">Loading...</div>
          </div>
          <div style="background:rgba(0,0,0,0.3);border:1px solid var(--border);border-radius:8px;padding:14px">
            <div style="font-family:var(--mono);font-size:9px;color:var(--text3);letter-spacing:1px;margin-bottom:8px">SURVIVOR TOKENS (>4h, >$500K)</div>
            <div id="adSurvivorList" style="font-family:var(--mono);font-size:10px;color:var(--text2)">Loading...</div>
          </div>
          <div style="background:rgba(0,0,0,0.3);border:1px solid rgba(68,138,255,0.2);border-radius:8px;padding:14px;margin-top:12px">
            <div style="font-family:var(--mono);font-size:9px;color:var(--blue);letter-spacing:1px;margin-bottom:10px">⚙ SYSTEM CONTROLS — AUTONOMY & FREEZE</div>
            <div id="adSystemState" style="font-family:var(--mono);font-size:10px;color:var(--text2)">Loading...</div>
          </div>
        </div>
      </div>
      <!-- Call Thesis Generator -->
            <!-- ═══ TOKEN ANALYZER — PATTERN LEARNING ═══ -->
      <div class="card" style="border-color:rgba(255,215,64,0.3);margin-bottom:14px">
        <div class="card-hdr" style="background:rgba(255,215,64,0.04)">
          <div class="card-title" style="color:var(--gold)"><span class="icon">🔬</span>TOKEN ANALYZER — STUDY WINNING PATTERNS</div>
          <span style="font-family:var(--mono);font-size:8px;color:var(--text3)">FEEDS AI LEARNING BRAIN</span>
        </div>
        <div class="card-body">
          <div style="font-family:var(--mono);font-size:9px;color:var(--text3);margin-bottom:12px;line-height:1.6">Paste any CA to deep-analyze. Claude studies signals, extracts repeatable patterns, and builds gem-finding intelligence. Study your winners and losses to train the AI brain.</div>
          <div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap">
            <input id="analyzerInput" placeholder="Contract address or $TICKER..." style="flex:1;min-width:200px;background:rgba(0,0,0,0.4);border:1px solid rgba(255,215,64,0.3);border-radius:6px;padding:10px 14px;color:var(--text1);font-family:var(--mono);font-size:11px;outline:none" onkeydown="if(event.key==='Enter')runTokenAnalyzer()">
            <button onclick="runTokenAnalyzer()" id="analyzerBtn" style="background:linear-gradient(135deg,rgba(255,215,64,0.15),rgba(255,109,0,0.1));border:1px solid var(--gold);color:var(--gold);border-radius:6px;padding:10px 20px;font-family:var(--mono);font-size:10px;cursor:pointer;letter-spacing:1px">🔬 ANALYZE</button>
          </div>
          <input id="analyzerQuestion" placeholder="Optional specific question (e.g. why did this 10x?)" style="width:100%;box-sizing:border-box;background:rgba(0,0,0,0.3);border:1px solid var(--border2);border-radius:6px;padding:8px 14px;color:var(--text1);font-family:var(--mono);font-size:10px;outline:none;margin-bottom:10px">
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px">
            <button onclick="quickStudy('winners')" style="background:rgba(0,230,118,0.08);border:1px solid rgba(0,230,118,0.25);color:var(--green);border-radius:5px;padding:5px 12px;font-family:var(--mono);font-size:9px;cursor:pointer">🏆 STUDY WINNERS</button>
            <button onclick="quickStudy('losses')" style="background:rgba(255,23,68,0.08);border:1px solid rgba(255,23,68,0.25);color:var(--red);border-radius:5px;padding:5px 12px;font-family:var(--mono);font-size:9px;cursor:pointer">💀 STUDY LOSSES</button>
            <button onclick="quickStudy('recent')" style="background:rgba(24,255,255,0.08);border:1px solid rgba(24,255,255,0.25);color:var(--cyan);border-radius:5px;padding:5px 12px;font-family:var(--mono);font-size:9px;cursor:pointer">⏱ RECENT</button>
            <button onclick="quickStudy('patterns')" style="background:rgba(156,39,176,0.08);border:1px solid rgba(156,39,176,0.25);color:var(--purple);border-radius:5px;padding:5px 12px;font-family:var(--mono);font-size:9px;cursor:pointer">🧠 EXTRACT PATTERNS</button>
          </div>
          <div id="analyzerLoading" style="display:none;text-align:center;padding:20px"><div class="spinner"><div class="spin-dot" style="background:var(--gold)"></div><div class="spin-dot" style="background:var(--orange)"></div><div class="spin-dot"></div></div><div style="font-family:var(--mono);font-size:9px;color:var(--text3);margin-top:8px">Claude extracting patterns...</div></div>
          <div id="analyzerOutput" style="background:rgba(0,0,0,0.3);border:1px solid var(--border);border-radius:8px;padding:14px;font-family:var(--mono);font-size:10px;color:var(--text2);line-height:1.7;white-space:pre-wrap;display:none;max-height:400px;overflow-y:auto"></div>
        </div>
      </div>

      <div class="card" style="margin-bottom:14px;border-color:rgba(24,255,255,0.2)">
        <div class="card-hdr" style="background:rgba(24,255,255,0.03)"><div class="card-title" style="color:var(--cyan)"><span class="icon">📝</span>CALL THESIS GENERATOR</div><span style="font-family:var(--mono);font-size:8px;color:var(--cyan)">AI-POWERED</span></div>
        <div class="card-body">
          <div style="display:flex;gap:10px;margin-bottom:10px">
            <input id="thesisTokenInput" placeholder="Paste CA or type $TICKER..." style="flex:1;background:rgba(0,0,0,0.4);border:1px solid var(--border2);border-radius:6px;padding:9px 14px;color:var(--text1);font-family:var(--mono);font-size:11px;outline:none" onkeydown="if(event.key==='Enter')generateThesis()">
            <button onclick="generateThesis()" style="background:linear-gradient(135deg,rgba(24,255,255,0.15),rgba(68,138,255,0.1));border:1px solid rgba(24,255,255,0.4);color:var(--cyan);border-radius:6px;padding:9px 20px;font-family:var(--mono);font-size:10px;cursor:pointer;letter-spacing:1px;white-space:nowrap">🧠 GENERATE</button>
          </div>
          <div id="thesisOutput" style="display:none"><div id="thesisContent" style="background:rgba(0,0,0,0.3);border:1px solid rgba(24,255,255,0.15);border-radius:8px;padding:14px;font-size:12px;line-height:1.7;color:var(--text2)"></div></div>
        </div>
      </div>
      <!-- AI Config Control -->
      <div class="card" style="border-color:rgba(255,109,0,0.2)">
        <div class="card-hdr" style="background:rgba(255,109,0,0.04)"><div class="card-title" style="color:var(--orange)"><span class="icon">🎛</span>AI CONFIG — LIVE TUNING</div><span style="font-family:var(--mono);font-size:8px;color:var(--orange)">NO DEPLOY NEEDED</span></div>
        <div class="card-body">
          <div class="g3" style="margin-bottom:14px">
            <div class="intel-tile"><div class="intel-label">Sweet Spot Min ($)</div><input id="cfgSweetSpotMin" type="number" value="10000" style="width:100%;background:transparent;border:none;color:var(--green);font-family:var(--mono);font-size:18px;font-weight:700;outline:none;margin-top:4px"><div class="intel-sub">Default: $10K</div></div>
            <div class="intel-tile"><div class="intel-label">Sweet Spot Max ($)</div><input id="cfgSweetSpotMax" type="number" value="25000" style="width:100%;background:transparent;border:none;color:var(--green);font-family:var(--mono);font-size:18px;font-weight:700;outline:none;margin-top:4px"><div class="intel-sub">Default: $25K</div></div>
            <div class="intel-tile"><div class="intel-label">Max MCap Override ($)</div><input id="cfgMaxMcap" type="number" value="150000" style="width:100%;background:transparent;border:none;color:var(--orange);font-family:var(--mono);font-size:18px;font-weight:700;outline:none;margin-top:4px"><div class="intel-sub">Default: $150K</div></div>
          </div>
          <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
            <button onclick="applyAIConfig()" style="background:rgba(255,109,0,0.15);border:1px solid var(--orange);color:var(--orange);border-radius:6px;padding:9px 20px;font-family:var(--mono);font-size:10px;cursor:pointer;letter-spacing:1px">⚡ APPLY</button>
            <button onclick="resetAIConfig()" style="background:transparent;border:1px solid var(--border2);color:var(--text3);border-radius:6px;padding:9px 20px;font-family:var(--mono);font-size:10px;cursor:pointer;letter-spacing:1px">↺ RESET</button>
            <button onclick="pausePosting(true)" style="background:rgba(255,23,68,0.1);border:1px solid rgba(255,23,68,0.3);color:var(--red);border-radius:6px;padding:9px 16px;font-family:var(--mono);font-size:10px;cursor:pointer">⏸ PAUSE</button>
            <button onclick="pausePosting(false)" style="background:rgba(0,230,118,0.1);border:1px solid rgba(0,230,118,0.3);color:var(--green);border-radius:6px;padding:9px 16px;font-family:var(--mono);font-size:10px;cursor:pointer">▶ RESUME</button>
            <span id="cfgStatus" style="font-family:var(--mono);font-size:9px;color:var(--text3)"></span>
          </div>
        </div>
      </div>
    </div><!-- /ai -->

    <!-- SMART MONEY TAB -->
    <div class="tab-panel" id="tab-smart">

      <!-- ══ HERO STATS ══════════════════════════════════════════════════════ -->
      <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin-bottom:14px">
        <div class="stat-tile" style="--tile-color:var(--text3)"><div class="tile-label">TOTAL TRACKED</div><div class="tile-val" id="smTotalWallets">—</div><div class="tile-sub">DB + memory</div></div>
        <div class="stat-tile" style="--tile-color:var(--gold)"><div class="tile-label">🏆 WINNERS</div><div class="tile-val" id="smWinnerCount">—</div><div class="tile-sub">≥35% 10x rate</div></div>
        <div class="stat-tile" style="--tile-color:var(--blue)"><div class="tile-label">🧠 SMART MONEY</div><div class="tile-val" id="smSmartCount">—</div><div class="tile-sub">Consistent alpha</div></div>
        <div class="stat-tile" style="--tile-color:var(--orange)"><div class="tile-label">🎯 SNIPERS</div><div class="tile-val" id="smSniperCount">—</div><div class="tile-sub">Flagged dumpers</div></div>
        <div class="stat-tile" style="--tile-color:var(--green)"><div class="tile-label">LAST DUNE SCAN</div><div class="tile-val" id="smLastScan" style="font-size:10px">—</div><div class="tile-sub">ET time</div></div>
      </div>

      <!-- ══ DUNE SCANNER PANEL ═══════════════════════════════════════════════ -->
      <div class="card" style="margin-bottom:14px;border-color:rgba(156,39,176,0.3)">
        <div class="card-hdr" style="background:rgba(156,39,176,0.04)">
          <div class="card-title" style="color:var(--purple)"><span class="icon">🔭</span>DUNE WALLET SCANNER</div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <span id="smScanStatus" style="font-family:var(--mono);font-size:8px;padding:3px 10px;border-radius:3px;background:rgba(156,39,176,0.1);border:1px solid rgba(156,39,176,0.3);color:var(--purple)">—</span>
            <button onclick="triggerDuneScan()" id="smScanBtn" style="background:linear-gradient(135deg,rgba(156,39,176,0.2),rgba(68,138,255,0.15));border:1px solid rgba(156,39,176,0.5);color:var(--purple);border-radius:5px;padding:7px 16px;font-family:var(--mono);font-size:9px;cursor:pointer;letter-spacing:1px;font-weight:700">⚡ RUN SCAN NOW</button>
          </div>
        </div>
        <div class="card-body">
          <div style="font-family:var(--mono);font-size:9px;color:var(--text3);margin-bottom:12px;line-height:1.7">
            Pulls <strong style="color:var(--text2)">10,000 gem-hunter wallets</strong> from Dune Analytics across 5 queries: early buyers (GEM_HUNTERS), high-PnL traders (TOP_PNL), pump.fun specialists (PUMPFUN), early entry (EARLY_ENTRY), sniper detection (SNIPERS). Auto-runs every 4 hours. Persists to SQLite across redeploys.
          </div>
          <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:8px">
            <div class="intel-tile" style="border-color:rgba(255,215,64,0.2)"><div class="intel-label" style="color:var(--gold)">🏆 WINNERS</div><div class="intel-value" id="smCatWinner" style="color:var(--gold)">—</div><div class="intel-sub">≥35% 10x win rate</div></div>
            <div class="intel-tile" style="border-color:rgba(68,138,255,0.2)"><div class="intel-label" style="color:var(--blue)">🧠 SMART $</div><div class="intel-value" id="smCatSmart" style="color:var(--blue)">—</div><div class="intel-sub">Early + profitable</div></div>
            <div class="intel-tile" style="border-color:rgba(24,255,255,0.2)"><div class="intel-label" style="color:var(--cyan)">📈 MOMENTUM</div><div class="intel-value" id="smCatMomentum" style="color:var(--cyan)">—</div><div class="intel-sub">Follows breakouts</div></div>
            <div class="intel-tile" style="border-color:rgba(255,109,0,0.2)"><div class="intel-label" style="color:var(--orange)">🎯 SNIPERS</div><div class="intel-value" id="smCatSniper" style="color:var(--orange)">—</div><div class="intel-sub">First-block buyers</div></div>
            <div class="intel-tile" style="border-color:rgba(255,23,68,0.2)"><div class="intel-label" style="color:var(--red)">☠ CLUSTERS</div><div class="intel-value" id="smCatCluster" style="color:var(--red)">—</div><div class="intel-sub">Coordinated bad actors</div></div>
          </div>
        </div>
      </div>

      <!-- ══ WINNER WALLET SPOTLIGHT ═══════════════════════════════════════════ -->
      <div class="card" style="margin-bottom:14px;border-color:rgba(255,215,64,0.25)">
        <div class="card-hdr" style="background:rgba(255,215,64,0.03)">
          <div class="card-title" style="color:var(--gold)"><span class="icon">🏆</span>TOP WINNER WALLETS — PROVEN GEM HUNTERS</div>
          <span style="font-family:var(--mono);font-size:8px;color:var(--text3)">Wallets with documented 10x+ wins — sorted by score</span>
        </div>
        <div id="smTopWinnersGrid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px;padding:14px">
          <div style="font-family:var(--mono);font-size:10px;color:var(--text3);text-align:center;padding:30px;grid-column:1/-1">Run Dune scan to populate winner wallets</div>
        </div>
      </div>

      <!-- ══ FULL RANKINGS TABLE ════════════════════════════════════════════════ -->
      <div class="card" style="margin-bottom:14px">
        <div class="card-hdr">
          <div class="card-title"><span class="icon">📊</span>WALLET RANKINGS — ALL TRACKED WALLETS</div>
          <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
            <select id="smRankCategory" onchange="loadWalletRankings()" style="background:var(--surface2);border:1px solid var(--border);border-radius:4px;padding:5px 8px;color:var(--text2);font-family:var(--mono);font-size:9px;cursor:pointer">
              <option value="">ALL CATEGORIES</option>
              <option value="WINNER">🏆 WINNERS</option>
              <option value="SMART_MONEY">🧠 SMART MONEY</option>
              <option value="MOMENTUM">📈 MOMENTUM</option>
              <option value="SNIPER">🎯 SNIPERS</option>
              <option value="CLUSTER">☠ CLUSTERS</option>
            </select>
            <input id="smRankSearch" oninput="filterWalletRankings(this.value)" placeholder="🔍 Filter by address..." style="background:rgba(0,0,0,0.3);border:1px solid var(--border);border-radius:4px;padding:5px 10px;color:var(--text1);font-family:var(--mono);font-size:9px;outline:none;width:180px">
            <button onclick="loadWalletRankings()" style="background:transparent;border:1px solid var(--border2);color:var(--text3);border-radius:4px;padding:5px 10px;font-family:var(--mono);font-size:9px;cursor:pointer">↻ REFRESH</button>
          </div>
        </div>
        <div style="overflow-x:auto">
          <table style="width:100%;border-collapse:collapse">
            <thead><tr style="border-bottom:2px solid var(--border)">
              <th style="font-family:var(--mono);font-size:8px;color:var(--text3);padding:10px 12px;text-align:left;letter-spacing:1px">#</th>
              <th style="font-family:var(--mono);font-size:8px;color:var(--text3);padding:10px 12px;text-align:left;letter-spacing:1px">WALLET ADDRESS</th>
              <th style="font-family:var(--mono);font-size:8px;color:var(--text3);padding:10px 12px;text-align:center;letter-spacing:1px">CATEGORY</th>
              <th style="font-family:var(--mono);font-size:8px;color:var(--text3);padding:10px 12px;text-align:center;letter-spacing:1px">SCORE</th>
              <th style="font-family:var(--mono);font-size:8px;color:var(--text3);padding:10px 12px;text-align:center;letter-spacing:1px">WIN RATE</th>
              <th style="font-family:var(--mono);font-size:8px;color:var(--text3);padding:10px 12px;text-align:center;letter-spacing:1px">AVG ROI</th>
              <th style="font-family:var(--mono);font-size:8px;color:var(--text3);padding:10px 12px;text-align:center;letter-spacing:1px">TRADES</th>
              <th style="font-family:var(--mono);font-size:8px;color:var(--text3);padding:10px 12px;text-align:center;letter-spacing:1px">OUR WINS</th>
              <th style="font-family:var(--mono);font-size:8px;color:var(--text3);padding:10px 12px;text-align:center;letter-spacing:1px">LINKS</th>
            </tr></thead>
            <tbody id="smRankBody">
              <tr><td colspan="9" style="text-align:center;padding:30px;font-family:var(--mono);font-size:10px;color:var(--text3)">Loading wallet rankings...</td></tr>
            </tbody>
          </table>
        </div>
        <div id="smRankPager" style="padding:10px 14px;border-top:1px solid var(--border);font-family:var(--mono);font-size:9px;color:var(--text3);display:none"></div>
      </div>

      <!-- ══ WINNER HISTORY + DEPLOYER LEADERBOARD ══════════════════════════════ -->
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px">
        <!-- Winner wallet history from our own calls -->
        <div class="card">
          <div class="card-hdr"><div class="card-title"><span class="icon">🏅</span>WINNER WALLETS — OUR CALL HISTORY</div><button onclick="loadWinnerWallets()" style="background:transparent;border:1px solid var(--border2);color:var(--text3);border-radius:3px;padding:3px 8px;font-family:var(--mono);font-size:8px;cursor:pointer">↻</button></div>
          <div style="max-height:320px;overflow-y:auto">
            <table style="width:100%;border-collapse:collapse">
              <thead><tr style="border-bottom:1px solid var(--border);position:sticky;top:0;background:var(--surface1)">
                <th style="font-family:var(--mono);font-size:8px;color:var(--text3);padding:7px 10px;text-align:left">#</th>
                <th style="font-family:var(--mono);font-size:8px;color:var(--text3);padding:7px 10px;text-align:left">ADDRESS</th>
                <th style="font-family:var(--mono);font-size:8px;color:var(--text3);padding:7px 10px;text-align:center">WINS</th>
                <th style="font-family:var(--mono);font-size:8px;color:var(--text3);padding:7px 10px;text-align:center">WIN %</th>
                <th style="font-family:var(--mono);font-size:8px;color:var(--text3);padding:7px 10px;text-align:center">LINKS</th>
              </tr></thead>
              <tbody id="winnerWalletsBody">
                <tr><td colspan="5" style="text-align:center;padding:20px;font-family:var(--mono);font-size:9px;color:var(--text3)">Loading...</td></tr>
              </tbody>
            </table>
          </div>
        </div>
        <!-- Deployer leaderboard -->
        <div class="card">
          <div class="card-hdr"><div class="card-title"><span class="icon">🎖</span>DEPLOYER LEADERBOARD</div><button onclick="loadDeployerLeaderboard()" style="background:transparent;border:1px solid var(--border2);color:var(--text3);border-radius:3px;padding:3px 8px;font-family:var(--mono);font-size:8px;cursor:pointer">↻</button></div>
          <div style="max-height:320px;overflow-y:auto">
            <table style="width:100%;border-collapse:collapse">
              <thead><tr style="border-bottom:1px solid var(--border);position:sticky;top:0;background:var(--surface1)">
                <th style="font-family:var(--mono);font-size:8px;color:var(--text3);padding:7px 10px;text-align:left">#</th>
                <th style="font-family:var(--mono);font-size:8px;color:var(--text3);padding:7px 10px;text-align:left">DEPLOYER</th>
                <th style="font-family:var(--mono);font-size:8px;color:var(--text3);padding:7px 10px;text-align:center">LAUNCHES</th>
                <th style="font-family:var(--mono);font-size:8px;color:var(--text3);padding:7px 10px;text-align:center">WIN%</th>
                <th style="font-family:var(--mono);font-size:8px;color:var(--text3);padding:7px 10px;text-align:center">GRADE</th>
                <th style="font-family:var(--mono);font-size:8px;color:var(--text3);padding:7px 10px;text-align:center">LINK</th>
              </tr></thead>
              <tbody id="deployerLeaderBody">
                <tr><td colspan="6" style="text-align:center;padding:20px;font-family:var(--mono);font-size:9px;color:var(--text3)">Loading...</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

    </div><!-- /tab-smart -->

    <!-- /tab-smart -->


    <!-- /tab-smart -->

    <!-- /smart -->

    <!-- ARCHIVE TAB -->
    <div class="tab-panel" id="tab-archive" style="display:none">
      <div class="card" style="margin-bottom:14px;border-color:rgba(255,215,64,0.2)">
        <div class="card-hdr" style="background:rgba(255,215,64,0.03)">
          <div class="card-title" style="color:var(--gold)"><span class="icon">📁</span>AUDIT ARCHIVE — LAST 500 PROMOTED CALLS</div>
          <span style="font-family:var(--mono);font-size:8px;color:var(--text3)" id="archiveTotalBadge">—</span>
        </div>
        <div style="padding:10px 14px;border-bottom:1px solid var(--border);display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <input id="archiveSearch" oninput="searchArchive()" placeholder="🔍 Search token or CA..." style="flex:1;min-width:180px;background:rgba(0,0,0,0.3);border:1px solid var(--border);border-radius:4px;padding:6px 10px;color:var(--text1);font-family:var(--mono);font-size:10px;outline:none">
          <div style="display:flex;gap:4px;flex-wrap:wrap">
            <button class="fchip active" id="arch-ALL"       onclick="setArchiveFilter(this,'ALL')"       style="color:var(--cyan);border-color:rgba(24,255,255,0.4);background:rgba(24,255,255,0.06)">ALL</button>
            <button class="fchip" id="arch-AUTO_POST"        onclick="setArchiveFilter(this,'AUTO_POST')" >POSTED</button>
            <button class="fchip" id="arch-WATCHLIST"        onclick="setArchiveFilter(this,'WATCHLIST')" >WATCHLIST</button>
            <button class="fchip" id="arch-IGNORE"           onclick="setArchiveFilter(this,'IGNORE')"    >IGNORE</button>
            <button class="fchip" id="arch-BLOCKLIST"        onclick="setArchiveFilter(this,'BLOCKLIST')" >BLOCKLIST</button>
          </div>
          <select id="archiveSort" onchange="loadArchive()" style="background:var(--surface2);border:1px solid var(--border);border-radius:4px;padding:5px;color:var(--text3);font-family:var(--mono);font-size:9px;cursor:pointer">
            <option value="newest">Newest First</option>
            <option value="score">Highest Score</option>
            <option value="mcap">Highest MCap</option>
          </select>
          <button onclick="loadArchive()" style="background:transparent;border:1px solid var(--border2);color:var(--text3);border-radius:4px;padding:5px 10px;font-family:var(--mono);font-size:9px;cursor:pointer">↻ REFRESH</button>
        </div>
        <!-- Stats summary row -->
        <div style="display:flex;gap:0;border-bottom:1px solid var(--border)" id="archiveStatsRow">
          <div style="flex:1;padding:8px 14px;border-right:1px solid var(--border)"><div style="font-family:var(--mono);font-size:8px;color:var(--text3)">TOTAL ARCHIVED</div><div style="font-family:var(--mono);font-size:16px;font-weight:700;color:var(--cyan)" id="archTotal">—</div></div>
          <div style="flex:1;padding:8px 14px;border-right:1px solid var(--border)"><div style="font-family:var(--mono);font-size:8px;color:var(--text3)">POSTED</div><div style="font-family:var(--mono);font-size:16px;font-weight:700;color:var(--green)" id="archPosted">—</div></div>
          <div style="flex:1;padding:8px 14px;border-right:1px solid var(--border)"><div style="font-family:var(--mono);font-size:8px;color:var(--text3)">WATCHLIST</div><div style="font-family:var(--mono);font-size:16px;font-weight:700;color:var(--gold)" id="archWatch">—</div></div>
          <div style="flex:1;padding:8px 14px"><div style="font-family:var(--mono);font-size:8px;color:var(--text3)">IGNORED</div><div style="font-family:var(--mono);font-size:16px;font-weight:700;color:var(--text3)" id="archIgnore">—</div></div>
        </div>
        <!-- Archive grid -->
        <div id="archiveGrid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:10px;padding:14px;max-height:70vh;overflow-y:auto">
          <div style="font-family:var(--mono);font-size:10px;color:var(--text3);text-align:center;padding:30px;grid-column:1/-1">Loading archive...</div>
        </div>
        <div style="padding:10px 14px;border-top:1px solid var(--border);display:flex;gap:8px;align-items:center">
          <button onclick="archivePage=Math.max(0,archivePage-1);loadArchive()" style="background:transparent;border:1px solid var(--border2);color:var(--text3);border-radius:4px;padding:5px 12px;font-family:var(--mono);font-size:9px;cursor:pointer">← PREV</button>
          <span id="archivePagination" style="font-family:var(--mono);font-size:9px;color:var(--text3);flex:1;text-align:center">Page 1</span>
          <button onclick="archivePage++;loadArchive()" style="background:transparent;border:1px solid var(--border2);color:var(--text3);border-radius:4px;padding:5px 12px;font-family:var(--mono);font-size:9px;cursor:pointer">NEXT →</button>
        </div>
      </div>
    </div><!-- /archive -->

    <!-- SYSTEM TAB -->
    <div class="tab-panel" id="tab-scanner">

      <!-- ══ SCANNER HEADER ══ -->
      <div class="card" style="margin-bottom:14px">
        <div class="card-hdr">
          <div class="card-title"><span class="icon">🔍</span>SCANNER — ALL EVALUATED TOKENS</div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <input id="scannerSearch" oninput="loadScanner()" placeholder="🔍 Search token or CA..." style="background:rgba(0,0,0,0.3);border:1px solid var(--border);border-radius:4px;padding:5px 10px;color:var(--text1);font-family:var(--mono);font-size:9px;outline:none;width:180px">
            <select id="scannerHours" onchange="loadScanner()" style="background:var(--surface2);border:1px solid var(--border);border-radius:4px;padding:5px 8px;color:var(--text2);font-family:var(--mono);font-size:9px;cursor:pointer">
              <option value="6">Last 6 hours</option>
              <option value="24" selected>Last 24 hours</option>
              <option value="48">Last 48 hours</option>
              <option value="168">Last 7 days</option>
              <option value="720">Last 30 days</option>
              <option value="9999">All time</option>
            </select>
            <button onclick="loadScanner()" style="background:transparent;border:1px solid var(--border2);color:var(--text3);border-radius:4px;padding:5px 10px;font-family:var(--mono);font-size:9px;cursor:pointer">↻ REFRESH</button>
          </div>
        </div>
        <!-- Decision filter chips -->
        <div style="padding:10px 14px;display:flex;gap:6px;flex-wrap:wrap;border-bottom:1px solid var(--border)">
          <button class="fchip active" id="scan-ALL"       onclick="setScanFilter('ALL')"       style="font-family:var(--mono);font-size:8px;padding:4px 10px;border-radius:3px;border:1px solid var(--border2);background:var(--surface2);color:var(--text2);cursor:pointer">ALL</button>
          <button class="fchip" id="scan-AUTO_POST"        onclick="setScanFilter('AUTO_POST')"  style="font-family:var(--mono);font-size:8px;padding:4px 10px;border-radius:3px;border:1px solid rgba(0,230,118,0.3);background:rgba(0,230,118,0.06);color:var(--green);cursor:pointer">✅ POSTED <span id="scanCntPost">—</span></button>
          <button class="fchip" id="scan-WATCHLIST"        onclick="setScanFilter('WATCHLIST')"  style="font-family:var(--mono);font-size:8px;padding:4px 10px;border-radius:3px;border:1px solid rgba(255,215,64,0.3);background:rgba(255,215,64,0.06);color:var(--gold);cursor:pointer">👁 WATCH <span id="scanCntWatch">—</span></button>
          <button class="fchip" id="scan-IGNORE"           onclick="setScanFilter('IGNORE')"     style="font-family:var(--mono);font-size:8px;padding:4px 10px;border-radius:3px;border:1px solid var(--border2);background:var(--surface2);color:var(--text3);cursor:pointer">⏭ IGNORE <span id="scanCntIgnore">—</span></button>
          <button class="fchip" id="scan-BLOCKLIST"        onclick="setScanFilter('BLOCKLIST')"  style="font-family:var(--mono);font-size:8px;padding:4px 10px;border-radius:3px;border:1px solid rgba(255,23,68,0.3);background:rgba(255,23,68,0.06);color:var(--red);cursor:pointer">🚫 BLOCK <span id="scanCntBlock">—</span></button>
          <button class="fchip" id="scan-RETEST"           onclick="setScanFilter('RETEST')"     style="font-family:var(--mono);font-size:8px;padding:4px 10px;border-radius:3px;border:1px solid rgba(24,255,255,0.3);background:rgba(24,255,255,0.06);color:var(--cyan);cursor:pointer">🔄 RETEST <span id="scanCntRetest">—</span></button>
          <span id="scannerTotal" style="font-family:var(--mono);font-size:8px;color:var(--text3);margin-left:auto;align-self:center">—</span>
        </div>
      </div>

      <!-- ══ SCANNER TABLE ══ -->
      <div class="card">
        <div style="overflow-x:auto">
          <table style="width:100%;border-collapse:collapse">
            <thead><tr style="border-bottom:2px solid var(--border)">
              <th style="font-family:var(--mono);font-size:8px;color:var(--text3);padding:9px 12px;text-align:left;letter-spacing:1px">TIME</th>
              <th style="font-family:var(--mono);font-size:8px;color:var(--text3);padding:9px 12px;text-align:left;letter-spacing:1px">TOKEN</th>
              <th style="font-family:var(--mono);font-size:8px;color:var(--text3);padding:9px 12px;text-align:center;letter-spacing:1px">DECISION</th>
              <th style="font-family:var(--mono);font-size:8px;color:var(--text3);padding:9px 12px;text-align:center;letter-spacing:1px">SCORE</th>
              <th style="font-family:var(--mono);font-size:8px;color:var(--text3);padding:9px 12px;text-align:center;letter-spacing:1px">MCAP</th>
              <th style="font-family:var(--mono);font-size:8px;color:var(--text3);padding:9px 12px;text-align:center;letter-spacing:1px">AGE</th>
              <th style="font-family:var(--mono);font-size:8px;color:var(--text3);padding:9px 12px;text-align:center;letter-spacing:1px">RISK</th>
              <th style="font-family:var(--mono);font-size:8px;color:var(--text3);padding:9px 12px;text-align:center;letter-spacing:1px">SETUP</th>
              <th style="font-family:var(--mono);font-size:8px;color:var(--text3);padding:9px 12px;text-align:center;letter-spacing:1px">CONTRACT ADDRESS</th>
              <th style="font-family:var(--mono);font-size:8px;color:var(--text3);padding:9px 12px;text-align:center;letter-spacing:1px">LINKS</th>
            </tr></thead>
            <tbody id="scannerBody">
              <tr><td colspan="10" style="text-align:center;padding:40px;font-family:var(--mono);font-size:10px;color:var(--text3)">Loading scanner data...</td></tr>
            </tbody>
          </table>
        </div>
        <div id="scannerPager" style="padding:10px 14px;border-top:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;font-family:var(--mono);font-size:9px;color:var(--text3)">
          <button onclick="scannerPage(-1)" style="background:transparent;border:1px solid var(--border2);color:var(--text3);border-radius:3px;padding:4px 10px;font-family:var(--mono);font-size:9px;cursor:pointer">← PREV</button>
          <span id="scannerPageInfo">Page 1</span>
          <button onclick="scannerPage(1)" style="background:transparent;border:1px solid var(--border2);color:var(--text3);border-radius:3px;padding:4px 10px;font-family:var(--mono);font-size:9px;cursor:pointer">NEXT →</button>
        </div>
      </div>

    </div><!-- /tab-scanner -->

    <div class="tab-panel" id="tab-system">
      <div class="g3" style="margin-bottom:14px">
        <div class="card">
          <div class="card-hdr"><div class="card-title"><span class="icon">⚙️</span>BOT CONFIGURATION</div><span style="font-family:var(--mono);font-size:9px;color:var(--text3)" id="sysModeName">—</span></div>
          <div class="card-body" style="padding:10px 14px">
            <div style="display:flex;flex-direction:column;gap:8px;font-family:var(--mono);font-size:10px">
              <div style="display:flex;justify-content:space-between;padding-bottom:7px;border-bottom:1px solid var(--border)"><span style="color:var(--text3)">Post Threshold</span><span style="color:var(--cyan)" id="cfgThreshold">—</span></div>
              <div style="display:flex;justify-content:space-between;padding-bottom:7px;border-bottom:1px solid var(--border)"><span style="color:var(--text3)">Max MCap</span><span style="color:var(--orange)">$150K</span></div>
              <div style="display:flex;justify-content:space-between;padding-bottom:7px;border-bottom:1px solid var(--border)"><span style="color:var(--text3)">Age Range</span><span style="color:var(--green)">0min–4h</span></div>
              <div style="display:flex;justify-content:space-between;padding-bottom:7px;border-bottom:1px solid var(--border)"><span style="color:var(--text3)">Score Floor</span><span style="color:var(--green)">38</span></div>
              <div style="display:flex;justify-content:space-between;padding-bottom:7px;border-bottom:1px solid var(--border)"><span style="color:var(--text3)">Stop Loss</span><span style="color:var(--red)">-25% from entry</span></div>
              <div style="display:flex;justify-content:space-between;padding-bottom:7px;border-bottom:1px solid var(--border)"><span style="color:var(--text3)">Take Profits</span><span style="color:var(--green)">2× · 5× · 10×</span></div>
              <div style="display:flex;justify-content:space-between"><span style="color:var(--text3)">Scan Interval</span><span id="cfgInterval">—</span></div>
            </div>
          </div>
        </div>
        <div class="card">
          <div class="card-hdr"><div class="card-title"><span class="icon">🔌</span>DATA SOURCE HEALTH</div></div>
          <div class="card-body" style="padding:10px;display:flex;flex-direction:column;gap:7px" id="sourceHealthList"><div class="spinner"><div class="spin-dot" style="background:var(--cyan)"></div><div class="spin-dot" style="background:var(--green)"></div><div class="spin-dot" style="background:var(--purple)"></div></div></div>
        </div>
        <div class="card">
          <div class="card-hdr"><div class="card-title"><span class="icon">🎮</span>MODE CONTROLS</div></div>
          <div class="card-body" style="padding:10px;display:flex;flex-direction:column;gap:8px" id="modeButtonList"><div class="spinner"><div class="spin-dot" style="background:var(--cyan)"></div><div class="spin-dot" style="background:var(--green)"></div><div class="spin-dot" style="background:var(--purple)"></div></div></div>
        </div>
      </div>
      <div class="card">
        <div class="card-hdr">
          <div class="card-title"><span class="icon">📟</span>SYSTEM LOG</div>
          <div style="display:flex;gap:8px">
            <select id="logLevelFilter" onchange="refreshLog()" style="background:var(--surface);border:1px solid var(--border2);color:var(--text3);padding:3px 8px;border-radius:3px;font-family:var(--mono);font-size:9px;cursor:pointer"><option value="">ALL</option><option value="INFO">INFO</option><option value="ERROR">ERROR</option><option value="WARN">WARN</option></select>
            <button onclick="refreshLog()" style="background:transparent;border:1px solid var(--border2);color:var(--text3);border-radius:3px;padding:3px 10px;font-family:var(--mono);font-size:9px;cursor:pointer">↻</button>
          </div>
        </div>
        <div class="card-body" style="padding:10px;max-height:400px;overflow-y:auto" id="systemLog"></div>
      </div>
    </div><!-- /system -->

  </main><!-- /main-content -->
</div><!-- /workspace -->

<!-- ═══════════════ STATUS BAR ═══════════════ -->
<div class="statusbar">
  <div class="sb-item"><div class="sb-dot" style="background:var(--green);box-shadow:0 0 4px var(--green)"></div>PULSE CALLER v8.0</div>
  <div class="sb-sep"></div>
  <div class="sb-item" id="sbMode">🚀 NEW_COINS</div>
  <div class="sb-sep"></div>
  <div class="sb-item" id="sbRegime">REGIME: —</div>
  <div class="sb-sep"></div>
  <div class="sb-item" id="sbEvals">EVALS: —</div>
  <div class="sb-right">
    <div class="sb-item" id="sbHelius" style="color:var(--text3)">HELIUS: —</div>
    <div class="sb-sep"></div>
    <div class="sb-item" id="sbTime">—</div>
  </div>
</div>

<!-- ═══════════════ AI AGENT CHAT PANEL ═══════════════ -->
<div class="chat-overlay" id="chatOverlay">
  <div class="chat-header">
    <div class="chat-title">
      <span style="font-size:16px">⚡</span>
      AI AGENT — PULSE CALLER
      <span style="font-size:8px;padding:2px 7px;border-radius:3px;background:rgba(224,64,251,0.2);border:1px solid rgba(224,64,251,0.4);letter-spacing:1px">ANALYSIS MODE</span>
    </div>
    <button class="chat-close" onclick="toggleChat()">✕</button>
  </div>
  <div class="chat-quick-cmds">
    <button class="qcmd" onclick="sendAgentMsg('Why did we make our last call?')">Last call thesis</button>
    <button class="qcmd" onclick="sendAgentMsg('What are our top loss patterns?')">Loss patterns</button>
    <button class="qcmd" onclick="sendAgentMsg('What is the current market regime?')">Market regime</button>
    <button class="qcmd" onclick="sendAgentMsg('Which wallets appear before our winners?')">Smart wallets</button>
    <button class="qcmd" onclick="sendAgentMsg('What score bands are winning?')">Score calibration</button>
    <button class="qcmd" onclick="sendAgentMsg('What tokens did we miss that pumped today?')">Missed winners</button>
    <button class="qcmd" onclick="sendAgentMsg('What config changes would help us find more $10K-$25K gems?')">Tune for gems</button>
    <button class="qcmd" onclick="sendAgentMsg('Summarize bot performance this week')">Weekly summary</button>
  </div>
  <div class="chat-messages" id="agentMessages">
    <div class="chat-msg">
      <div class="chat-avatar avatar-bot">🧠</div>
      <div class="chat-bubble bubble-bot">Pulse Caller AI online. I can analyze calls, explain scores, identify patterns, review losses, and help tune the bot. What do you want to know?</div>
    </div>
  </div>
  <div class="chat-input-row">
    <textarea class="chat-input" id="agentInput" placeholder="Ask about calls, losses, wallets, regime..." rows="1" onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendAgentMsg();}"></textarea>
    <button class="chat-send" id="agentSendBtn" onclick="sendAgentMsg()">SEND</button>
  </div>
</div>

<!-- CANDIDATE MODAL -->
<div class="modal-bg" id="candidateModal">
  <div class="modal-box" style="max-width:900px">
    <div class="modal-hdr">
      <div><div style="font-family:var(--mono);font-size:16px;font-weight:700;color:var(--text1)" id="modalTokenName">—</div><div style="font-family:var(--mono);font-size:9px;color:var(--text3);margin-top:3px" id="modalCA">—</div></div>
      <div style="display:flex;gap:10px;align-items:center"><div id="modalDecisionBadge"></div><button class="modal-close" onclick="closeModal()">✕</button></div>
    </div>
    <div class="modal-body" id="modalBody"><div class="spinner"><div class="spin-dot" style="background:var(--cyan)"></div><div class="spin-dot" style="background:var(--green)"></div><div class="spin-dot" style="background:var(--purple)"></div></div></div>
  </div>
</div>

<!-- PROMOTED MODAL -->
<div class="modal-bg" id="promotedModal">
  <div class="modal-box" style="max-width:700px">
    <div class="modal-hdr">
      <div><div style="font-family:var(--mono);font-size:16px;font-weight:700;color:var(--green)" id="pmTokenName">—</div><div style="font-family:var(--mono);font-size:9px;color:var(--text3);margin-top:3px" id="pmCA">—</div></div>
      <div style="display:flex;gap:10px;align-items:center"><span style="font-family:var(--mono);font-size:9px;padding:3px 10px;border-radius:3px;background:rgba(0,230,118,0.1);border:1px solid rgba(0,230,118,0.3);color:var(--green)">🚀 PROMOTED</span><button class="modal-close" onclick="closePromotedModal()">✕</button></div>
    </div>
    <div class="modal-body" id="pmBody"></div>
  </div>


<script>

// ═══════════════════════════════════════════════════════════
//  PULSE CALLER v8.0 — SUPREME DASHBOARD JS
// ═══════════════════════════════════════════════════════════

const API='';
let refreshTimer=null,currentTab='overview',agentHistory=[],
    allCandidatesData=[],auditCurrentFilter='all',auditSearchTerm='',
    sidebarFilter_='all',_promotedAll=[];

// ── UTILITIES ─────────────────────────────────────────────
const fmt=(v,p='$',d=0)=>{if(v==null||isNaN(+v))return'—';const n=+v;if(n>=1e9)return`${p}${(n/1e9).toFixed(2)}B`;if(n>=1e6)return`${p}${(n/1e6).toFixed(2)}M`;if(n>=1e3)return`${p}${(n/1e3).toFixed(1)}K`;return`${p}${n.toFixed(d)}`;};
const fmtPct=v=>{if(v==null||isNaN(+v))return'—';const n=+v;const c=n>0?'#00e676':n<0?'#ff1744':'#8899bb';return`<span style="color:${c}">${n>0?'+':''}${n.toFixed(2)}%</span>`;};
const fmtTime=v=>{if(!v)return'—';const d=new Date(v);if(isNaN(d))return v;const mo=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];return`${mo[d.getUTCMonth()]} ${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')} UTC`;};
const timeAgo=ts=>{if(!ts)return'—';const s=Math.floor((Date.now()-new Date(ts).getTime())/1000);if(s<60)return s+'s ago';if(s<3600)return Math.floor(s/60)+'m ago';if(s<86400)return Math.floor(s/3600)+'h ago';return Math.floor(s/86400)+'d ago';};
const shortAddr=a=>a?`${a.slice(0,6)}…${a.slice(-4)}`:'—';
const esc=s=>{if(!s)return'';return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');};
const scoreCol=s=>s>=80?'#ffd740':s>=65?'#00e676':s>=50?'#18ffff':s>=38?'#ff6d00':'#ff1744';
const sltp=m=>{if(!m||m<=0)return null;return{sl:m*.75,tp1:m*2,tp2:m*5,tp3:m*10};};
const isBrandNew=h=>h!=null&&h<(5/60);
function setText(id,v){const e=document.getElementById(id);if(e)e.innerHTML=v??'—';}
function setWidth(id,pct){const e=document.getElementById(id);if(e)e.style.width=Math.min(pct,100)+'%';}
function copyCA(addr){navigator.clipboard?.writeText(addr);const el=event?.target;if(el){const orig=el.textContent;el.textContent='✓';setTimeout(()=>el.textContent=orig,1500);}}
const decColor=d=>({AUTO_POST:'#00e676',WATCHLIST:'#ffd740',RETEST:'#ff6d00',IGNORE:'#3d4f70',BLOCKLIST:'#ff1744',HOLD_FOR_REVIEW:'#e040fb'}[d]||'#8899bb');
const stageCol=s=>({LAUNCH:'#ff1744',EARLY:'#ff6d00',PRE_BOND:'#ff6d00',DEVELOPING:'#ffd740',ESTABLISHED:'#18ffff',MATURE:'#8899bb',MIGRATED:'#8899bb'}[s]||'#8899bb');
const outcomeBadge=o=>o==='WIN'?`<span class="outcome-win">🏆 WIN</span>`:o==='LOSS'?`<span class="outcome-loss">💀 LOSS</span>`:`<span class="outcome-pend">⏳ PENDING</span>`;
const gradeColor=g=>({ELITE:'#18ffff',CLEAN:'#00e676',AVERAGE:'#8899bb',MIXED:'#ff6d00',DIRTY:'#ff1744',UNVERIFIED:'#e040fb'}[g]||'#8899bb');

// ── API FETCH ─────────────────────────────────────────────
async function apiFetch(path){
  try{const r=await fetch(API+path,{signal:AbortSignal.timeout(15000)});if(!r.ok)throw new Error(r.status);return await r.json();}
  catch(e){console.warn('API',path,e.message);return null;}
}

// ── CANDIDATE NORMALIZE ───────────────────────────────────
function normalizeCandidate(c){
  if(!c)return c;
  return{
    id:c.id,token:c.token??c.symbol,tokenName:c.tokenName??c.token_name??c.name,
    contractAddress:c.contractAddress??c.contract_address,chain:c.chain??'solana',dex:c.dex,
    compositeScore:c.compositeScore??c.composite_score??c.score,
    structureGrade:c.structureGrade??c.structure_grade,
    setupType:c.setupType??c.setup_type??c.claudeSetupType??c.claude_setup_type,
    stage:c.stage,candidateType:c.candidateType??c.candidate_type,
    finalDecision:c.finalDecision??c.final_decision,
    claudeRisk:c.claudeRisk??c.claude_risk??c.risk,
    claudeVerdict:c.claudeVerdict??c.claude_verdict,
    openaiDecision:c.openaiDecision??c.openai_decision,
    openaiConviction:c.openaiConviction??c.openai_conviction,
    openaiVerdict:c.openaiVerdict??c.openai_verdict,
    walletVerdict:c.walletVerdict??c.wallet_verdict,
    smartMoneyScore:c.smartMoneyScore??c.smart_money_score,
    deployerVerdict:c.deployerVerdict??c.deployer_verdict,
    deployerRiskScore:c.deployerRiskScore??c.deployer_risk_score,
    trapSeverity:c.trapSeverity??c.trap_severity,
    dynamicThreshold:c.dynamicThreshold??c.dynamic_threshold,
    priceUsd:c.priceUsd??c.price_usd,
    marketCap:c.marketCap??c.market_cap,
    liquidity:c.liquidity,volume24h:c.volume24h??c.volume_24h,volume1h:c.volume1h??c.volume_1h,
    priceChange5m:c.priceChange5m??c.price_change_5m,
    priceChange1h:c.priceChange1h??c.price_change_1h,
    priceChange6h:c.priceChange6h??c.price_change_6h,
    priceChange24h:c.priceChange24h??c.price_change_24h,
    buys1h:c.buys1h??c.buys_1h,sells1h:c.sells1h??c.sells_1h,
    buySellRatio1h:c.buySellRatio1h??c.buy_sell_ratio_1h,
    volumeVelocity:c.volumeVelocity??c.volume_velocity,
    pairAgeHours:c.pairAgeHours??c.pair_age_hours,
    holders:c.holders,holderGrowth24h:c.holderGrowth24h??c.holder_growth_24h,
    top10HolderPct:c.top10HolderPct??c.top10_holder_pct??c.top_10_holder_pct,
    devWalletPct:c.devWalletPct??c.dev_wallet_pct,
    insiderWalletPct:c.insiderWalletPct??c.insider_wallet_pct,
    sniperWalletCount:c.sniperWalletCount??c.sniper_wallet_count,
    bundleRisk:c.bundleRisk??c.bundle_risk,
    bubbleMapRisk:c.bubbleMapRisk??c.bubble_map_risk,
    mintAuthority:c.mintAuthority??c.mint_authority,
    freezeAuthority:c.freezeAuthority??c.freeze_authority,
    lpLocked:c.lpLocked??c.lp_locked,
    launchQualityScore:c.launchQualityScore??c.launch_quality_score,
    launchUniqueBuyerRatio:c.launchUniqueBuyerRatio??c.launch_unique_buyer_ratio,
    bondingCurvePct:c.bondingCurvePct??c.bonding_curve_pct,
    bondingCurveAcceleration:c.bondingCurveAcceleration??c.bonding_curve_accel,
    livestream:c.livestream,
    website:c.website,twitter:c.twitter,telegram:c.telegram,
    subScores:(()=>{const ss=c.subScores??c.sub_scores;if(!ss)return{};if(typeof ss==='object')return ss;try{return JSON.parse(ss);}catch{return{};}})(),
    birdeyeOk:c.birdeyeOk??c.birdeye_ok,
    heliusOk:c.heliusOk??c.helius_ok,
    bubblemapOk:c.bubblemapOk??c.bubblemap_ok,
    notes:Array.isArray(c.notes)?c.notes:[],
    buyVelocity:c.buyVelocity??c.buy_velocity,
    walletIntelScore:c.walletIntelScore??c.wallet_intel_score,
    walletIntel:(()=>{const wi=c.walletIntel??c.wallet_intel;if(!wi)return{};if(typeof wi==='object')return wi;try{return JSON.parse(wi);}catch{return{};}})(),
    narrativeTags:(()=>{const nt=c.narrativeTags??c.narrative_tags;if(!nt)return[];if(Array.isArray(nt))return nt;try{return JSON.parse(nt);}catch{return[];}})(),
    coordinationIntensity:c.coordinationIntensity??c.coordination_intensity,
    momentumGrade:c.momentumGrade??c.momentum_grade,
    claudeSetupType:c.claudeSetupType??c.claude_setup_type??c.setupType??c.setup_type,
    // v5: scoring detail fields
    signals:(()=>{const ss=c.signals??c.score_signals;if(!ss)return{};if(typeof ss==='object'&&!Array.isArray(ss))return ss;try{return JSON.parse(ss);}catch{return{};}})(),
    penalties:(()=>{const pp=c.penalties??c.score_penalties;if(!pp)return{};if(typeof pp==='object'&&!Array.isArray(pp))return pp;try{return JSON.parse(pp);}catch{return{};}})(),
    trapDetector:(()=>{const td=c.trapDetector;if(td&&typeof td==='object')return td;return{severity:c.trapSeverity??c.trap_severity,triggered:!!(c.trapTriggered??c.trap_triggered),confidencePenalty:c.trapConfidencePenalty??c.trap_confidence_penalty??0};})(),
    stealthDetected:!!(c.stealthDetected??c.stealth_detected),
    stealthBonus:c.stealthBonus??c.stealth_bonus??0,
    openaiAgreesWithClaude:c.openaiAgreesWithClaude??c.openai_agrees_with_claude,
    missingDataImpact:c.missingDataImpact??c.missing_data_impact,
    replyCount:c.replyCount??c.reply_count,
    dexPaid:c.dexPaid??c.dex_paid,
    boostStatus:c.boostStatus??c.boost_status,
    insiderWalletPct:c.insiderWalletPct??c.insider_wallet_pct,
    quickScore:c.quickScore??c.quick_score,
  };
}

// ── TAB NAVIGATION ────────────────────────────────────────
function switchTab(name){
  document.querySelectorAll('.htab').forEach(t=>t.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(p=>p.classList.remove('active'));
  const panel=document.getElementById('tab-'+name);
  if(panel)panel.classList.add('active');
  document.querySelectorAll('.htab').forEach(t=>{
    const oc=t.getAttribute('onclick')||'';
    if(oc.includes("'"+name+"'"))t.classList.add('active');
  });
  currentTab=name;
  refreshTabData(name);

  if(name==='smart')loadSmartMoneyTab();
  if(name==='archive')loadArchive();
  if(name==='scanner')loadScanner();
}

function refreshTabData(name){
  switch(name){
    case 'overview':   loadOverview();   break;
    case 'promoted':   loadPromotedFull(); break;
    case 'calls':      loadCalls();      break;
    case 'audit':      loadAudit();      break;
    case 'analytics':  loadAnalytics();  break;
    case 'ai':         loadAI();         break;
    case 'smart':      loadSmartMoneyTab(); break;
    case 'system':     loadSystem();     break;
  }
}

// ── STATUS BAR CLOCK ─────────────────────────────────────
function updateClock(){
  const now=new Date();
  setText('sbTime',`${String(now.getUTCHours()).padStart(2,'0')}:${String(now.getUTCMinutes()).padStart(2,'0')} UTC`);
}
setInterval(updateClock,1000);updateClock();

// ── PROMOTED SIDEBAR (ALWAYS VISIBLE, NEVER CLEARED) ─────
let _sidebarLoaded=false;
async function loadPromotedSidebar(){
  const data=await apiFetch('/api/scanner-feed?limit=300');
  if(!data)return;
  const rows=data.rows??[];
  _promotedAll=rows.filter(r=>r.filter_action==='PROMOTE').sort((a,b)=>(b.quick_score??0)-(a.quick_score??0));
  renderSidebar();
  setText('sidebarCount',_promotedAll.length+' tokens');
  setText('tb-promoted-badge',_promotedAll.length);
  _sidebarLoaded=true;
}

function sidebarFilter(btn,f){
  document.querySelectorAll('.sfilter').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  sidebarFilter_=f;
  renderSidebar();
}

function renderSidebar(){
  const el=document.getElementById('promotedSidebar');
  if(!el)return;
  let coins=[..._promotedAll];
  if(sidebarFilter_==='prebond') coins=coins.filter(c=>c.stage==='PRE_BOND'||c.stage==='BONDING');
  if(sidebarFilter_==='new') coins=coins.filter(c=>isBrandNew(c.pair_age_hours));
  if(sidebarFilter_==='hot') coins=coins.filter(c=>(c.quick_score??0)>=70);
  if(!coins.length){el.innerHTML='<div class="sidebar-empty"><div class="icon">📡</div>No promoted tokens</div>';return;}
  el.innerHTML=coins.slice(0,30).map(r=>buildSidebarCoin(r)).join('');
}

function buildSidebarCoin(r){
  const qs=r.quick_score??0;
  const col=qs>=80?'var(--gold)':qs>=65?'var(--green)':qs>=50?'var(--cyan)':'var(--orange)';
  const p5m=r.price_change_5m,p1h=r.price_change_1h;
  const p5mC=p5m>0?'var(--green)':p5m<0?'var(--red)':'var(--text3)';
  const p1hC=p1h>0?'var(--green)':p1h<0?'var(--red)':'var(--text3)';
  const age=r.pair_age_hours!=null?r.pair_age_hours.toFixed(1)+'h':'—';
  const ago=timeAgo(r.scanned_at);
  const lvls=sltp(r.market_cap);
  const safeR=JSON.stringify(r).replace(/"/g,'&quot;');
  // Check if DEX Screener paid
  const hasSocials = r.website||r.twitter||r.telegram;

  return`<div class="pcoin" style="--accent-color:${col}" onclick="openPromotedModal(${safeR})">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
      <img src="https://dd.dexscreener.com/ds-data/tokens/solana/${r.contract_address||''}.png"
           onerror="this.style.display='none'"
           style="width:32px;height:32px;border-radius:50%;border:1px solid rgba(255,255,255,0.1);object-fit:cover;flex-shrink:0"
           alt="">
      <div style="flex:1;min-width:0">
        ${isBrandNew(r.pair_age_hours)?'<span class="new-badge">⚡ BRAND NEW</span>':''}
      </div>
    </div>
    <div class="pcoin-top">
      <div>
        <div class="pcoin-token">$${esc(r.token||'?')}</div>
        <div class="pcoin-name">${esc(r.token_name||r.tokenName||'')}</div>
      </div>
      <div style="text-align:right">
        <div class="pcoin-score" style="color:${col}">${qs}</div>
        <div style="font-family:var(--mono);font-size:7px;color:var(--text3)">SCORE</div>
      </div>
    </div>
    <div class="pcoin-meta">
      <span class="pmeta-chip" style="border-color:${stageCol(r.stage)}44;color:${stageCol(r.stage)}">${r.stage||'?'}</span>
      <span class="pmeta-chip" style="border-color:rgba(255,109,0,0.3);color:var(--orange)">MCap: ${fmt(r.market_cap,'$')}</span>
      <span class="pmeta-chip" style="border-color:var(--border);color:var(--text3)">⏱ ${age}</span>
    </div>
    <div class="pcoin-row">
      <div class="pcoin-stat"><div class="pcoin-stat-label">5M</div><div class="pcoin-stat-val" style="color:${p5mC}">${p5m!=null?(p5m>0?'+':'')+p5m.toFixed(1)+'%':'—'}</div></div>
      <div class="pcoin-stat"><div class="pcoin-stat-label">1H</div><div class="pcoin-stat-val" style="color:${p1hC}">${p1h!=null?(p1h>0?'+':'')+p1h.toFixed(1)+'%':'—'}</div></div>
      <div class="pcoin-stat"><div class="pcoin-stat-label">BUYS</div><div class="pcoin-stat-val" style="color:var(--green)">${r.buys_1h??'—'}</div></div>
    </div>
    <div style="display:flex;gap:4px;margin-top:5px;flex-wrap:wrap">
      ${r.bundle_risk&&r.bundle_risk!=='NONE'?`<span style="font-family:var(--mono);font-size:7px;padding:1px 5px;border-radius:2px;background:rgba(255,109,0,0.15);border:1px solid rgba(255,109,0,0.3);color:var(--orange)">BUNDLE:${r.bundle_risk}</span>`:''}
      ${(r.sniper_wallet_count||0)>0?`<span style="font-family:var(--mono);font-size:7px;padding:1px 5px;border-radius:2px;background:rgba(255,215,64,0.1);border:1px solid rgba(255,215,64,0.2);color:var(--gold)">${r.sniper_wallet_count} SNIPERS</span>`:''}
      ${r.volume_velocity>0.3?`<span style="font-family:var(--mono);font-size:7px;padding:1px 5px;border-radius:2px;background:rgba(0,230,118,0.08);border:1px solid rgba(0,230,118,0.2);color:var(--green)">VEL:${r.volume_velocity?.toFixed(2)}</span>`:''}
      <a href="https://dexscreener.com/solana/${r.contract_address||''}" target="_blank" onclick="event.stopPropagation()" style="font-family:var(--mono);font-size:7px;padding:1px 5px;border-radius:2px;background:rgba(0,230,118,0.08);border:1px solid rgba(0,230,118,0.15);color:var(--green);text-decoration:none">DSC↗</a>
      <a href="https://pump.fun/${r.contract_address||''}" target="_blank" onclick="event.stopPropagation()" style="font-family:var(--mono);font-size:7px;padding:1px 5px;border-radius:2px;background:rgba(255,109,0,0.08);border:1px solid rgba(255,109,0,0.15);color:var(--orange);text-decoration:none">PF↗</a>
    </div>
    ${lvls?`<div class="pcoin-sltp">
      <div class="sltp-cell sl-cell"><span class="sltp-label">SL -25%</span><span class="sltp-val" style="color:var(--red)">${fmt(lvls.sl,'$')}</span></div>
      <div class="sltp-cell tp1-cell"><span class="sltp-label">TP1 2×</span><span class="sltp-val" style="color:var(--cyan)">${fmt(lvls.tp1,'$')}</span></div>
      <div class="sltp-cell tp2-cell"><span class="sltp-label">TP2 5×</span><span class="sltp-val" style="color:var(--gold)">${fmt(lvls.tp2,'$')}</span></div>
      <div class="sltp-cell tp3-cell"><span class="sltp-label">TP3 10×</span><span class="sltp-val" style="color:var(--green)">${fmt(lvls.tp3,'$')}</span></div>
    </div>`:''}
    <div class="pcoin-footer">
      <span class="pcoin-time">${ago}</span>
      <div class="pcoin-links">
        ${r.website?`<a class="pcoin-link" href="${r.website}" target="_blank" onclick="event.stopPropagation()">🌐</a>`:''}
        ${r.twitter?`<a class="pcoin-link" href="${r.twitter}" target="_blank" onclick="event.stopPropagation()">𝕏</a>`:''}
        ${r.telegram?`<a class="pcoin-link" href="${r.telegram}" target="_blank" onclick="event.stopPropagation()">✈</a>`:''}
      </div>
    </div>
  </div>`;
}

// ── OVERVIEW ──────────────────────────────────────────────
async function loadOverview(){
  const [stats,ai,memory,v8]=await Promise.all([
    apiFetch('/api/stats'),
    apiFetch('/api/openai/status'),
    apiFetch('/api/ai/memory'),
    apiFetch('/api/v8/dashboard'),
  ]);
  if(stats)renderOverviewStats(stats,memory,v8);
  if(v8)renderV8Row(v8);
  const calls=await apiFetch('/api/calls?limit=6');
  if(calls)renderCallCards('recentCallsCards',calls.rows||calls.calls||[],true);
}

function renderOverviewStats(stats,memory,v8){
  const s=stats.stats||{},q=stats.queueStats||{},r=stats.regime||{},m=stats.mode||{},c=stats.config||{},ai=stats.aiLearning||{};
  // Header chips
  const modeEl=document.getElementById('modeChip');
  if(modeEl)modeEl.textContent=`${m.emoji||'🚀'} ${m.name||'NEW_COINS'}`;
  const regEl=document.getElementById('regimeChip');
  if(regEl){
    const market=r.market||'—';
    const col=market.includes('BULL')?'#00e676':market.includes('BEAR')?'#ff1744':'#ffd740';
    regEl.textContent=market;regEl.style.color=col;
  }
  // Status bar
  setText('sbMode',`${m.emoji||'🚀'} ${m.name||'?'}`);
  setText('sbRegime',`REGIME: ${r.market||'—'}`);
  setText('sbEvals',`EVALS: ${s.totalEvaluated||0}`);
  // Stats
  setText('statEvaluated',s.totalEvaluated||0);
  setText('statEval24h',`24h: ${s.last24hEvaluated||0}`);
  setText('statWinRate',s.winRate||'—');
  setText('statWL',`${s.winCount||0}W / ${s.lossCount||0}L`);
  const wr=parseFloat(s.winRate)||0;
  setWidth('aiWinBar',wr);
  setText('aiWinRatePct',s.winRate||'—');
  // AI
  setText('aiTotalCalls',ai.totalCalls||s.totalPosted||0);
  setText('aiResolved',ai.resolvedCalls||0);
  setText('aiFtStatus',ai.ftModelActive?'🤖 FT ON':'🧠 IN-CTX');
  setText('qWatchlist',q.watchlist?.total||0);
  setText('qRetest',q.retest?.total||0);
  setText('qPosted',s.totalPosted||0);
  setText('qInterval',c.scanIntervalMs?(c.scanIntervalMs/1000)+'s':'—');
  setText('cfgThreshold',c.postThreshold!=null?c.postThreshold+'/100':'38/100');
  setText('cfgInterval',c.scanIntervalMs?(c.scanIntervalMs/1000)+'s':'—');
  setText('sysModeName',m.name||'—');
  // Regime card
  renderRegime(r);
}

function renderRegime(r){
  if(!r)return;
  const market=r.market||'UNKNOWN';
  const dc=market.includes('BULL')?'#00e676':market.includes('BEAR')?'#ff1744':'#ffd740';
  const el=document.getElementById('regimeDisplay');
  if(el)el.innerHTML=`<div class="regime-dot-big" style="color:${dc};background:${dc}"></div><span style="color:${dc}">${market}</span>`;
  setText('regimeConf',r.confidence?`${r.confidence} confidence`:'—');
  setText('regimeActivity',r.solanaActivity||'—');
  setText('regimeNarrative',r.narrativeTrend||'—');
  setText('regimeLaunches',r.recentLaunchHealth||'—');
  setText('regimeAge',r.ageMinutes!=null?`${r.ageMinutes}m ago`:'—');
  const adjEl=document.getElementById('regimeAdj');
  if(adjEl)adjEl.innerHTML=Object.entries(r.scoreAdjustments||{}).map(([k,v])=>{
    const col=v>0?'var(--green)':v<0?'var(--red)':'var(--text3)';
    return`<div style="display:flex;justify-content:space-between"><span style="color:var(--text3)">${k.replace(/([A-Z])/g,' $1').trim()}</span><span style="color:${col}">${v>=0?'+':''}${v}</span></div>`;
  }).join('');
}

function renderV8Row(v8){
  if(!v8?.ok)return;
  const{detection={},intelligence={},performance={},aiStatus={}}=v8;
  // Helius chip
  const hc=document.getElementById('heliusChip');
  if(hc){hc.style.display='flex';if(!detection.heliusConnected){hc.className='status-chip chip-orange';hc.innerHTML='<div class="pulse pulse-o"></div>90S POLLING';}}
  // v8 row
  setText('v8HeliusStatus',detection.heliusConnected?'⚡ ~3s':'90s poll');
  setText('v8WalletDbSize',(intelligence.walletDbSize||0).toLocaleString());
  setText('v8DbFresh',intelligence.walletDbStale?'⚠ stale':'✓ fresh');
  setText('v8Missed',performance.missedWinnersDetected||0);
  setText('v8OpenAI',intelligence.openaiConfigured?'✅ GPT-4o':'— not set');
  setText('sbHelius',detection.heliusConnected?'HELIUS: ⚡':'HELIUS: polling');
  setText('tb-calls-badge',performance.totalCalls||0);
  setText('aiWrCount',performance.winRate||'—');
  setText('aiWLCount',`${performance.wins||0}W / ${performance.losses||0}L`);
  setText('aiEvalsCount',performance.totalEvaluations||0);
  setText('aiCallsCount',performance.totalCalls||0);
  setText('aiSweetSpot',aiStatus.sweetSpotTarget||'$10K–$25K');
}

// ── CALL CARDS ────────────────────────────────────────────
function renderCallCards(containerId,rows,compact=false){
  const el=document.getElementById(containerId);if(!el)return;
  if(!rows?.length){
    el.innerHTML='<div class="empty-state"><div class="empty-icon">📭</div><div>No calls posted yet</div><div class="empty-hint">When the bot finds a quality token, it posts to Telegram and appears here with full thesis and trade levels.</div></div>';
    return;
  }
  // Update badges
  setText('tb-calls-badge',rows.length);
  el.innerHTML=rows.map(c=>{
    const score=c.score_at_call||c.score||0;
    const mcap=c.market_cap_at_call||c.marketCap;
    const lvls=sltp(mcap);
    const oc=c.outcome==='WIN'?'win':c.outcome==='LOSS'?'loss':'pending';
    const verdict=c.claudeVerdict||c.claude_verdict||c.verdict||'';
    const shortV=verdict?verdict.slice(0,110)+(verdict.length>110?'…':''):'No AI thesis recorded.';
    const oaiD=c.openaiDecision||c.openai_decision;
    const oaiC=c.openaiConviction||c.openai_conviction;
    const wV=c.walletVerdict||c.wallet_verdict;
    const wCol=wV==='BULLISH'||wV==='VERY_BULLISH'?'var(--green)':wV==='MANIPULATED'||wV==='SUSPICIOUS'?'var(--red)':'var(--text3)';
    const signals=[];
    if((c.buySellRatio1h||c.buy_sell_ratio_1h)>0.6)signals.push({t:'Strong buy pressure',cls:'bull-tag'});
    if(c.lp_locked===1||c.lpLocked===1)signals.push({t:'LP locked',cls:'bull-tag'});
    if(c.mint_authority===0||c.mintAuthority===0)signals.push({t:'Mint revoked',cls:'bull-tag'});
    if((c.sniper_wallet_count||c.sniperWalletCount)>10)signals.push({t:`${c.sniper_wallet_count||c.sniperWalletCount} snipers`,cls:'bear-tag'});
    if((c.dev_wallet_pct||c.devWalletPct)>10)signals.push({t:`Dev ${(c.dev_wallet_pct||c.devWalletPct)?.toFixed(1)}%`,cls:'bear-tag'});
    if(oaiD)signals.push({t:`🤖 ${oaiD} ${oaiC?oaiC+'%':''}`,cls:'ai-tag'});
    if(wV&&wV!=='NEUTRAL')signals.push({t:`👥 ${wV}`,cls:wV==='BULLISH'||wV==='VERY_BULLISH'?'bull-tag':'bear-tag'});
    return`<div class="call-card ${oc}" onclick="openCandidate('${c.contract_address||c.contractAddress||''}')">
      <div class="call-header">
        <div>
          <div class="call-token">$${esc(c.token||'?')}</div>
          <div class="call-meta">${fmtTime(c.called_at)} · ${c.stage||'?'} · MCap: ${fmt(mcap,'$')}</div>
        </div>
        <div class="call-badges">
          <div class="call-score-badge" style="background:${scoreCol(score)}22;color:${scoreCol(score)};border:1px solid ${scoreCol(score)}44">${score}</div>
          ${outcomeBadge(c.outcome)}
        </div>
      </div>
      <div class="call-body">
        <div class="call-verdict">"${esc(shortV)}"</div>
        ${signals.length?`<div class="call-signals">${signals.slice(0,6).map(s=>`<span class="signal-tag ${s.cls}">${esc(s.t)}</span>`).join('')}</div>`:''}
        ${lvls?`<div class="call-levels">
          <div class="level-box sl-cell"><span class="level-lbl">SL -25%</span><span class="level-val" style="color:var(--red)">${fmt(lvls.sl,'$')}</span></div>
          <div class="level-box tp1-cell"><span class="level-lbl">TP1 2×</span><span class="level-val" style="color:var(--cyan)">${fmt(lvls.tp1,'$')}</span></div>
          <div class="level-box tp2-cell"><span class="level-lbl">TP2 5×</span><span class="level-val" style="color:var(--gold)">${fmt(lvls.tp2,'$')}</span></div>
          <div class="level-box tp3-cell"><span class="level-lbl">TP3 10×</span><span class="level-val" style="color:var(--green)">${fmt(lvls.tp3,'$')}</span></div>
        </div>`:''}
      </div>
    </div>`;
  }).join('');
}

// ── PROMOTED FULL TAB ─────────────────────────────────────
async function loadPromotedFull(){
  const data=await apiFetch('/api/scanner-feed?limit=300');
  if(!data)return;
  const rows=data.rows??[],counts=data.actionCounts??[];
  const cm={};for(const c of counts)cm[c.filter_action]=c.n;
  const total=counts.reduce((a,c)=>a+c.n,0);
  setText('feedTotal',total);
  setText('feedPromoted',cm.PROMOTE??0);
  setText('feedSkipped',cm.SKIP??0);
  setText('feedDeduped',cm.DEDUPED??0);
  const promoted=rows.filter(r=>r.filter_action==='PROMOTE').sort((a,b)=>(b.quick_score??0)-(a.quick_score??0));
  _promotedAll=promoted;renderSidebar();
  setText('sidebarCount',promoted.length+' tokens');
  setText('tb-promoted-badge',promoted.length);
  setText('promotedHistoryCount',`${promoted.length} records`);
  // Card grid in Promoted tab
  const grid=document.getElementById('promotedTabGrid');
  if(grid){
    if(!promoted.length){grid.innerHTML='<div class="empty-state"><div class="empty-icon">🚀</div><div>No promoted tokens yet</div><div class="empty-hint">Tokens passing quick score ≥40 and MCap ≤$150K appear here.</div></div>';return;}
    grid.innerHTML=promoted.map(r=>buildSidebarCoin(r)).join('');
  }
  // Table
  const tbody=document.getElementById('promotedHistoryBody');
  if(tbody){
    tbody.innerHTML=promoted.map(r=>{
      const qs=r.quick_score;const qsCol=qs>=80?'#ffd740':qs>=65?'#00e676':qs>=50?'#18ffff':'#ff6d00';
      const ago=timeAgo(r.scanned_at);
      const safeR=JSON.stringify(r).replace(/"/g,'&quot;');
      const links=[r.website?`<a href="${r.website}" target="_blank" style="color:var(--cyan);text-decoration:none">🌐</a>`:'',r.twitter?`<a href="${r.twitter}" target="_blank" style="color:var(--cyan);text-decoration:none">𝕏</a>`:'',r.telegram?`<a href="${r.telegram}" target="_blank" style="color:var(--cyan);text-decoration:none">✈</a>`:''].filter(Boolean).join(' ');
      return`<tr onclick="openPromotedModal(${safeR})" style="cursor:pointer">
        <td><div style="display:flex;align-items:center;gap:8px"><div style="width:26px;height:26px;border-radius:4px;background:${qsCol}22;border:1px solid ${qsCol}44;display:flex;align-items:center;justify-content:center;font-family:var(--mono);font-size:9px;font-weight:700;color:${qsCol}">${(r.token||'?').slice(0,2).toUpperCase()}</div><div><div style="font-family:var(--mono);font-size:11px;font-weight:700;color:${qsCol}">$${esc(r.token||'?')}</div><div style="font-family:var(--mono);font-size:8px;color:var(--text3)">${shortAddr(r.contract_address)}</div></div></div></td>
        <td>${isBrandNew(r.pair_age_hours)?'<span class="new-badge">⚡</span>':'—'}</td>
        <td style="font-family:var(--mono);font-size:9px;color:var(--text3)">${ago}</td>
        <td style="font-family:var(--mono);font-size:9px;color:${stageCol(r.stage)}">${r.stage||'—'}</td>
        <td style="font-family:var(--mono);font-size:9px;color:${(r.bonding_curve_pct||0)<85?'var(--green)':'var(--orange)'}">${r.bonding_curve_pct!=null?r.bonding_curve_pct.toFixed(1)+'%':'—'}</td>
        <td style="font-family:var(--mono)">${fmt(r.market_cap,'$')}</td>
        <td style="font-family:var(--mono)">${fmt(r.liquidity,'$')}</td>
        <td>${fmtPct(r.price_change_5m)}</td>
        <td>${fmtPct(r.price_change_1h)}</td>
        <td style="font-family:var(--mono);color:var(--green)">${r.buys_1h??'—'}</td>
        <td style="font-family:var(--mono);color:${(r.buy_ratio_1h??0)>0.6?'var(--green)':'var(--text3)'}">${r.buy_ratio_1h!=null?(r.buy_ratio_1h*100).toFixed(0)+'%':'—'}</td>
        <td style="font-family:var(--mono);color:${(r.volume_velocity??0)>0.3?'var(--cyan)':'var(--text3)'}">${r.volume_velocity!=null?r.volume_velocity.toFixed(2):'—'}</td>
        <td><span style="font-family:var(--mono);font-size:13px;font-weight:700;color:${qsCol}">${qs??'—'}</span></td>
        <td style="font-family:var(--mono);font-size:9px;color:var(--text3);max-width:160px;overflow:hidden;text-overflow:ellipsis">${esc((r.filter_reason||'').slice(0,40))}</td>
        <td>${links||'—'}</td>
      </tr>`;
    }).join('');
  }
}

// ── CALLS TAB ─────────────────────────────────────────────
async function loadCalls(){
  const data=await apiFetch('/api/calls?limit=100');
  const calls=data?.rows||data?.calls||[];
  const wins=calls.filter(c=>c.outcome==='WIN').length,losses=calls.filter(c=>c.outcome==='LOSS').length;
  const wr=wins+losses>0?Math.round(wins/(wins+losses)*100):0;
  setText('cTotal',calls.length);setText('cWins',wins);setText('cLosses',losses);setText('cWinRate',wr+'%');
  renderCallCards('callsGrid',calls,false);
}

// ── AUDIT TAB ─────────────────────────────────────────────
async function loadAudit(){
  const data=await apiFetch('/api/candidates?limit=300');
  const rows=(data?.rows||data?.candidates||[]).map(normalizeCandidate);
  allCandidatesData=rows;
  setText('tb-audit-badge',rows.length);
  renderAuditList();
}

function auditFilter(btn,f){
  document.querySelectorAll('#tab-audit .fchip').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  auditCurrentFilter=f;
  renderAuditList();
}

function filterAuditList(){
  auditSearchTerm=document.getElementById('auditSearch')?.value?.toLowerCase()||'';
  renderAuditList();
}

function renderAuditList(){
  const el=document.getElementById('auditList');if(!el)return;
  let rows=allCandidatesData;
  // Filter by decision
  if(auditCurrentFilter==='POST') rows=rows.filter(c=>c.finalDecision==='AUTO_POST'||c.posted);
  else if(auditCurrentFilter==='IGNORE') rows=rows.filter(c=>c.finalDecision==='IGNORE');
  else if(auditCurrentFilter==='WATCHLIST') rows=rows.filter(c=>c.finalDecision==='WATCHLIST'||c.finalDecision==='RETEST'||c.finalDecision==='HOLD_FOR_REVIEW');
  // Filter by search
  if(auditSearchTerm) rows=rows.filter(c=>(c.token||'').toLowerCase().includes(auditSearchTerm)||(c.contractAddress||'').toLowerCase().includes(auditSearchTerm));
  if(!rows.length){el.innerHTML='<div class="empty-state"><div class="empty-icon">🔍</div><div>No tokens match</div></div>';return;}
  el.innerHTML=rows.slice(0,100).map(c=>{
    const score=c.compositeScore||0;
    const dec=c.finalDecision||'—';
    const decC=decColor(dec);
    return`<div class="audit-item" onclick="showAuditDetail(${c.id})">
      <div>
        <div class="audit-item-token">$${esc(c.token||'?')}</div>
        <div class="audit-item-meta">${c.stage||'?'} · MCap: ${fmt(c.marketCap,'$')} · Age: ${c.pairAgeHours?.toFixed?.(1)||'?'}h</div>
      </div>
      <div class="audit-item-dec">
        <div style="color:${scoreCol(score)};font-family:var(--mono);font-size:13px;font-weight:700">${score}</div>
        <div style="color:${decC};font-size:8px;letter-spacing:0.5px;margin-top:2px">${dec}</div>
      </div>
    </div>`;
  }).join('');
}

async function showAuditDetail(id){
  if(!id)return;
  // Mark selected
  document.querySelectorAll('.audit-item').forEach(el=>{
    if(el.getAttribute('onclick')?.includes(id))el.classList.add('selected');
    else el.classList.remove('selected');
  });
  const det=document.getElementById('auditDetail');
  if(det)det.innerHTML='<div class="spinner"><div class="spin-dot" style="background:var(--cyan)"></div><div class="spin-dot" style="background:var(--green)"></div><div class="spin-dot" style="background:var(--purple)"></div></div>';
  const data=await apiFetch(`/api/candidates/${id}`);
  if(!data?.candidate){if(det)det.innerHTML='<div class="empty-state"><div class="empty-icon">❌</div><div>Failed to load</div></div>';return;}
  const c=normalizeCandidate(data.candidate);
  if(det)det.innerHTML=buildAuditDetail(c);
}

function buildAuditDetail(c){
  const score=c.compositeScore||0;
  const lvls=sltp(c.marketCap);
  // Parse subScores safely — handle string or object, multiple key formats
  const _ss = (()=>{
    const raw = c.subScores;
    if(!raw) return {};
    if(typeof raw === 'string'){try{return JSON.parse(raw);}catch{return {};}}
    return raw;
  })();
  const sub = {
    launchQuality:   _ss.launchQuality   ?? _ss.launch_quality   ?? _ss.launch   ?? null,
    walletStructure: _ss.walletStructure ?? _ss.wallet_structure ?? _ss.wallet   ?? null,
    marketBehavior:  _ss.marketBehavior  ?? _ss.market_behavior  ?? _ss.market   ?? null,
    socialNarrative: _ss.socialNarrative ?? _ss.social_narrative ?? _ss.social   ?? null,
  };
  const dec=c.finalDecision||'—';
  const oaiD=c.openaiDecision,oaiC=c.openaiConviction;
  const wi=c.walletIntel||{};

  // Helpers
  function fg(label,val,color,hint){return`<div class="audit-field"><div class="audit-field-label">${label}</div><div class="audit-field-value" style="${color?'color:'+color:''}">${val||'—'}</div>${hint?`<div style="font-family:var(--mono);font-size:7px;color:var(--text3);margin-top:2px">${hint}</div>`:''}</div>`;}
  function ss(label,val,color){const v=(val!==null&&val!==undefined&&val!==''&&!isNaN(+val))?+val:null;const pct=v!=null?Math.min(Math.max(v,0),100):0;return`<div class="sub-score-item"><div class="sub-score-label">${label}</div><div class="sub-score-bar"><div class="prog-track"><div class="prog-fill" style="width:${pct}%;background:${color}${v==null?';opacity:0.2':''}"></div></div></div><div class="sub-score-num" style="color:${v!=null?color:'var(--text3)'}">${v!=null?Math.round(v):'—'}</div></div>`;}

  // Wallet verdict color
  const wv=c.walletVerdict||wi.walletVerdict||'NEUTRAL';
  const wvCol=wv==='BULLISH'||wv==='VERY_BULLISH'?'var(--green)':wv==='MANIPULATED'||wv==='SUSPICIOUS'?'var(--red)':wv==='SNIPER_DOMINATED'?'var(--orange)':'var(--text3)';

  // Sniper risk
  const snipers=c.sniperWalletCount??wi.sniperWalletCount??0;
  const snipCol=snipers===0?'var(--green)':snipers<=5?'var(--gold)':snipers<=15?'var(--orange)':'var(--red)';

  // Bundle risk
  const bundleCol=c.bundleRisk==='NONE'?'var(--green)':c.bundleRisk==='LOW'?'var(--cyan)':c.bundleRisk==='MEDIUM'?'var(--gold)':c.bundleRisk==='HIGH'?'var(--orange)':'var(--red)';

  // Deployer risk
  const dRisk=c.deployerRiskScore??0;
  const dRCol=dRisk<30?'var(--green)':dRisk<60?'var(--gold)':dRisk<80?'var(--orange)':'var(--red)';

  // Buy ratio bar color
  const brCol=(c.buySellRatio1h??0)>=0.65?'var(--green)':(c.buySellRatio1h??0)>=0.5?'var(--cyan)':(c.buySellRatio1h??0)>=0.4?'var(--gold)':'var(--red)';

  // Multiplier targets
  const entryMcap=c.marketCap??0;
  const multi=(x)=>entryMcap>0?fmt(entryMcap*x,'$'):'—';

  const pipelineSteps=[
    {n:1,name:'Rules Engine',col:'#18ffff',
     detail:`Score: ${score}/100 · Threshold: ${c.dynamicThreshold||'?'}/100 · Trap: ${c.trapSeverity||'NONE'} · Stage: ${c.stage||'?'}`,
     verdict:score>=(c.dynamicThreshold||38)?'✓ Passed threshold':'✗ Below threshold'},
    {n:2,name:'Wallet Intelligence (Dune)',col:'#e040fb',
     detail:`Verdict: ${wv} · Smart Money: ${wi.smartMoneyScore??c.smartMoneyScore??'?'}/100 · Winners: ${wi.knownWinnerWalletCount??0} · Snipers: ${snipers} · Clusters: ${wi.clusterWalletCount??0}`,
     verdict:wv==='BULLISH'||wv==='VERY_BULLISH'?'✓ Bullish wallet structure detected':wv==='MANIPULATED'?'✗ Blocked — manipulation detected':wv==='SNIPER_DOMINATED'?'⚠ Sniper-dominated (low conviction)':'→ Neutral / insufficient data'},
    {n:3,name:'Deployer Check',col:'#ffd740',
     detail:`Verdict: ${c.deployerVerdict||'UNKNOWN'} · Risk Score: ${c.deployerRiskScore??'?'}/100`,
     verdict:c.deployerVerdict==='CLEAN'?'✓ Deployer has clean history':c.deployerVerdict==='DANGEROUS'?'✗ Blocked — dangerous deployer':'→ Neutral / first launch'},
    {n:4,name:'Pump.fun Livestream',col:'#ff6d00',
     detail:c.livestream?.isLive?`✓ LIVE — ${c.livestream.viewerCount||0} viewers · Engagement: ${c.livestream.engagementScore||0}/10`:'— Not live or data unavailable',
     verdict:c.livestream?.isLive?`+${c.livestream.engagementScore||2} confidence bonus`:'No livestream bonus applied'},
    {n:5,name:'Claude Forensic Analysis',col:'#448aff',
     detail:`Risk: ${c.claudeRisk||'?'} · Setup: ${(c.claudeSetupType||c.setupType||'?').replace(/_/g,' ')} · Structure: ${c.structureGrade||'?'} · Missing: ${c.missingDataImpact||'none'}`,
     verdict:c.claudeVerdict?'"'+c.claudeVerdict.slice(0,100)+'…"':'No Claude verdict recorded'},
    {n:6,name:'OpenAI GPT-4o Final Decision',col:'#00e676',
     detail:oaiD?`Decision: ${oaiD} · Conviction: ${oaiC||'?'}%${c.openaiVerdict?' · "'+c.openaiVerdict.slice(0,60)+'"':''}`:(score>=45?'Triggered but no response yet — check server logs (OPENAI_API_KEY set? API reachable?)':'Score below 45 — OpenAI skipped to save API credits (score must be ≥45 for OpenAI to run)'),
     verdict:oaiD?`→ FINAL: ${oaiD}${oaiC?' ('+oaiC+'% conviction)':''}${!c.openaiAgreesWithClaude?' ⚠ Disagrees with Claude':''}` : (score>=45?'→ OpenAI should have run — verify OPENAI_API_KEY is set in Railway and redeploy':'→ Claude/Scorer decision is final (score too low for OpenAI)')},
  ];

  return`
    <!-- ═══ HEADER ═══ -->
    <div style="display:flex;align-items:flex-start;gap:20px;margin-bottom:20px;padding-bottom:20px;border-bottom:1px solid var(--border);flex-wrap:wrap">
      <div style="text-align:center;flex-shrink:0">
        <div class="audit-score-big" style="color:${scoreCol(score)};text-shadow:0 0 30px ${scoreCol(score)}44">${score}</div>
        <div style="font-family:var(--mono);font-size:8px;color:var(--text3);letter-spacing:2px;margin-top:4px">COMPOSITE</div>
      </div>
      <div style="flex:1;min-width:200px">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:8px;flex-wrap:wrap">
          <div style="font-family:var(--mono);font-size:18px;font-weight:700;color:var(--text1)">$${esc(c.token||'?')} <span style="color:var(--text3);font-size:12px;font-weight:400">${esc(c.tokenName||'')}</span></div>
          ${(c.dex==='pump.fun'||c.stage==='PRE_BOND'||c.stage==='BONDING')?`<span style="font-family:var(--mono);font-size:8px;padding:2px 8px;border-radius:3px;background:rgba(255,109,0,0.15);border:1px solid rgba(255,109,0,0.4);color:var(--orange)">⚡ PUMP.FUN</span>`:''}
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px">
          <span style="font-family:var(--mono);font-size:9px;padding:3px 10px;border-radius:3px;background:${decColor(dec)}18;border:1px solid ${decColor(dec)}44;color:${decColor(dec)}">${dec}</span>
          <span style="font-family:var(--mono);font-size:9px;padding:3px 10px;border-radius:3px;background:${stageCol(c.stage)}18;border:1px solid ${stageCol(c.stage)}44;color:${stageCol(c.stage)}">${c.stage||'?'}</span>
          ${isBrandNew(c.pairAgeHours)?'<span class="new-badge">⚡ BRAND NEW</span>':''}
          ${oaiD?`<span style="font-family:var(--mono);font-size:9px;padding:3px 10px;border-radius:3px;background:rgba(0,230,118,0.1);border:1px solid rgba(0,230,118,0.3);color:var(--green)">🤖 GPT-4o: ${oaiD} (${oaiC||'?'}%)</span>`:''}
          <span style="font-family:var(--mono);font-size:9px;padding:3px 10px;border-radius:3px;background:${wvCol}18;border:1px solid ${wvCol}44;color:${wvCol}">👥 ${wv}</span>
        </div>
        <div style="font-family:var(--mono);font-size:9px;color:var(--text3);margin-bottom:4px">MCap: ${fmt(c.marketCap,'$')} · Liq: ${fmt(c.liquidity,'$')} · Age: ${c.pairAgeHours?.toFixed?.(2)||'?'}h · ${c.candidateType||'?'}</div>
        ${c.contractAddress?`<div style="display:flex;align-items:center;gap:8px;margin-top:6px;flex-wrap:wrap">
          <code style="font-family:var(--mono);font-size:8px;color:var(--text3);word-break:break-all">${c.contractAddress}</code>
          <button onclick="copyCA('${c.contractAddress}')" style="background:rgba(24,255,255,0.1);border:1px solid rgba(24,255,255,0.2);color:var(--cyan);border-radius:3px;padding:3px 10px;font-family:var(--mono);font-size:9px;cursor:pointer;white-space:nowrap">📋 COPY</button>
        </div>
        <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
          <a href="https://dexscreener.com/solana/${c.contractAddress}" target="_blank" style="display:inline-flex;align-items:center;gap:5px;padding:6px 12px;background:rgba(0,230,118,0.08);border:1px solid rgba(0,230,118,0.3);border-radius:5px;color:var(--green);text-decoration:none;font-family:var(--mono);font-size:10px;font-weight:600">📊 DEX SCREENER</a>
          <a href="https://pump.fun/${c.contractAddress}" target="_blank" style="display:inline-flex;align-items:center;gap:5px;padding:6px 12px;background:rgba(255,109,0,0.08);border:1px solid rgba(255,109,0,0.3);border-radius:5px;color:var(--orange);text-decoration:none;font-family:var(--mono);font-size:10px;font-weight:600">⚡ PUMP.FUN</a>
          <a href="https://solscan.io/token/${c.contractAddress}" target="_blank" style="display:inline-flex;align-items:center;gap:5px;padding:6px 12px;background:rgba(68,138,255,0.08);border:1px solid rgba(68,138,255,0.3);border-radius:5px;color:var(--blue);text-decoration:none;font-family:var(--mono);font-size:10px">🔍 SOLSCAN</a>
          <a href="https://birdeye.so/token/${c.contractAddress}?chain=solana" target="_blank" style="display:inline-flex;align-items:center;gap:5px;padding:6px 12px;background:rgba(224,64,251,0.08);border:1px solid rgba(224,64,251,0.3);border-radius:5px;color:var(--purple);text-decoration:none;font-family:var(--mono);font-size:10px">🦅 BIRDEYE</a>
        </div>`:''}
      </div>
    </div>

    <!-- ═══ TOKEN IMAGE / BANNER ═══ -->
    ${c.contractAddress?`<div style="display:flex;gap:12px;margin-bottom:16px;align-items:flex-start;flex-wrap:wrap">
      <div style="flex-shrink:0">
        <img src="https://dd.dexscreener.com/ds-data/tokens/solana/${c.contractAddress}.png"
             onerror="this.src='https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/solana/info/logo.png';this.onerror=null"
             style="width:64px;height:64px;border-radius:50%;border:2px solid rgba(255,255,255,0.1);background:rgba(0,0,0,0.3);object-fit:cover"
             alt="$${c.token||'?'} logo">
      </div>
      <div style="flex:1;min-width:200px">
        <img src="https://dd.dexscreener.com/ds-data/tokens/solana/${c.contractAddress}/header.png"
             onerror="this.style.display='none'"
             style="width:100%;max-height:80px;border-radius:8px;object-fit:cover;border:1px solid rgba(255,255,255,0.08)"
             alt="$${c.token||'?'} banner">
      </div>
    </div>`:''}

    <!-- ═══ SCORING BREAKDOWN ═══ -->
    <div class="audit-section-title">📊 SCORING BREAKDOWN — WHAT DROVE THE SCORE</div>
    <div class="sub-score-row" style="margin-bottom:8px;grid-template-columns:1fr 1fr">
      ${ss('🚀 Launch Quality',sub.launchQuality,'var(--cyan)')}
      ${ss('👥 Wallet Structure',sub.walletStructure,'var(--purple)')}
      ${ss('📈 Market Behavior',sub.marketBehavior,'var(--green)')}
      ${ss('📣 Social / Narrative',sub.socialNarrative,'var(--gold)')}
    </div>
    ${(()=>{
      const sigs=c.signals||{};const pens=c.penalties||{};
      const allSigs=[...(sigs.launch||[]),...(sigs.wallet||[]),...(sigs.market||[]),...(sigs.social||[]),...(sigs.stealth||[])];
      const allPens=[...(pens.launch||[]),...(pens.wallet||[]),...(pens.market||[]),...(pens.social||[])];
      const stealthBonus=c.stealthBonus>0?`<span style="font-family:var(--mono);font-size:8px;padding:1px 6px;border-radius:2px;background:rgba(156,39,176,0.1);color:var(--purple);margin-left:6px">🔮 STEALTH +${c.stealthBonus}</span>`:'';
      const trapPenalty=c.trapDetector?.confidencePenalty>0?`<span style="font-family:var(--mono);font-size:8px;padding:1px 6px;border-radius:2px;background:rgba(255,23,68,0.1);color:var(--red);margin-left:6px">⚠ TRAP -${c.trapDetector.confidencePenalty}</span>`:'';
      if(!allSigs.length&&!allPens.length)return'';
      return`<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px">
        <div style="background:rgba(0,230,118,0.04);border:1px solid rgba(0,230,118,0.15);border-radius:6px;padding:10px">
          <div style="font-family:var(--mono);font-size:8px;color:var(--green);letter-spacing:1px;margin-bottom:6px">✓ POSITIVE SIGNALS ${stealthBonus}</div>
          ${allSigs.slice(0,6).map(sig=>`<div style="font-family:var(--mono);font-size:9px;color:var(--text2);padding:2px 0;border-bottom:1px solid rgba(0,230,118,0.08)">✓ ${esc(sig)}</div>`).join('')}
          ${allSigs.length>6?`<div style="font-family:var(--mono);font-size:8px;color:var(--text3);margin-top:3px">+${allSigs.length-6} more signals</div>`:''}
        </div>
        <div style="background:rgba(255,23,68,0.04);border:1px solid rgba(255,23,68,0.15);border-radius:6px;padding:10px">
          <div style="font-family:var(--mono);font-size:8px;color:var(--red);letter-spacing:1px;margin-bottom:6px">✗ RED FLAGS ${trapPenalty}</div>
          ${allPens.slice(0,6).map(pen=>`<div style="font-family:var(--mono);font-size:9px;color:var(--text2);padding:2px 0;border-bottom:1px solid rgba(255,23,68,0.08)">✗ ${esc(pen)}</div>`).join('')}
          ${allPens.length>6?`<div style="font-family:var(--mono);font-size:8px;color:var(--text3);margin-top:3px">+${allPens.length-6} more red flags</div>`:''}
          ${(!allPens.length)?'<div style="font-family:var(--mono);font-size:9px;color:var(--green)">No red flags</div>':''}
        </div>
      </div>`;
    })()}

    <!-- ═══ AI ANALYSIS (above wallet intel per user request) ═══ -->
    <div style="margin-bottom:16px">
      ${(c.claudeVerdict||c.openaiVerdict)?`
      <div class="audit-section-title">🤖 AI ANALYSIS</div>
      <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:4px">
        ${c.claudeVerdict?`
        <div style="background:rgba(68,138,255,0.06);border:1px solid rgba(68,138,255,0.25);border-radius:8px;padding:12px 14px">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap">
            <span style="font-family:var(--mono);font-size:8px;padding:2px 8px;border-radius:2px;background:rgba(68,138,255,0.15);border:1px solid rgba(68,138,255,0.4);color:var(--blue);letter-spacing:1px">🧠 CLAUDE FORENSIC</span>
            ${c.claudeRisk?`<span style="font-family:var(--mono);font-size:8px;padding:2px 8px;border-radius:2px;background:${c.claudeRisk==='LOW'?'rgba(0,230,118,0.1)':c.claudeRisk==='MEDIUM'?'rgba(255,215,64,0.1)':'rgba(255,23,68,0.1)'};color:${c.claudeRisk==='LOW'?'var(--green)':c.claudeRisk==='MEDIUM'?'var(--gold)':'var(--red)'}">${c.claudeRisk} RISK</span>`:''}
            ${c.claudeSetupType?`<span style="font-family:var(--mono);font-size:8px;color:var(--text3)">${esc(c.claudeSetupType)}</span>`:''}
          </div>
          <div style="font-family:var(--mono);font-size:11px;color:var(--text1);line-height:1.6;font-style:italic">"${esc(c.claudeVerdict)}"</div>
        </div>`:''
        }
        ${c.openaiVerdict?`
        <div style="background:rgba(0,230,118,0.05);border:1px solid rgba(0,230,118,0.22);border-radius:8px;padding:12px 14px">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap">
            <span style="font-family:var(--mono);font-size:8px;padding:2px 8px;border-radius:2px;background:rgba(0,230,118,0.12);border:1px solid rgba(0,230,118,0.35);color:var(--green);letter-spacing:1px">🤖 OPENAI GPT-4o FINAL</span>
            ${c.openaiDecision?`<span style="font-family:var(--mono);font-size:8px;padding:2px 8px;border-radius:2px;background:rgba(0,230,118,0.08);border:1px solid rgba(0,230,118,0.2);color:var(--green)">${esc(c.openaiDecision)}</span>`:''}
            ${c.openaiConviction?`<span style="font-family:var(--mono);font-size:8px;color:var(--text3)">${esc(c.openaiConviction)}% conviction</span>`:''}
            ${c.openaiAgreesWithClaude===false?'<span style="font-family:var(--mono);font-size:8px;color:var(--orange)">⚠ Disagrees with Claude</span>':''}
          </div>
          <div style="font-family:var(--mono);font-size:11px;color:var(--text1);line-height:1.6;font-style:italic">"${esc(c.openaiVerdict)}"</div>
        </div>`:''
        }
      </div>`:''}
    </div>

    <!-- ═══ MULTIPLIER TARGETS ═══ -->
    <div style="background:linear-gradient(135deg,rgba(0,230,118,0.06),rgba(24,255,255,0.03));border:1px solid rgba(0,230,118,0.25);border-radius:10px;padding:16px;margin-bottom:18px">
      <div style="font-family:var(--mono);font-size:9px;letter-spacing:2px;color:var(--green);margin-bottom:12px">📍 MULTIPLIER TARGETS FROM ENTRY MCap ${fmt(c.marketCap,'$')} — BOT TRACKS EACH MILESTONE</div>
      <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:8px" class="forensic-grid-3">
        <div style="text-align:center;padding:10px;background:rgba(255,215,64,0.06);border:1px solid rgba(255,215,64,0.2);border-radius:6px">
          <div style="font-family:var(--mono);font-size:8px;color:var(--text3);margin-bottom:4px">🛑 STOP LOSS</div>
          <div style="font-family:var(--mono);font-size:14px;font-weight:700;color:var(--red)">${multi(0.75)}</div>
          <div style="font-family:var(--mono);font-size:8px;color:var(--text3);margin-top:2px">-25% · EXIT FAST</div>
        </div>
        <div style="text-align:center;padding:10px;background:rgba(24,255,255,0.04);border:1px solid rgba(24,255,255,0.2);border-radius:6px">
          <div style="font-family:var(--mono);font-size:8px;color:var(--text3);margin-bottom:4px">🎯 2× TARGET</div>
          <div style="font-family:var(--mono);font-size:14px;font-weight:700;color:var(--cyan)">${multi(2)}</div>
          <div style="font-family:var(--mono);font-size:8px;color:var(--text3);margin-top:2px">+100% · SELL 33%</div>
        </div>
        <div style="text-align:center;padding:10px;background:rgba(68,138,255,0.04);border:1px solid rgba(68,138,255,0.2);border-radius:6px">
          <div style="font-family:var(--mono);font-size:8px;color:var(--text3);margin-bottom:4px">🚀 5× TARGET</div>
          <div style="font-family:var(--mono);font-size:14px;font-weight:700;color:var(--blue)">${multi(5)}</div>
          <div style="font-family:var(--mono);font-size:8px;color:var(--text3);margin-top:2px">+400% · SELL 33%</div>
        </div>
        <div style="text-align:center;padding:10px;background:rgba(255,215,64,0.04);border:1px solid rgba(255,215,64,0.2);border-radius:6px">
          <div style="font-family:var(--mono);font-size:8px;color:var(--text3);margin-bottom:4px">💎 10× TARGET</div>
          <div style="font-family:var(--mono);font-size:14px;font-weight:700;color:var(--gold)">${multi(10)}</div>
          <div style="font-family:var(--mono);font-size:8px;color:var(--text3);margin-top:2px">+900% · MOON BAG</div>
        </div>
        <div style="text-align:center;padding:10px;background:rgba(224,64,251,0.04);border:1px solid rgba(224,64,251,0.2);border-radius:6px">
          <div style="font-family:var(--mono);font-size:8px;color:var(--text3);margin-bottom:4px">🌙 50× DREAM</div>
          <div style="font-family:var(--mono);font-size:14px;font-weight:700;color:var(--purple)">${multi(50)}</div>
          <div style="font-family:var(--mono);font-size:8px;color:var(--text3);margin-top:2px">+4900% · LET IT RUN</div>
        </div>
      </div>
      <div style="font-family:var(--mono);font-size:8px;color:var(--text3);margin-top:8px;text-align:center">Bot auto-checks price every 30min · Marks WIN at 2× · Marks LOSS at -25% · Feeds AI learning loop</div>
    </div>

    <!-- ═══ WALLET INTELLIGENCE ═══ -->
    <div class="audit-section-title">👥 WALLET INTELLIGENCE — DUNE ANALYTICS DATA</div>
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:12px" class="forensic-grid">
      ${fg('WALLET VERDICT',wv,wvCol,'Dune cross-reference result')}
      ${fg('SMART MONEY SCORE',(wi.smartMoneyScore??c.smartMoneyScore??'?')+'/100',(wi.smartMoneyScore??0)>60?'var(--green)':(wi.smartMoneyScore??0)>30?'var(--gold)':'var(--text3)','0=bearish 100=strongly bullish')}
      ${fg('🏆 WINNER WALLETS',(wi.knownWinnerWalletCount??0).toString(),(wi.knownWinnerWalletCount??0)>0?'var(--green)':'var(--text3)','Proven 10x+ hunters in this token')}
      ${fg('🧠 SMART MONEY',(wi.smartMoneyWalletCount??0).toString(),(wi.smartMoneyWalletCount??0)>0?'var(--blue)':'var(--text3)','Early entry consistent profitability')}
      ${fg('🎯 SNIPERS',snipers.toString(),snipCol,'First-block buyers — reduce conviction')}
      ${fg('⚠ CLUSTERS',(wi.clusterWalletCount??0).toString(),(wi.clusterWalletCount??0)>5?'var(--red)':(wi.clusterWalletCount??0)>2?'var(--orange)':'var(--text3)','Coordinated wallet groups = manipulation')}
      ${fg('🌾 FARM WALLETS',(wi.farmWalletCount??0).toString(),(wi.farmWalletCount??0)>10?'var(--orange)':'var(--text3)','Volume farmers — ignore their buys')}
      ${fg('☠ RUG WALLETS',(wi.rugWalletCount??0).toString(),(wi.rugWalletCount??0)>0?'var(--red)':'var(--green)','Linked to past rugs — hard red flag')}
    </div>
    ${(wi.topWinners||[]).length?`<div style="background:rgba(0,230,118,0.04);border:1px solid rgba(0,230,118,0.15);border-radius:6px;padding:12px;margin-bottom:12px">
      <div style="font-family:var(--mono);font-size:8px;letter-spacing:2px;color:var(--green);margin-bottom:8px">🏆 TOP WINNER WALLETS IN THIS TOKEN</div>
      ${wi.topWinners.map(w=>`<div style="display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid rgba(255,255,255,0.04);font-family:var(--mono);font-size:9px"><span style="color:var(--cyan)">${w.address?.slice(0,12)||'?'}…</span><span style="color:var(--green)">Win rate: ${w.winRate!=null?(w.winRate*100).toFixed(0)+'%':'?'} · Avg ROI: ${w.avgRoi?.toFixed?.(0)||'?'}%</span></div>`).join('')}
    </div>`:''}

    <!-- ═══ BUNDLE BUY & SNIPER ANALYSIS ═══ -->
    <div class="audit-section-title">🎯 BUNDLE BUY, SNIPER & VELOCITY ANALYSIS</div>
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:12px" class="forensic-grid">
      ${fg('BUNDLE RISK',c.bundleRisk||'UNKNOWN',bundleCol,'Coordinated bulk-buy manipulation')}
      ${fg('BUBBLE MAP',c.bubbleMapRisk||'UNKNOWN',c.bubbleMapRisk==='CLEAN'?'var(--green)':c.bubbleMapRisk==='SEVERE'?'var(--red)':'var(--text3)','Visual wallet cluster analysis')}
      ${fg('SNIPER COUNT',snipers.toString(),snipCol,'Wallets buying in first 30 seconds')}
      ${fg('BUY VELOCITY',c.buyVelocity!=null?c.buyVelocity.toFixed(2)+'/min':'—',c.buyVelocity>3?'var(--green)':c.buyVelocity>1?'var(--gold)':'var(--text3)','Buys per minute — higher = more demand')}
      ${fg('VOL VELOCITY',c.volumeVelocity!=null?c.volumeVelocity.toFixed(2):'—',c.volumeVelocity>0.4?'var(--green)':c.volumeVelocity>0.15?'var(--gold)':'var(--text3)','Vol/Liquidity — measures organic volume')}
      ${fg('BUYS 1H VS SELLS',c.buys1h!=null&&c.sells1h!=null?c.buys1h+'B / '+c.sells1h+'S':'—',c.buySellRatio1h>0.65?'var(--green)':c.buySellRatio1h>0.5?'var(--gold)':'var(--red)','Raw buy/sell transaction count')}
      ${fg('TOP 10 HOLDER %',c.top10HolderPct!=null?c.top10HolderPct.toFixed(1)+'%':'—',c.top10HolderPct<25?'var(--green)':c.top10HolderPct<50?'var(--gold)':'var(--red)','Lower = better distribution')}
      ${fg('DEV WALLET %',c.devWalletPct!=null?c.devWalletPct.toFixed(1)+'%':'—',c.devWalletPct<3?'var(--green)':c.devWalletPct<10?'var(--gold)':'var(--red)','Developer holdings — should be low')}
      ${fg('INSIDER %',c.insiderWalletPct!=null?c.insiderWalletPct.toFixed(1)+'%':'—',c.insiderWalletPct<10?'var(--green)':'var(--orange)','Team + early insider holdings')}
      ${fg('DEX PAID',c.dexPaid||c.boostStatus||'NOT CHECKED','var(--text3)','DexScreener paid ad boost status')}
      ${fg('HOLDER GROWTH',c.holderGrowth24h!=null?c.holderGrowth24h.toFixed(1)+'%/24h':'—',c.holderGrowth24h>20?'var(--green)':c.holderGrowth24h>5?'var(--gold)':'var(--text3)','Holder count change in 24h')}
      ${fg('UNIQUE BUYERS',c.launchUniqueBuyerRatio!=null?(c.launchUniqueBuyerRatio*100).toFixed(0)+'%':'—',c.launchUniqueBuyerRatio>0.6?'var(--green)':'var(--text3)','% unique wallets vs total buys')}
    </div>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:16px" class="forensic-grid">
      ${fg('LAUNCH QUALITY',c.launchQualityScore!=null?c.launchQualityScore+'/100':'—',c.launchQualityScore>60?'var(--green)':c.launchQualityScore>40?'var(--gold)':'var(--text3)','Quality of initial launch structure')}
      ${fg('UNIQUE BUYERS',c.launchUniqueBuyerRatio!=null?(c.launchUniqueBuyerRatio*100).toFixed(0)+'%':'—',c.launchUniqueBuyerRatio>0.5?'var(--green)':'var(--text3)','% unique wallets vs total buys')}
      ${fg('COORDINATION',c.coordinationIntensity||'—',c.coordinationIntensity==='LOW'?'var(--green)':c.coordinationIntensity==='HIGH'?'var(--red)':'var(--text3)','Wallet coordination intensity')}
    </div>

    <!-- ═══ SOCIAL STRUCTURE ═══ -->
    <div class="audit-section-title">📣 SOCIAL & NARRATIVE STRUCTURE</div>
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:12px" class="forensic-grid">
      ${fg('NARRATIVE TAGS',(c.narrativeTags||[]).slice(0,3).join(' · ')||'—',null,'AI-detected thematic categories')}
      ${fg('SOCIAL SCORE',(sub.socialNarrative!=null?sub.socialNarrative+'/100':'—'),sub.socialNarrative>60?'var(--green)':sub.socialNarrative>30?'var(--gold)':'var(--text3)','Social narrative strength')}
      ${fg('REPLY COUNT',(c.replyCount!=null?c.replyCount:'—'),c.replyCount>50?'var(--green)':'var(--text3)','pump.fun reply count')}
      ${fg('LIVESTREAM',c.livestream?.isLive?`✓ LIVE (${c.livestream.viewerCount||0}👁)`:'— Not live',c.livestream?.isLive?'var(--green)':'var(--text3)','Dev streaming on pump.fun')}
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px">
      ${c.website?`<a href="${c.website}" target="_blank" style="display:flex;align-items:center;gap:5px;padding:6px 12px;background:rgba(24,255,255,0.06);border:1px solid rgba(24,255,255,0.2);border-radius:5px;color:var(--cyan);text-decoration:none;font-family:var(--mono);font-size:10px">🌐 Website</a>`:''}
      ${c.twitter?`<a href="${c.twitter}" target="_blank" style="display:flex;align-items:center;gap:5px;padding:6px 12px;background:rgba(255,255,255,0.04);border:1px solid var(--border2);border-radius:5px;color:var(--text1);text-decoration:none;font-family:var(--mono);font-size:10px">𝕏 Twitter</a>`:''}
      ${c.telegram?`<a href="${c.telegram}" target="_blank" style="display:flex;align-items:center;gap:5px;padding:6px 12px;background:rgba(24,255,255,0.04);border:1px solid rgba(24,255,255,0.15);border-radius:5px;color:var(--cyan);text-decoration:none;font-family:var(--mono);font-size:10px">✈ Telegram</a>`:''}
      ${!c.website&&!c.twitter&&!c.telegram?'<div style="font-family:var(--mono);font-size:9px;color:var(--text3)">No social links recorded — stealth launch</div>':''}
    </div>

    <!-- ═══ MOMENTUM & MARKET ═══ -->
    <div class="audit-section-title">📈 MOMENTUM & MARKET BEHAVIOR</div>
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:12px" class="forensic-grid">
      ${fg('5M CHANGE',c.priceChange5m!=null?(c.priceChange5m>0?'+':'')+c.priceChange5m.toFixed(1)+'%':'—',c.priceChange5m>0?'var(--green)':c.priceChange5m<0?'var(--red)':'var(--text3)')}
      ${fg('1H CHANGE',c.priceChange1h!=null?(c.priceChange1h>0?'+':'')+c.priceChange1h.toFixed(1)+'%':'—',c.priceChange1h>0?'var(--green)':c.priceChange1h<0?'var(--red)':'var(--text3)')}
      ${fg('6H CHANGE',c.priceChange6h!=null?(c.priceChange6h>0?'+':'')+c.priceChange6h.toFixed(1)+'%':'—',c.priceChange6h>0?'var(--green)':c.priceChange6h<0?'var(--red)':'var(--text3)')}
      ${fg('24H CHANGE',c.priceChange24h!=null?(c.priceChange24h>0?'+':'')+c.priceChange24h.toFixed(1)+'%':'—',c.priceChange24h>0?'var(--green)':c.priceChange24h<0?'var(--red)':'var(--text3)')}
      ${fg('BUYS 1H',(c.buys1h??'—').toString(),'var(--green)')}
      ${fg('SELLS 1H',(c.sells1h??'—').toString(),'var(--red)')}
      ${fg('BUY RATIO 1H',c.buySellRatio1h!=null?(c.buySellRatio1h*100).toFixed(0)+'%':'—',brCol,'Above 60% = strong buy pressure')}
      ${fg('VOL VELOCITY',c.volumeVelocity!=null?c.volumeVelocity.toFixed(2):'—',c.volumeVelocity>0.3?'var(--green)':c.volumeVelocity>0.15?'var(--gold)':'var(--text3)','Vol/(liquidity) — higher = more active')}
      ${fg('VOLUME 1H',fmt(c.volume1h,'$'),null)}
      ${fg('VOLUME 24H',fmt(c.volume24h,'$'),null)}
      ${fg('HOLDERS',(c.holders?.toLocaleString()||'—'),null)}
      ${fg('HOLDER GROWTH',c.holderGrowth24h!=null?c.holderGrowth24h.toFixed(1)+'%':'—',c.holderGrowth24h>10?'var(--green)':'var(--text3)','24h holder count change')}
      ${fg('BUY VELOCITY',c.buyVelocity!=null?c.buyVelocity.toFixed(2):'—',c.buyVelocity>2?'var(--green)':'var(--text3)','Buys per minute')}
      ${fg('MOMENTUM GRADE',c.momentumGrade||'—',c.momentumGrade==='STRONG'||c.momentumGrade==='A'?'var(--green)':'var(--text3)')}
      ${fg('BONDING CURVE',c.bondingCurvePct!=null?c.bondingCurvePct.toFixed(1)+'%':'—',c.bondingCurvePct!=null&&c.bondingCurvePct<85?'var(--green)':'var(--orange)','pump.fun migration at 100%')}
      ${fg('CURVE ACCEL',c.bondingCurveAcceleration!=null?c.bondingCurveAcceleration.toFixed(2):'—',c.bondingCurveAcceleration>0.5?'var(--green)':'var(--text3)','Bonding curve fill speed')}
    </div>

    <!-- ═══ CONTRACT SAFETY ═══ -->
    <div class="audit-section-title">🛡 CONTRACT SAFETY CHECKS</div>
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:16px" class="forensic-grid">
      ${fg('MINT AUTHORITY',c.mintAuthority===0?'✓ REVOKED':c.mintAuthority===1?'⚠ ACTIVE':'?',c.mintAuthority===0?'var(--green)':c.mintAuthority===1?'var(--red)':'var(--text3)','Revoked = no new tokens can be minted')}
      ${fg('FREEZE AUTHORITY',c.freezeAuthority===0?'✓ REVOKED':c.freezeAuthority===1?'⚠ ACTIVE':'?',c.freezeAuthority===0?'var(--green)':c.freezeAuthority===1?'var(--orange)':'var(--text3)','Revoked = wallets cannot be frozen')}
      ${fg('LP STATUS',c.lpLocked===1?'✓ LOCKED':c.lpLocked===0?'⚠ UNLOCKED':'?',c.lpLocked===1?'var(--green)':c.lpLocked===0?'var(--red)':'var(--text3)','Locked = dev cannot rug liquidity')}
      ${fg('DEPLOYER VERDICT',c.deployerVerdict||'UNKNOWN',dRCol,'Based on deployer wallet history')}
      ${fg('DEPLOYER RISK',c.deployerRiskScore!=null?c.deployerRiskScore+'/100':'?',dRCol,'0=clean 100=serial rugger')}
      ${fg('DEPLOYER HISTORY',c.deployerHistory||'No prior launches',null,'Previous token launches')}
      ${fg('TRAP SEVERITY',c.trapSeverity||'NONE',c.trapSeverity&&c.trapSeverity!=='NONE'?'var(--orange)':'var(--green)','Pump & dump pattern detection')}
      ${fg('STRUCTURE GRADE',c.structureGrade||'?',gradeColor(c.structureGrade),'Overall structural quality grade')}
    </div>

    <!-- ═══ AI PIPELINE ═══ -->
    <div class="audit-section-title">🔬 AI PIPELINE — STEP BY STEP AUDIT</div>
    <div class="pipeline-steps" style="margin-bottom:16px">
      ${pipelineSteps.map(step=>`<div class="pipeline-step">
        <div class="step-num" style="border-color:${step.col}55;color:${step.col};background:${step.col}11;min-width:22px">${step.n}</div>
        <div class="step-content" style="flex:1">
          <div class="step-name">${step.name}</div>
          <div class="step-detail" style="word-break:break-word">${esc(step.detail)}</div>
          <div class="step-verdict" style="color:${step.col}">${esc(step.verdict)}</div>
        </div>
      </div>`).join('')}
    </div>

    <!-- ═══ DATA SOURCES ═══ -->
    <div class="audit-section-title">🔌 DATA SOURCES USED</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;font-family:var(--mono);font-size:9px">
      <span style="padding:3px 8px;border-radius:3px;border:1px solid var(--border);color:${c.birdeyeOk?'var(--green)':'var(--text3)'}">Birdeye ${c.birdeyeOk?'✓':'—'}</span>
      <span style="padding:3px 8px;border-radius:3px;border:1px solid var(--border);color:${c.heliusOk?'var(--green)':'var(--text3)'}">Helius ${c.heliusOk?'✓':'—'}</span>
      <span style="padding:3px 8px;border-radius:3px;border:1px solid var(--border);color:${c.bubblemapOk?'var(--green)':'var(--text3)'}">BubbleMap ${c.bubblemapOk?'✓':'—'}</span>
      <span style="padding:3px 8px;border-radius:3px;border:1px solid var(--border);color:var(--green)">Claude AI ✓</span>
      <span style="padding:3px 8px;border-radius:3px;border:1px solid var(--border);color:${oaiD?'var(--green)':'var(--text3)'}">OpenAI ${oaiD?'✓':'—'}</span>
      <span style="padding:3px 8px;border-radius:3px;border:1px solid var(--border);color:${(wi.knownWinnerWalletCount!=null)?'var(--green)':'var(--text3)'}">Dune Wallet DB ${wi.knownWinnerWalletCount!=null?'✓':'—'}</span>
    </div>
  `;
}


// ── ANALYTICS ─────────────────────────────────────────────
async function loadAnalytics(){
  const [analytics,stats,learning]=await Promise.all([
    apiFetch('/api/analytics'),apiFetch('/api/stats'),apiFetch('/api/v8/learning-stats'),
  ]);
  if(analytics){
    renderCalibration(analytics.winRateByScore||[]);
    renderWinRateList('winBySetup',analytics.winRateBySetup||[]);
    renderMissedWinners(analytics.missedWinners||[]);
    renderLossAutopsy(analytics);
  }
  if(learning)renderLearningStats(learning);
  if(stats?.scores)renderHeatmap(stats.scores);
}

function renderCalibration(data){
  const el=document.getElementById('calibrationChart');if(!el)return;
  if(!data?.length){el.innerHTML='<div class="empty-state"><div class="empty-icon">🎯</div><div>Needs resolved WIN/LOSS calls</div></div>';return;}
  el.innerHTML=data.map(item=>{
    const wr=item.winRate||0;const tot=item.total||0;
    const col=wr>=60?'var(--green)':wr>=40?'var(--gold)':'var(--red)';
    return`<div class="cal-row"><div class="cal-band">${item.scoreBand||item.band||'?'}</div><div class="cal-wrap"><div class="cal-track"><div class="cal-fill" style="width:${wr}%;background:${col}44"><span style="font-family:var(--mono);font-size:9px;color:${col};font-weight:700">${wr}%</span></div><span class="cal-right-label">${tot} calls</span></div></div><div class="cal-verdict" style="color:${col}">${wr>=60?'✅ Strong':'⚠ Weak'}</div></div>`;
  }).join('');
}

function renderWinRateList(id,data){
  const el=document.getElementById(id);if(!el)return;
  if(!data.length){el.innerHTML='<div class="empty-state"><div class="empty-icon">📊</div><div>Mark calls WIN/LOSS</div></div>';return;}
  const tot=data.reduce((a,i)=>a+(i.wins||0)+(i.losses||0),0);
  if(tot===0){el.innerHTML='<div style="padding:8px 12px;font-family:var(--mono);font-size:9px;color:var(--gold)">⚠ '+data.reduce((a,i)=>a+(i.total||0),0)+' calls — mark outcomes to see win rates</div>'+data.slice(0,6).map(item=>`<div class="win-rate-row"><div class="wr-label">${(item.setupType||item.type||'?').replace(/_/g,' ')}</div><div class="wr-bar-wrap"><div class="wr-track"><div class="wr-fill" style="width:${Math.min((item.total||0)*5,100)}%;background:rgba(136,153,187,0.3)"></div></div></div><div class="wr-stat">${item.total||0} calls</div></div>`).join('');return;}
  const sorted=[...data].filter(i=>{const l=(i.setupType||i.type||'').toString();return l&&l!=='?';}).sort((a,b)=>(b.winRate||0)-(a.winRate||0));
  el.innerHTML=sorted.slice(0,10).map(item=>{
    const wr=item.winRate||0;const col=wr>=60?'var(--green)':wr>=40?'var(--gold)':'var(--red)';
    const lbl=(item.setupType||item.type||'?').replace(/_/g,' ').slice(0,20);
    return`<div class="win-rate-row"><div class="wr-label" title="${lbl}">${lbl}</div><div class="wr-bar-wrap"><div class="wr-track"><div class="wr-fill" style="width:${wr}%;background:${col}44"><span style="font-family:var(--mono);font-size:8px;color:${col}">${wr}%</span></div></div></div><div class="wr-stat">${item.wins||0}W/${item.losses||0}L</div></div>`;
  }).join('');
}

function renderMissedWinners(data){
  const el=document.getElementById('missedWinnersList');if(!el)return;
  if(!data?.length){el.innerHTML='<div class="empty-state"><div class="empty-icon">😢</div><div>No missed winners</div><div class="empty-hint">Learning loop checks every 6h</div></div>';return;}
  el.innerHTML=data.slice(0,8).map(m=>{
    const mult=m.missed_winner_peak_multiple||0;
    const mc=mult>=10?'var(--gold)':mult>=5?'var(--green)':'var(--cyan)';
    return`<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid var(--border)">
      <div><div style="font-family:var(--mono);font-size:11px;color:var(--text1)">$${esc(m.token||'?')}</div><div style="font-family:var(--mono);font-size:8px;color:var(--text3)">Was: ${m.final_decision} · Score: ${m.composite_score||'?'}</div></div>
      <div style="font-family:var(--mono);font-size:20px;font-weight:900;color:${mc}">${mult?mult.toFixed(1)+'×':'?×'}</div>
    </div>`;
  }).join('');
}

function renderLossAutopsy(analytics){
  const el=document.getElementById('lossAutopsy');if(!el)return;
  const ls=(analytics?.winRateBySetup||[]).filter(s=>(s.winRate||0)<40&&(s.total||0)>0);
  if(!ls.length){el.innerHTML='<div class="empty-state"><div class="empty-icon">🔬</div><div>Needs LOSS outcomes</div></div>';return;}
  const max=Math.max(...ls.map(s=>s.total||0),1);
  el.innerHTML=ls.map(s=>{const pct=Math.round(((s.total||0)/max)*100);return`<div style="display:flex;align-items:center;gap:10px;padding:8px 14px;border-bottom:1px solid var(--border)"><div style="font-family:var(--mono);font-size:9px;color:var(--orange);width:160px;overflow:hidden;text-overflow:ellipsis">${(s.setupType||s.type||'?').replace(/_/g,' ')}</div><div style="flex:1"><div class="prog-track"><div class="prog-fill" style="width:${pct}%;background:rgba(255,23,68,0.5)"></div></div></div><div style="font-family:var(--mono);font-size:8px;color:var(--text3);white-space:nowrap">${s.winRate||0}% win · ${s.total||0}</div></div>`;}).join('');
}

function renderLearningStats(data){
  if(!data?.ok)return;
  const {topMissedWinners=[],latestRecommendations=null}=data;
  if(topMissedWinners.length){
    const mwEl=document.getElementById('missedWinnersList');
    if(mwEl)mwEl.innerHTML=topMissedWinners.map(m=>{
      const mult=m.missed_winner_peak_multiple;const mc=mult>=10?'var(--gold)':mult>=5?'var(--green)':'var(--cyan)';
      return`<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid var(--border)"><div><div style="font-family:var(--mono);font-size:11px;color:var(--text1)">$${esc(m.token||'?')}</div><div style="font-family:var(--mono);font-size:8px;color:var(--text3)">Was: ${m.final_decision} · Score: ${m.composite_score||'?'} · ${fmtTime(m.created_at)}</div></div><div style="font-family:var(--mono);font-size:20px;font-weight:900;color:${mc}">${mult?mult.toFixed(1)+'×':'?×'}</div></div>`;
    }).join('');
  }
  if(latestRecommendations?.recommendations?.length){
    const recEl=document.getElementById('aiRecommendations');
    if(recEl)recEl.innerHTML=latestRecommendations.recommendations.slice(0,5).map(r=>`<div style="padding:12px 14px;border-left:3px solid ${r.priority==='HIGH'?'var(--red)':r.priority==='MEDIUM'?'var(--gold)':'var(--cyan)'};background:rgba(0,0,0,0.2);border-radius:0 8px 8px 0;margin-bottom:10px"><div style="font-family:var(--mono);font-size:8px;color:${r.priority==='HIGH'?'var(--red)':'var(--gold)'};letter-spacing:1px;margin-bottom:5px">${r.priority} PRIORITY · ${r.target||'?'} · Confidence: ${r.confidence||'?'}%</div><div style="font-family:var(--mono);font-size:10px;color:var(--text1);margin-bottom:4px">${esc(r.component||'?')} — ${esc((r.suggested||'').slice(0,100))}</div><div style="font-family:var(--mono);font-size:9px;color:var(--text3);line-height:1.4">${esc((r.rationale||'').slice(0,120))} · FP risk: ${r.falsePositiveRisk||'?'}</div></div>`).join('');
  }
}

function renderHeatmap(scores){
  const el=document.getElementById('scoreHeatmap');if(!el)return;
  const bands=Array.from({length:10},(_,i)=>({min:i*10,max:i*10+10,count:0}));
  if(Array.isArray(scores))scores.forEach(s=>{const v=s.score||s.compositeScore||0;bands[Math.min(Math.floor(v/10),9)].count++;});
  const max=Math.max(...bands.map(b=>b.count),1);
  el.innerHTML=bands.map((b,i)=>{
    const int=b.count/max;
    const bg=int<0.1?'rgba(24,255,255,0.1)':int<0.3?'rgba(24,255,255,0.3)':int<0.6?'rgba(24,255,255,0.6)':int<0.8?'rgba(0,230,118,0.7)':'rgba(255,215,64,0.8)';
    const extra=i===3?'outline:1px solid rgba(0,230,118,0.6);outline-offset:1px':'';
    return`<div style="aspect-ratio:1;border-radius:3px;background:${bg};${extra}display:flex;align-items:center;justify-content:center;font-family:var(--mono);font-size:9px;font-weight:700;border:1px solid rgba(255,255,255,0.05)" title="${b.min}-${b.max}: ${b.count}">${b.count}</div>`;
  }).join('');
}

// ── AI BRAIN ──────────────────────────────────────────────
async function loadAI(){
  const [ai,memory]=await Promise.all([apiFetch('/api/openai/status'),apiFetch('/api/ai/memory')]);
  if(ai&&memory){ai.totalEvaluations=memory.totalEvaluations||0;ai.totalCalls=memory.totalCalls||0;ai.wins=memory.wins||0;ai.losses=memory.losses||0;ai.winRate=memory.winRate||'—';}
  if(ai){
    setText('aiEvalsCount',(ai.totalEvaluations||0).toLocaleString());
    setText('aiCallsCount',ai.totalCalls||0);
    setText('aiWrCount',ai.winRate||'—');
    setText('aiWLCount',`Resolved: ${ai.wins||0} WIN / ${ai.losses||0} LOSS — ${ai.totalCalls||0} calls total`);
    setText('aiBigBadge',ai.ftModelActive?'🤖 FT+IN-CTX ACTIVE':'⚡ AI OS ALWAYS ON');
  }
  if(memory)renderAIMemoryPanel(memory);
  startNeuralCanvas(ai,memory);
}

function startNeuralCanvas(ai,memory){
  const canvas=document.getElementById('neuralCanvas');
  if(!canvas)return;
  const ctx=canvas.getContext('2d');
  canvas.width=canvas.offsetWidth||800;
  canvas.height=canvas.offsetHeight||200;
  const W=canvas.width,H=canvas.height;

  // Node positions (6 input, 4 hidden, 2 output)
  const layers=[
    [{x:0.08,y:0.2},{x:0.08,y:0.4},{x:0.08,y:0.6},{x:0.08,y:0.8}],
    [{x:0.25,y:0.15},{x:0.25,y:0.38},{x:0.25,y:0.62},{x:0.25,y:0.85}],
    [{x:0.5,y:0.25},{x:0.5,y:0.5},{x:0.5,y:0.75}],
    [{x:0.75,y:0.25},{x:0.75,y:0.5},{x:0.75,y:0.75}],
    [{x:0.92,y:0.35},{x:0.92,y:0.65}],
  ];
  const colors=['#18ffff','#9c27b0','#ffd740','#00e676'];
  let frame=0,pulses=[];

  // Add a pulse every N frames
  function addPulse(){
    const fromLayer=Math.floor(Math.random()*(layers.length-1));
    const fromNode=Math.floor(Math.random()*layers[fromLayer].length);
    const toNode=Math.floor(Math.random()*layers[fromLayer+1].length);
    pulses.push({fromLayer,fromNode,toNode,progress:0,color:colors[Math.floor(Math.random()*colors.length)]});
  }

  function draw(){
    ctx.clearRect(0,0,W,H);
    // Draw connections
    for(let l=0;l<layers.length-1;l++){
      for(const n1 of layers[l]){
        for(const n2 of layers[l+1]){
          ctx.beginPath();
          ctx.moveTo(n1.x*W,n1.y*H);
          ctx.lineTo(n2.x*W,n2.y*H);
          ctx.strokeStyle='rgba(24,255,255,0.06)';
          ctx.lineWidth=0.5;
          ctx.stroke();
        }
      }
    }
    // Draw pulses
    pulses=pulses.filter(p=>{
      p.progress+=0.02;
      if(p.progress>1)return false;
      const n1=layers[p.fromLayer][p.fromNode];
      const n2=layers[p.fromLayer+1][p.toNode];
      const x=n1.x*W+(n2.x*W-n1.x*W)*p.progress;
      const y=n1.y*H+(n2.y*H-n1.y*H)*p.progress;
      ctx.beginPath();
      ctx.arc(x,y,3,0,Math.PI*2);
      ctx.fillStyle=p.color;
      ctx.shadowColor=p.color;
      ctx.shadowBlur=8;
      ctx.fill();
      ctx.shadowBlur=0;
      return true;
    });
    // Draw nodes
    layers.forEach((layer,li)=>{
      layer.forEach(n=>{
        const grd=ctx.createRadialGradient(n.x*W,n.y*H,0,n.x*W,n.y*H,8);
        grd.addColorStop(0,colors[li%colors.length]);
        grd.addColorStop(1,'transparent');
        ctx.beginPath();
        ctx.arc(n.x*W,n.y*H,5,0,Math.PI*2);
        ctx.fillStyle=grd;
        ctx.fill();
        ctx.beginPath();
        ctx.arc(n.x*W,n.y*H,2,0,Math.PI*2);
        ctx.fillStyle=colors[li%colors.length];
        ctx.fill();
      });
    });
    frame++;
    if(frame%8===0)addPulse();
  }

  // Run at 30fps
  if(window._neuralTimer)clearInterval(window._neuralTimer);
  window._neuralTimer=setInterval(draw,33);
  draw();
}

function renderAIMemoryPanel(memory){
  const el=document.getElementById('aiMemoryPanel');if(!el)return;
  const{gemPatterns=[],configOverrides={},sweetSpot={}}=memory;
  const hasOv=Object.keys(configOverrides).length>0;
  el.innerHTML=`
    <div class="intel-row" style="grid-template-columns:repeat(4,1fr);margin-bottom:14px">
      <div class="intel-tile"><div class="intel-label">Total Evaluations</div><div class="intel-value" style="color:var(--cyan)">${(memory.totalEvaluations||0).toLocaleString()}</div><div class="intel-sub">Every token scanned</div></div>
      <div class="intel-tile"><div class="intel-label">Calls Posted</div><div class="intel-value" style="color:var(--green)">${memory.totalCalls||0}</div><div class="intel-sub">Passed AI + scoring</div></div>
      <div class="intel-tile"><div class="intel-label">Win Rate</div><div class="intel-value" style="color:var(--gold)">${memory.winRate||'—'}</div><div class="intel-sub">${memory.wins||0}W / ${memory.losses||0}L</div></div>
      <div class="intel-tile"><div class="intel-label">Sweet Spot</div><div class="intel-value" style="font-size:14px;color:var(--green)">$${Math.round((sweetSpot.min||10000)/1000)}K–$${Math.round((sweetSpot.max||25000)/1000)}K</div><div class="intel-sub">Target MCap</div></div>
    </div>
    ${gemPatterns.length?`<div style="padding:10px 14px;background:rgba(0,230,118,0.05);border:1px solid rgba(0,230,118,0.15);border-radius:6px;margin-bottom:12px">
      <div style="font-family:var(--mono);font-size:8px;letter-spacing:2px;color:var(--green);margin-bottom:8px">🎯 GEM PATTERNS FROM WINS</div>
      ${gemPatterns.map(p=>`<div style="font-family:var(--mono);font-size:9px;color:var(--text2);margin-bottom:4px">• ${esc(p)}</div>`).join('')}
    </div>`:''}
    <div style="padding:10px 14px;background:rgba(0,0,0,0.3);border:1px solid ${hasOv?'rgba(255,109,0,0.3)':'var(--border)'};border-radius:6px">
      <div style="font-family:var(--mono);font-size:8px;letter-spacing:2px;color:${hasOv?'var(--orange)':'var(--text3)'};margin-bottom:8px">⚙️ ${hasOv?'ACTIVE CONFIG OVERRIDES':'NO OVERRIDES — USING DEFAULTS'}</div>
      ${hasOv?Object.entries(configOverrides).map(([k,v])=>`<div style="font-family:var(--mono);font-size:9px;display:flex;justify-content:space-between;margin-bottom:3px"><span style="color:var(--text3)">${esc(k)}</span><span style="color:var(--orange);font-weight:700">${JSON.stringify(v)}</span></div>`).join(''):'<div style="font-family:var(--mono);font-size:9px;color:var(--text3)">AI runs with default gem hunting parameters.</div>'}
    </div>`;
}

async function startFineTune(){const r=await fetch('/api/openai/finetune',{method:'POST'});const d=await r.json();alert(d.ok?'✓ Fine-tune job started!':'✗ '+d.error);}
async function applyAIConfig(){
  const sm=Number(document.getElementById('cfgSweetSpotMin')?.value)||10000;
  const sx=Number(document.getElementById('cfgSweetSpotMax')?.value)||25000;
  const mm=Number(document.getElementById('cfgMaxMcap')?.value)||150000;
  const st=document.getElementById('cfgStatus');if(st)st.textContent='Applying…';
  await Promise.all([
    fetch(location.origin+'/api/ai/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:'sweetSpotMin',value:sm,reason:'dashboard'})}),
    fetch(location.origin+'/api/ai/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:'sweetSpotMax',value:sx,reason:'dashboard'})}),
    fetch(location.origin+'/api/ai/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:'maxMarketCapOverride',value:mm,reason:'dashboard'})}),
  ]);
  if(st)st.textContent='✓ Applied at '+new Date().toLocaleTimeString();
  setTimeout(()=>loadAI(),2000);
}
async function resetAIConfig(){await fetch(location.origin+'/api/ai/config',{method:'DELETE'});const st=document.getElementById('cfgStatus');if(st)st.textContent='✓ Reset to defaults';setTimeout(()=>loadAI(),2000);}
async function pausePosting(pause){await fetch(location.origin+'/api/ai/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:'pausePosting',value:pause,reason:'dashboard'})});const st=document.getElementById('cfgStatus');if(st)st.textContent=pause?'⏸ Posting PAUSED':'▶ Posting RESUMED';}

async function generateThesis(){
  const input=document.getElementById('thesisTokenInput');
  const query=(input?.value||'').trim();if(!query)return;
  const out=document.getElementById('thesisOutput');const cont=document.getElementById('thesisContent');
  if(out)out.style.display='block';if(cont)cont.innerHTML='<div class="spinner"><div class="spin-dot" style="background:var(--cyan)"></div><div class="spin-dot" style="background:var(--green)"></div><div class="spin-dot" style="background:var(--purple)"></div></div>';
  let ctx='Token: '+query;
  try{const cands=await apiFetch('/api/candidates?limit=200');const rows=cands?.rows||[];const found=rows.find(c=>{const ca=(c.contractAddress||c.contract_address||'').toLowerCase();const tok=(c.token||'').toLowerCase();const q=query.replace(/^\$/,'').toLowerCase();return ca.includes(q)||tok===q||ca===q;});if(found){const c=normalizeCandidate(found);ctx=`Token: $${c.token} (${c.tokenName||''})\nCA: ${c.contractAddress}\nStage: ${c.stage}\nMCap: ${c.marketCap?'$'+Math.round(c.marketCap/1000)+'K':'?'}\nScore: ${c.compositeScore}/100\nAge: ${c.pairAgeHours?.toFixed?.(1)||'?'}h\nDev%: ${c.devWalletPct?.toFixed?.(1)||'?'}%\nTop10: ${c.top10HolderPct?.toFixed?.(1)||'?'}%\nSnipers: ${c.sniperWalletCount??'?'}\nBundle: ${c.bundleRisk||'?'}\nBubbleMap: ${c.bubbleMapRisk||'?'}\nMint: ${c.mintAuthority===0?'REVOKED':c.mintAuthority===1?'ACTIVE':'?'}\nLP: ${c.lpLocked===1?'LOCKED':c.lpLocked===0?'UNLOCKED':'?'}\nVol vel: ${c.volumeVelocity?.toFixed?.(2)||'?'}\nBuy ratio: ${c.buySellRatio1h!=null?(c.buySellRatio1h*100).toFixed(0)+'%':'?'}\nVerdict: ${c.claudeVerdict||'none'}`;}}catch{}
  try{
    const res=await fetch(location.origin+'/api/agent',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({messages:[{role:'user',content:`Generate a full call thesis:\n\n${ctx}\n\n**WHY NOW** — signal\n**UPSIDE CASE** — bull scenario\n**ENTRY THESIS** — on-chain evidence\n**TRAP / RUG RISK** — risks\n**INVALIDATION** — what kills this\n\nBe concise, data-driven.`}],system:'You are Alpha Lennix, elite Solana caller bot. Generate precise, professional call thesis. Data-backed, direct.'})});
    const data=await res.json();const text=data.reply||'Failed.';
    const html=text.replace(/\*\*(WHY NOW)\*\*/g,'<div style="font-family:var(--mono);font-size:9px;letter-spacing:2px;color:var(--cyan);margin:12px 0 6px">📡 WHY NOW</div>').replace(/\*\*(UPSIDE CASE)\*\*/g,'<div style="font-family:var(--mono);font-size:9px;letter-spacing:2px;color:var(--green);margin:12px 0 6px">🚀 UPSIDE CASE</div>').replace(/\*\*(ENTRY THESIS)\*\*/g,'<div style="font-family:var(--mono);font-size:9px;letter-spacing:2px;color:var(--gold);margin:12px 0 6px">🎯 ENTRY THESIS</div>').replace(/\*\*(TRAP \/ RUG RISK)\*\*/g,'<div style="font-family:var(--mono);font-size:9px;letter-spacing:2px;color:var(--orange);margin:12px 0 6px">⚠️ TRAP/RUG RISK</div>').replace(/\*\*(INVALIDATION)\*\*/g,'<div style="font-family:var(--mono);font-size:9px;letter-spacing:2px;color:var(--red);margin:12px 0 6px">🚫 INVALIDATION</div>').replace(/\n/g,'<br>');
    if(cont)cont.innerHTML=html;
  }catch(e){if(cont)cont.innerHTML='<span style="color:var(--red)">Error: '+e.message+'</span>';}
}

// ── SMART MONEY ───────────────────────────────────────────


async function markOutcome(id,outcome){
  try{const r=await fetch(`/api/calls/${id}/outcome`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({outcome})});const d=await r.json();if(d.ok)setTimeout(()=>loadSmartMoney(),1000);}catch{}
}

// ── SYSTEM ────────────────────────────────────────────────
async function loadSystem(){
  const [statsData,modeData,v8Data]=await Promise.all([apiFetch('/api/stats'),apiFetch('/api/mode'),apiFetch('/api/v8/dashboard')]);
  if(statsData){
    const c=statsData.config||{},m=statsData.mode||{};
    setText('sysModeName',m.name||'—');
    setText('cfgThreshold',c.postThreshold!=null?c.postThreshold+'/100':'38/100');
    setText('cfgInterval',c.scanIntervalMs?(c.scanIntervalMs/1000)+'s':'—');
    const cands=await apiFetch('/api/candidates?limit=20');const rows=cands?.rows||[];
    const bOk=rows.filter(c=>c.birdeyeOk||c.birdeye_ok).length,hOk=rows.filter(c=>c.heliusOk||c.helius_ok).length,bmOk=rows.filter(c=>c.bubblemapOk||c.bubblemap_ok).length,tot=rows.length||1;
    const hConn=v8Data?.detection?.heliusConnected||false;const wSize=v8Data?.intelligence?.walletDbSize||0;const wStale=v8Data?.intelligence?.walletDbStale||true;const oaiOk=v8Data?.intelligence?.openaiConfigured||false;
    const src=document.getElementById('sourceHealthList');
    if(src)src.innerHTML=[
      {n:'Helius WebSocket',ok:hConn,d:hConn?'⚡ ~3s detection ACTIVE':'⚠ Disconnected — 90s polling',c:'var(--green)'},
      {n:'DEX Screener',ok:true,d:'New pairs polling — backup coverage',c:'var(--cyan)'},
      {n:'Pump.fun Monitor',ok:true,d:'Pre-bonding coins polled every 45s',c:'var(--green)'},
      {n:'Wallet DB (Dune)',ok:wSize>0,d:wSize>0?`${wSize.toLocaleString()} wallets${wStale?' — ⚠ stale':' — ✓ fresh'}`:'Needs DUNE_API_KEY',c:wSize>1000?'var(--green)':wSize>0?'var(--gold)':'var(--text3)'},
      {n:'Birdeye',ok:bOk>0,d:`${bOk}/${tot} indexed`,c:bOk/tot>0.5?'var(--green)':'var(--orange)'},
      {n:'Helius RPC',ok:hOk>0,d:`${hOk}/${tot} available`,c:hOk/tot>0.5?'var(--green)':'var(--orange)'},
      {n:'BubbleMap',ok:bmOk>0,d:`${bmOk}/${tot} indexed (tokens >2h)`,c:'var(--cyan)'},
      {n:'Claude AI',ok:true,d:'Forensic analysis on every token (STEP 5)',c:'var(--purple)'},
      {n:'OpenAI GPT-4o',ok:oaiOk,d:oaiOk?'Final decision engine active (STEP 6)':'Add OPENAI_API_KEY to Railway',c:oaiOk?'var(--green)':'var(--text3)'},
      {n:'Learning Loop',ok:true,d:'Outcome tracking 30m · Missed winner detection 6h',c:'var(--gold)'},
    ].map(s=>`<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border:1px solid var(--border);border-radius:5px;background:rgba(0,0,0,0.2)"><div style="display:flex;align-items:center;gap:10px"><div style="width:7px;height:7px;border-radius:50%;background:${s.c};box-shadow:0 0 5px ${s.c}"></div><div><div style="font-family:var(--mono);font-size:10px;color:var(--text1)">${s.n}</div><div style="font-family:var(--mono);font-size:8px;color:var(--text3)">${s.d}</div></div></div><span style="font-family:var(--mono);font-size:9px;color:${s.ok?'var(--green)':'var(--orange)'}">${s.ok?'✓ OK':'⚠'}</span></div>`).join('');
  }
  if(modeData){
    const ml=document.getElementById('modeButtonList'),avail=modeData.available||[],curr=modeData.mode?.name;
    if(ml)ml.innerHTML=avail.map(m=>`<div style="border:1px solid ${m.name===curr?'rgba(24,255,255,0.4)':'var(--border)'};border-radius:6px;padding:10px 12px;background:${m.name===curr?'rgba(24,255,255,0.05)':'rgba(0,0,0,0.2)'};cursor:pointer;transition:all 0.15s" onclick="setMode('${m.name}')"><div style="font-family:var(--mono);font-size:11px;color:${m.name===curr?'var(--cyan)':'var(--text1)'};letter-spacing:1px;margin-bottom:4px">${m.emoji} ${m.name}</div><div style="font-family:var(--mono);font-size:8px;color:var(--text3);line-height:1.4">${m.description}</div><div style="font-family:var(--mono);font-size:8px;color:var(--text3);margin-top:5px">Score: ${m.minScore} · MCap: ${m.maxMarketCap?'$'+Math.round(m.maxMarketCap/1000)+'K':'—'} · Age: ${m.maxPairAgeHours}h</div></div>`).join('');
  }
  refreshLog();
}

async function setMode(name){try{await fetch('/api/mode',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:name})});loadSystem();}catch{}}

async function refreshLog(){
  const lv=document.getElementById('logLevelFilter')?.value||'';
  const data=await apiFetch('/api/log?limit=80'+(lv?'&level='+lv:''));
  const el=document.getElementById('systemLog');if(!el)return;
  const rows=data?.rows||[];
  if(!rows.length){el.innerHTML='<div class="empty-state"><div class="empty-icon">📟</div>No log entries</div>';return;}
  el.innerHTML=rows.map(r=>`<div style="display:flex;align-items:baseline;gap:10px;padding:4px 6px;border-radius:3px;font-family:var(--mono);font-size:10px;border-left:2px solid ${r.level==='ERROR'?'var(--red)':r.level==='WARN'?'var(--orange)':'rgba(24,255,255,0.3)'};transition:background 0.1s;margin-bottom:2px" onmouseover="this.style.background='rgba(255,255,255,0.02)'" onmouseout="this.style.background='transparent'"><span style="color:var(--text3);flex-shrink:0">${r.created_at?new Date(r.created_at).toLocaleTimeString():'—'}</span><span style="color:${r.level==='ERROR'?'var(--red)':r.level==='WARN'?'var(--orange)':'var(--cyan)'};width:38px;flex-shrink:0">${r.level||'INFO'}</span><span style="color:rgba(24,255,255,0.5);width:180px;flex-shrink:0;overflow:hidden;text-overflow:ellipsis">${esc(r.event||'')}</span><span style="color:var(--text3);flex:1;overflow:hidden;text-overflow:ellipsis">${esc((r.data||r.message||'').slice(0,120))}</span></div>`).join('');
}

// ── AI AGENT CHAT ─────────────────────────────────────────
function toggleChat(){
  const ov=document.getElementById('chatOverlay');const btn=document.getElementById('chatToggleBtn');
  if(!ov||!btn)return;
  const isOpen=ov.classList.contains('open');
  ov.classList.toggle('open',!isOpen);
  btn.classList.toggle('active',!isOpen);
  if(!isOpen){const inp=document.getElementById('agentInput');if(inp)inp.focus();}
}

async function sendAgentMsg(preset){
  const input=document.getElementById('agentInput');
  const msg=(preset||input?.value||'').trim();if(!msg)return;
  if(input)input.value='';
  addMsg(msg,'user');agentHistory.push({role:'user',content:msg});
  const btn=document.getElementById('agentSendBtn');if(btn)btn.disabled=true;
  const tid='t'+Date.now();const msgs=document.getElementById('agentMessages');
  if(msgs){msgs.innerHTML+=`<div class="chat-msg" id="${tid}"><div class="chat-avatar avatar-bot">🧠</div><div class="chat-bubble bubble-bot"><div class="typing-dots"><div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div></div></div></div>`;msgs.scrollTop=msgs.scrollHeight;}
  try{
    const r=await fetch(location.origin+'/api/agent',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({messages:agentHistory}),signal:AbortSignal.timeout(30000)});
    const d=await r.json();const reply=d.reply||'No response.';
    document.getElementById(tid)?.remove();
    addMsg(reply,'bot');agentHistory.push({role:'assistant',content:reply});
    if(agentHistory.length>20)agentHistory=agentHistory.slice(-16);
  }catch(e){
    document.getElementById(tid)?.remove();
    addMsg(`Connection error: ${e.message}. Check that /api/agent is working on the bot server.`,'bot');
  }
  if(btn)btn.disabled=false;
}

function addMsg(text,role){
  const msgs=document.getElementById('agentMessages');if(!msgs)return;
  const avatar=role==='bot'?`<div class="chat-avatar avatar-bot">🧠</div>`:`<div class="chat-avatar avatar-user">YOU</div>`;
  const safe=esc(text).replace(/\n/g,'<br>');
  msgs.innerHTML+=`<div class="chat-msg ${role}">${avatar}<div class="chat-bubble bubble-${role}">${safe}</div></div>`;
  msgs.scrollTop=msgs.scrollHeight;
}

// ── MODALS ────────────────────────────────────────────────
async function openCandidateById(id){
  if(!id)return;
  document.getElementById('candidateModal')?.classList.add('open');
  setText('modalTokenName','Loading...');setText('modalCA','');
  document.getElementById('modalBody').innerHTML='<div class="spinner"><div class="spin-dot" style="background:var(--cyan)"></div><div class="spin-dot" style="background:var(--green)"></div><div class="spin-dot" style="background:var(--purple)"></div></div>';
  const data=await apiFetch(`/api/candidates/${id}`);
  if(!data?.candidate){document.getElementById('modalBody').innerHTML='<div class="empty-state"><div class="empty-icon">❌</div>Failed to load</div>';return;}
  const c=normalizeCandidate(data.candidate);
  setText('modalTokenName',`$${c.token||'?'} — ${c.tokenName||''}`);
  setText('modalCA',c.contractAddress||'—');
  const decEl=document.getElementById('modalDecisionBadge');
  if(decEl)decEl.innerHTML=`<span style="font-family:var(--mono);font-size:10px;padding:4px 12px;border-radius:3px;color:${decColor(c.finalDecision)};border:1px solid ${decColor(c.finalDecision)}44;background:${decColor(c.finalDecision)}11">${c.finalDecision||'—'}</span>`;
  document.getElementById('modalBody').innerHTML=buildAuditDetail(c);
}

async function openCandidate(ca){
  if(!ca)return;
  const found=allCandidatesData.find(c=>c.contractAddress===ca);
  if(found?.id){openCandidateById(found.id);return;}
  const data=await apiFetch('/api/candidates?limit=200');
  const match=(data?.rows||[]).find(c=>(c.contractAddress||c.contract_address)===ca);
  if(match?.id)openCandidateById(match.id);
}

function closeModal(){document.getElementById('candidateModal')?.classList.remove('open');}

function openPromotedModal(r){
  if(typeof r==='string'){try{r=JSON.parse(r);}catch{return;}}
  const qs=r.quick_score??0;const col=qs>=80?'var(--gold)':qs>=65?'var(--green)':qs>=50?'var(--cyan)':'var(--orange)';
  setText('pmTokenName',`$${r.token||'?'}`);setText('pmCA',r.contract_address||'—');
  const lvls=sltp(r.market_cap);const ago=timeAgo(r.scanned_at);
  const links=[r.website?`<a href="${r.website}" target="_blank" style="color:var(--cyan);text-decoration:none;font-family:var(--mono);font-size:10px">🌐 Website</a>`:'',r.twitter?`<a href="${r.twitter}" target="_blank" style="color:var(--cyan);text-decoration:none;font-family:var(--mono);font-size:10px">𝕏 Twitter</a>`:'',r.telegram?`<a href="${r.telegram}" target="_blank" style="color:var(--cyan);text-decoration:none;font-family:var(--mono);font-size:10px">✈ Telegram</a>`:''].filter(Boolean).join('  ·  ');
  document.getElementById('pmBody').innerHTML=`
    <!-- Token image + external links row -->
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:14px;flex-wrap:wrap">
      <img src="https://dd.dexscreener.com/ds-data/tokens/solana/${r.contract_address||''}.png"
           onerror="this.style.display='none'"
           style="width:48px;height:48px;border-radius:50%;border:2px solid rgba(255,255,255,0.1);object-fit:cover;flex-shrink:0"
           alt="">
      <div style="flex:1">
        <img src="https://dd.dexscreener.com/ds-data/tokens/solana/${r.contract_address||''}/header.png"
             onerror="this.style.display='none'"
             style="width:100%;max-height:60px;border-radius:6px;object-fit:cover;border:1px solid rgba(255,255,255,0.06)"
             alt="">
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        <a href="https://dexscreener.com/solana/${r.contract_address||''}" target="_blank" style="padding:6px 10px;background:rgba(0,230,118,0.1);border:1px solid rgba(0,230,118,0.3);border-radius:5px;color:var(--green);text-decoration:none;font-family:var(--mono);font-size:9px;font-weight:700">📊 DEXSCREENER</a>
        <a href="https://pump.fun/${r.contract_address||''}" target="_blank" style="padding:6px 10px;background:rgba(255,109,0,0.1);border:1px solid rgba(255,109,0,0.3);border-radius:5px;color:var(--orange);text-decoration:none;font-family:var(--mono);font-size:9px;font-weight:700">⚡ PUMP.FUN</a>
        <a href="https://birdeye.so/token/${r.contract_address||''}?chain=solana" target="_blank" style="padding:6px 10px;background:rgba(224,64,251,0.08);border:1px solid rgba(224,64,251,0.3);border-radius:5px;color:var(--purple);text-decoration:none;font-family:var(--mono);font-size:9px">🦅 BIRDEYE</a>
      </div>
    </div>
    <div style="display:flex;align-items:center;gap:24px;padding:18px;background:rgba(0,0,0,0.3);border-radius:8px;margin-bottom:16px">
      <div style="text-align:center"><div style="font-family:var(--mono);font-size:56px;font-weight:900;color:${col};line-height:1">${qs}</div><div style="font-family:var(--mono);font-size:8px;color:var(--text3);letter-spacing:2px;margin-top:4px">QUICK SCORE</div></div>
      <div style="flex:1">
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px">${isBrandNew(r.pair_age_hours)?'<span class="new-badge">⚡ BRAND NEW</span>':''}<span style="font-family:var(--mono);font-size:9px;padding:3px 10px;border-radius:3px;color:${stageCol(r.stage)};border:1px solid ${stageCol(r.stage)}44">${r.stage||'?'}</span></div>
        <div style="font-family:var(--mono);font-size:10px;color:var(--text3)">Age: ${r.pair_age_hours?.toFixed?.(2)||'—'}h · Scanned: ${ago}</div>
        <!-- Large stat display -->
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-top:10px;margin-bottom:4px">
          <div style="background:rgba(0,0,0,0.4);border:1px solid rgba(255,109,0,0.25);border-radius:8px;padding:10px;text-align:center">
            <div style="font-family:var(--mono);font-size:8px;color:var(--text3);letter-spacing:1px;margin-bottom:4px">MARKET CAP</div>
            <div style="font-family:var(--mono);font-size:18px;font-weight:800;color:var(--orange)">${fmt(r.market_cap,'$')}</div>
          </div>
          <div style="background:rgba(0,0,0,0.4);border:1px solid rgba(24,255,255,0.2);border-radius:8px;padding:10px;text-align:center">
            <div style="font-family:var(--mono);font-size:8px;color:var(--text3);letter-spacing:1px;margin-bottom:4px">LIQUIDITY</div>
            <div style="font-family:var(--mono);font-size:18px;font-weight:800;color:var(--cyan)">${fmt(r.liquidity,'$')}</div>
          </div>
          <div style="background:rgba(0,0,0,0.4);border:1px solid rgba(0,230,118,0.2);border-radius:8px;padding:10px;text-align:center">
            <div style="font-family:var(--mono);font-size:8px;color:var(--text3);letter-spacing:1px;margin-bottom:4px">VOL 1H</div>
            <div style="font-family:var(--mono);font-size:18px;font-weight:800;color:var(--green)">${fmt(r.volume_1h,'$')}</div>
          </div>
        </div>
        <div style="font-family:var(--mono);font-size:9px;color:var(--text3);text-align:center">Age: ${r.pair_age_hours!=null?r.pair_age_hours.toFixed(2)+'h':'?'} · Stage: ${r.stage||'?'} · Scanned: ${ago}</div>
        <div style="font-family:var(--mono);font-size:10px;color:var(--green);margin-top:4px">Buys 1h: ${r.buys_1h??'—'} · Buy ratio: ${r.buy_ratio_1h!=null?(r.buy_ratio_1h*100).toFixed(0)+'%':'—'} · Vol vel: ${r.volume_velocity?.toFixed?.(2)||'—'}</div>
        <div style="font-family:var(--mono);font-size:10px;color:var(--text3);margin-top:4px">Promote reason: ${esc(r.filter_reason||'—')}</div>
      </div>
    </div>
    ${lvls?`<div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:8px;margin-bottom:14px">
      <div style="text-align:center;padding:10px;background:rgba(255,23,68,0.06);border:1px solid rgba(255,23,68,0.2);border-radius:6px"><div style="font-family:var(--mono);font-size:8px;color:var(--text3);margin-bottom:4px">🛑 SL -25%</div><div style="font-family:var(--mono);font-size:14px;font-weight:700;color:var(--red)">${fmt(lvls.sl,'$')}</div></div>
      <div style="text-align:center;padding:10px;background:rgba(24,255,255,0.04);border:1px solid rgba(24,255,255,0.15);border-radius:6px"><div style="font-family:var(--mono);font-size:8px;color:var(--text3);margin-bottom:4px">🎯 TP1 2×</div><div style="font-family:var(--mono);font-size:14px;font-weight:700;color:var(--cyan)">${fmt(lvls.tp1,'$')}</div></div>
      <div style="text-align:center;padding:10px;background:rgba(255,215,64,0.04);border:1px solid rgba(255,215,64,0.15);border-radius:6px"><div style="font-family:var(--mono);font-size:8px;color:var(--text3);margin-bottom:4px">🎯 TP2 5×</div><div style="font-family:var(--mono);font-size:14px;font-weight:700;color:var(--gold)">${fmt(lvls.tp2,'$')}</div></div>
      <div style="text-align:center;padding:10px;background:rgba(0,230,118,0.04);border:1px solid rgba(0,230,118,0.15);border-radius:6px"><div style="font-family:var(--mono);font-size:8px;color:var(--text3);margin-bottom:4px">🚀 TP3 10×</div><div style="font-family:var(--mono);font-size:14px;font-weight:700;color:var(--green)">${fmt(lvls.tp3,'$')}</div></div>
    </div>`:''}
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:14px">
      <div style="background:rgba(0,0,0,0.3);border:1px solid var(--border);border-radius:6px;padding:10px"><div style="font-family:var(--mono);font-size:8px;color:var(--text3);margin-bottom:4px">5M / 1H</div><div style="font-family:var(--mono);font-size:11px">${fmtPct(r.price_change_5m)} / ${fmtPct(r.price_change_1h)}</div></div>
      <div style="background:rgba(0,0,0,0.3);border:1px solid var(--border);border-radius:6px;padding:10px"><div style="font-family:var(--mono);font-size:8px;color:var(--text3);margin-bottom:4px">BUYS / SELLS 1H</div><div style="font-family:var(--mono);font-size:11px;color:var(--green)">${r.buys_1h??'—'} 🟢 <span style="color:var(--red)">${r.sells_1h??'—'} 🔴</span></div></div>
      <div style="background:rgba(0,0,0,0.3);border:1px solid var(--border);border-radius:6px;padding:10px"><div style="font-family:var(--mono);font-size:8px;color:var(--text3);margin-bottom:4px">BUY RATIO / VOL VEL</div><div style="font-family:var(--mono);font-size:11px">${r.buy_ratio_1h!=null?(r.buy_ratio_1h*100).toFixed(0)+'%':'—'} / ${r.volume_velocity?.toFixed?.(2)||'—'}</div></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:14px">
      <div style="background:rgba(0,0,0,0.3);border:1px solid var(--border);border-radius:6px;padding:10px"><div style="font-family:var(--mono);font-size:8px;color:var(--text3);margin-bottom:4px">BUNDLE RISK</div><div style="font-family:var(--mono);font-size:11px;color:${r.bundle_risk==='NONE'||!r.bundle_risk?'var(--green)':r.bundle_risk==='SEVERE'?'var(--red)':'var(--orange)'}">${r.bundle_risk||'—'}</div></div>
      <div style="background:rgba(0,0,0,0.3);border:1px solid var(--border);border-radius:6px;padding:10px"><div style="font-family:var(--mono);font-size:8px;color:var(--text3);margin-bottom:4px">SNIPER COUNT</div><div style="font-family:var(--mono);font-size:11px;color:${(r.sniper_wallet_count||0)===0?'var(--green)':(r.sniper_wallet_count||0)>10?'var(--red)':'var(--orange)'}">${r.sniper_wallet_count??'—'} wallets</div></div>
      <div style="background:rgba(0,0,0,0.3);border:1px solid var(--border);border-radius:6px;padding:10px"><div style="font-family:var(--mono);font-size:8px;color:var(--text3);margin-bottom:4px">BUBBLEMAP RISK</div><div style="font-family:var(--mono);font-size:11px;color:${r.bubble_map_risk==='CLEAN'?'var(--green)':r.bubble_map_risk==='SEVERE'?'var(--red)':'var(--text3)'}">${r.bubble_map_risk||'—'}</div></div>
    </div>
    <div style="background:rgba(0,0,0,0.3);border:1px solid var(--border);border-radius:6px;padding:10px;display:flex;align-items:center;justify-content:space-between;margin-bottom:${links?'12px':'0'}">
      <code style="font-family:var(--mono);font-size:9px;color:var(--text3);word-break:break-all">${r.contract_address||'—'}</code>
      <button onclick="copyCA('${r.contract_address}')" style="background:rgba(24,255,255,0.1);border:1px solid rgba(24,255,255,0.3);color:var(--cyan);border-radius:3px;padding:4px 12px;font-family:var(--mono);font-size:9px;cursor:pointer;white-space:nowrap;margin-left:10px">📋 COPY CA</button>
    </div>
    ${links?`<div style="display:flex;gap:16px;padding:10px;background:rgba(0,0,0,0.2);border-radius:6px">${links}</div>`:''}`;
  document.getElementById('promotedModal')?.classList.add('open');
}
function closePromotedModal(){document.getElementById('promotedModal')?.classList.remove('open');}

// Modal close on backdrop click
document.getElementById('candidateModal')?.addEventListener('click',e=>{if(e.target===e.currentTarget)closeModal();});
document.getElementById('promotedModal')?.addEventListener('click',e=>{if(e.target===e.currentTarget)closePromotedModal();});

// ── AUTO REFRESH ──────────────────────────────────────────
function startAutoRefresh(){
  if(refreshTimer)clearInterval(refreshTimer);
  refreshTimer=setInterval(()=>{
    refreshTabData(currentTab);
    loadPromotedSidebar(); // sidebar always refreshes
  },15000);
}

// ── BOOT ──────────────────────────────────────────────────
loadOverview();
loadPromotedSidebar();


// ── MOBILE NAVIGATION ─────────────────────────────────────
let _mobileMenuOpen=false,_mobileSidebarOpen=false;
function toggleMobileMenu(){
  _mobileMenuOpen=!_mobileMenuOpen;
  const tabs=document.querySelector('.header-tabs');
  if(tabs)tabs.classList.toggle('mobile-open',_mobileMenuOpen);
}
function toggleMobileSidebar(){
  _mobileSidebarOpen=!_mobileSidebarOpen;
  const sb=document.querySelector('.promoted-sidebar');
  if(sb)sb.classList.toggle('mobile-open',_mobileSidebarOpen);
}
// Close mobile menu when tab is clicked
document.querySelectorAll('.htab').forEach(t=>{
  t.addEventListener('click',()=>{
    _mobileMenuOpen=false;
    document.querySelector('.header-tabs')?.classList.remove('mobile-open');
  });
});

// ── DUNE WALLET SCAN ──────────────────────────────────────
async function triggerWalletScan(){
  const btn=document.getElementById('scanWalletsBtn');
  const status=document.getElementById('dwScanStatus');
  const badge=document.getElementById('duneScanBadge');
  const reset=(msg,err=false)=>{
    if(btn){btn.disabled=false;btn.textContent='⚡ RUN WALLET SCAN NOW';}
    if(badge)badge.textContent=err?'ERROR':'READY';
    if(status)status.style.color=err?'var(--red)':'var(--text3)';
    if(status)status.textContent=msg;
  };
  if(btn){btn.disabled=true;btn.textContent='⏳ CONNECTING TO DUNE...';}
  if(status){status.style.color='var(--cyan)';status.textContent='Sending request to bot server...';}
  if(badge)badge.textContent='CONNECTING';
  try{
    const res=await fetch(location.origin+'/api/v8/dune-wallet-scan',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      signal:AbortSignal.timeout(15000),
    });
    const data=await res.json();
    if(data.ok&&(data.started||data.message?.includes('progress'))){
      if(status){status.style.color='var(--green)';status.textContent='✓ '+data.message;}
      if(badge)badge.textContent='SCANNING';
      if(btn)btn.textContent='⏳ SCANNING...';
      // Poll every 5 seconds for up to 3 minutes
      let polls=0,prevCount=0;
      const pollTimer=setInterval(async()=>{
        polls++;
        await loadDuneStatus();
        const el=document.getElementById('dwTotal');
        const count=parseInt((el?.textContent||'0').replace(/,/g,''))||0;
        if(status&&polls%2===0)status.textContent=`⏳ Dune processing... ${count>0?count.toLocaleString()+' wallets so far':polls*5+'s elapsed'}`;
        if(count>100||(polls>5&&count>prevCount&&count>0)){
          clearInterval(pollTimer);
          if(badge)badge.textContent='✓ '+count.toLocaleString()+' LOADED';
          if(status){status.style.color='var(--green)';status.textContent=`✓ Scan complete — ${count.toLocaleString()} wallets loaded from Dune. Cross-referencing active on all future scans.`;}
          if(btn){btn.disabled=false;btn.textContent='⚡ RUN WALLET SCAN NOW';}
        }
        if(polls>=36){
          clearInterval(pollTimer);
          reset('Scan may still be running in background. Click REFRESH STATUS to check.',false);
        }
        prevCount=count;
      },5000);
    }else if(data.ok===false){
      reset('✗ '+( data.error||'Scan failed')+'.',true);
    }else{
      // Already scanning
      if(status){status.style.color='var(--gold)';status.textContent=data.message||'Scan in progress...';}
      if(badge)badge.textContent='SCANNING';
      if(btn){btn.disabled=false;btn.textContent='⚡ RUN WALLET SCAN NOW';}
    }
  }catch(e){
    if(e.name==='TimeoutError'||e.name==='AbortError'){
      reset('Request timed out. The bot server may be starting up — try again in 30 seconds.',true);
    }else{
      reset('Connection error: '+e.message+'. Make sure the bot is running on Railway.',true);
    }
  }
}

async function loadDuneStatus(){
  const data=await apiFetch('/api/v8/dune-wallet-status');
  if(!data?.ok)return;
  const cats=data.categories||{};
  setText('dwTotal',(data.totalWallets||0).toLocaleString());
  setText('dwWinners',(cats.WINNER||0).toLocaleString());
  setText('dwSmart',((cats.SMART_MONEY||0)+(cats.MOMENTUM||0)).toLocaleString());
  setText('dwSnipers',(cats.SNIPER||0).toLocaleString());
  setText('dwRug',(cats.RUG||cats.RUG_ASSOCIATED||0).toLocaleString());
  setText('dwLastSync',data.lastSync?timeAgo(data.lastSync):'Never');
  setText('dwStale',data.isStale?'⚠ Refresh recommended':'✓ Fresh data');
  const badge=document.getElementById('duneScanBadge');
  if(badge){
    if(data.scanning){badge.textContent='SCANNING...';}
    else if(data.totalWallets>0){badge.textContent=data.totalWallets.toLocaleString()+' WALLETS LOADED';}
    else{badge.textContent='READY — NO DATA YET';}
  }
  // Update sidebar count2
  setText('sidebarCount2',(_promotedAll.length||'?')+' promoted');
}


// ═══════════════════════════════════════════════════════════
//  PULSE CALLER v8.0 — SUPREME DASHBOARD JS
// ═══════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════
//  WALLET TRACKER — Full CRUD + Display
// ══════════════════════════════════════════════════════

let _walletFilter='ALL',_allWallets=[];

async function loadWalletTracker(){
  const sort=document.getElementById('walletSort')?.value||'score';
  const search=document.getElementById('walletSearch')?.value||'';
  const cat=_walletFilter==='ALL'?'':_walletFilter;
  const url=`/api/wallets?sort=${sort}${cat?'&category='+cat:''}${search?'&search='+encodeURIComponent(search):''}&limit=500`;
  const data=await apiFetch(url);if(!data)return;
  _allWallets=data.wallets||[];
  renderWalletTable(_allWallets);
  const st=data.stats||{};
  setText('wt-total',st.total||0);setText('wt-manual',st.manual||0);setText('wt-dune',st.dune||0);
  setText('smWallets',st.total||0);
  if(st.winners!=null)setText('dwWinners',st.winners);
  if(st.snipers!=null)setText('dwSnipers',st.snipers);
}

function renderWalletTable(wallets){
  const tbody=document.getElementById('walletTrackerBody');if(!tbody)return;
  if(!wallets.length){
    tbody.innerHTML=`<tr><td colspan="12"><div class="empty-state"><div class="empty-icon">🗂</div><div>No wallets tracked yet</div><div class="empty-hint">Add wallets manually above or run the Dune Wallet Scan</div></div></td></tr>`;
    return;
  }
  const catC={WINNER:'var(--gold)',SMART_MONEY:'var(--cyan)',MOMENTUM:'var(--green)',SNIPER:'var(--orange)',CLUSTER:'var(--red)',FARM:'var(--text3)',RUG:'var(--red)',NEUTRAL:'var(--text3)'};
  const catI={WINNER:'🏆',SMART_MONEY:'🧠',MOMENTUM:'📈',SNIPER:'🎯',CLUSTER:'⚠',FARM:'🌾',RUG:'☠',NEUTRAL:'⚪'};
  const srcC={manual:'var(--cyan)',dune:'var(--purple)',dune_top_pnl:'var(--purple)',dune_pumpfun:'var(--orange)',dune_sniper:'var(--orange)',db_restore:'var(--text3)'};
  tbody.innerHTML=wallets.map(w=>{
    const col=catC[w.category]||'var(--text3)';
    const icon=catI[w.category]||'⚪';
    const srcCol=srcC[w.source]||'var(--text3)';
    const wr=w.win_rate!=null?(w.win_rate*100).toFixed(1)+'%':'—';
    const roi=w.avg_roi!=null?'$'+Math.round(w.avg_roi).toLocaleString():'—';
    const scoreC=(w.score||0)>=70?'var(--green)':(w.score||0)>=40?'var(--gold)':'var(--text3)';
    const sa=w.address?w.address.slice(0,8)+'…'+w.address.slice(-4):'—';
    const isBL=w.is_blacklist===1;
    return`<tr style="opacity:${isBL?'0.6':'1'}">
      <td><div style="display:flex;align-items:center;gap:5px"><code style="font-family:var(--mono);font-size:9px;color:var(--cyan)">${sa}</code><button onclick="copyCA('${w.address}')" style="background:transparent;border:none;color:var(--text3);cursor:pointer;font-size:10px">📋</button><a href="https://solscan.io/account/${w.address}" target="_blank" style="color:var(--text3);font-size:10px;text-decoration:none">🔍</a></div>${isBL?'<span style="font-family:var(--mono);font-size:7px;color:var(--red);background:rgba(255,23,68,0.1);padding:1px 5px;border-radius:2px">BL</span>':''}</td>
      <td><div style="font-family:var(--mono);font-size:10px">${esc(w.label||'—')}</div><div style="font-family:var(--mono);font-size:8px;color:var(--text3)">${esc(w.tags||'')}</div></td>
      <td><span style="font-family:var(--mono);font-size:9px;color:${col};background:${col}15;padding:2px 7px;border-radius:3px;border:1px solid ${col}33">${icon} ${w.category||'?'}</span></td>
      <td><span style="font-family:var(--mono);font-size:8px;color:${srcCol}">${w.source||'?'}</span></td>
      <td><span style="font-family:var(--mono);font-size:13px;font-weight:700;color:${scoreC}">${w.score||0}</span></td>
      <td style="font-family:var(--mono);font-size:10px;color:${parseFloat(wr)>=30?'var(--green)':parseFloat(wr)>=15?'var(--gold)':'var(--text3)'}">${wr}</td>
      <td style="font-family:var(--mono);font-size:10px;color:${(w.avg_roi||0)>0?'var(--green)':'var(--red)'}">${roi}</td>
      <td style="font-family:var(--mono);font-size:10px">${(w.trade_count||0).toLocaleString()}</td>
      <td style="font-family:var(--mono);font-size:10px;color:var(--green)">${w.wins_found_in||0}</td>
      <td style="font-family:var(--mono);font-size:9px;color:var(--text3);max-width:120px;overflow:hidden;text-overflow:ellipsis">${esc(w.notes||'')}</td>
      <td style="font-family:var(--mono);font-size:8px;color:var(--text3)">${w.created_at?timeAgo(w.created_at):'—'}</td>
      <td><div style="display:flex;gap:4px">
        <button onclick="editWallet('${w.address}')" style="background:rgba(24,255,255,0.08);border:1px solid rgba(24,255,255,0.2);color:var(--cyan);border-radius:3px;padding:3px 6px;font-family:var(--mono);font-size:8px;cursor:pointer">✏</button>
        <button onclick="analyzeWallet('${w.address}')" style="background:rgba(0,230,118,0.08);border:1px solid rgba(0,230,118,0.2);color:var(--green);border-radius:3px;padding:3px 6px;font-family:var(--mono);font-size:8px;cursor:pointer">🔬</button>
        ${w.source==='manual'?`<button onclick="deleteWallet('${w.address}')" style="background:rgba(255,23,68,0.08);border:1px solid rgba(255,23,68,0.2);color:var(--red);border-radius:3px;padding:3px 6px;font-family:var(--mono);font-size:8px;cursor:pointer">✕</button>`:''}
      </div></td>
    </tr>`;
  }).join('');
}

function setWalletFilter(btn,cat){
  document.querySelectorAll('#tab-smart .fchip').forEach(b=>{b.classList.remove('active');b.style.cssText='';});
  btn.classList.add('active');btn.style.color='var(--cyan)';btn.style.borderColor='rgba(24,255,255,0.4)';btn.style.background='rgba(24,255,255,0.06)';
  _walletFilter=cat;loadWalletTracker();
}

function filterWalletTable(){
  const term=document.getElementById('walletSearch')?.value?.toLowerCase()||'';
  if(!term){renderWalletTable(_allWallets);return;}
  renderWalletTable(_allWallets.filter(w=>(w.address||'').toLowerCase().includes(term)||(w.label||'').toLowerCase().includes(term)||(w.notes||'').toLowerCase().includes(term)));
}

async function addWalletManually(){
  const address=document.getElementById('walletAddressInput')?.value?.trim();
  const label=document.getElementById('walletLabelInput')?.value?.trim();
  const category=document.getElementById('walletCatInput')?.value||'NEUTRAL';
  const status=document.getElementById('walletAddStatus');
  if(!address||address.length<32){if(status){status.style.color='var(--red)';status.textContent='✗ Enter a valid Solana address (32+ chars)';}return;}
  if(status){status.style.color='var(--cyan)';status.textContent='Adding...';}
  try{
    const res=await fetch('/api/wallets',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({address,label,category})});
    const d=await res.json();
    if(d.ok){if(status){status.style.color='var(--green)';status.textContent='✓ '+d.message;}document.getElementById('walletAddressInput').value='';document.getElementById('walletLabelInput').value='';setTimeout(()=>loadWalletTracker(),500);}
    else{if(status){status.style.color='var(--red)';status.textContent='✗ '+d.error;}}
  }catch(e){if(status){status.style.color='var(--red)';status.textContent='✗ '+e.message;}}
}

async function deleteWallet(address){
  if(!confirm('Remove '+address.slice(0,12)+'... from tracker?'))return;
  const res=await fetch('/api/wallets/'+address,{method:'DELETE'});
  const d=await res.json();if(d.ok)loadWalletTracker();
}

async function editWallet(address){
  const w=_allWallets.find(x=>x.address===address);if(!w)return;
  const label=prompt('Label:',w.label||'');if(label===null)return;
  const notes=prompt('Notes:',w.notes||'');
  const category=prompt('Category (WINNER/SMART_MONEY/SNIPER/CLUSTER/RUG/NEUTRAL):',w.category||'NEUTRAL');
  const res=await fetch('/api/wallets/'+address,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({label:label||undefined,notes:notes||undefined,category:category||undefined})});
  const d=await res.json();if(d.ok)loadWalletTracker();
}

async function analyzeWallet(address){
  const res=await fetch('/api/wallets/'+address+'/analyze',{method:'POST'});
  const data=await res.json();if(!data.ok){alert('Failed: '+data.error);return;}
  const p=data.profile,d=data.dbRecord;
  alert(['Wallet: '+address,'Category: '+(d?.category||p?.category||'Unknown'),'Score: '+(d?.score||p?.score||'?')+'/100','Win Rate: '+(d?.win_rate!=null?(d.win_rate*100).toFixed(1)+'%':'?'),'Trades: '+(d?.trade_count||p?.tradeCount||'?'),'In Dune Memory: '+(data.inMemory?'Yes':'No'),'Call History: '+(data.callHistory?.length||0)+' calls'].join('\n'));
}

// Smart money tab loading handled by loadSmartMoneyTab()



// ══════════════════════════════════════════════════════
//  AUTONOMOUS AGENT SYSTEM
// ══════════════════════════════════════════════════════

let _agentTab = 'chat';
let _agentMsgs = []; // full conversation history
let _agentAutoApply = false;
let _pendingActions = []; // proposed changes awaiting approval

function switchAgentTab(tab) {
  _agentTab = tab;
  document.querySelectorAll('.agent-tab').forEach(b => {
    b.classList.remove('active');
    b.style.cssText = '';
  });
  document.querySelectorAll('.agent-tab-panel').forEach(p => { p.style.display = 'none'; });
  const btn = document.getElementById('atab-' + tab);
  if (btn) { btn.classList.add('active'); }
  const panel = document.getElementById('agent-tab-' + tab);
  if (panel) panel.style.display = tab === 'chat' ? 'flex' : 'block';
  if (tab === 'actions') loadAgentHistory();
  if (tab === 'rec')     loadAgentRecs();
  if (tab === 'data')    loadAgentData();
}

function toggleAgentAutoApply(cb) {
  _agentAutoApply = cb.checked;
  apiFetch('/api/ai/config', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ key: 'agentAutoApply', value: _agentAutoApply, reason: 'dashboard toggle' })
  });
  const badge = document.getElementById('agentStatusBadge');
  if (badge) {
    badge.textContent = _agentAutoApply ? '🔥 AUTO-APPLY ON' : '⚡ READY';
    badge.style.color = _agentAutoApply ? 'var(--orange)' : 'var(--green)';
    badge.style.borderColor = _agentAutoApply ? 'rgba(255,109,0,0.4)' : 'rgba(0,230,118,0.3)';
  }
}

function appendAgentMessage(role, content, extra) {
  const msgs = document.getElementById('agentMessages');
  if (!msgs) return;
  const isBot = role === 'bot';
  const div = document.createElement('div');
  div.className = isBot ? 'agent-msg-bot' : 'agent-msg-user';

  const avatar = `<div class="agent-avatar" style="background:${isBot ? 'linear-gradient(135deg,#448aff,#9c27b0)' : 'rgba(0,230,118,0.2);border:1px solid rgba(0,230,118,0.4)'}">${isBot ? '🤖' : '👤'}</div>`;
  const bubble = `<div class="${isBot ? 'agent-bubble-bot' : 'agent-bubble-user'}">${esc(content)}${extra || ''}</div>`;
  div.innerHTML = isBot ? avatar + bubble : bubble + avatar;
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
}

function showAgentTyping() {
  const msgs = document.getElementById('agentMessages');
  if (!msgs) return;
  const div = document.createElement('div');
  div.className = 'agent-msg-bot';
  div.id = 'agentTyping';
  div.innerHTML = `<div class="agent-avatar" style="background:linear-gradient(135deg,#448aff,#9c27b0)">🤖</div><div class="agent-bubble-bot"><div class="typing-indicator"><div class="typing-dot-agent"></div><div class="typing-dot-agent"></div><div class="typing-dot-agent"></div></div></div>`;
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
}

function removeAgentTyping() {
  const el = document.getElementById('agentTyping');
  if (el) el.remove();
}

async function sendAgentMessage() {
  const input = document.getElementById('agentInput');
  const btn   = document.getElementById('agentSendBtn');
  const text  = input?.value?.trim();
  if (!text) return;
  input.value = '';
  input.disabled = true;
  if (btn) btn.disabled = true;

  appendAgentMessage('user', text);
  _agentMsgs.push({ role: 'user', content: text });

  showAgentTyping();
  try {
    const res  = await fetch('/api/agent', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ messages: _agentMsgs.slice(-20) }),
      signal: AbortSignal.timeout(35000),
    });
    const data = await res.json();
    removeAgentTyping();
    const reply = data.reply || data.error || 'No response';
    _agentMsgs.push({ role: 'assistant', content: reply });
    appendAgentMessage('bot', reply);
  } catch (e) {
    removeAgentTyping();
    appendAgentMessage('bot', '⚠ Error: ' + e.message + '. Check bot is running.');
  } finally {
    if (input) input.disabled = false;
    if (btn)   btn.disabled   = false;
    input?.focus();
  }
}

async function runAutonomousAgent(mode){
  const badge=document.getElementById('agentStatusBadge');
  if(badge){badge.textContent='⏳ ANALYZING...';badge.style.color='var(--cyan)';}
  const labels={analyze:'🔍 Bot A analyzing data, Bot B reviewing...',optimize:'⚡ Bot A proposing optimizations, Bot B validating...',wallets:'👥 Bot A analyzing wallets, Bot B reviewing...',survivors:'🏆 Bot A scanning survivors, Bot B validating...',review:'📋 Bot A reviewing 24h, Bot B checking...'};
  appendAgentMessage('bot',labels[mode]||'Running dual-agent analysis...');
  showAgentTyping();
  try{
    const res=await fetch('/api/agent/autonomous',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode,autoApply:_agentAutoApply}),signal:AbortSignal.timeout(90000)});
    const data=await res.json();
    removeAgentTyping();
    if(!data.ok){
      appendAgentMessage('bot',data.error?.includes('freeze')?'🔒 SYSTEM FREEZE ACTIVE — changes paused. Lift freeze in Data tab.':'✗ Agent error: '+(data.error||'Unknown'));
      return;
    }
    const botA=data.bot_a||{},botB=data.bot_b||null;
    let msg='🤖 BOT A (Hunter):\n'+(botA.analysis||botA.message||'Analysis complete');
    if(botA.findings&&botA.findings.length) msg+='\n\n📊 Findings:\n'+botA.findings.slice(0,4).map(function(f){return '• '+f;}).join('\n');
    if(botB){
      msg+='\n\n🧠 BOT B (Critic):\nVerdict: '+(botB.verdict||'?')+' | Risk: '+(botB.risk_confirmed||'?');
      if(botB.critique) msg+='\n'+botB.critique.slice(0,200);
      if(!botB.auto_apply_allowed) msg+='\n⚠ Bot B blocked auto-apply — approve manually below';
    }
    if(data.drift_warning) msg+='\n\n⚠️ DRIFT WARNING: 3+ changes in 6h. Review before applying more.';
    if(data.executed_changes&&data.executed_changes.length) msg+='\n\n✅ AUTO-APPLIED:\n'+data.executed_changes.map(function(c){return '• '+c.key+': '+c.current+' → '+c.proposed+' ('+c.confidence+'%)';}).join('\n');
    if(data.recommendations&&data.recommendations.length) msg+='\n\n📋 '+data.recommendations.length+' recommendation(s) added to Recommended tab.';

    let extraHtml='';
    const notBlocked=(data.proposed_changes||[]).filter(function(c){return !c.blocked;});
    const blocked=(data.proposed_changes||[]).filter(function(c){return c.blocked;});
    _pendingActions=notBlocked;
    if(notBlocked.length){
      extraHtml+='<div style="margin-top:12px;border-top:1px solid rgba(255,215,64,0.2);padding-top:10px"><div style="font-family:var(--mono);font-size:8px;color:var(--gold);letter-spacing:1px;margin-bottom:8px">⚡ '+notBlocked.length+' CHANGE'+(notBlocked.length>1?'S':'')+' AWAITING OPERATOR APPROVAL</div>';
      notBlocked.forEach(function(c){
        var rc=c.risk==='LOW'?'var(--green)':c.risk==='MEDIUM'?'var(--gold)':'var(--red)';
        var botBOk=c.botBVerdict&&c.botBVerdict!=='REJECT';
        extraHtml+='<div style="background:rgba(255,215,64,0.06);border:1px solid rgba(255,215,64,0.2);border-radius:6px;padding:8px 10px;margin-bottom:6px">';
        extraHtml+='<div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:4px;margin-bottom:4px"><span style="font-family:var(--mono);font-size:9px"><span style="color:var(--gold)">'+esc(c.key)+'</span>: '+JSON.stringify(c.current)+' → <span style="color:var(--cyan)">'+JSON.stringify(c.proposed)+'</span></span>';
        extraHtml+='<span style="font-family:var(--mono);font-size:7px;padding:2px 7px;border-radius:2px;background:'+rc+'18;border:1px solid '+rc+'44;color:'+rc+'">'+( c.risk||'?')+' · '+(c.confidence||'?')+'%</span></div>';
        if(c.rationale) extraHtml+='<div style="font-family:var(--mono);font-size:8px;color:var(--text3);margin-bottom:4px">'+esc(c.rationale)+'</div>';
        if(c.botBCritique) extraHtml+='<div style="font-family:var(--mono);font-size:8px;color:'+(botBOk?'var(--cyan)':'var(--orange)')+';margin-bottom:6px">🧠 Bot B: '+esc(c.botBCritique.slice(0,120))+'</div>';
        extraHtml+='<div style="display:flex;gap:5px"><button onclick="applyAgentChange(\''+c.key+'\','+JSON.stringify(c.proposed)+',\''+esc((c.rationale||'').slice(0,60))+'\',this)" style="background:rgba(0,230,118,0.12);border:1px solid rgba(0,230,118,0.3);color:var(--green);border-radius:3px;padding:3px 10px;font-family:var(--mono);font-size:8px;cursor:pointer">✓ APPLY</button>';
        extraHtml+='<button onclick="this.closest(\'div\').parentElement.style.opacity=\'0.4\'" style="background:rgba(255,23,68,0.08);border:1px solid rgba(255,23,68,0.2);color:var(--red);border-radius:3px;padding:3px 10px;font-family:var(--mono);font-size:8px;cursor:pointer">✗ SKIP</button></div></div>';
      });
      extraHtml+='</div>';
    }
    if(blocked.length){
      extraHtml+='<div style="margin-top:8px;padding:8px;background:rgba(255,23,68,0.04);border:1px solid rgba(255,23,68,0.15);border-radius:6px"><div style="font-family:var(--mono);font-size:8px;color:var(--red);margin-bottom:4px">🛡 POLICY BLOCKED ('+blocked.length+'):</div>';
      extraHtml+=blocked.map(function(c){return '<div style="font-family:var(--mono);font-size:8px;color:var(--text3)">• '+esc(c.key)+': '+esc(c.reason||'')+'</div>';}).join('');
      extraHtml+='</div>';
    }

    appendAgentMessage('bot',msg,extraHtml);
    _agentMsgs.push({role:'assistant',content:msg});
    if(badge){badge.textContent=data.drift_warning?'⚠ DRIFT WARNING':'✓ COMPLETE';badge.style.color=data.drift_warning?'var(--orange)':'var(--green)';}
    setTimeout(function(){if(badge){badge.textContent=_agentAutoApply?'🔥 AUTO-APPLY ON':'⚡ READY';badge.style.color=_agentAutoApply?'var(--orange)':'var(--green)';}},4000);
    if(_agentTab==='actions')loadAgentHistory();
    if(_agentTab==='rec')loadAgentRecs();
    if(_agentTab==='data')loadAgentData();
  }catch(err){
    removeAgentTyping();
    appendAgentMessage('bot','⚠ Failed: '+err.message+(err.name==='TimeoutError'?'\n\nDual-agent takes up to 90s. Try again.':''));
    if(badge){badge.textContent='✗ ERROR';badge.style.color='var(--red)';}
  }
}

async function applyAgentChange(key, value, reason, btn) {
  if (btn) { btn.disabled = true; btn.textContent = '⏳'; }
  try {
    const res  = await fetch('/api/agent/apply', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ key, value, reason })
    });
    const data = await res.json();
    if (data.ok) {
      if (btn) { btn.textContent = '✓ APPLIED'; btn.style.background = 'rgba(0,230,118,0.2)'; }
      appendAgentMessage('bot', `✅ Applied: ${key} = ${JSON.stringify(value)}\nPrevious value: ${JSON.stringify(data.previous)}`);
    } else {
      if (btn) { btn.textContent = '✗ FAILED'; btn.disabled = false; }
      appendAgentMessage('bot', `✗ Failed to apply ${key}: ${data.error}`);
    }
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = '✓ APPLY'; }
  }
}

async function loadAgentHistory() {
  const el = document.getElementById('agentActionsList');
  if (!el) return;
  const data = await apiFetch('/api/agent/history');
  if (!data?.ok) return;

  setText('adAgentActions', data.actions?.length || 0);

  if (!data.actions?.length) {
    el.innerHTML = '<div style="font-family:var(--mono);font-size:10px;color:var(--text3);text-align:center;padding:30px">No agent actions yet.</div>';
    return;
  }

  el.innerHTML = data.actions.map(a => {
    const isApplied   = a.approved && a.result === 'APPLIED';
    const isRolledBack= a.rolled_back;
    const cls = isRolledBack ? 'rolled' : isApplied ? 'applied' : 'proposed';
    const params = (() => { try { const p = JSON.parse(a.params||'{}'); return `${p.key||''}: ${JSON.stringify(p.current)} → ${JSON.stringify(p.proposed)}`; } catch { return a.params||''; } })();
    return `<div class="action-card ${cls}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:4px">
        <div style="font-family:var(--mono);font-size:10px;color:${isApplied?'var(--green)':isRolledBack?'var(--red)':'var(--gold)'};font-weight:700">${isApplied?'✅ APPLIED':isRolledBack?'↩ ROLLED BACK':'⏳ PROPOSED'}</div>
        <div style="font-family:var(--mono);font-size:8px;color:var(--text3)">${a.created_at||'—'}</div>
      </div>
      <div style="font-family:var(--mono);font-size:10px;margin-top:6px">${esc(a.description||'')}</div>
      ${params ? `<div style="font-family:var(--mono);font-size:9px;color:var(--cyan);margin-top:4px">${esc(params)}</div>` : ''}
      ${!isApplied && !isRolledBack ? `<div style="display:flex;gap:6px;margin-top:8px">
        <button onclick="applyAgentChange('${(() => { try { return JSON.parse(a.params||'{}').key; } catch { return ''; } })()}',${(() => { try { return JSON.stringify(JSON.parse(a.params||'{}').proposed); } catch { return 'null'; } })()},'approved from history',this)" style="background:rgba(0,230,118,0.1);border:1px solid rgba(0,230,118,0.3);color:var(--green);border-radius:3px;padding:4px 12px;font-family:var(--mono);font-size:8px;cursor:pointer">✓ APPLY</button>
        <button onclick="rollbackAgentChange('${a.id}',this)" style="background:rgba(255,23,68,0.08);border:1px solid rgba(255,23,68,0.2);color:var(--red);border-radius:3px;padding:4px 12px;font-family:var(--mono);font-size:8px;cursor:pointer">↩ ROLLBACK</button>
      </div>` : ''}
    </div>`;
  }).join('');
}

async function rollbackAgentChange(id, btn) {
  const data = await apiFetch('/api/agent/history');
  const action = data?.actions?.find(a => a.id == id);
  if (!action) return;
  try { const params = JSON.parse(action.params||'{}'); await fetch('/api/agent/rollback', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:params.key})}); } catch {}
  loadAgentHistory();
}

async function loadAgentRecs() {
  const el = document.getElementById('agentRecsList');
  if (!el) return;
  const data = await apiFetch('/api/agent/history');
  if (!data?.ok) return;

  const recs = data.recommendations || [];
  if (!recs.length) {
    el.innerHTML = '<div style="font-family:var(--mono);font-size:10px;color:var(--text3);text-align:center;padding:30px">No recommendations yet. Run ANALYZE PERFORMANCE and the agent will flag what it needs.</div>';
    return;
  }

  el.innerHTML = recs.map(r => `
    <div class="rec-card rec-${r.status==='DONE'?'DONE':r.priority||'MEDIUM'}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:4px">
        <div style="display:flex;align-items:center;gap:8px">
          <span style="font-family:var(--mono);font-size:8px;padding:2px 7px;border-radius:2px;background:${r.priority==='HIGH'?'rgba(255,23,68,0.15)':r.priority==='LOW'?'rgba(0,0,0,0.3)':'rgba(255,215,64,0.1)'};color:${r.priority==='HIGH'?'var(--red)':r.priority==='LOW'?'var(--text3)':'var(--gold)'}">${r.priority||'MEDIUM'}</span>
          <span style="font-family:var(--mono);font-size:8px;color:var(--text3)">${r.category||'GENERAL'}</span>
          <span style="font-family:var(--mono);font-size:8px;color:${r.created_by==='user'?'var(--cyan)':'var(--purple)'}">${r.created_by==='user'?'👤 USER':'🤖 AGENT'}</span>
        </div>
        <div style="display:flex;gap:5px;align-items:center">
          <div style="font-family:var(--mono);font-size:8px;color:var(--text3)">${r.created_at?.slice(0,10)||'—'}</div>
          ${r.status!=='DONE'?`<button onclick="markRecDone(${r.id},this)" style="background:rgba(0,230,118,0.08);border:1px solid rgba(0,230,118,0.25);color:var(--green);border-radius:3px;padding:2px 8px;font-family:var(--mono);font-size:7px;cursor:pointer">✓ DONE</button>`:'<span style="font-family:var(--mono);font-size:7px;color:var(--green)">✓ DONE</span>'}
        </div>
      </div>
      <div style="font-family:var(--mono);font-size:11px;font-weight:700;margin:6px 0 4px;color:var(--text1)">${esc(r.title||'')}</div>
      ${r.description?`<div style="font-family:var(--mono);font-size:9px;color:var(--text2);margin-bottom:4px">${esc(r.description)}</div>`:''}
      ${r.rationale?`<div style="font-family:var(--mono);font-size:8px;color:var(--text3);font-style:italic">${esc(r.rationale)}</div>`:''}
    </div>
  `).join('');
}

async function markRecDone(id, btn) {
  if (btn) { btn.disabled = true; btn.textContent = '⏳'; }
  await fetch('/api/agent/recommendations/'+id, {method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:'DONE'})});
  loadAgentRecs();
}

async function addManualRecommendation() {
  const title    = prompt('Recommendation title:');
  if (!title) return;
  const priority = prompt('Priority (HIGH/MEDIUM/LOW):', 'MEDIUM') || 'MEDIUM';
  const category = prompt('Category (e.g. DATA_SOURCE, API_ACCESS, PARAMETER):', 'GENERAL') || 'GENERAL';
  const desc     = prompt('Description (what is needed and why):') || '';
  await fetch('/api/agent/recommendations', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title,priority,category,description:desc,created_by:'user'})});
  switchAgentTab('rec');
}

async function loadAgentData(){
  const survivors=await apiFetch('/api/tokens/survivors');
  setText('adSurvivorTokens',survivors?.survivors?.length||0);
  const cfg=await apiFetch('/api/ai/config');
  const overrides=cfg?.overrides||{};
  const keys=Object.keys(overrides);
  setText('adOverrides',keys.length);
  const overrideEl=document.getElementById('adOverrideDetails');
  if(overrideEl){
    overrideEl.innerHTML=keys.length
      ?keys.map(function(k){return '<div style="display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid var(--border)"><span style="color:var(--cyan)">'+esc(k)+'</span><span style="color:var(--gold)">'+JSON.stringify(overrides[k])+'</span><button onclick="fetch(\'/api/agent/rollback\',{method:\'POST\',headers:{\'Content-Type\':\'application/json\'},body:JSON.stringify({key:\''+k+'\'})})" style="background:transparent;border:none;color:var(--red);cursor:pointer;font-size:10px" title="Rollback">↩</button></div>';}).join('')
      :'<span style="color:var(--text3)">No overrides — using defaults</span>';
  }
  const survivorEl=document.getElementById('adSurvivorList');
  if(survivorEl&&survivors?.survivors?.length){
    survivorEl.innerHTML=survivors.survivors.slice(0,10).map(function(sv){
      return '<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--border)"><span style="color:var(--text1)">$'+esc(sv.token||sv.token_ca&&sv.token_ca.slice(0,8)||'?')+'</span><span style="color:var(--gold)">$'+Math.round((sv.current_mcap||0)/1000)+'K · '+(sv.age_hours||0).toFixed(1)+'h</span></div>';
    }).join('');
  }else if(survivorEl){
    survivorEl.innerHTML='<span style="color:var(--text3)">No survivors tracked yet (need tokens >4h, >$500K MCap)</span>';
  }
  try{
    const ewRes=await fetch('/api/wallets?source=survivor_tracker&limit=1');
    const ew=await ewRes.json();
    setText('adEarlyWallets',ew?.stats?.dune||'—');
  }catch(err){}
  const hist=await apiFetch('/api/agent/history');
  setText('adAgentActions',hist?.actions?.length||0);
  const sysState=await apiFetch('/api/agent/system-state');
  if(sysState?.state){
    const st=sysState.state;
    const botAScore=parseInt(st.bot_a_autonomy||'75');
    const botBScore=parseInt(st.bot_b_autonomy||'80');
    const freeze=st.freeze_active==='true';
    const driftWarn=st.drift_warning==='true';
    const stateEl=document.getElementById('adSystemState');
    if(stateEl){
      stateEl.innerHTML=[
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px">',
        '<div style="background:rgba(0,0,0,0.3);border:1px solid rgba(68,138,255,0.2);border-radius:6px;padding:10px">',
        '<div style="font-family:var(--mono);font-size:8px;color:var(--text3);margin-bottom:4px">BOT A AUTONOMY (HUNTER)</div>',
        '<div style="display:flex;align-items:center;gap:8px">',
        '<div style="height:4px;flex:1;background:rgba(0,0,0,0.3);border-radius:2px"><div style="height:4px;width:'+botAScore+'%;background:var(--cyan);border-radius:2px"></div></div>',
        '<span style="font-family:var(--mono);font-size:11px;color:var(--cyan)">'+botAScore+'</span></div>',
        '<input type="range" min="0" max="100" value="'+botAScore+'" oninput="setAutonomy(\'A\',this.value)" style="width:100%;margin-top:6px;accent-color:var(--cyan)">',
        '</div>',
        '<div style="background:rgba(0,0,0,0.3);border:1px solid rgba(156,39,176,0.2);border-radius:6px;padding:10px">',
        '<div style="font-family:var(--mono);font-size:8px;color:var(--text3);margin-bottom:4px">BOT B AUTONOMY (CRITIC)</div>',
        '<div style="display:flex;align-items:center;gap:8px">',
        '<div style="height:4px;flex:1;background:rgba(0,0,0,0.3);border-radius:2px"><div style="height:4px;width:'+botBScore+'%;background:var(--purple);border-radius:2px"></div></div>',
        '<span style="font-family:var(--mono);font-size:11px;color:var(--purple)">'+botBScore+'</span></div>',
        '<input type="range" min="0" max="100" value="'+botBScore+'" oninput="setAutonomy(\'B\',this.value)" style="width:100%;margin-top:6px;accent-color:var(--purple)">',
        '</div></div>',
        '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">',
        '<button onclick="toggleFreeze('+(!freeze)+')" style="background:'+(freeze?'rgba(255,23,68,0.2)':'rgba(0,0,0,0.3)')+';border:1px solid '+(freeze?'rgba(255,23,68,0.5)':'var(--border2)')+';color:'+(freeze?'var(--red)':'var(--text3)')+';border-radius:5px;padding:7px 14px;font-family:var(--mono);font-size:9px;cursor:pointer;letter-spacing:1px">'+(freeze?'🔒 FREEZE ACTIVE — CLICK TO LIFT':'🔓 ACTIVATE FREEZE')+'</button>',
        '<button onclick="triggerDailyReview()" style="background:rgba(68,138,255,0.08);border:1px solid rgba(68,138,255,0.25);color:var(--blue);border-radius:5px;padding:7px 14px;font-family:var(--mono);font-size:9px;cursor:pointer;letter-spacing:1px">🔄 RUN FULL DAILY CYCLE</button>',
        driftWarn?'<span style="background:rgba(255,109,0,0.1);border:1px solid rgba(255,109,0,0.3);color:var(--orange);border-radius:5px;padding:7px 14px;font-family:var(--mono);font-size:9px">⚠ DRIFT WARNING</span>':'',
        '</div>',
        '<div style="font-family:var(--mono);font-size:8px;color:var(--text3)">',
        'Last review: '+(st.last_review_at||'Never')+' &nbsp;·&nbsp; Improvements applied: '+(st.total_improvements||0)+' &nbsp;·&nbsp; Rollbacks: '+(st.total_rollbacks||0),
        '</div>',
      ].join('');
    }
  }
}

async function setAutonomy(bot, score) {
  await fetch('/api/agent/autonomy', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({bot,score:parseInt(score)})});
}

async function toggleFreeze(active) {
  const reason = active ? (prompt('Reason for freeze:') || 'operator') : 'operator lift';
  await fetch('/api/agent/freeze',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({active,reason})});
  loadAgentData();
  const badge = document.getElementById('agentStatusBadge');
  if (badge) { badge.textContent = active ? '🔒 FROZEN' : '⚡ READY'; badge.style.color = active ? 'var(--red)' : 'var(--green)'; }
}

async function triggerDailyReview(){
  const autoApply=document.getElementById('agentAutoApply')?.checked||false;
  appendAgentMessage('bot','🔄 Daily self-improvement loop started.\n\nRunning 4 modes: analyze → optimize → wallets → survivors. Takes 3-5 minutes. Check Actions tab for results.');
  await fetch('/api/agent/daily-review',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({autoApply})});
  setTimeout(function(){loadAgentHistory();},60000);
}


// ══════════════════════════════════════════════
//  ARCHIVE TAB
// ══════════════════════════════════════════════

let _archiveFilter = 'ALL', archivePage = 0;
const ARCHIVE_PAGE_SIZE = 50;

async function loadArchive() {
  const grid = document.getElementById('archiveGrid');
  if (!grid) return;
  grid.innerHTML = '<div style="font-family:var(--mono);font-size:10px;color:var(--text3);text-align:center;padding:30px;grid-column:1/-1">Loading archive...</div>';

  const search = document.getElementById('archiveSearch')?.value || '';
  const sortEl = document.getElementById('archiveSort');
  const sort   = sortEl?.value || 'newest';
  const decision = _archiveFilter === 'ALL' ? '' : _archiveFilter;

  const url = '/api/archive?limit=' + ARCHIVE_PAGE_SIZE + '&offset=' + (archivePage * ARCHIVE_PAGE_SIZE) +
    (decision ? '&decision=' + decision : '') +
    (search    ? '&search=' + encodeURIComponent(search) : '');

  const data = await apiFetch(url);
  if (!data?.ok) { grid.innerHTML = '<div style="color:var(--red);font-family:var(--mono);padding:20px;grid-column:1/-1">Failed to load archive</div>'; return; }

  const bd = data.byDecision || {};
  setText('archTotal',  data.total || 0);
  setText('archPosted', bd.AUTO_POST || 0);
  setText('archWatch',  bd.WATCHLIST || 0);
  setText('archIgnore', (bd.IGNORE || 0) + (bd.BLOCKLIST || 0));
  setText('archiveTotalBadge', (data.total || 0) + ' tokens archived');

  const totalPages = Math.ceil((data.total || 0) / ARCHIVE_PAGE_SIZE);
  setText('archivePagination', 'Page ' + (archivePage + 1) + ' of ' + Math.max(1, totalPages) + ' · ' + (data.rows?.length || 0) + ' shown');

  if (!data.rows?.length) {
    grid.innerHTML = '<div style="font-family:var(--mono);font-size:10px;color:var(--text3);text-align:center;padding:40px;grid-column:1/-1">No archived tokens yet. Tokens are archived automatically when the bot posts or evaluates calls.</div>';
    return;
  }

  const decCol = { AUTO_POST: 'var(--green)', WATCHLIST: 'var(--gold)', IGNORE: 'var(--text3)', BLOCKLIST: 'var(--red)', RETEST: 'var(--cyan)' };

  grid.innerHTML = data.rows.map(r => {
    const col   = decCol[r.final_decision] || 'var(--text3)';
    const score = r.composite_score || 0;
    const scoreC = score >= 80 ? 'var(--gold)' : score >= 60 ? 'var(--green)' : score >= 40 ? 'var(--cyan)' : 'var(--text3)';
    const tags  = (() => { try { return JSON.parse(r.narrative_tags||'[]').slice(0,2); } catch { return []; } })();
    const sub   = (() => { try { return JSON.parse(r.sub_scores||'{}'); } catch { return {}; } })();
    return `<div style="background:rgba(0,0,0,0.3);border:1px solid ${col}22;border-radius:8px;padding:12px;cursor:pointer;transition:border-color 0.2s" onclick="openArchiveDetail('${r.contract_address}')" onmouseenter="this.style.borderColor='${col}55'" onmouseleave="this.style.borderColor='${col}22'">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px">
        <div>
          <div style="font-family:var(--mono);font-size:13px;font-weight:700;color:var(--text1)">$${esc(r.token||'?')} <span style="font-size:9px;color:var(--text3)">${esc(r.token_name||'')}</span></div>
          <div style="font-family:var(--mono);font-size:8px;color:var(--text3);margin-top:2px">${r.called_at_et||r.created_at?.slice(0,16)||'—'}</div>
        </div>
        <div style="text-align:right">
          <div style="font-family:var(--mono);font-size:22px;font-weight:900;color:${scoreC}">${score}</div>
          <span style="font-family:var(--mono);font-size:7px;padding:2px 7px;border-radius:2px;background:${col}18;border:1px solid ${col}44;color:${col}">${r.final_decision||'?'}</span>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px;margin-bottom:8px">
        <div style="background:rgba(255,109,0,0.08);border:1px solid rgba(255,109,0,0.2);border-radius:4px;padding:5px;text-align:center">
          <div style="font-family:var(--mono);font-size:7px;color:var(--text3)">MCAP</div>
          <div style="font-family:var(--mono);font-size:11px;font-weight:700;color:var(--orange)">${fmt(r.market_cap,'$')}</div>
        </div>
        <div style="background:rgba(24,255,255,0.06);border:1px solid rgba(24,255,255,0.15);border-radius:4px;padding:5px;text-align:center">
          <div style="font-family:var(--mono);font-size:7px;color:var(--text3)">LIQ</div>
          <div style="font-family:var(--mono);font-size:11px;font-weight:700;color:var(--cyan)">${fmt(r.liquidity,'$')}</div>
        </div>
        <div style="background:rgba(0,230,118,0.06);border:1px solid rgba(0,230,118,0.15);border-radius:4px;padding:5px;text-align:center">
          <div style="font-family:var(--mono);font-size:7px;color:var(--text3)">VOL 1H</div>
          <div style="font-family:var(--mono);font-size:11px;font-weight:700;color:var(--green)">${fmt(r.volume_1h,'$')}</div>
        </div>
      </div>
      <div style="display:flex;justify-content:space-between;font-family:var(--mono);font-size:9px;color:var(--text3);margin-bottom:6px">
        <span>Age: ${r.pair_age_hours?.toFixed?.(2)||'?'}h · ${r.stage||'?'}</span>
        <span>Ratio: ${r.buy_ratio_1h!=null?(r.buy_ratio_1h*100).toFixed(0)+'%':'?'} · VelVol: ${r.volume_velocity?.toFixed?.(2)||'?'}</span>
      </div>
      <div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:6px">
        ${(r.bundle_risk&&r.bundle_risk!=='NONE')?'<span style="font-family:var(--mono);font-size:7px;padding:1px 5px;border-radius:2px;background:rgba(255,109,0,0.1);color:var(--orange)">BUNDLE:'+esc(r.bundle_risk)+'</span>':''}
        ${(r.sniper_count||0)>0?'<span style="font-family:var(--mono);font-size:7px;padding:1px 5px;border-radius:2px;background:rgba(255,215,64,0.1);color:var(--gold)">'+r.sniper_count+' SNI</span>':''}
        ${(r.winner_wallets||0)>0?'<span style="font-family:var(--mono);font-size:7px;padding:1px 5px;border-radius:2px;background:rgba(0,230,118,0.1);color:var(--green)">'+r.winner_wallets+' WIN</span>':''}
        ${tags.map(t=>'<span style="font-family:var(--mono);font-size:7px;padding:1px 5px;border-radius:2px;background:rgba(156,39,176,0.1);color:var(--purple)">'+esc(t)+'</span>').join('')}
      </div>
      <div style="display:flex;gap:6px">
        <button onclick="event.stopPropagation();copyCA('${r.contract_address}')" style="background:transparent;border:1px solid var(--border2);color:var(--text3);border-radius:3px;padding:3px 8px;font-family:var(--mono);font-size:8px;cursor:pointer">📋 CA</button>
        <a href="https://dexscreener.com/solana/${r.contract_address}" target="_blank" onclick="event.stopPropagation()" style="background:rgba(0,230,118,0.06);border:1px solid rgba(0,230,118,0.2);color:var(--green);border-radius:3px;padding:3px 8px;font-family:var(--mono);font-size:8px;text-decoration:none">DSC↗</a>
        <button onclick="event.stopPropagation();studyToken('${r.contract_address}','${esc(r.token||'')}',null)" style="background:rgba(255,215,64,0.06);border:1px solid rgba(255,215,64,0.2);color:var(--gold);border-radius:3px;padding:3px 8px;font-family:var(--mono);font-size:8px;cursor:pointer">🔬 STUDY</button>
      </div>
    </div>`;
  }).join('');
}

function setArchiveFilter(btn, filter) {
  document.querySelectorAll('#tab-archive .fchip').forEach(b => { b.classList.remove('active'); b.style.cssText = ''; });
  btn.classList.add('active');
  btn.style.color = 'var(--cyan)';
  btn.style.borderColor = 'rgba(24,255,255,0.4)';
  btn.style.background = 'rgba(24,255,255,0.06)';
  _archiveFilter = filter;
  archivePage = 0;
  loadArchive();
}

function searchArchive() {
  archivePage = 0;
  clearTimeout(window._archSearch);
  window._archSearch = setTimeout(loadArchive, 300);
}

async function openArchiveDetail(ca) {
  // Open the full audit detail for this token
  const data = await apiFetch('/api/archive/' + ca);
  if (!data?.ok) return;
  const r = data.row;
  // Use existing audit detail logic if available, otherwise show basic modal
  if (typeof buildAuditDetail === 'function') {
    const candidate = {
      token: r.token, tokenName: r.token_name, contractAddress: r.contract_address,
      compositeScore: r.composite_score, marketCap: r.market_cap, liquidity: r.liquidity,
      volume1h: r.volume_1h, volume24h: r.volume_24h, pairAgeHours: r.pair_age_hours,
      stage: r.stage, buySellRatio1h: r.buy_ratio_1h, buys1h: r.buys_1h, sells1h: r.sells_1h,
      volumeVelocity: r.volume_velocity, bundleRisk: r.bundle_risk, sniperWalletCount: r.sniper_count,
      top10HolderPct: r.top10_holder_pct, devWalletPct: r.dev_wallet_pct,
      mintAuthority: r.mint_authority, freezeAuthority: r.freeze_authority, lpLocked: r.lp_locked,
      deployerVerdict: r.deployer_verdict, walletVerdict: r.wallet_verdict,
      smartMoneyScore: r.smart_money_score, finalDecision: r.final_decision,
      claudeVerdict: r.claude_verdict, claudeRisk: r.claude_risk, setupType: r.claude_setup_type,
      openaiDecision: r.openai_decision, openaiConviction: r.openai_conviction,
      twitter: r.twitter, website: r.website, telegram: r.telegram, holders: r.holder_count,
      structureGrade: r.structure_grade, trapSeverity: r.trap_severity,
      bondingCurvePct: r.bonding_curve_pct, narrativeTags: (() => { try { return JSON.parse(r.narrative_tags||'[]'); } catch { return []; } })(),
      subScores: (() => { try { return JSON.parse(r.sub_scores||'{}'); } catch { return {}; } })(),
      walletIntel: { knownWinnerWalletCount: r.winner_wallets, smartMoneyScore: r.smart_money_score, walletVerdict: r.wallet_verdict },
    };
    // Switch to audit tab and show this token
    switchTab('audit');
    setTimeout(function() { showAuditDetail(candidate); }, 200);
  }
}

// ══════════════════════════════════════════════
//  TOKEN ANALYZER
// ══════════════════════════════════════════════

async function runTokenAnalyzer() {
  const input = document.getElementById('analyzerInput');
  const qInput = document.getElementById('analyzerQuestion');
  const out = document.getElementById('analyzerOutput');
  const loading = document.getElementById('analyzerLoading');
  const btn = document.getElementById('analyzerBtn');
  const ca = input?.value?.trim();
  if (!ca) { if(input)input.style.borderColor='var(--red)'; return; }
  if(input)input.style.borderColor='rgba(255,215,64,0.3)';
  if(out)out.style.display='none';
  if(loading)loading.style.display='block';
  if(btn){btn.disabled=true;btn.textContent='⏳ ANALYZING...';}
  try {
    const res = await fetch('/api/archive/analyze', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ contractAddress: ca, question: qInput?.value?.trim()||null }),
      signal: AbortSignal.timeout(45000),
    });
    const data = await res.json();
    if(loading)loading.style.display='none';
    if(!data.ok){ if(out){out.style.display='block';out.textContent='Error: '+data.error;out.style.color='var(--red)';} return; }
    if(out){
      out.style.display='block';
      out.style.color='var(--text2)';
      out.textContent = '=== $'+esc(data.token||ca)+' PATTERN ANALYSIS ===\n\n'+data.analysis;
    }
  } catch(err) {
    if(loading)loading.style.display='none';
    if(out){out.style.display='block';out.textContent='Error: '+err.message;out.style.color='var(--red)';}
  } finally {
    if(btn){btn.disabled=false;btn.textContent='🔬 ANALYZE';}
  }
}

async function quickStudy(type) {
  const out = document.getElementById('analyzerOutput');
  const loading = document.getElementById('analyzerLoading');
  if(out)out.style.display='none';
  if(loading)loading.style.display='block';
  let url = '/api/archive?limit=5&decision=AUTO_POST';
  const questions = {
    winners: 'What specific signals were present in these winning calls? What patterns repeat across multiple winners? What should we weight MORE in scoring?',
    losses:  'What signals should have caught these as bad calls? What do they have in common? What should we weight MORE to filter these out?',
    recent:  'Review these recent calls. What is the system doing well? What could be improved? Any pattern in what it is missing?',
    patterns:'Extract the top 5 repeatable patterns from these tokens. What philosophy should guide finding the next 10x gem?',
  };
  if(type==='losses') url = '/api/archive?limit=5&decision=IGNORE';
  if(type==='recent') url = '/api/archive?limit=10';
  try {
    const archData = await apiFetch(url);
    if(!archData?.rows?.length){ if(loading)loading.style.display='none'; if(out){out.style.display='block';out.textContent='No tokens in archive yet. Tokens are saved as the bot evaluates calls.';} return; }
    // Use the first token as entry point, but include context about all
    const firstCA = archData.rows[0].contract_address;
    const tokenList = archData.rows.map(function(r){return '$'+r.token+' ('+r.final_decision+', score:'+r.composite_score+', mcap:$'+Math.round((r.market_cap||0)/1000)+'K)';}).join('\n');
    const res = await fetch('/api/archive/analyze', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ contractAddress: firstCA, question: questions[type] + '\n\nOther recent tokens context:\n'+tokenList }),
      signal: AbortSignal.timeout(45000),
    });
    const data = await res.json();
    if(loading)loading.style.display='none';
    if(out){
      out.style.display='block';
      out.style.color='var(--text2)';
      out.textContent = '=== '+type.toUpperCase()+' PATTERN STUDY ===\nTokens analyzed: '+archData.rows.map(function(r){return '$'+r.token;}).join(', ')+'\n\n'+(data.analysis||data.error||'No analysis returned');
    }
  } catch(err) {
    if(loading)loading.style.display='none';
    if(out){out.style.display='block';out.textContent='Error: '+err.message;}
  }
}

function studyToken(ca, token, question) {
  switchTab('ai');
  setTimeout(function() {
    const input = document.getElementById('analyzerInput');
    const qInput = document.getElementById('analyzerQuestion');
    if(input) input.value = ca;
    if(qInput && question) qInput.value = question;
    runTokenAnalyzer();
    // Scroll to analyzer
    document.getElementById('analyzerInput')?.scrollIntoView({behavior:'smooth',block:'center'});
  }, 300);
}


// ══════════════════════════════════════════════════════════
//  SMART MONEY TAB — WALLET RANKINGS & INTELLIGENCE
// ══════════════════════════════════════════════════════════






















// ══════════════════════════════════════════════════════════════════
//  SMART MONEY TAB — v2 (fixed: no recursion, full detail)
// ══════════════════════════════════════════════════════════════════

var _smRankings = [];
var _smLoading  = false;

// Main entry — called by switchTab and refreshTabData
async function loadSmartMoneyTab() {
  if (_smLoading) return; // prevent double-load from 15s interval + switchTab
  _smLoading = true;
  try {
    await Promise.all([
      loadSmartMoneySummary(),
      loadWalletRankings(),
      loadWinnerWallets(),
      loadDeployerLeaderboard(),
    ]);
  } finally {
    _smLoading = false;
  }
}

// ── Summary stats + Dune status ────────────────────────────────────
async function loadSmartMoneySummary() {
  try {
    const data = await apiFetch('/api/wallets/rankings?limit=1');
    if (!data?.ok) return;

    const cats   = data.categories || [];
    const bycat  = Object.fromEntries(cats.map(function(c){ return [c.category, c]; }));
    const ds     = data.duneStatus || {};

    setText('smTotalWallets', (data.total || 0).toLocaleString());
    setText('smWinnerCount',  (bycat.WINNER?.count     || 0).toLocaleString());
    setText('smSmartCount',   (bycat.SMART_MONEY?.count || 0).toLocaleString());
    setText('smSniperCount',  (bycat.SNIPER?.count      || 0).toLocaleString());
    setText('smCatWinner',   bycat.WINNER?.count     || 0);
    setText('smCatSmart',    bycat.SMART_MONEY?.count || 0);
    setText('smCatMomentum', bycat.MOMENTUM?.count   || 0);
    setText('smCatSniper',   bycat.SNIPER?.count      || 0);
    setText('smCatCluster',  bycat.CLUSTER?.count     || 0);

    const lastSync = ds.lastSync
      ? new Date(ds.lastSync).toLocaleString('en-US', {
          timeZone:'America/New_York', month:'short', day:'numeric',
          hour:'2-digit', minute:'2-digit', hour12:true,
        })
      : 'Never';
    setText('smLastScan', lastSync);

    const badge = document.getElementById('smScanStatus');
    if (badge) {
      if (ds.ready) {
        badge.textContent = '✓ ' + (ds.totalWallets||0).toLocaleString() + ' wallets loaded';
        badge.style.background = 'rgba(0,230,118,0.1)';
        badge.style.borderColor = 'rgba(0,230,118,0.3)';
        badge.style.color = 'var(--green)';
      } else {
        badge.textContent = 'No wallets — scan needed';
        badge.style.background = 'rgba(255,109,0,0.1)';
        badge.style.borderColor = 'rgba(255,109,0,0.3)';
        badge.style.color = 'var(--orange)';
      }
    }
  } catch (err) {
    console.warn('[smart] summary error:', err.message);
  }
}

// ── Full wallet rankings table ──────────────────────────────────────
async function loadScanner(){
  const tbody=document.getElementById('scannerBody');
  if(!tbody)return;
  tbody.innerHTML='<tr><td colspan="10" style="text-align:center;padding:30px;font-family:var(--mono);font-size:10px;color:var(--text3)">Loading...</td></tr>';
  const search=document.getElementById('scannerSearch')?.value||'';
  const hours=document.getElementById('scannerHours')?.value||'24';
  const dec=_scanFilter==='ALL'?'':_scanFilter;
  const url='/api/scanner?limit='+SCAN_PAGE_SIZE+'&offset='+(_scanPage*SCAN_PAGE_SIZE)+'&hours='+hours+(dec?'&decision='+encodeURIComponent(dec):'')+(search?'&search='+encodeURIComponent(search):'');
  const data=await apiFetch(url);
  if(!data?.ok){tbody.innerHTML='<tr><td colspan="10" style="text-align:center;padding:20px;font-family:var(--mono);font-size:10px;color:var(--red)">Failed to load</td></tr>';return;}
  const bd=data.byDecision||{};
  setText('scanCntPost',bd.AUTO_POST||0);setText('scanCntWatch',bd.WATCHLIST||0);
  setText('scanCntIgnore',bd.IGNORE||0);setText('scanCntBlock',bd.BLOCKLIST||0);
  setText('scanCntRetest',bd.RETEST||0);
  setText('scannerTotal',(data.total||0).toLocaleString()+' tokens evaluated');
  const tp=Math.ceil((data.total||0)/SCAN_PAGE_SIZE);
  setText('scannerPageInfo','Page '+(_scanPage+1)+' of '+Math.max(1,tp)+'  ·  '+(data.rows?.length||0)+' shown');
  if(!data.rows?.length){tbody.innerHTML='<tr><td colspan="10" style="text-align:center;padding:40px;font-family:var(--mono);font-size:10px;color:var(--text3)">No tokens found.</td></tr>';return;}
  const dC={AUTO_POST:'var(--green)',WATCHLIST:'var(--gold)',IGNORE:'var(--text3)',BLOCKLIST:'var(--red)',RETEST:'var(--cyan)'};
  const dI={AUTO_POST:'✅',WATCHLIST:'👁',IGNORE:'⏭',BLOCKLIST:'🚫',RETEST:'🔄'};
  const rC={LOW:'var(--green)',MEDIUM:'var(--gold)',HIGH:'var(--orange)',EXTREME:'var(--red)'};
  tbody.innerHTML='';
  for(const r of data.rows){
    const tr=document.createElement('tr');
    const col=dC[r.final_decision]||'var(--text3)';
    const sc=r.composite_score||0;
    const sC=sc>=70?'var(--gold)':sc>=50?'var(--green)':sc>=35?'var(--cyan)':'var(--text3)';
    const ca=r.contract_address||'';
    const sCA=ca.length>10?ca.slice(0,8)+'…'+ca.slice(-6):ca;
    tr.dataset.ca=ca;
    tr.style.cssText='border-bottom:1px solid rgba(255,255,255,0.06);cursor:pointer';
    tr.addEventListener('click',function(){scannerOpenDetail(this.dataset.ca);});
    tr.addEventListener('mouseenter',function(){this.style.background='rgba(255,255,255,0.02)';});
    tr.addEventListener('mouseleave',function(){this.style.background='';});
    tr.innerHTML=
      '<td style="padding:8px 12px"><div style="font-family:var(--mono);font-size:9px;color:var(--text2)">'+(r.created_at?r.created_at.slice(11,16):'—')+'</div><div style="font-family:var(--mono);font-size:8px;color:var(--text3)">'+(r.created_at?r.created_at.slice(5,10):'—')+'</div></td>'+
      '<td style="padding:8px 12px"><div style="font-family:var(--mono);font-size:11px;font-weight:700;color:var(--text1)">$'+esc(r.token||'?')+'</div><div style="font-family:var(--mono);font-size:8px;color:var(--text3)">'+esc(r.token_name||'')+'</div></td>'+
      '<td style="text-align:center;padding:8px 12px"><span style="font-family:var(--mono);font-size:8px;padding:2px 8px;border-radius:3px;background:'+col+'15;border:1px solid '+col+'40;color:'+col+'">'+(dI[r.final_decision]||'—')+' '+(r.final_decision||'?')+'</span></td>'+
      '<td style="text-align:center;padding:8px 12px"><span style="font-family:var(--mono);font-size:14px;font-weight:900;color:'+sC+'">'+sc+'</span></td>'+
      '<td style="text-align:center;font-family:var(--mono);font-size:10px;color:var(--orange);padding:8px 12px">'+fmt(r.market_cap,'$')+'</td>'+
      '<td style="text-align:center;font-family:var(--mono);font-size:10px;color:var(--text2);padding:8px 12px">'+(r.pair_age_hours!=null?r.pair_age_hours.toFixed(1)+'h':'—')+'</td>'+
      '<td style="text-align:center;padding:8px 12px"><span style="font-family:var(--mono);font-size:8px;color:'+(rC[r.claude_risk]||'var(--text3)')+'">'+(r.claude_risk||'—')+'</span></td>'+
      '<td style="text-align:center;font-family:var(--mono);font-size:8px;color:var(--text3);padding:8px 12px">'+esc((r.claude_setup_type||r.stage||'—').replace(/_/g,' ').slice(0,16))+'</td>'+
      '<td style="text-align:center;padding:8px 12px"><div style="display:flex;align-items:center;gap:4px;justify-content:center">'+
        '<code style="font-family:var(--mono);font-size:8px;color:var(--cyan);background:rgba(0,0,0,0.3);padding:2px 6px;border-radius:3px">'+esc(sCA)+'</code>'+
        '<button class="scan-copy-btn" style="background:transparent;border:1px solid rgba(255,255,255,0.12);color:var(--text3);border-radius:3px;padding:2px 6px;font-size:10px;cursor:pointer" title="Copy CA">📋</button>'+
      '</div></td>'+
      '<td style="text-align:center;padding:8px 12px"><div style="display:flex;gap:3px;justify-content:center">'+
        '<a href="https://dexscreener.com/solana/'+esc(ca)+'" target="_blank" style="background:rgba(0,230,118,0.06);border:1px solid rgba(0,230,118,0.2);color:var(--green);border-radius:3px;padding:2px 6px;font-family:var(--mono);font-size:8px;text-decoration:none">DSC↗</a>'+
        '<a href="https://pump.fun/'+esc(ca)+'" target="_blank" style="background:rgba(255,109,0,0.06);border:1px solid rgba(255,109,0,0.2);color:var(--orange);border-radius:3px;padding:2px 6px;font-family:var(--mono);font-size:8px;text-decoration:none">PF↗</a>'+
      '</div></td>';
    tr.querySelector('.scan-copy-btn')?.addEventListener('click',function(ev){ev.stopPropagation();copyCA(this.closest('tr').dataset.ca);});
    tbody.appendChild(tr);
  }
}

function scannerOpenDetail(ca){
  if(!ca)return;
  switchTab('audit');
  setTimeout(function(){const el=document.getElementById('auditSearch');if(el){el.value=ca;el.dispatchEvent(new Event('input'));}},250);
}


function scannerOpenDetail(ca){
  if(!ca)return;
  switchTab('audit');
  setTimeout(function(){const el=document.getElementById('auditSearch');if(el){el.value=ca;el.dispatchEvent(new Event('input'));}},250);
}


function filterWalletRankings(q) {
  q = (q || '').toLowerCase();
  const filtered = q
    ? _smRankings.filter(function(w){ return (w.address||'').toLowerCase().includes(q) || (w.label||'').toLowerCase().includes(q); })
    : _smRankings;
  _renderRankings(filtered);
}

function _renderRankings(wallets) {
  const tbody = document.getElementById('smRankBody');
  if (!tbody) return;
  if (!wallets.length) {
    tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:40px;font-family:var(--mono);font-size:10px;color:var(--text3)">No wallets found. Run a Dune wallet scan.</td></tr>';
    return;
  }
  const catCol  = { WINNER:'var(--gold)', SMART_MONEY:'var(--blue)', MOMENTUM:'var(--cyan)', SNIPER:'var(--orange)', CLUSTER:'var(--red)', RUG:'var(--red)', NEUTRAL:'var(--text3)' };
  const catIcon = { WINNER:'🏆', SMART_MONEY:'🧠', MOMENTUM:'📈', SNIPER:'🎯', CLUSTER:'☠', RUG:'☠', NEUTRAL:'—' };
  tbody.innerHTML = '';
  wallets.slice(0, 200).forEach(function(w, i) {
    const col   = catCol[w.category]  || 'var(--text3)';
    const icon  = catIcon[w.category] || '';
    const wr    = w.win_rate != null  ? Math.round(w.win_rate * 100) + '%' : '—';
    const wrCol = w.win_rate >= 0.35  ? 'var(--gold)' : w.win_rate >= 0.20 ? 'var(--green)' : 'var(--text3)';
    const roi   = w.avg_roi != null   ? '$' + Math.round(w.avg_roi)  : '—';
    const sc    = w.score != null     ? Math.round(w.score) : 0;
    const scCol = sc >= 70 ? 'var(--gold)' : sc >= 50 ? 'var(--green)' : sc >= 30 ? 'var(--cyan)' : 'var(--text3)';
    const addr  = w.address || '';
    const short = addr.slice(0,6) + '…' + addr.slice(-4);
    const tr = document.createElement('tr');
    tr.dataset.addr = addr;
    tr.style.cssText = 'border-bottom:1px solid rgba(255,255,255,0.06);cursor:pointer';
    tr.addEventListener('click', function(){ showWalletModal(this.dataset.addr); });
    tr.addEventListener('mouseenter', function(){ this.style.background='rgba(255,255,255,0.025)'; });
    tr.addEventListener('mouseleave', function(){ this.style.background=''; });
    tr.innerHTML =
      '<td style="font-family:var(--mono);font-size:9px;color:var(--text3);padding:9px 12px">#'+(i+1)+'</td>'+
      '<td style="padding:9px 12px">'+
        '<div style="font-family:var(--mono);font-size:10px;color:var(--text1)">'+(w.label?'<span style="color:'+col+';margin-right:4px">'+icon+'</span>'+esc(w.label):'<span style="color:var(--text3)">(unlabelled)</span>')+'</div>'+
        '<div style="font-family:var(--mono);font-size:9px;color:var(--text3);margin-top:2px">'+esc(short)+'</div>'+
      '</td>'+
      '<td style="text-align:center;padding:9px 12px"><span style="font-family:var(--mono);font-size:8px;padding:2px 8px;border-radius:3px;background:'+col+'15;border:1px solid '+col+'40;color:'+col+'">'+icon+' '+(w.category||'?')+'</span></td>'+
      '<td style="text-align:center;padding:9px 12px"><div style="display:flex;align-items:center;gap:5px;justify-content:center"><div style="width:36px;height:3px;background:rgba(0,0,0,0.4);border-radius:2px"><div style="height:3px;width:'+Math.min(sc,100)+'%;background:'+scCol+';border-radius:2px"></div></div><span style="font-family:var(--mono);font-size:11px;font-weight:700;color:'+scCol+'">'+sc+'</span></div></td>'+
      '<td style="text-align:center;font-family:var(--mono);font-size:11px;font-weight:700;color:'+wrCol+';padding:9px 12px">'+wr+'</td>'+
      '<td style="text-align:center;font-family:var(--mono);font-size:10px;color:var(--green);padding:9px 12px">'+roi+'</td>'+
      '<td style="text-align:center;font-family:var(--mono);font-size:10px;color:var(--text3);padding:9px 12px">'+(w.trade_count||'—')+'</td>'+
      '<td style="text-align:center;font-family:var(--mono);font-size:11px;font-weight:700;color:'+(w.wins_found_in>0?'var(--green)':'var(--text3)')+';padding:9px 12px">'+(w.wins_found_in||0)+'</td>'+
      '<td style="text-align:center;padding:9px 12px"><div style="display:flex;gap:3px;justify-content:center">'+
        '<button class="rank-copy" style="background:transparent;border:1px solid rgba(255,255,255,0.12);color:var(--text3);border-radius:3px;padding:3px 7px;font-size:10px;cursor:pointer" title="Copy">📋</button>'+
        '<a href="https://solscan.io/account/'+esc(addr)+'" target="_blank" style="background:rgba(24,255,255,0.06);border:1px solid rgba(24,255,255,0.2);color:var(--cyan);border-radius:3px;padding:3px 7px;font-family:var(--mono);font-size:8px;text-decoration:none">SOL↗</a>'+
        '<a href="https://birdeye.so/profile/'+esc(addr)+'?chain=solana" target="_blank" style="background:rgba(156,39,176,0.06);border:1px solid rgba(156,39,176,0.2);color:var(--purple);border-radius:3px;padding:3px 7px;font-family:var(--mono);font-size:8px;text-decoration:none">👁↗</a>'+
      '</div></td>';
    tr.querySelector('.rank-copy')?.addEventListener('click', function(ev){ ev.stopPropagation(); copyCA(this.closest('tr').dataset.addr); });
    tbody.appendChild(tr);
  });
}


function scannerOpenDetail(ca) {
  if (!ca) return;
  // Switch to audit tab and load this CA
  switchTab('audit');
  setTimeout(function() {
    const searchEl = document.getElementById('auditSearch');
    if (searchEl) {
      searchEl.value = ca;
      searchEl.dispatchEvent(new Event('input'));
    }
  }, 200);
}


startAutoRefresh();
</script>
</body>
</html>
