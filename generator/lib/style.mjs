// generator/lib/style.mjs - site stylesheet (single CSS source).
export const CSS = `
*,*::before,*::after{box-sizing:border-box}
:root, [data-theme="dark"]{
  color-scheme:dark;
  --bg:#0d1117;
  --panel:#161b22;
  --panel-hover:#1c2128;
  --term-border:#30363d;
  --term-border-strong:#484f58;
  
  --txt:#f0f6fc;
  --txt-dim:#c2cbd4;
  --txt-subtle:#9aa4ae;
  
  --term-green:#3fb950;
  --term-red:#f85149;
  --term-amber:#d29922;
  --term-cyan:#58a6ff;
  
  --code:#0a0d13;

  --cyan-tint-bg:rgba(88,166,255,0.08);
  --cyan-tint-border:rgba(88,166,255,0.4);
  --amber-tint-bg:rgba(210,153,34,0.1);
  --amber-tint-border:rgba(210,153,34,0.45);
  --green-tint-bg:rgba(63,185,80,0.08);
  --red-tint-bg:rgba(248,81,73,0.08);
  --diff-add-bg:rgba(126,231,135,0.06);
  --diff-del-bg:rgba(248,81,73,0.06);
  --diff-hunk-bg:rgba(88,166,255,0.06);
  --eli5-bg:rgba(210,153,34,.07);
  --eli5-rule:rgba(210,153,34,.25);
  --mark-bg:rgba(88,166,255,0.22);
}

[data-theme="amber"]{
  color-scheme:dark;
  --bg:#120d04;
  --panel:#1a1409;
  --panel-hover:#261e0e;
  --term-border:#3d2b0f;
  --term-border-strong:#5c4217;
  
  --txt:#ffe099;
  --txt-dim:#f5ba53;
  --txt-subtle:#c79033;
  
  --term-green:#e6a72e;
  --term-red:#ff6f59;
  --term-amber:#ffb84d;
  --term-cyan:#ffa726;
  
  --code:#0c0802;

  --cyan-tint-bg:rgba(255,167,38,0.1);
  --cyan-tint-border:rgba(255,167,38,0.4);
  --amber-tint-bg:rgba(255,184,77,0.1);
  --amber-tint-border:rgba(255,184,77,0.45);
  --green-tint-bg:rgba(230,167,46,0.1);
  --red-tint-bg:rgba(255,111,89,0.1);
  --diff-add-bg:rgba(230,167,46,0.08);
  --diff-del-bg:rgba(255,111,89,0.08);
  --diff-hunk-bg:rgba(255,167,38,0.06);
  --eli5-bg:rgba(255,184,77,.08);
  --eli5-rule:rgba(255,184,77,.3);
  --mark-bg:rgba(255,168,38,0.22);
}

[data-theme="green"]{
  color-scheme:dark;
  --bg:#041006;
  --panel:#081a0b;
  --panel-hover:#0f2b13;
  --term-border:#15381a;
  --term-border-strong:#1f5427;
  
  --txt:#6fff8e;
  --txt-dim:#4ade72;
  --txt-subtle:#32be52;
  
  --term-green:#38ff6b;
  --term-red:#ff5e5e;
  --term-amber:#c8ff54;
  --term-cyan:#62ffc8;
  
  --code:#020a03;

  --cyan-tint-bg:rgba(98,255,200,0.08);
  --cyan-tint-border:rgba(98,255,200,0.35);
  --amber-tint-bg:rgba(200,255,84,0.1);
  --amber-tint-border:rgba(200,255,84,0.4);
  --green-tint-bg:rgba(56,255,107,0.08);
  --red-tint-bg:rgba(255,94,94,0.1);
  --diff-add-bg:rgba(56,255,107,0.06);
  --diff-del-bg:rgba(255,94,94,0.06);
  --diff-hunk-bg:rgba(98,255,200,0.06);
  --eli5-bg:rgba(200,255,84,.08);
  --eli5-rule:rgba(200,255,84,.25);
  --mark-bg:rgba(51,255,102,0.22);
}

[data-theme="light"]{
  color-scheme:light;
  --bg:#f6f8fa;
  --panel:#ffffff;
  --panel-hover:#f0f2f5;
  --term-border:#d0d7de;
  --term-border-strong:#afb8c1;
  
  --txt:#111827;
  --txt-dim:#374151;
  --txt-subtle:#4b5563;
  
  --term-green:#166534;
  --term-red:#b91c1c;
  --term-amber:#854d0e;
  --term-cyan:#0366d6;
  
  --code:#eaecf0;

  --cyan-tint-bg:rgba(3,102,214,0.06);
  --cyan-tint-border:rgba(3,102,214,0.35);
  --amber-tint-bg:rgba(133,77,14,0.06);
  --amber-tint-border:rgba(133,77,14,0.4);
  --green-tint-bg:rgba(22,101,52,0.06);
  --red-tint-bg:rgba(185,28,28,0.06);
  --diff-add-bg:rgba(22,101,52,0.06);
  --diff-del-bg:rgba(185,28,28,0.06);
  --diff-hunk-bg:rgba(3,102,214,0.06);
  --eli5-bg:rgba(133,77,14,.06);
  --eli5-rule:rgba(133,77,14,.2);
  --mark-bg:rgba(9,105,218,0.15);
}

html{
  font:13.5px/1.55 ui-monospace,"SF Mono","Cascadia Mono","JetBrains Mono",Menlo,Monaco,Consolas,monospace;
  background:var(--bg);
  color:var(--txt);
  scroll-behavior:smooth;
  -webkit-font-smoothing:antialiased;
  /* Mobile browsers inflate type they judge "too small" (Android's text
     autosizing, iOS's boosting) -- which at a 13.5px base means everything on
     the site. It hit the search box hardest: the same query text rendered at
     two sizes side by side. Opt out and let the sheet say what it means. */
  -webkit-text-size-adjust:100%;
  text-size-adjust:100%;
}
body{
  margin:0;
  background:var(--bg);
  color:var(--txt);
  min-height:100vh;
}
#reading-progress{
  position:fixed;
  top:0;
  left:0;
  height:3px;
  background:var(--term-cyan);
  z-index:99999;
  width:0%;
  pointer-events:none;
  transition:width .08s ease-out;
}
main{
  max-width:920px;
  margin:0 auto;
  padding:0 20px 80px;
}
a{
  color:var(--txt);
  text-decoration:underline;
  text-decoration-color:var(--term-border-strong);
  text-underline-offset:2px;
}
a:hover{
  text-decoration-color:var(--term-cyan);
  color:var(--term-cyan);
}
code{
  font:inherit;
  background:var(--code);
  color:var(--txt);
  padding:.1em .35em;
  border-radius:3px;
  border:1px solid var(--term-border);
}


header.top{
  border-bottom:1px solid var(--term-border);
  padding:14px 0;
  margin-bottom:24px;
  display:flex;
  align-items:center;
  justify-content:space-between;
  flex-wrap:wrap;
  gap:12px;
  background:var(--bg);
}
.brand{
  display:flex;
  align-items:center;
  gap:10px;
}
.brand a.logo{
  color:var(--txt);
  font-weight:700;
  display:inline-flex;
  align-items:center;
  gap:6px;
  font-size:1rem;
  text-decoration:none;
}
.brand a.logo:hover{
  text-decoration:none;
  color:var(--txt);
}
.term-prompt-sym{
  color:var(--term-cyan);
  user-select:none;
  font-weight:700;
}
nav.term-nav{
  display:flex;
  gap:8px;
  font-size:.84rem;
  flex-wrap:wrap;
}
nav.term-nav a, nav.term-nav button{
  display:inline-flex;
  align-items:center;
  min-height:24px;
  color:var(--txt-dim);
  padding:5px 10px;
  border:1px solid var(--term-border);
  border-radius:2px;
  background:var(--panel);
  text-decoration:none;
  transition:all .1s ease;
  font:inherit;
  cursor:pointer;
}
nav.term-nav a:hover, nav.term-nav button:hover{
  color:var(--txt);
  border-color:var(--term-border-strong);
  text-decoration:none;
}
nav.term-nav a.active{
  color:var(--term-cyan);
  border-color:var(--cyan-tint-border);
  background:var(--cyan-tint-bg);
  text-decoration:none;
}
.nav-feed{
  color:var(--txt-dim)!important;
}

.hero{
  margin-bottom:28px;
}
.term-box{
  background:var(--panel);
  border:1px solid var(--term-border);
  border-radius:3px;
  padding:14px 16px;
}
.term-box-hdr{
  display:flex;
  align-items:center;
  justify-content:space-between;
  border-bottom:1px solid var(--term-border);
  padding-bottom:10px;
  margin-bottom:14px;
  font-size:.82rem;
  color:var(--txt-dim);
  flex-wrap:wrap;
  gap:8px;
}
.term-box-title{
  color:var(--txt);
  font-weight:700;
}
.term-box-head{
  font-size:.8rem;
  color:var(--txt-dim);
}
.term-box-slim{
  padding:10px 14px;
}
.term-box-slim .term-box-hdr{
  margin-bottom:0;
}
.term-box-slim .term-footer-bar{
  border-top:none;
  padding-top:6px;
}
.term-footer-bar{
  display:flex;
  justify-content:space-between;
  border-top:1px solid var(--term-border);
  padding-top:10px;
  font-size:.76rem;
  color:var(--txt-subtle);
  flex-wrap:wrap;
  gap:8px;
}

.day{
  margin-top:36px;
}
.day-line{
  display:flex;
  align-items:center;
  justify-content:space-between;
  border-bottom:1px solid var(--term-border);
  padding-bottom:6px;
  margin-bottom:14px;
}
.day-line h2{
  margin:0;
  font-size:.92rem;
  font-weight:700;
  color:var(--txt);
}
.day-line time{
  color:var(--txt);
}
.day-count{
  font-size:.76rem;
  color:var(--txt-subtle);
}
/* Rows on /changes/<category>/: those pages are complete lists, and Internal
   alone runs to thousands of entries, so a row costs a line of metadata and one
   truncated summary -- the full body stays on the day page it links to. */
.crow{
  display:flex;
  flex-wrap:wrap;
  align-items:baseline;
  gap:8px;
  padding:5px 0;
  border-bottom:1px solid var(--term-border);
  font-size:.8rem;
}
.crow:last-child{border-bottom:0}
.crow-time{min-width:34px;font-size:.72rem;color:var(--txt-dim)}
.crow-ref{font-size:.72rem;color:var(--txt-subtle);text-decoration:none}
.crow-ref:hover{color:var(--term-cyan)}
.crow-title{color:var(--txt);text-decoration:none}
.crow-title:hover{color:var(--term-cyan);text-decoration:underline}
.crow-sum{flex:1 0 100%;padding-left:42px;font-size:.74rem;color:var(--txt-subtle)}
.crow-noise .crow-title{color:var(--txt-dim)}
.list-note{margin:14px 0;font-size:.76rem;color:var(--txt-subtle)}

.entry{
  background:var(--panel);
  border:1px solid var(--term-border);
  border-left:3px solid var(--term-border);
  border-radius:2px;
  margin:10px 0;
  transition:border-color .12s ease;
  overflow:hidden;
}
.entry:hover{
  border-color:var(--term-border-strong);
}
.entry.major{
  border-left-color:var(--term-amber);
}
.entry.notable{
  border-left-color:var(--term-border-strong);
}

.entry-summary{
  list-style:none;
  cursor:pointer;
  padding:12px 14px;
  user-select:none;
  display:block;
  outline:none;
}
.entry-summary::-webkit-details-marker{
  display:none;
}
.entry-summary::marker{
  display:none;
}
.entry-summary:hover{
  background:var(--panel-hover);
}

.entry-meta-top{
  display:flex;
  align-items:center;
  gap:8px;
  font-size:.78rem;
  color:var(--txt-subtle);
  margin-bottom:6px;
  flex-wrap:wrap;
}
.entry-arrow{
  display:inline-block;
  font-size:.8rem;
  color:var(--txt-subtle);
  font-weight:700;
  transition:transform .12s ease, color .12s ease;
  user-select:none;
  margin-right:2px;
}
.entry[open] > .entry-summary .entry-arrow{
  transform:rotate(90deg);
  color:var(--term-cyan);
}
.entry-summary:hover .entry-arrow{
  color:var(--txt);
}
.commit-ref{
  color:var(--txt-subtle);
  font-weight:600;
}
.commit-ref a{
  color:var(--term-cyan);
  text-decoration:none;
}
.commit-ref a:hover{
  color:var(--txt);
  text-decoration:underline;
}
.entry-utc{
  color:var(--txt-subtle);
}
.badges{
  display:inline-flex;
  gap:8px;
  flex-wrap:wrap;
  align-items:center;
}
.badge{
  display:inline-flex;
  align-items:center;
  min-height:24px;
  font-size:.7rem;
  font-weight:600;
  padding:4px 9px;
  border-radius:2px;
  background:transparent;
  border:1px solid var(--term-border);
  color:var(--txt-dim);
  text-decoration:none;
}
.badge.maj{
  color:var(--term-amber);
  border-color:var(--amber-tint-border);
  font-weight:700;
}
.badge.not{
  color:var(--txt-dim);
  border-color:var(--term-border-strong);
}
.badge.model{
  color:var(--term-cyan);
  border-color:var(--cyan-tint-border);
}
.badge.ver{
  color:var(--term-green);
  border-color:var(--term-green);
  text-decoration:none;
}
.badge.ver:hover{
  border-color:var(--term-green);
  color:var(--txt);
}
.badge.cat{
  color:var(--txt-subtle);
}
.permalink{
  opacity:0;
  margin-left:auto;
  color:var(--txt-dim);
  font-size:.85em;
  padding:4px 8px;
  min-height:24px;
  display:inline-flex;
  align-items:center;
  text-decoration:none;
}
.entry:hover .permalink{
  opacity:1;
}
.permalink:hover{
  color:var(--term-cyan);
}

.entry h3.entry-title,.entry h3{
  margin:0;
  font-size:1.02rem;
  font-weight:700;
  line-height:1.45;
  color:var(--txt);
  transition:color .12s ease;
}
.entry-summary:hover .entry-title{
  color:var(--term-cyan);
}
.entry h3 a{
  color:var(--txt);
  text-decoration:none;
}
.entry h3 a:hover{
  color:var(--term-cyan);
  text-decoration:underline;
}
/* Churn rows (lockfile/icon-only commits, merges) are listed so the timeline is
   complete, but they must not compete with real changes for attention. */
.entry.noise{
  opacity:.52;
  margin:4px 0;
  background:transparent;
}
.entry.noise:hover{
  opacity:.92;
}
.entry.noise .entry-summary{
  padding:8px 14px;
}
.entry.noise .entry-title{
  font-size:.86rem;
  font-weight:400;
  color:var(--txt-dim);
}
.entry.noise .entry-body{
  padding:2px 16px 9px;
  border-top:none;
}
.entry.noise .summary{
  font-size:.76rem;
  color:var(--txt-dim);
}
.day-churn{
  color:var(--txt-dim);
  font-size:.72rem;
  font-weight:400;
  margin-left:6px;
}
/* Filtering is a visibility toggle, so the hidden attribute has to beat whatever
   display rule a row class grows later. One guard here is cheaper than auditing
   every rule that touches .entry, and it keeps the server default (churn hidden)
   true even with scripting off. */
[hidden]{display:none!important}
.filterbar{
  display:flex;
  flex-wrap:wrap;
  align-items:center;
  justify-content:center;
  gap:6px;
  margin:14px 0 4px;
  padding:8px 10px;
  border:1px solid var(--term-border);
  border-radius:2px;
  background:var(--panel);
}
.filter-label{font-size:.7rem;letter-spacing:.08em;color:var(--txt-subtle)}
.chip{
  font:inherit;
  font-size:.76rem;
  color:var(--txt-subtle);
  background:transparent;
  border:1px solid var(--term-border);
  border-radius:2px;
  padding:2px 8px;
  cursor:pointer;
}
.chip:hover{color:var(--txt);border-color:var(--term-border-strong)}
.chip:focus-visible{outline:1px solid var(--term-cyan);outline-offset:1px}
.chip.active{color:var(--txt);border-color:var(--term-cyan);background:var(--cyan-tint-bg)}
.chip-n{margin-left:5px;font-size:.68rem;color:var(--txt-subtle)}
.chip-churn{border-style:dashed}
.chip-churn.active{border-color:var(--term-amber);background:var(--amber-tint-bg)}
.filter-note{margin:0 0 10px;font-size:.8rem;color:var(--txt-subtle);text-align:center}
.filter-note b{color:var(--txt-dim)}
.filter-note em{font-style:normal;color:var(--term-amber)}
.related{
  margin-top:8px;
  padding-top:6px;
  border-top:1px dotted var(--term-border);
  font-size:.76rem;
  color:var(--txt-dim);
}
.related a{color:var(--term-cyan);text-decoration:none}
.related a:hover{text-decoration:underline}
.spark{display:block;margin:4px 0 8px;max-width:100%;height:auto}

.entry-body{
  padding:12px 16px 14px;
  border-top:1px solid var(--term-border);
}

.model-swap{
  background:var(--code);
  border:1px solid var(--term-border);
  border-radius:2px;
  padding:6px 10px;
  margin:8px 0;
  font-size:.82rem;
  display:flex;
  align-items:center;
  gap:8px;
  flex-wrap:wrap;
}
.model-swap-tag{
  color:var(--term-cyan);
  font-size:.7rem;
  font-weight:700;
  letter-spacing:.04em;
}
.modelplus{
  color:var(--term-green);
  font-weight:600;
}
.modelminus{
  color:var(--term-red);
  font-weight:400;
  text-decoration:line-through;
}
.swap-arrow{
  color:var(--txt-subtle);
}
.model-snap{
  margin:6px 0 2px 0;
  border:1px solid var(--term-border);
  border-radius:2px;
  overflow:hidden;
  font-size:.78rem;
}
.snap-row{
  display:flex;
  gap:10px;
  padding:5px 10px;
  border-top:1px solid var(--term-border);
}
.snap-row:first-child{border-top:none}
.snap-row.add{background:var(--diff-add-bg)}
.snap-row.del{background:var(--diff-del-bg)}
.snap-name{font-weight:700;white-space:nowrap}
.snap-row.add .snap-name{color:var(--term-green)}
.snap-row.del .snap-name{color:var(--term-red);text-decoration:line-through}
.snap-cells{color:var(--txt-dim)}
.diff-view-modes{display:flex;gap:6px;margin:8px 0 0}
.diff-mode{background:var(--panel);border:1px solid var(--term-border);color:var(--txt-dim);padding:5px 12px;min-height:24px;border-radius:2px;font:inherit;font-size:.72rem;cursor:pointer}
.diff-mode.active{border-color:var(--term-cyan);color:var(--term-cyan);font-weight:700}
.diff-split{width:100%;border-collapse:collapse;font-family:var(--font-mono);font-size:.76rem;line-height:1.5}
.diff-cell{width:50%;vertical-align:top;padding:1px 8px;white-space:pre-wrap;word-break:break-word;border-top:1px solid var(--term-border)}
.diff-cell.diff-hdr{background:var(--diff-hunk-bg);color:var(--txt-subtle)}
.diff-cell.diff-add{background:var(--diff-add-bg)}
.diff-cell.diff-del{background:var(--diff-del-bg)}
.diff-cell.diff-ctx{color:var(--txt-dim)}
.day-jump{display:inline-flex;align-items:center;gap:6px;font-size:.76rem;color:var(--txt-subtle)}
.day-jump select{background:var(--panel);border:1px solid var(--term-border);color:var(--txt-dim);padding:1px 6px;border-radius:2px;font:inherit;max-width:190px}
/* /stats/ opens with six numbers rather than forty bars: the strip is one bordered
   box with 1px gaps, so it reads as a table of contents for the page below rather
   than as more cards of the same shape. */
.stat-figures{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:1px;background:var(--term-border);border:1px solid var(--term-border);border-radius:3px;margin:0 0 14px}
@media (max-width:768px){
  .stat-figures{grid-template-columns:repeat(3,minmax(0,1fr))}
}
@media (max-width:480px){
  .stat-figures{grid-template-columns:repeat(2,minmax(0,1fr))}
}
.stat-figure{background:var(--panel);padding:10px 12px;display:flex;flex-direction:column;gap:1px}
.stat-figure-lbl{font-size:.66rem;letter-spacing:.07em;color:var(--txt-subtle)}
.stat-figure-val{font-size:1.45rem;line-height:1.2;font-weight:600;color:var(--txt);font-variant-numeric:tabular-nums}
.stat-figure-note{font-size:.68rem;color:var(--txt-subtle);line-height:1.4}
.stat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:12px;margin:12px 0}
.stat-card{background:var(--panel);border:1px solid var(--term-border);border-radius:3px;padding:12px 14px 14px}
.stat-span{grid-column:1/-1}
.stat-card-hdr{display:flex;align-items:baseline;justify-content:space-between;gap:12px;border-bottom:1px solid var(--term-border);padding-bottom:7px;margin-bottom:10px}
.stat-card h3{margin:0;font-size:.74rem;letter-spacing:.07em;color:var(--txt)}
.stat-card-note{font-size:.68rem;color:var(--txt-subtle);text-align:right}
.stat-rows{display:flex;flex-direction:column;gap:6px}
/* The old row was flex with a fixed 110px label and a 44px number inside a card
   that was never 260px wide, so the bar got the remainder (nothing) and the
   sparkline hung out of the card. Every column is budgeted now, and the track is
   the one that flexes. */
.stat-row{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(48px,2fr) auto minmax(0,112px);grid-template-areas:"lbl track num trend";align-items:center;gap:4px 10px;font-size:.76rem;color:var(--txt-dim)}
.stat-row:hover{color:var(--txt)}
.stat-lbl{grid-area:lbl;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.stat-lbl a{color:var(--txt-dim);text-decoration:none}
.stat-row:hover .stat-lbl a{color:var(--term-cyan);text-decoration:underline}
.stat-track{grid-area:track;display:flex;height:9px;background:var(--code);border-radius:2px;overflow:hidden}
.stat-fill{display:block;height:100%;background:var(--term-cyan);opacity:.85}
.stat-fill.add{background:var(--term-green)}
.stat-fill.del{background:var(--term-red)}
.stat-fill.sig-major{background:var(--term-amber)}
.stat-fill.sig-notable{background:var(--term-cyan)}
.stat-fill.sig-minor{background:var(--term-border-strong)}
.stat-num{grid-area:num;min-width:78px;text-align:right;color:var(--txt-subtle);font-variant-numeric:tabular-nums;white-space:nowrap}
.stat-num i{font-style:normal}
.stat-num .pos,.stat-figure-val .pos{color:var(--term-green)}
.stat-num .neg,.stat-figure-val .neg{color:var(--term-red)}
.stat-share{margin-left:7px;opacity:.65}
.stat-delta{margin-left:6px}
.stat-trend{grid-area:trend;display:flex;justify-content:flex-end;min-width:0}
.stat-trend .spark{margin:0;width:100%;max-width:112px}
.cad-spark{margin:0 0 10px}
/* The svg carries an intrinsic width, so max-width:100% only caps it — the cadence
   line sat at its authored 300px inside a 1,100px card. Stretch it: the viewBox is
   already preserveAspectRatio="none" and the stroke is non-scaling, so the only
   thing that changes is the horizontal spacing between months. */
.cad-spark .spark{width:100%;height:52px}
.sig-split{display:flex;height:13px;border-radius:2px;overflow:hidden;background:var(--code);margin-bottom:10px}
.sig-seg{display:block;height:100%}
.sig-major{background:var(--term-amber)}
.sig-notable{background:var(--term-cyan)}
.sig-minor{background:var(--term-border-strong)}

@media (max-width:560px){
  .stat-row{grid-template-columns:minmax(0,1fr) auto;grid-template-areas:"lbl num" "track track"}
  .stat-trend{display:none}
  .stat-num{min-width:0}
}

.summary{
  margin:6px 0;
  font-size:.9rem;
  line-height:1.6;
  color:var(--txt-dim);
}
/* The plain-English line is a different register, not a lesser status: amber like
   the terminal's own annotations, so it reads as the human note beside the
   technical text without competing with it. */
.eli5{
  margin:10px 0 8px;
  padding:10px 14px;
  border-left:3px solid var(--term-amber);
  background:var(--eli5-bg);
  border-radius:0 3px 3px 0;
  font-size:.92rem;
  line-height:1.6;
  color:var(--txt);
}
.eli5-label{
  display:flex;
  align-items:center;
  gap:10px;
  font-size:.74rem;
  font-weight:700;
  letter-spacing:.08em;
  color:var(--term-amber);
  margin-bottom:8px;
}
.eli5-label::before{
  content:':: ';
  opacity:.7;
}
.eli5-label::after{
  content:'';
  flex:1;
  height:1px;
  background:var(--eli5-rule);
}
.facts{
  margin:8px 0;
  padding-left:14px;
  border-left:2px solid var(--term-border);
  list-style:none;
}
.facts li{
  color:var(--txt-dim);
  font-size:.82rem;
  margin:3px 0;
}
.facts li::before{
  content:"> ";
  color:var(--term-cyan);
  font-weight:700;
}

.files{
  margin:8px 0 0;
  display:flex;
  flex-wrap:wrap;
  gap:4px;
  align-items:center;
}
.fchip{
  display:inline-block;
  background:var(--code);
  border:1px solid var(--term-border);
  border-radius:2px;
  padding:1px 6px;
  font-size:.74rem;
  color:var(--txt-dim);
}
.fchip.add::before{
  content:"+ ";
  color:var(--term-green);
  font-weight:700;
}
.fchip.del::before{
  content:"− ";
  color:var(--term-red);
  font-weight:700;
}
.fchip.mod::before{
  content:"~ ";
  color:var(--txt-subtle);
}

.diff-viewer{
  margin:10px 0 6px;
  border:1px solid var(--term-border);
  border-radius:2px;
  background:var(--code);
  overflow:hidden;
}
.diff-toggle{
  cursor:pointer;
  padding:6px 10px;
  font-size:.78rem;
  font-weight:600;
  color:var(--txt-dim);
  user-select:none;
  display:flex;
  align-items:center;
  justify-content:space-between;
  background:var(--code);
}
.diff-toggle:hover{
  color:var(--txt);
  background:var(--panel-hover);
}
.diff-toggle-left{
  display:inline-flex;
  align-items:center;
  gap:6px;
}
.diff-arrow{
  color:var(--txt-subtle);
  font-weight:700;
  transition:transform .1s ease;
  display:inline-block;
}
.diff-viewer[open] .diff-arrow{
  transform:rotate(90deg);
  color:var(--txt);
}
.diff-viewer[open] .diff-toggle{
  border-bottom:1px solid var(--term-border);
}
.diff-badge{
  font-size:.72rem;
  color:var(--txt-subtle);
}
.diff-body{
  max-height:460px;
  overflow:auto;
  font-family:inherit;
  font-size:.75rem;
  line-height:1.42;
  padding:0;
  background:var(--code);
}
.diff-toolbar{
  display:flex;
  align-items:center;
  justify-content:space-between;
  padding:5px 10px;
  border-bottom:1px solid var(--term-border);
  background:rgba(0,0,0,0.3);
  font-size:.72rem;
  color:var(--txt-subtle);
}
.diff-toolbar-title{
  color:var(--term-cyan);
}
.diff-toolbar-actions{
  display:inline-flex;
  align-items:center;
  gap:8px;
}
.diff-copy-btn,.diff-gh-btn{
  background:none;
  border:none;
  color:var(--txt-dim);
  cursor:pointer;
  padding:4px 6px;
  min-height:24px;
  display:inline-flex;
  align-items:center;
  font:inherit;
  font-size:.72rem;
  text-decoration:underline dotted;
}
.diff-copy-btn:hover,.diff-gh-btn:hover{
  color:var(--term-cyan);
}
.diff-pre{
  margin:0;
  font-family:inherit;
  font-size:.75rem;
  line-height:1.42;
  padding:4px 0;
}
.diff-file-jump{
  font-family:inherit;
  font-size:.72rem;
  background:var(--panel);
  border:1px solid var(--term-border);
  color:var(--txt-dim);
  border-radius:2px;
  padding:2px 6px;
  max-width:220px;
}
.diff-file-jump:focus{
  outline:none;
  border-color:var(--term-cyan);
}
.diff-line{
  padding:1px 8px;
  white-space:pre-wrap;
  word-break:break-all;
  display:flex;
  font-family:inherit;
  font-size:.75rem;
  line-height:1.42;
}
.diff-num{
  display:inline-block;
  width:32px;
  flex-shrink:0;
  text-align:right;
  padding-right:6px;
  color:var(--txt-subtle);
  opacity:.5;
  user-select:none;
  font-size:.72rem;
}
.diff-num.old{border-right:1px solid var(--term-border)}
.diff-num.new{border-right:1px solid var(--term-border);margin-right:6px}
.diff-line.diff-hdr .diff-num,.diff-line.diff-hunk .diff-num{visibility:hidden}
.diff-marker{
  width:14px;
  flex-shrink:0;
  user-select:none;
  font-weight:700;
  font-size:.75rem;
}
.diff-text{
  flex-grow:1;
  font-family:inherit;
  font-size:.75rem;
}
.diff-add{
  background:var(--green-tint-bg);
  color:var(--txt);
}
.diff-add .diff-marker{
  color:var(--term-green);
}
.diff-del{
  background:var(--red-tint-bg);
  color:var(--txt-dim);
}
.diff-del .diff-marker{
  color:var(--term-red);
}
.diff-hunk{
  background:var(--diff-hunk-bg);
  color:var(--term-cyan);
  font-weight:600;
}
.diff-hdr{
  color:var(--txt-subtle);
  font-weight:600;
}
.diff-notice{
  padding:10px;
  color:var(--txt-dim);
  font-size:.75rem;
}
.diff-loading{
  padding:10px;
  display:block;
  color:var(--txt-subtle);
  font-size:.75rem;
}

.metarow{
  display:flex;
  align-items:center;
  justify-content:space-between;
  margin-top:10px;
  padding-top:8px;
  border-top:1px solid var(--term-border);
  font-size:.76rem;
  color:var(--txt-subtle);
  flex-wrap:wrap;
  gap:8px;
}
.diffstat b{
  color:var(--term-green);
  font-weight:700;
}
.diffstat i{
  color:var(--term-red);
  font-style:normal;
}
.meta-links{
  display:inline-flex;
  align-items:center;
  gap:8px;
}
.meta-link{
  color:var(--txt-subtle);
  text-decoration:underline dotted;
}
.meta-link:hover{
  color:var(--term-cyan);
}
/* The discord copy control sits in the same row as the meta links, so it has to
   look like one -- a <button> would otherwise arrive with the UA's chrome. */
button.meta-link{
  background:none;
  border:0;
  padding:0;
  margin:0;
  font:inherit;
  cursor:pointer;
}
button.meta-link.dc-ok{
  color:var(--term-green);
  text-decoration:none;
}

.models-intro{margin:0 0 12px;font-size:.82rem;color:var(--txt-dim)}
.model-grid{display:flex;flex-wrap:wrap;gap:6px}
.model-card{
  display:inline-flex;
  align-items:center;
  gap:7px;
  background:var(--code);
  border:1px solid var(--term-border);
  border-radius:2px;
  padding:3px 9px;
  font-size:.8rem;
  color:var(--txt);
  text-decoration:none;
}
.model-card:hover{border-color:var(--term-border-strong);color:var(--txt);text-decoration:none}
.model-card.live{border-left:3px solid var(--term-green)}
.model-card.out{border-left:3px solid var(--term-red);color:var(--txt-dim);text-decoration:line-through;text-decoration-color:var(--txt-subtle)}
.mc-tag{font-size:.62rem;font-weight:700;letter-spacing:.06em}
.model-card.live .mc-tag{color:var(--term-green)}
.model-card.out .mc-tag{color:var(--term-red)}
.model-retired{margin-top:10px}
.model-retired-toggle{cursor:pointer;font-size:.76rem;letter-spacing:.06em;color:var(--txt-subtle);user-select:none}
.model-retired-toggle:hover{color:var(--txt)}
.model-sep{
  color:var(--txt-dim);
}
.model-history{
  display:flex;
  flex-direction:column;
  gap:6px;
}
.model-row{
  display:flex;
  align-items:baseline;
  gap:10px;
  flex-wrap:wrap;
  background:var(--panel);
  border:1px solid var(--term-border);
  border-radius:2px;
  padding:8px 12px;
  font-size:.84rem;
  word-break:break-word;
  overflow-wrap:anywhere;
}
.model-row-date{
  white-space:nowrap;
  font-size:.76rem;
}
.model-row-date a{
  color:var(--term-cyan);
  text-decoration:none;
}
.model-row-change{
  display:inline-flex;
  align-items:center;
  gap:6px;
  flex-wrap:wrap;
}
.model-row-title{
  color:var(--txt-dim);
  font-size:.78rem;
  word-break:break-word;
  overflow-wrap:anywhere;
}

.model-matrix-wrap{
  margin:14px 0 16px;
  overflow-x:hidden;
}
.matrix-scrubber-box{
  display:flex;
  flex-direction:column;
  gap:8px;
  margin-top:12px;
  padding-top:12px;
  border-top:1px solid var(--term-border);
}
.matrix-scrubber-hdr{
  display:flex;
  justify-content:space-between;
  align-items:baseline;
  flex-wrap:wrap;
  gap:8px;
}
.matrix-date-display{
  font-size:.84rem;
  font-weight:700;
  color:var(--term-cyan);
}
.matrix-active-count{
  font-size:.78rem;
  color:var(--term-green);
}
.matrix-slider{
  width:100%;
  cursor:pointer;
  accent-color:var(--term-cyan);
}
.matrix-selected-event{
  font-size:.78rem;
  color:var(--txt-dim);
  margin-top:2px;
  word-break:break-word;
  overflow-wrap:anywhere;
}
.matrix-selected-event a{
  color:var(--txt);
  text-decoration:none;
}
.matrix-selected-event a:hover{
  text-decoration:underline;
  color:var(--term-cyan);
}
.model-matrix-filters{
  display:flex;
  gap:6px;
  flex-wrap:wrap;
  align-items:center;
}
.model-filter-label{
  font-size:.75rem;
  color:var(--txt-subtle);
  margin-right:2px;
}
.model-filter-btn{
  background:var(--code);
  border:1px solid var(--term-border);
  color:var(--txt-dim);
  font:inherit;
  font-size:.75rem;
  padding:2px 8px;
  border-radius:2px;
  cursor:pointer;
}
.model-filter-btn:hover{
  border-color:var(--term-border-strong);
  color:var(--txt);
}
.model-filter-btn.active{
  background:var(--cyan-tint-bg);
  border-color:var(--term-cyan);
  color:var(--term-cyan);
  font-weight:700;
}
.model-matrix-table{
  display:flex;
  flex-direction:column;
  gap:4px;
  width:100%;
  box-sizing:border-box;
}
.mt-axis-hdr{
  display:flex;
  justify-content:space-between;
  align-items:baseline;
  font-size:.68rem;
  font-family:monospace;
  color:var(--txt-subtle);
  padding:2px 4px 6px;
  border-bottom:1px solid var(--term-border);
  margin-bottom:2px;
}
.mt-axis-title{
  letter-spacing:.05em;
  font-weight:700;
  color:var(--txt-dim);
}
.mt-axis-label{
  color:var(--txt-subtle);
}
.model-timeline-item{
  background:var(--code);
  border:1px solid var(--term-border);
  border-left:3px solid transparent;
  border-radius:2px;
  padding:5px 8px;
  display:flex;
  flex-direction:column;
  gap:4px;
  transition:border-color .15s, background .15s, opacity .15s;
  box-sizing:border-box;
  width:100%;
}
.model-timeline-item:hover{
  border-color:var(--term-border-strong);
}
.model-timeline-item.active-at-date{
  border-color:var(--term-cyan);
  border-left:3px solid var(--term-cyan);
  background:rgba(88,166,255,0.06);
  opacity:1;
}
.model-timeline-item.inactive-at-date{
  border-left:3px solid transparent;
  opacity:0.45;
}
.mt-item-main{
  display:flex;
  justify-content:space-between;
  align-items:center;
  flex-wrap:wrap;
  gap:6px;
}
.mt-item-left{
  display:flex;
  align-items:center;
  gap:8px;
}
.model-status-tag{
  font-family:monospace;
  font-size:.66rem;
  font-weight:700;
  padding:1px 5px;
  border-radius:2px;
  letter-spacing:.03em;
  min-width:62px;
  text-align:center;
  display:inline-block;
  line-height:1.2;
}
.model-status-tag.live{
  color:var(--term-green);
  background:rgba(63,185,80,0.12);
  border:1px solid rgba(63,185,80,0.35);
}
.model-status-tag.retired{
  color:var(--txt-subtle);
  background:rgba(255,255,255,0.03);
  border:1px solid var(--term-border);
}
.mt-model-name{
  font-size:.82rem;
  font-weight:700;
  color:var(--txt);
  text-decoration:none;
}
.mt-model-name:hover{
  color:var(--term-cyan);
  text-decoration:underline;
}
.mt-item-right{
  display:flex;
  align-items:center;
  gap:8px;
  margin-left:auto;
}
.mt-lifespan{
  color:var(--txt-subtle);
  font-family:monospace;
  font-size:.70rem;
}
.mt-days-pill{
  background:rgba(255,255,255,0.04);
  border:1px solid var(--term-border);
  padding:0 5px;
  border-radius:2px;
  font-family:monospace;
  font-size:.68rem;
  color:var(--txt-dim);
}
.mt-bar-track{
  position:relative;
  width:100%;
  height:5px;
  background:rgba(255,255,255,0.03);
  border:1px solid rgba(255,255,255,0.08);
  border-radius:2px;
  overflow:hidden;
}
.mt-bar-segment{
  position:absolute;
  top:0;
  bottom:0;
  border-radius:1px;
}
.mt-bar-segment.live{
  background:var(--term-green);
}
.mt-bar-segment.retired{
  background:#388bfd;
}
.mt-milestones-details{
  font-size:.70rem;
  margin-top:1px;
}
.mt-milestones-summary{
  cursor:pointer;
  color:var(--txt-subtle);
  font-family:monospace;
  display:inline-flex;
  align-items:center;
  gap:4px;
  user-select:none;
  transition:color .1s ease;
  font-size:.70rem;
}
.mt-milestones-summary:hover{
  color:var(--term-cyan);
}
.mt-milestones-summary .diff-arrow{
  font-size:.66rem;
  transition:transform .15s ease;
  display:inline-block;
  color:var(--term-cyan);
}
.mt-milestones-details[open] > .mt-milestones-summary .diff-arrow{
  transform:rotate(90deg);
}
.mt-milestones-body{
  margin-top:4px;
  padding:4px 8px;
  background:var(--panel);
  border:1px solid var(--term-border);
  border-radius:2px;
  display:flex;
  flex-direction:column;
  gap:3px;
}
.mt-milestone{
  display:flex;
  align-items:baseline;
  gap:6px;
  font-size:.72rem;
  flex-wrap:wrap;
  word-break:break-word;
  overflow-wrap:anywhere;
  line-height:1.35;
}
.mt-milestone-tag{
  font-family:monospace;
  font-weight:700;
  font-size:.68rem;
}
.mt-milestone-date a{
  color:var(--term-cyan);
  text-decoration:none;
  font-family:monospace;
}
.mt-milestone-date a:hover{
  text-decoration:underline;
}
.mt-milestone-desc{
  color:var(--txt-dim);
}
.mt-milestone .snap-cells{
  color:var(--txt-subtle);
  font-size:.68rem;
}

.search-input-row{
  display:flex;
  align-items:center;
  gap:8px;
  margin:10px 0;
  background:var(--code);
  border:1px solid var(--term-border);
  padding:6px 10px;
  border-radius:2px;
  min-width:0;
}
#q{
  /* A flex item defaults to min-width:auto, i.e. never narrower than its
     content -- and an 18-character placeholder is *content*, so the row grew
     past the box on a phone instead of clipping inside the input. */
  flex:1 1 auto;
  min-width:0;
  background:none;
  border:none;
  color:var(--txt);
  font-family:inherit;
  /* 1rem = the 13.5px base, i.e. exactly the size of the "$ grep -i" prompt
     beside it; the old font:inherit looked oversized next to .72rem text. */
  font-size:1rem;
  line-height:1.45;
  padding:1px 0;
  outline:none;
  -webkit-appearance:none;
  appearance:none;
}
#q::placeholder{color:var(--txt-subtle);opacity:1}
#q::-webkit-search-cancel-button{-webkit-appearance:none;appearance:none}
.search-prompt{
  color:var(--term-green);
  font-weight:700;
  white-space:nowrap;
}
.search-hint{
  font-size:.72rem;
  color:var(--txt-subtle);
  white-space:nowrap;
}
.filter-chips{
  display:flex;
  align-items:center;
  gap:6px;
  flex-wrap:wrap;
  margin-top:8px;
  font-size:.78rem;
}
.filter-lbl{
  color:var(--txt-subtle);
  font-size:.72rem;
}
.filter-chip{
  background:var(--panel);
  border:1px solid var(--term-border);
  color:var(--txt-dim);
  padding:5px 12px;
  min-height:24px;
  border-radius:2px;
  font:inherit;
  cursor:pointer;
}
.filter-chip:hover{
  border-color:var(--term-border-strong);
  color:var(--txt);
}
.filter-chip.active{
  background:var(--cyan-tint-bg);
  border-color:var(--term-cyan);
  color:var(--term-cyan);
  font-weight:700;
}
.search-status{
  font-size:.76rem;
  color:var(--txt-subtle);
  margin-top:8px;
}
.filter-row{
  display:flex;
  align-items:center;
  gap:12px;
  flex-wrap:wrap;
  margin-top:8px;
  font-size:.78rem;
}
.filter-sel-lbl{
  color:var(--txt-subtle);
  display:inline-flex;
  align-items:center;
  gap:6px;
}
.filter-row select{
  background:var(--panel);
  border:1px solid var(--term-border);
  color:var(--txt-dim);
  padding:2px 6px;
  border-radius:2px;
  font-family:inherit;
  font-size:.94rem;
}

/* Phones only. iOS zooms the page when a focused control is smaller than 16px,
   so the form controls go to exactly 16px -- and the prompt label with them, so
   the row still reads as one size. The "press / to focus" hint is dropped: a
   touch keyboard makes it both irrelevant and the thing that overflowed. */
@media (max-width:600px){
  #q,.search-prompt,.filter-row select{
    font-size:16px;
  }
  .search-hint{
    display:none;
  }
  .search-input-row{
    gap:6px;
    padding:6px 8px;
  }
}

.grid{
  display:grid;
  grid-template-columns:repeat(auto-fill,minmax(180px,1fr));
  gap:8px;
  margin:12px 0;
}
.tile{
  background:var(--code);
  border:1px solid var(--term-border);
  border-radius:2px;
  padding:8px 10px;
  color:inherit;
  display:block;
}
.tile:hover{
  border-color:var(--term-border-strong);
  text-decoration:none;
}
.tile b{
  display:block;
  font-size:.85rem;
  color:var(--txt);
}
.tile span{
  font-size:.72rem;
  color:var(--txt-dim);
}

.section-hdr{
  border-bottom:1px solid var(--term-border);
  padding-bottom:6px;
  margin:28px 0 12px;
}
.section-hdr h2{
  font-size:.92rem;
  color:var(--txt);
  margin:0;
}
/* Archive: one list on screen at a time, and each list folded by month. The tab
   bar reuses the chip look on purpose -- it *is* the same control, choosing which
   rows to show -- and .atab only differs in carrying a total, not a count. */
.archive-tabs{
  display:flex;
  flex-wrap:wrap;
  align-items:center;
  gap:6px;
  margin-top:8px;
}
.atab{
  font:inherit;
  font-size:.78rem;
  letter-spacing:.06em;
  color:var(--txt-subtle);
  background:var(--code);
  border:1px solid var(--term-border);
  border-radius:2px;
  padding:3px 10px;
  cursor:pointer;
}
.atab:hover{color:var(--txt);border-color:var(--term-border-strong)}
.atab:focus-visible{outline:1px solid var(--term-cyan);outline-offset:1px}
.atab.active{color:var(--txt);border-color:var(--term-cyan);background:var(--cyan-tint-bg)}
.atab-fold{margin-left:auto;display:flex;gap:6px}
.atab-fold button{
  font:inherit;
  font-size:.72rem;
  color:var(--txt-dim);
  background:none;
  border:none;
  padding:0;
  cursor:pointer;
}
.atab-fold button:hover{color:var(--term-cyan);text-decoration:underline}

.archive-year{
  margin-top:20px;
  font-size:1rem;
  color:var(--txt);
  border-bottom:1px solid var(--term-border);
  padding-bottom:4px;
}
/* A month is a <details>: the fold works with scripting off, and the summary
   line carries the counts that decide whether opening it is worth a click. */
details.amonth{
  background:var(--panel);
  border:1px solid var(--term-border);
  border-radius:2px;
  margin:0 0 6px;
}
details.amonth>summary{
  list-style:none;
  display:flex;
  flex-wrap:wrap;
  align-items:baseline;
  gap:10px;
  padding:7px 10px;
  cursor:pointer;
}
details.amonth>summary::-webkit-details-marker{display:none}
details.amonth>summary::before{content:'\\25B8';color:var(--txt-dim);font-size:.7rem}
details.amonth[open]>summary::before{content:'\\25BE'}
details.amonth[open]>summary{border-bottom:1px solid var(--term-border)}
details.amonth>summary:hover .am-name{color:var(--txt)}
.am-name{font-size:.84rem;font-weight:700;color:var(--txt)}
.am-meta{font-size:.74rem;color:var(--txt-subtle)}
.am-body{padding:8px 10px 10px}
/* A release window can hold a thousand commits: the tail folds into compact rows
   so the page stays openable while staying complete. Same affordance as the
   archive month folds, so the arrow reads the same way. */
details.more-rows{margin:10px 0 0}
details.more-rows>summary{
  list-style:none;
  cursor:pointer;
  padding:7px 10px;
  border:1px solid var(--term-border);
  border-radius:2px;
  background:var(--panel);
  font-size:.8rem;
  color:var(--txt-dim);
}
details.more-rows>summary::-webkit-details-marker{display:none}
details.more-rows>summary::before{content:'\\25B8';color:var(--txt-dim);font-size:.7rem;margin-right:6px}
details.more-rows[open]>summary::before{content:'\\25BE'}
details.more-rows[open]>summary{margin-bottom:6px}

/* /c/<sha> is one change alone. The card is the day page's own server-rendered
   markup, so it needs room to breathe and a slightly stronger edge -- not a
   second design to keep in sync. */
#c-entry{
  max-width:860px;
  margin:14px auto 0;
}
#c-entry>details.entry{
  border-color:var(--term-border-strong);
}
.rel-chips{
  display:flex;
  flex-wrap:wrap;
  gap:4px;
}
.rel-chip{
  display:inline-flex;
  align-items:baseline;
  gap:5px;
  padding:2px 7px;
  background:var(--code);
  border:1px solid var(--term-border);
  border-radius:2px;
  text-decoration:none;
}
.rel-chip b{font-size:.78rem;font-weight:400;color:var(--txt-dim)}
.rel-chip span{font-size:.68rem;color:var(--txt-subtle)}
.rel-chip:hover{border-color:var(--term-border-strong);text-decoration:none}
.rel-chip:hover b{color:var(--term-cyan)}
.archive-days{
  display:grid;
  grid-template-columns:repeat(auto-fill,minmax(105px,1fr));
  gap:4px;
  list-style:none;
  padding:0;
  margin:0;
}
.archive-days li a{
  display:flex;
  justify-content:space-between;
  padding:3px 6px;
  border-radius:2px;
  background:var(--panel);
  border:1px solid var(--term-border);
  font-size:.76rem;
  color:var(--txt-dim);
  text-decoration:none;
}
.archive-days li a:hover{
  border-color:var(--term-border-strong);
  color:var(--txt);
}

.pr-list{
  display:flex;
  flex-direction:column;
  gap:8px;
  margin-top:12px;
}
.pr-card{
  background:var(--panel);
  border:1px solid var(--term-border);
  border-radius:2px;
  padding:10px 14px;
}
.pr-card-header{
  display:flex;
  justify-content:space-between;
  font-size:.76rem;
  margin-bottom:4px;
}
.pr-status{
  font-weight:700;
}
.pr-status.open{
  color:var(--txt-dim);
}
.pr-status.draft{
  color:var(--txt-subtle);
}
.pr-title{
  margin:0 0 4px;
  font-size:.92rem;
  font-weight:700;
}
.pr-title a{
  color:var(--txt);
}
.pr-meta{
  font-size:.76rem;
  color:var(--txt-subtle);
  display:flex;
  gap:8px;
  flex-wrap:wrap;
}
.pr-review-badge{
  font-weight:700;
  font-size:.70rem;
  padding:1px 5px;
  border-radius:3px;
  letter-spacing:.02em;
}
.pr-review-badge.approved{
  color:var(--term-green);
  border:1px solid rgba(63,185,80,0.35);
  background:var(--green-tint-bg);
}
.pr-review-badge.changes-requested{
  color:var(--term-red);
  border:1px solid rgba(248,81,73,0.35);
  background:var(--red-tint-bg);
}
.pr-review-badge.commented{
  color:var(--term-cyan);
  border:1px solid rgba(88,166,255,0.35);
  background:var(--cyan-tint-bg);
}
.pr-activity{
  display:inline-flex;
  align-items:center;
  gap:4px;
  color:var(--txt-dim);
}
.pr-tag-filters{
  display:flex;
  gap:6px;
  flex-wrap:wrap;
  margin-top:10px;
}
.pr-tag-btn{
  background:var(--code);
  border:1px solid var(--term-border);
  color:var(--txt-dim);
  font:inherit;
  font-size:.74rem;
  padding:2px 8px;
  border-radius:2px;
  cursor:pointer;
  transition:all .1s ease;
}
.pr-tag-btn:hover{
  border-color:var(--term-border-strong);
  color:var(--txt);
}
.pr-tag-btn.active{
  background:var(--cyan-tint-bg);
  border-color:var(--term-cyan);
  color:var(--term-cyan);
  font-weight:700;
}
.pr-labels{
  display:inline-flex;
  gap:5px;
  flex-wrap:wrap;
}
.pr-tag{
  display:inline-block;
  font-size:.68rem;
  font-family:monospace;
  padding:1px 5px;
  border-radius:2px;
  border:1px solid var(--term-border);
  background:rgba(255,255,255,0.03);
  color:var(--txt-dim);
  white-space:nowrap;
}
.pr-section{
  margin-top:8px;
  border:1px solid var(--term-border);
  border-radius:2px;
  background:var(--code);
  overflow:hidden;
}
.pr-section-toggle{
  display:flex;
  align-items:center;
  gap:6px;
  padding:5px 10px;
  cursor:pointer;
  font-size:.78rem;
  font-weight:700;
  color:var(--txt-dim);
  background:rgba(255,255,255,0.02);
  user-select:none;
}
.pr-section-toggle:hover{
  color:var(--txt);
  background:rgba(255,255,255,0.04);
}
.pr-section-toggle .diff-arrow{
  display:inline-block;
  transition:transform .15s ease;
  color:var(--term-cyan);
  font-family:monospace;
}
.pr-section[open] > .pr-section-toggle .diff-arrow{
  transform:rotate(90deg);
}
.pr-section-body{
  padding:8px 10px;
  border-top:1px solid var(--term-border);
  font-size:.78rem;
  display:flex;
  flex-direction:column;
  gap:6px;
  max-height:400px;
  overflow-y:auto;
}
.pr-commits-list{
  gap:4px;
}
.pr-commit-row{
  display:flex;
  align-items:baseline;
  gap:8px;
  font-size:.76rem;
  flex-wrap:wrap;
  word-break:break-word;
}
.pr-commit-sha{
  color:var(--term-cyan);
  text-decoration:none;
  font-weight:700;
  font-family:monospace;
}
.pr-commit-sha:hover{
  text-decoration:underline;
}
.pr-commit-msg{
  color:var(--txt);
}
.pr-commit-meta{
  color:var(--txt-subtle);
  font-size:.72rem;
}
.pr-comments-list{
  gap:8px;
}
.pr-comment-row{
  background:var(--panel);
  border:1px solid var(--term-border);
  border-radius:2px;
  padding:8px 10px;
  display:flex;
  flex-direction:column;
  gap:4px;
}
.pr-comment-row.is-review{
  border-left:3px solid var(--term-cyan);
}
.pr-comment-hdr{
  display:flex;
  align-items:baseline;
  gap:8px;
  flex-wrap:wrap;
  font-size:.74rem;
}
.pr-comment-author{
  font-weight:700;
  color:var(--txt);
}
.pr-comment-badge{
  color:var(--term-cyan);
  font-size:.70rem;
  font-family:monospace;
}
.pr-comment-time{
  margin-left:auto;
  color:var(--txt-subtle);
  font-size:.70rem;
  text-decoration:none;
}
.pr-comment-time:hover{
  text-decoration:underline;
}
.pr-comment-body{
  font-size:.78rem;
  color:var(--txt-dim);
  line-height:1.45;
  word-break:break-word;
  overflow-wrap:anywhere;
}
.pr-code-block{
  background:var(--code);
  border:1px solid var(--term-border);
  border-radius:2px;
  padding:6px 8px;
  margin:4px 0;
  overflow-x:auto;
  font-size:.74rem;
}
.btn-copy-relnotes{
  background:var(--code);
  border:1px solid var(--term-border);
  color:var(--txt-dim);
  font:inherit;
  font-size:.78rem;
  padding:3px 8px;
  border-radius:3px;
  cursor:pointer;
  transition:all .12s ease;
}
.btn-copy-relnotes:hover{
  border-color:var(--term-cyan);
  color:var(--term-cyan);
}

.man-body{
  padding:4px 0 2px;
  font-size:.90rem;
  line-height:1.55;
}
.man-body h4{
  margin:16px 0 6px;
  color:var(--term-amber);
  font-size:.88rem;
  font-weight:700;
  letter-spacing:.04em;
  text-transform:uppercase;
}
.man-body h4:first-child{
  margin-top:2px;
}
.man-ul{
  margin:0 0 12px;
  padding-left:18px;
  font-size:.88rem;
  line-height:1.55;
}
.man-ul li{
  margin:0 0 6px;
  color:var(--txt-dim);
}
.man-ul li strong{
  color:var(--txt);
}
.man-dl{
  display:grid;
  grid-template-columns:auto auto minmax(0,1fr);
  gap:4px 14px;
  margin:0 0 12px;
  font-size:.86rem;
  line-height:1.5;
  align-items:baseline;
}
.man-dl dt{
  color:var(--txt);
  font-weight:600;
  white-space:nowrap;
}
.man-dl dd{
  margin:0;
  color:var(--term-cyan);
  font-weight:600;
  font-variant-numeric:tabular-nums;
  text-align:right;
}
.man-dl .man-note{
  color:var(--txt-dim);
  font-weight:400;
  text-align:left;
}
@media (max-width:600px){
  .man-dl{
    grid-template-columns:auto 1fr;
    row-gap:2px;
  }
  .man-dl .man-note{
    grid-column:1 / -1;
    margin-bottom:8px;
  }
}
.man-routes{
  display:grid;
  grid-template-columns:repeat(auto-fit,minmax(210px,1fr));
  gap:4px 16px;
  margin:0 0 8px;
  font-size:.86rem;
  color:var(--txt-dim);
}
.man-routes a{
  color:var(--term-cyan);
  text-decoration:none;
}
.man-routes a:hover{
  text-decoration:underline;
}
.man-routes code{
  color:var(--term-cyan);
}
.man-body p{
  margin:0 0 10px;
  color:var(--txt-dim);
  font-size:.88rem;
  line-height:1.55;
}

.pager{
  display:flex;
  justify-content:space-between;
  align-items:center;
  gap:12px;
  margin:24px 0 12px;
  padding-top:12px;
  border-top:1px solid var(--term-border);
}
.pager a{
  color:var(--txt-dim);
  padding:3px 8px;
  border:1px solid var(--term-border);
  border-radius:2px;
  background:var(--code);
  font-size:.75rem;
  text-decoration:none;
  transition:all .1s ease;
}
.pager a:hover{
  border-color:var(--term-cyan);
  color:var(--txt);
  text-decoration:none;
}
/* Timeline pagination: the same bar above and below the day sections, so the
   way back is never something a reader has to scroll to find. */
.pager-page{
  font-size:.74rem;
  color:var(--txt-subtle);
}
.pager-num{
  font-family:monospace;
  font-size:.74rem;
  padding:2px 6px;
  border-radius:2px;
  color:var(--txt-dim);
  text-decoration:none;
  background:var(--code);
  border:1px solid var(--term-border);
  transition:all .1s ease;
}
a.pager-num:hover{
  color:var(--term-cyan);
  border-color:var(--term-cyan);
}
span.pager-num.active{
  color:var(--term-cyan);
  border-color:var(--term-cyan);
  background:var(--cyan-tint-bg);
  font-weight:700;
}
.pager-disabled{
  color:var(--txt-subtle);
  opacity:0.35;
  padding:3px 8px;
  font-size:.75rem;
  font-family:monospace;
  user-select:none;
}
.pager-timeline{
  flex-wrap:wrap;
  margin:28px 0 0;
  padding-top:14px;
  border-top:1px solid var(--term-border);
}
.pager-timeline-top{
  margin:10px 0 0;
  padding-top:0;
  border-top:none;
}
.timeline-hero{
  margin-bottom:20px;
}
.timeline-control{
  padding:8px 12px;
}
.timeline-control .pager-timeline-top{
  margin:0;
  padding:0 0 6px;
  border-top:none;
  display:flex;
  justify-content:space-between;
  align-items:center;
  gap:8px 12px;
  flex-wrap:wrap;
}
.timeline-nav-group{
  display:inline-flex;
  align-items:center;
  gap:8px;
  flex-wrap:wrap;
  font-size:.75rem;
}
.timeline-control .pager-timeline-top a{
  padding:2px 7px;
  font-size:.74rem;
  background:var(--code);
  border:1px solid var(--term-border);
  border-radius:2px;
  color:var(--txt-dim);
  text-decoration:none;
  transition:all .1s ease;
}
.timeline-control .pager-timeline-top a:hover{
  border-color:var(--term-cyan);
  color:var(--txt);
  text-decoration:none;
}
.timeline-status-bar{
  display:flex;
  justify-content:space-between;
  align-items:center;
  gap:8px 12px;
  flex-wrap:wrap;
  padding:4px 0 6px;
  font-size:.75rem;
  color:var(--txt-subtle);
  border-top:1px dotted var(--term-border);
}
.timeline-freshness{
  color:var(--txt-subtle);
}
.timeline-freshness a{
  color:var(--txt-dim);
}
.timeline-stats{
  color:var(--txt-subtle);
}
.timeline-filter-row{
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:8px 14px;
  flex-wrap:wrap;
  border-top:1px solid var(--term-border);
  padding-top:6px;
  margin-top:2px;
}
.timeline-filter-row .filterbar{
  margin:0;
  padding:0;
  border:none;
  background:transparent;
  justify-content:flex-start;
  gap:4px;
}
.timeline-filter-row .chip{
  padding:1px 6px;
  font-size:.73rem;
}
.timeline-filter-row .filter-note{
  margin:0;
  font-size:.73rem;
  color:var(--txt-subtle);
  text-align:right;
  white-space:nowrap;
}
.timeline-filter-row .filter-note a{
  color:var(--term-cyan);
  text-decoration:none;
}
.timeline-filter-row .filter-note a:hover{
  text-decoration:underline;
}
.timeline-settled-note{
  margin:6px 0 0;
  padding-top:6px;
  border-top:1px dotted var(--term-border);
  font-size:.78rem;
  color:var(--txt-dim);
}
@media (max-width:860px){
  .timeline-filter-row .filter-note{
    white-space:normal;
    text-align:left;
  }
}
@media (max-width:768px){
  .timeline-control .pager-timeline-top{
    flex-direction:column;
    align-items:flex-start;
    gap:8px;
  }
  .timeline-status-bar{
    flex-direction:column;
    align-items:flex-start;
    gap:4px;
  }
  .timeline-filter-row{
    flex-direction:column;
    align-items:flex-start;
    gap:8px;
  }
}

footer{
  margin-top:36px;
  padding-top:14px;
  border-top:1px solid var(--term-border);
  font-size:.74rem;
  color:var(--txt-subtle);
  display:flex;
  flex-direction:column;
  gap:8px;
}
.footer-row{
  display:flex;
  justify-content:space-between;
  align-items:center;
  flex-wrap:wrap;
  gap:10px;
}
.footer-desc{
  color:var(--txt-subtle);
  line-height:1.4;
}
.footer-links, .footer-feeds, .footer-shortcuts{
  display:inline-flex;
  align-items:center;
  gap:10px;
  flex-wrap:wrap;
}
.footer-links a, .footer-feeds a, .footer-links button, .footer-shortcuts button{
  background:none;
  border:none;
  padding:0;
  font:inherit;
  color:var(--txt-subtle);
  text-decoration:none;
  font-size:.73rem;
  cursor:pointer;
  transition:color .1s ease;
}
.footer-links a:hover, .footer-feeds a:hover, .footer-links button:hover, .footer-shortcuts button:hover{
  color:var(--term-cyan);
}
.footer-label{
  color:var(--txt-subtle);
  font-size:.72rem;
  text-transform:uppercase;
  letter-spacing:.03em;
}
.footer-sub{
  justify-content:center;
  font-size:.72rem;
}
.term-sep{
  color:var(--term-border-strong);
  margin:0 4px;
}

/* Footer Theme Switcher */
.footer-theme{
  display:inline-flex;
  align-items:center;
  gap:6px;
  flex-wrap:wrap;
}
.theme-btn{
  background:none;
  border:none;
  padding:1px 4px;
  font:inherit;
  font-size:.73rem;
  color:var(--txt-subtle);
  cursor:pointer;
  transition:color .1s ease;
}
.theme-btn:hover{
  color:var(--term-cyan);
}
.theme-btn.active{
  color:var(--term-cyan);
  font-weight:700;
}

/* Keyboard Navigation & Help Modal */
details.entry.kb-active{
  outline:1px solid var(--term-cyan);
  outline-offset:-1px;
}
details.entry.kb-active .entry-arrow{
  color:var(--term-cyan);
}
.kb-modal{
  position:fixed;
  inset:0;
  z-index:9999;
  background:rgba(0,0,0,0.7);
  display:flex;
  align-items:center;
  justify-content:center;
  padding:20px;
  backdrop-filter:blur(2px);
}
.kb-modal[hidden]{
  display:none;
}
.kb-dialog{
  background:var(--panel);
  border:1px solid var(--term-border-strong);
  border-radius:4px;
  max-width:440px;
  width:100%;
  box-shadow:0 8px 30px rgba(0,0,0,0.6);
  font-size:.82rem;
}
.kb-header{
  display:flex;
  justify-content:space-between;
  align-items:center;
  padding:10px 14px;
  border-bottom:1px solid var(--term-border);
  color:var(--term-amber);
  font-weight:700;
  letter-spacing:.04em;
}
.kb-close{
  background:none;
  border:none;
  font:inherit;
  color:var(--txt-subtle);
  cursor:pointer;
  padding:0;
}
.kb-close:hover{
  color:var(--term-red);
}
.kb-grid{
  display:grid;
  grid-template-columns:auto 1fr;
  gap:6px 14px;
  padding:12px 14px;
  align-items:center;
}
.kb-key, kbd{
  color:var(--term-cyan);
  font-weight:700;
  background:var(--code);
  border:1px solid var(--term-border);
  padding:1px 6px;
  border-radius:2px;
  display:inline-block;
  min-width:20px;
  text-align:center;
  font-size:.76rem;
  font-family:inherit;
}

/* Timeline Bulk Toggle */
.timeline-bulk-toggle{
  display:inline-flex;
  gap:8px;
  font-size:.74rem;
  margin-left:auto;
}
.timeline-bulk-btn{
  background:none;
  border:none;
  font:inherit;
  color:var(--txt-subtle);
  cursor:pointer;
  padding:0;
  font-size:.74rem;
}
.timeline-bulk-btn:hover{
  color:var(--term-cyan);
  text-decoration:underline;
}

/* Search Highlights */
mark.search-match{
  background:var(--mark-bg);
  color:var(--term-cyan);
  padding:0 2px;
  border-radius:2px;
  font-weight:700;
}
.search-hit-active{
  outline:1px solid var(--term-cyan);
}

/* Model Catalog Search / Filter */
.model-search-row{
  margin:10px 0 12px;
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:12px;
  flex-wrap:wrap;
}
.model-search-group{
  display:flex;
  align-items:center;
  gap:8px;
  flex:1;
  min-width:240px;
}
.model-search-prompt{
  color:var(--term-cyan);
  font-weight:700;
  font-size:.82rem;
}
.model-search-input{
  flex:1;
  max-width:320px;
  background:var(--code);
  border:1px solid var(--term-border);
  color:var(--txt);
  padding:4px 8px;
  border-radius:2px;
  font:inherit;
  font-size:.82rem;
}
.model-search-input:focus{
  outline:none;
  border-color:var(--term-cyan);
}
.timeline-reading-mode-btn.active{
  color:var(--term-amber);
  font-weight:700;
}
.reading-mode-plain .entry:has(.eli5){
  border-left-color:var(--term-amber);
}
.reading-mode-plain .entry-body{
  display:flex;
  flex-direction:column;
}
.reading-mode-plain .eli5{
  order:-1;
  margin:0 0 12px;
  box-shadow:0 0 8px rgba(210,153,34,0.15);
}
.eli5-copy{
  color:var(--term-amber);
  border-color:rgba(210,153,34,0.3);
}
.eli5-copy:hover{
  color:var(--term-amber);
  border-color:var(--term-amber);
  background:var(--eli5-bg);
}
.search-eli5{
  margin:6px 0 0;
  font-size:.82rem;
  line-height:1.45;
  color:var(--txt-dim);
  padding:4px 8px;
  background:var(--eli5-bg);
  border-left:2px solid var(--term-amber);
  border-radius:0 2px 2px 0;
}
.search-eli5-lbl{
  font-size:.7rem;
  font-weight:700;
  letter-spacing:.05em;
  color:var(--term-amber);
  margin-right:4px;
}
`
