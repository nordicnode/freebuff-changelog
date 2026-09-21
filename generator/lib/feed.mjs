// generator/lib/feed.mjs - RSS feeds (XML render + XSL stylesheet), favicons.
// Pure render helpers; buildSite() in site.mjs passes entries and writes output.
import { deflateSync } from 'node:zlib'
import { escapeHtml as esc } from './util.mjs'

export function generateFaviconIco () {
  const width = 16, height = 16
  const headerSize = 40
  const imageSize = width * height * 4
  const maskRowBytes = Math.ceil(width / 32) * 4
  const maskSize = maskRowBytes * height
  const dibSize = headerSize + imageSize + maskSize
  const buf = Buffer.alloc(6 + 16 + dibSize)

  // ICONDIR
  buf.writeUInt16LE(0, 0)
  buf.writeUInt16LE(1, 2)
  buf.writeUInt16LE(1, 4)

  // ICONDIRENTRY
  buf.writeUInt8(width, 6)
  buf.writeUInt8(height, 7)
  buf.writeUInt8(0, 8)
  buf.writeUInt8(0, 9)
  buf.writeUInt16LE(1, 10)
  buf.writeUInt16LE(32, 12)
  buf.writeUInt32LE(dibSize, 14)
  buf.writeUInt32LE(22, 18)

  // BITMAPINFOHEADER
  let off = 22
  buf.writeUInt32LE(headerSize, off); off += 4
  buf.writeInt32LE(width, off); off += 4
  buf.writeInt32LE(height * 2, off); off += 4
  buf.writeUInt16LE(1, off); off += 2
  buf.writeUInt16LE(32, off); off += 2
  buf.writeUInt32LE(0, off); off += 4
  buf.writeUInt32LE(imageSize + maskSize, off); off += 4
  buf.writeInt32LE(0, off); off += 4
  buf.writeInt32LE(0, off); off += 4
  buf.writeUInt32LE(0, off); off += 4
  buf.writeUInt32LE(0, off); off += 4

  const pixels = Array.from({ length: 16 }, () => Array(16).fill(0))
  pixels[10][3] = 1
  pixels[9][4] = 1
  pixels[8][5] = 1
  pixels[7][4] = 1
  pixels[6][3] = 1
  pixels[6][8] = 1
  pixels[6][9] = 1
  pixels[6][10] = 1
  pixels[6][11] = 1

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (pixels[y][x]) {
        buf.writeUInt8(0xff, off++) // B (cyan #58a6ff)
        buf.writeUInt8(0xa6, off++) // G
        buf.writeUInt8(0x58, off++) // R
        buf.writeUInt8(0xff, off++) // A
      } else {
        buf.writeUInt8(0x17, off++) // B (dark #0d1117)
        buf.writeUInt8(0x11, off++) // G
        buf.writeUInt8(0x0d, off++) // R
        buf.writeUInt8(0xff, off++) // A
      }
    }
  }
  buf.fill(0, off, off + maskSize)
  return buf
}

// OG card (SVG): day label + top-3 entry titles on the dark tile.
export function ogCardSvg (dayLabel, titles, stats) {
  const rows = titles.slice(0, 3).map((t, i) =>
    `<text x="48" y="${300 + i * 56}" font-family="monospace" font-size="30" fill="#e6edf3">${esc(t.slice(0, 52))}</text>`).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630"><rect width="1200" height="630" fill="#0d1117"/>`
    + `<rect x="0" y="0" width="1200" height="160" fill="#161b22"/>`
    + `<text x="48" y="80" font-family="monospace" font-size="40" font-weight="bold" fill="#58a6ff">&gt;_ Unofficial Freebuff Changelog</text>`
    + `<text x="48" y="128" font-family="monospace" font-size="28" fill="#9aa4ae">${esc(dayLabel)} · ${esc(stats)}</text>`
    + rows + `</svg>`
}
// Minimal PNG encoder: RGBA `raw` (width*height*4) -> a valid PNG buffer using
// zlib "stored" (uncompressed) blocks. Shared by the favicon icons and the OG
// social card, so a bitmap can be emitted with zero image dependencies.
function encodePng (width, height, raw) {
  const crcTable = (() => {
    const t = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 8
      t[n] = c
    }
    return t
  })()
  const crc = (buf) => {
    let c = 0xffffffff
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const cs = Buffer.alloc(4); cs.writeUInt32BE(crc(body))
    return Buffer.concat([len, body, cs])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  const rows = []
  for (let y = 0; y < height; y++) rows.push(Buffer.concat([Buffer.from([0]), raw.subarray(y * width * 4, (y + 1) * width * 4)]))
  // node:zlib emits a spec-compliant IDAT (zlib header + deflate + adler), so a
  // flat-colour tile compresses to a few KB instead of raw RGBA megabytes.
  const idat = deflateSync(Buffer.concat(rows))
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
}

// Same >_ mark as the favicon at 192 and 512 for the PWA manifest.
export function generateIconPng (size = 192) {
  const px = (x, y) => {
    // Glyph: >_ centered. Bar thickness scales with size.
    const t = Math.max(2, Math.round(size / 16))
    const cx = size / 2, cy = size / 2
    const chev = (x >= cx - size * 0.22 && x < cx - size * 0.22 + t * 3 && Math.abs(y - cy) < size * 0.16)
      ? Math.abs((x - (cx - size * 0.22)) - Math.abs(y - cy) * 0.9) < t : false
    const bar = x >= cx + size * 0.02 && x < cx + size * 0.24 && y >= cy + size * 0.10 && y < cy + size * 0.10 + t
    return chev || bar
  }
  const raw = Buffer.alloc(size * size * 4)
  let o = 0
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (px(x, y)) { raw[o++] = 0x58; raw[o++] = 0xa6; raw[o++] = 0xff; raw[o++] = 0xff }
      else { raw[o++] = 0x0d; raw[o++] = 0x11; raw[o++] = 0x17; raw[o++] = 0xff }
    }
  }
  // Reuse the shared deflate-backed encoder (the one generateOgPng uses). The
  // old hand-rolled "stored blocks" path here never compressed, so a flat-color
  // 512px icon shipped at ~1 MB of raw RGBA instead of a few KB.
  return encodePng(size, size, raw)
}

// 1200x630 social card as PNG. Discord, Twitter/X and Facebook do not render an
// SVG og:image, so the site-wide default has to be a bitmap. Text rasterization
// is out of scope for a zero-dependency build, so this is a branded tile: the >_
// prompt mark and a few dim "change rows" on the dark terminal palette.
export function generateOgPng () {
  const W = 1200, H = 630
  const raw = Buffer.alloc(W * H * 4)
  const put = (x, y, r, g, b) => { const o = (y * W + x) * 4; raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = 255 }
  const band = 150
  const t = 26, gx = 110, gy = 360
  const rowsArr = [[460, 1120, 300], [460, 1040, 370], [460, 900, 440]]
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let r = 0x0d, g = 0x11, b = 0x17
      if (y < band) { r = 0x16; g = 0x1b; b = 0x22 }
      else if (y < band + 4) { r = 0x58; g = 0xa6; b = 0xff } // cyan accent under the band
      if (x >= gx && x <= gx + 120) {
        const p = (x - gx) / 120
        const ycTop = (gy - 90) + 90 * p
        const ycBot = (gy + 90) - 90 * p
        if (Math.abs(y - ycTop) < t || Math.abs(y - ycBot) < t) { r = 0x58; g = 0xa6; b = 0xff }
      }
      if (x >= gx + 150 && x <= gx + 300 && y >= gy + 55 && y < gy + 55 + t) { r = 0x58; g = 0xa6; b = 0xff }
      for (const [x0, x1, by] of rowsArr) {
        if (x >= x0 && x <= x1 && y >= by && y < by + 26) { r = 0x30; g = 0x36; b = 0x3d }
      }
      put(x, y, r, g, b)
    }
  }
  return encodePng(W, H, raw)
}

export const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="4" fill="#0d1117"/><text x="5" y="22" font-family="monospace" font-weight="bold" font-size="20" fill="#58a6ff">&gt;_</text></svg>`

export const FEED_XSL = `<?xml version="1.0" encoding="utf-8"?>
<xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <xsl:output method="html" version="1.0" encoding="UTF-8" indent="yes"/>
  <xsl:template match="/">
    <html lang="en" data-theme="dark">
      <head>
        <title><xsl:value-of select="/rss/channel/title"/>: RSS Feed</title>
        <meta charset="utf-8"/>
        <meta name="viewport" content="width=device-width, initial-scale=1"/>
        <link rel="icon" type="image/x-icon" href="/favicon.ico"/>
        <link rel="icon" type="image/svg+xml" href="/favicon.svg"/>
        <style>
          *,*::before,*::after{box-sizing:border-box}
          :root{
            color-scheme:dark;
            --bg:#0d1117;
            --panel:#161b22;
            --panel-hover:#1c2128;
            --term-border:#30363d;
            --txt:#e6edf3;
            --txt-dim:#8b949e;
            --txt-subtle:#6e7681;
            --term-green:#7ee787;
            --term-cyan:#58a6ff;
            --term-amber:#d29922;
            --font-mono:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono","Courier New",monospace;
          }
          body{
            margin:0;
            padding:16px;
            background:var(--bg);
            color:var(--txt);
            font-family:var(--font-mono);
            font-size:13px;
            line-height:1.5;
          }
          .feed-wrap{max-width:880px;margin:0 auto}
          .term-box{background:var(--panel);border:1px solid var(--term-border);border-radius:6px;padding:16px;margin-bottom:20px}
          .term-box-hdr{color:var(--term-cyan);font-weight:600;margin-bottom:8px;font-size:14px}
          p{margin:6px 0;color:var(--txt-dim)}
          a{color:var(--term-cyan);text-decoration:none}
          a:hover{text-decoration:underline}
          .feed-badge{display:inline-block;padding:2px 8px;border-radius:3px;background:#1f293d;color:var(--term-cyan);font-weight:bold;font-size:11px}
          .item-card{background:var(--panel);border:1px solid var(--term-border);border-radius:6px;padding:14px;margin-bottom:12px}
          .item-card:hover{border-color:var(--txt-subtle);background:var(--panel-hover)}
          .item-title{font-size:14px;font-weight:600;margin:0 0 4px}
          .item-meta{font-size:11px;color:var(--txt-subtle);margin-bottom:8px}
          .item-desc{color:var(--txt-dim);font-size:12px;margin:0;white-space:pre-line}
          .sub-callout{background:#1c1e24;border-left:3px solid var(--term-amber);padding:10px 14px;margin:12px 0}
        </style>
      </head>
      <body>
        <div class="feed-wrap">
          <div class="term-box">
            <div class="term-box-hdr">[ RSS FEED :: <xsl:value-of select="/rss/channel/title"/> ]</div>
            <p><xsl:value-of select="/rss/channel/description"/></p>
            <div class="sub-callout">
              <span class="feed-badge">RSS 2.0</span>
              <p style="margin-top:6px">This is an RSS feed. To subscribe and receive updates automatically in your newsreader (Feedly, NetNewsWire, Miniflux, etc.) or Discord bot, copy this URL:</p>
              <code style="color:var(--term-green);font-size:12px"><xsl:value-of select="/rss/channel/atom:link/@href"/></code>
            </div>
            <div class="sub-callout" style="border-left-color:var(--term-cyan)">
              <span class="feed-badge" style="background:#1b2d42">Discord Bot Setup</span>
              <p style="margin-top:6px">To post updates automatically to Discord using <b>MonitoRSS</b> or <b>RSS Bot</b>, run in your channel:</p>
              <code style="color:var(--term-green);font-size:12px">/feed add url:<xsl:value-of select="/rss/channel/atom:link/@href"/></code>
              <p style="margin-top:6px;font-size:11px">Embed mapping: Title = <code>{title}</code>, URL = <code>{link}</code>, Description = <code>{description}</code>, Author = <code>{author}</code>.</p>
            </div>
            <p style="font-size:12px;margin-top:8px">
              <a href="/">&lt; [back to changelog]</a>
              <span style="margin:0 6px">&#183;</span>
              <a href="/archive/">[archive]</a>
              <span style="margin:0 6px">&#183;</span>
              <a href="/about/">[about]</a>
            </p>
          </div>

          <div class="feed-items">
            <xsl:for-each select="/rss/channel/item">
              <article class="item-card">
                <div class="item-meta">
                  <xsl:value-of select="pubDate"/>
                  <xsl:if test="category"> &#183; <span class="feed-badge"><xsl:value-of select="category"/></span></xsl:if>
                </div>
                <h3 class="item-title">
                  <a target="_blank" rel="noopener">
                    <xsl:attribute name="href">
                      <xsl:value-of select="link"/>
                    </xsl:attribute>
                    <xsl:value-of select="title"/>
                  </a>
                </h3>
                <p class="item-desc">
                  <xsl:value-of select="description"/>
                </p>
              </article>
            </xsl:for-each>
          </div>
        </div>
      </body>
    </html>
  </xsl:template>
</xsl:stylesheet>
`

// One feed <item>: title, link, stable guid, author, categories,
// Discord-friendly clean description (no duplicated title, no 300-char truncation,
// plain-English quote if available), and rich HTML in content:encoded.
export function feedItem (siteUrl, e, titleOf, storyNotes = []) {
  // Date-prefix disambiguates repeat titles across days ("New slash
  // command /queue" shipped once; model swaps repeat names often).
  const title = `[${e.day}] ${titleOf(e)}`
  const summary = String(e.ai?.summary || e.summary || '').replace(/[*`#]/g, '').trim()
  const eli5 = e.eli5?.text ? String(e.eli5.text).replace(/[*`#]/g, '').trim() : ''

  // Description is optimized for Discord bots (embed description or message)
  // as well as standard RSS readers:
  // - Never duplicates the title at the top of the description.
  // - Includes plain-English summary as a Discord-friendly blockquote when present.
  // - Full technical summary without harsh 300-char truncation.
  // - Clean bulleted highlights for quick scanning.
  const descParts = storyNotes.map(n => `> **Related access context**\n> ${n.text}`)
  if (eli5) descParts.push(`> **In plain English**\n> ${eli5}`)
  if (summary) descParts.push(summary)
  if (e.facts?.length) {
    const highlights = e.facts.slice(0, 3).map(f => `• ${String(f).replace(/[*`#]/g, '').trim()}`).join('\n')
    descParts.push(`**Highlights**\n${highlights}`)
  }
  let desc = descParts.join('\n\n')
  // Discord description max is 4096 (standard message 2000); keep description bounded under 1800 chars cleanly
  if (desc.length > 1800) {
    desc = desc.slice(0, 1799) + '…'
  }

  // Enriched HTML for readers that render content:encoded (Feedly, NetNewsWire, etc.)
  const factsHtml = (e.facts || []).slice(0, 5).map(f => `<li>${esc(String(f)).slice(0, 400)}</li>`).join('')
  const modelChangesHtml = (e.modelChanges?.added?.length || e.modelChanges?.removed?.length)
    ? `<p><b>Model catalog:</b></p><ul>`
      + (e.modelChanges.removed || []).map(m => `<li><del>${esc(m)}</del></li>`).join('')
      + (e.modelChanges.added || []).map(m => `<li><b>+ ${esc(m)}</b></li>`).join('')
      + `</ul>`
    : ''
  const content = [
    ...storyNotes.map(n => `<p><b>Related access context:</b> ${esc(n.text)} <a href="${siteUrl}/day/${n.day}/#${n.anchor}">Related entry</a></p>`),
    eli5 ? `<blockquote><p><b>In plain English:</b> ${esc(eli5)}</p></blockquote>` : '',
    summary ? `<p>${esc(summary)}</p>` : '',
    modelChangesHtml,
    factsHtml ? `<p><b>Details:</b></p><ul>${factsHtml}</ul>` : '',
    `<p><a href="${siteUrl}/day/${e.day}/#${e.sha.slice(0, 12)}">View on changelog</a> · <a href="${e.url || `https://github.com/CodebuffAI/freebuff/commit/${e.sha}`}">Commit ${e.sha.slice(0, 8)}</a>${e.prUrl ? ` · <a href="${e.prUrl}">PR #${e.pr}</a>` : ''}</p>`
  ].filter(Boolean).join('')

  const authorTag = e.author ? `<dc:creator>${esc(e.author)}</dc:creator>` : ''
  const categories = [e.category, e.significance, ...(e.areas || [])].filter(Boolean)
  const categoryTags = categories.map(c => `<category>${esc(c)}</category>`).join('')

  return `<item><title>${esc(title)}</title><link>${siteUrl}/day/${e.day}/#${e.sha.slice(0, 12)}</link>`
    + `<guid isPermaLink="false">${esc(e.sha)}</guid><pubDate>${new Date(e.date).toUTCString()}</pubDate>`
    + `${authorTag}${categoryTags}`
    + `<description>${esc(desc)}</description>`
    + `<content:encoded xmlns:content="http://purl.org/rss/1.0/modules/content/"><![CDATA[${content}]]></content:encoded></item>`
}

export function feedXml (siteUrl, siteName, siteDesc, generated, name, title, desc, items) {
  return `<?xml version="1.0" encoding="UTF-8"?>`
    + `<?xml-stylesheet type="text/xsl" href="/feed.xsl"?>`
    + `<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title>${esc(title)}</title>`
    + `<link>${siteUrl}</link><atom:link href="${siteUrl}/${name}" rel="self" type="application/rss+xml" /><description>${esc(desc)}</description><language>en</language><lastBuildDate>${new Date(generated).toUTCString()}</lastBuildDate>${items}</channel></rss>`
}

// JSON Feed 1.1 (jsonfeed.org): same envelope as RSS, reader-friendly JSON.
export function feedJson (siteUrl, generated, title, desc, feedPath, items) {
  return JSON.stringify({
    version: 'https://jsonfeed.org/version/1.1',
    title,
    home_page_url: siteUrl,
    feed_url: `${siteUrl}/${feedPath}`,
    description: desc,
    items: items.map(it => ({
      id: it.id,
      url: it.url,
      title: it.title,
      content_html: it.content_html,
      summary: it.summary,
      date_published: it.date_published,
      ...(it.authors ? { authors: it.authors } : {}),
      tags: it.tags
    }))
  })
}

export function jsonItem (siteUrl, e, titleOf, storyNotes = []) {
  const title = titleOf(e)
  const summary = String(e.ai?.summary || e.summary || '').replace(/[*`#]/g, '').trim()
  const eli5 = e.eli5?.text ? String(e.eli5.text).replace(/[*`#]/g, '').trim() : ''
  const facts = (e.facts || []).slice(0, 5).map(f => `<li>${esc(String(f)).slice(0, 400)}</li>`).join('')
  const html = [
    ...storyNotes.map(n => `<p><b>Related access context:</b> ${esc(n.text)} <a href="${siteUrl}/day/${n.day}/#${n.anchor}">Related entry</a></p>`),
    eli5 ? `<blockquote><p><b>In plain English:</b> ${esc(eli5)}</p></blockquote>` : '',
    summary ? `<p>${esc(summary)}</p>` : '',
    facts ? `<ul>${facts}</ul>` : ''
  ].filter(Boolean).join('')

  return {
    id: e.sha,
    url: `${siteUrl}/day/${e.day}/#${e.sha.slice(0, 12)}`,
    title: `[${e.day}] ${title}`,
    summary: [
      ...storyNotes.map(n => `[Related access context] ${n.text}`),
      eli5 ? `[In plain English] ${eli5} · ${summary}` : summary
    ].filter(Boolean).join(' · '),
    content_html: html,
    date_published: new Date(e.date).toISOString(),
    ...(e.author ? { authors: [{ name: e.author }] } : {}),
    tags: [e.category, e.significance, ...(e.areas || [])].filter(Boolean)
  }
}
