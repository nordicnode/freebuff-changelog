// generator/lib/feed.mjs - RSS feeds (XML render + XSL stylesheet), favicons.
// Pure render helpers; buildSite() in site.mjs passes entries and writes output.
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

export const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="4" fill="#0d1117"/><text x="5" y="22" font-family="monospace" font-weight="bold" font-size="20" fill="#58a6ff">&gt;_</text></svg>`

export const FEED_XSL = `<?xml version="1.0" encoding="utf-8"?>
<xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform" xmlns:atom="http://www.w3.org/2005/Atom">
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
          .item-desc{color:var(--txt-dim);font-size:12px;margin:0}
          .sub-callout{background:#1c1e24;border-left:3px solid var(--term-amber);padding:10px 14px;margin:12px 0}
        </style>
      </head>
      <body>
        <div class="feed-wrap">
          <div class="term-box">
            <div class="term-box-hdr">== [ RSS FEED :: <xsl:value-of select="/rss/channel/title"/> ] ==</div>
            <p><xsl:value-of select="/rss/channel/description"/></p>
            <div class="sub-callout">
              <span class="feed-badge">RSS 2.0</span>
              <p style="margin-top:6px">This is an RSS feed. To subscribe and receive updates automatically in your newsreader (Feedly, NetNewsWire, Miniflux, etc.), copy this URL:</p>
              <code style="color:var(--term-green);font-size:12px"><xsl:value-of select="/rss/channel/atom:link/@href"/></code>
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

// One feed <item>: title link, stable guid, summary + facts in content.
export function feedItem (siteUrl, e, titleOf) {
  // Date-prefix disambiguates repeat titles across days ("New slash
  // command /queue" shipped once; model swaps repeat names often).
  const title = `[${e.day}] ${titleOf(e)}`
  const summary = String(e.ai?.summary || e.summary || '').replace(/[*`#]/g, '')
  const facts = (e.facts || []).slice(0, 5).map(f => `<li>${esc(String(f)).slice(0, 400)}</li>`).join('')
  const content = facts
    ? `<p>${esc(summary)}</p><p><b>Details:</b></p><ul>${facts}</ul>`
    : `<p>${esc(summary)}</p>`
  return `<item><title>${esc(title)}</title><link>${siteUrl}/day/${e.day}/#${e.sha.slice(0, 12)}</link>`
    + `<guid isPermaLink="false">${esc(e.sha)}</guid><pubDate>${new Date(e.date).toUTCString()}</pubDate>`
    + `<description>${esc(title)}: ${esc(summary.slice(0, 300))}</description>`
    + `<content:encoded xmlns:content="http://purl.org/rss/1.0/modules/content/"><![CDATA[${content}]]></content:encoded></item>`
}

export function feedXml (siteUrl, siteName, siteDesc, generated, name, title, desc, items) {
  return `<?xml version="1.0" encoding="UTF-8"?>`
    + `<?xml-stylesheet type="text/xsl" href="/feed.xsl"?>`
    + `<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>${esc(title)}</title>`
    + `<link>${siteUrl}</link><atom:link href="${siteUrl}/${name}" rel="self" type="application/rss+xml" /><description>${esc(desc)}</description><language>en</language><lastBuildDate>${new Date(generated).toUTCString()}</lastBuildDate>${items}</channel></rss>`
}
