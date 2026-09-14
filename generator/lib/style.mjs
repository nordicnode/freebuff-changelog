// generator/lib/style.mjs - site stylesheet (single CSS source).
export const CSS = `
*,*::before,*::after{box-sizing:border-box}
:root{
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
}

html{
  font:13.5px/1.55 ui-monospace,"SF Mono","Cascadia Mono","JetBrains Mono",Menlo,Monaco,Consolas,monospace;
  background:var(--bg);
  color:var(--txt);
  scroll-behavior:smooth;
  -webkit-font-smoothing:antialiased;
}
body{
  margin:0;
  background:var(--bg);
  color:var(--txt);
  min-height:100vh;
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
  color:#ffffff;
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
nav.term-nav a{
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
}
nav.term-nav a:hover{
  color:#ffffff;
  border-color:var(--term-border-strong);
  text-decoration:none;
}
nav.term-nav a.active{
  color:var(--term-cyan);
  border-color:rgba(88,166,255,0.5);
  background:rgba(88,166,255,0.08);
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
  background:rgba(255,255,255,0.02);
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
  color:#ffffff;
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
  border-color:rgba(210,153,34,0.45);
  font-weight:700;
}
.badge.not{
  color:var(--txt-dim);
  border-color:var(--term-border-strong);
}
.badge.model{
  color:var(--term-cyan);
  border-color:rgba(88,166,255,0.4);
}
.badge.ver{
  color:var(--term-green);
  border-color:rgba(63,185,80,0.4);
  text-decoration:none;
}
.badge.ver:hover{
  border-color:var(--term-green);
  color:#ffffff;
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
.entry.teaser .entry-summary{
  padding:10px 14px;
}
.entry.teaser .entry-meta-top{
  margin-bottom:2px;
}
.entry.teaser .entry-title{
  font-size:.95rem;
}
.teaser-empty{
  margin:6px 0;
  font-size:.82rem;
  color:var(--txt-dim);
}
.teaser-facts{
  margin-top:4px;
  font-size:.76rem;
  color:var(--txt-dim);
}
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
  border-top:1px solid rgba(48,54,61,0.5);
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
  border-top:1px solid rgba(48,54,61,0.5);
}
.snap-row:first-child{border-top:none}
.snap-row.add{background:rgba(126,231,135,0.06)}
.snap-row.del{background:rgba(248,81,73,0.06)}
.snap-name{font-weight:700;white-space:nowrap}
.snap-row.add .snap-name{color:var(--term-green)}
.snap-row.del .snap-name{color:var(--term-red);text-decoration:line-through}
.snap-cells{color:var(--txt-dim)}
.diff-view-modes{display:flex;gap:6px;margin:8px 0 0}
.diff-mode{background:var(--panel);border:1px solid var(--term-border);color:var(--txt-dim);padding:5px 12px;min-height:24px;border-radius:2px;font:inherit;font-size:.72rem;cursor:pointer}
.diff-mode.active{border-color:var(--term-cyan);color:var(--term-cyan);font-weight:700}
.diff-split{width:100%;border-collapse:collapse;font-family:var(--font-mono);font-size:.76rem;line-height:1.5}
.diff-cell{width:50%;vertical-align:top;padding:1px 8px;white-space:pre-wrap;word-break:break-word;border-top:1px solid rgba(48,54,61,0.4)}
.diff-cell.diff-hdr{background:rgba(88,166,255,0.06);color:var(--txt-subtle)}
.diff-cell.diff-add{background:rgba(126,231,135,0.07)}
.diff-cell.diff-del{background:rgba(248,81,73,0.07)}
.diff-cell.diff-ctx{color:var(--txt-dim)}
.cat-collapse{margin-top:6px}
.cat-toggle{cursor:pointer;color:var(--txt-subtle);font-size:.76rem}
.day-jump{display:inline-flex;align-items:center;gap:6px;font-size:.76rem;color:var(--txt-subtle)}
.day-jump select{background:var(--panel);border:1px solid var(--term-border);color:var(--txt-dim);padding:1px 6px;border-radius:2px;font:inherit;max-width:190px}
.stat-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px;margin:12px 0}
.stat-card{background:var(--panel);border:1px solid var(--term-border);border-radius:2px;padding:10px 12px}
.stat-card h3{margin:0 0 8px;font-size:.8rem;color:var(--txt)}
.stat-bar-row{display:flex;align-items:center;gap:8px;font-size:.74rem;margin:3px 0;color:var(--txt-dim)}
.stat-bar-lbl{width:110px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.stat-bar{flex:1;height:8px;background:var(--code);border-radius:2px;overflow:hidden}
.stat-bar-fill{display:block;height:100%;background:var(--term-cyan)}
.stat-bar-n{width:44px;text-align:right;color:var(--txt-subtle)}
.watch-row{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:8px 0;font-size:.82rem}
.watch-row input,.watch-row select{background:var(--code);border:1px solid var(--term-border);color:var(--txt);padding:4px 8px;border-radius:2px;font:inherit}
.watch-hint{font-size:.76rem;color:var(--txt-subtle)}

.summary{
  margin:6px 0;
  font-size:.9rem;
  line-height:1.6;
  color:#d1d7e0;
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
  background:rgba(255,255,255,0.02);
}
.diff-toggle:hover{
  color:var(--txt);
  background:rgba(255,255,255,0.04);
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
.diff-line{
  padding:1px 10px;
  white-space:pre-wrap;
  word-break:break-all;
  display:flex;
  font-family:inherit;
  font-size:.75rem;
  line-height:1.42;
}
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
  background:rgba(63,185,80,0.08);
  color:var(--txt);
}
.diff-add .diff-marker{
  color:var(--term-green);
}
.diff-del{
  background:rgba(248,81,73,0.08);
  color:var(--txt-dim);
}
.diff-del .diff-marker{
  color:var(--term-red);
}
.diff-hunk{
  background:rgba(88,166,255,0.06);
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

.model-lineup{
  display:flex;
  flex-wrap:wrap;
  gap:8px;
  font-size:.84rem;
}
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
}
.search-prompt{
  color:var(--term-green);
  font-weight:700;
  white-space:nowrap;
}
#q{
  flex-grow:1;
  background:none;
  border:none;
  color:var(--txt);
  font:inherit;
  outline:none;
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
  color:#ffffff;
}
.filter-chip.active{
  background:rgba(88,166,255,0.12);
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
  font:inherit;
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
.release-grid{
  display:grid;
  grid-template-columns:repeat(auto-fill,minmax(170px,1fr));
  gap:6px;
  margin-bottom:20px;
}
.release-card{
  background:var(--panel);
  border:1px solid var(--term-border);
  padding:6px 10px;
  border-radius:2px;
  display:flex;
  justify-content:space-between;
  align-items:center;
  font-size:.82rem;
}
.release-card a{
  font-weight:700;
  color:var(--txt);
  text-decoration:none;
}
.release-card a:hover{
  color:#ffffff;
  text-decoration:underline;
}

.archive-year{
  margin-top:20px;
  font-size:1rem;
  color:var(--txt);
  border-bottom:1px solid var(--term-border);
  padding-bottom:4px;
}
.archive-month{
  margin:10px 0 6px;
  font-size:.8rem;
  color:var(--txt-dim);
}
.archive-days{
  display:grid;
  grid-template-columns:repeat(auto-fill,minmax(105px,1fr));
  gap:4px;
  list-style:none;
  padding:0;
  margin:0 0 12px;
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
  color:#ffffff;
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

.man-body{
  padding:6px 0;
  font-size:.84rem;
  line-height:1.6;
}
.man-body h4{
  margin:12px 0 4px;
  color:var(--term-amber);
  font-size:.84rem;
  letter-spacing:.05em;
}
.man-body p{
  margin:0 0 10px;
  color:var(--txt-dim);
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
  padding:4px 10px;
  border:1px solid var(--term-border);
  border-radius:2px;
  background:var(--panel);
  font-size:.8rem;
  text-decoration:none;
}
.pager a:hover{
  border-color:var(--term-border-strong);
  color:#ffffff;
  text-decoration:none;
}

footer{
  margin-top:48px;
  padding-top:16px;
  border-top:1px solid var(--term-border);
  font-size:.76rem;
  color:var(--txt-subtle);
  display:flex;
  justify-content:space-between;
  align-items:center;
  flex-wrap:wrap;
  gap:8px;
}
.footer-links{
  display:inline-flex;
  gap:12px;
}
.footer-links a{
  color:var(--txt-subtle);
  text-decoration:none;
}
.footer-links a:hover{
  color:var(--txt-dim);
}
`
