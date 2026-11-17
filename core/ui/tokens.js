// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// core/ui design tokens. One source for the colours, the contrast pairs the tests check, and the stylesheet.
// A product re-themes by passing `theme` (accent colours); the pairs are re-checked by contrastReport().
export const LIGHT = { bg: '#fbfaf7', surface: '#ffffff', sunk: '#f1efe8', ink: '#16202a', mut: '#4a5562', line: '#d6d3c8', accent: '#0a4f9e', accentInk: '#ffffff',
  ok: '#0f6129', okBg: '#e5f3e9', warn: '#764700', warnBg: '#fff2d1', info: '#0a4f9e', infoBg: '#e6effb', bad: '#9f1a10', focus: '#ffbf47' };
export const DARK = { bg: '#11171c', surface: '#192027', sunk: '#0d1216', ink: '#e8ecef', mut: '#a8b3bd', line: '#2e3944', accent: '#8ec1ff', accentInk: '#0b1620',
  ok: '#74d58f', okBg: '#16301f', warn: '#f2c35c', warnBg: '#33280e', info: '#8ec1ff', infoBg: '#14263a', bad: '#ff9d92', focus: '#ffbf47' };

// [foreground, background, minimum ratio]: WCAG 2.2 AA is 4.5 for text. Every text/background pair the stylesheet uses is listed here.
export const PAIRS = [['ink', 'bg', 4.5], ['ink', 'surface', 4.5], ['ink', 'sunk', 4.5], ['mut', 'bg', 4.5], ['mut', 'surface', 4.5], ['mut', 'sunk', 4.5],
  ['accent', 'bg', 4.5], ['accent', 'surface', 4.5], ['accent', 'sunk', 4.5], ['accentInk', 'accent', 4.5], ['ok', 'okBg', 4.5], ['warn', 'warnBg', 4.5], ['info', 'infoBg', 4.5],
  ['ok', 'surface', 4.5], ['warn', 'surface', 4.5], ['bad', 'surface', 4.5], ['line', 'bg', 1.2]];

const lin = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const lum = hex => { const n = parseInt(hex.slice(1), 16); return 0.2126 * lin(n >> 16 & 255) + 0.7152 * lin(n >> 8 & 255) + 0.0722 * lin(n & 255); };
export const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
export function contrastReport(theme = {}) {
  const out = [];
  for (const [mode, base] of [['light', LIGHT], ['dark', DARK]]) {
    const t = { ...base, ...(theme[mode] || {}) };
    for (const [f, b, min] of PAIRS) { const r = contrast(t[f], t[b]); out.push({ mode, fg: f, bg: b, ratio: Math.round(r * 100) / 100, min, ok: r >= min }); }
  }
  return out;
}
const vars = t => Object.entries(t).map(([k, v]) => `--${k.replace(/[A-Z]/g, m => '-' + m.toLowerCase())}:${v}`).join(';');

// The whole stylesheet is inline and small on purpose: no request, no font download, no script.
export function css(theme = {}) {
  const L = { ...LIGHT, ...(theme.light || {}) }, D = { ...DARK, ...(theme.dark || {}) };
  return `:root{${vars(L)};--r:10px;--w:72rem;--read:44rem;--serif:ui-serif,Georgia,"Iowan Old Style","Times New Roman",serif;--sans:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color-scheme:light dark}
@media(prefers-color-scheme:dark){:root:not([data-theme=light]){${vars(D)}}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}body{margin:0;background:var(--bg);color:var(--ink);font:1.0625rem/1.65 var(--sans)}
a{color:var(--accent);text-underline-offset:.18em}a:hover{text-decoration-thickness:2px}
:focus-visible{outline:3px solid var(--focus);outline-offset:2px;box-shadow:0 0 0 5px var(--ink);border-radius:3px}
.skip{position:absolute;left:8px;top:-4rem;background:var(--ink);color:var(--bg);padding:.6rem 1rem;z-index:10;border-radius:0 0 8px 8px}.skip:focus{top:0}
.wrap{max-width:var(--w);margin:0 auto;padding:0 clamp(16px,4vw,32px)}
.site-h{background:var(--surface);border-bottom:1px solid var(--line)}.site-h .wrap{display:flex;flex-wrap:wrap;align-items:center;gap:.25rem 1.25rem;padding-block:.5rem}
.brand{font:700 1.2rem var(--serif);color:var(--ink);text-decoration:none;display:flex;flex-direction:column;line-height:1.2;padding:.4rem 0}.brand small{font:.75rem var(--sans);color:var(--mut);font-weight:400}
.nav{display:flex;flex-wrap:wrap;gap:0 .25rem;margin:0;padding:0;list-style:none}.nav a{display:inline-block;padding:.65rem .7rem;min-height:44px;color:var(--ink);text-decoration:none;border-bottom:3px solid transparent}
.nav a:hover{border-color:var(--line)}.nav a[aria-current]{border-color:var(--accent);font-weight:600}
.srch{margin-left:auto;display:flex;gap:.4rem}.srch input{width:12rem;max-width:100%;min-width:0}
input,select,button,.btn{font:inherit;min-height:44px;border-radius:8px}select{max-width:100%}input,select{padding:.4rem .7rem;border:1px solid var(--mut);background:var(--surface);color:var(--ink)}
button,.btn{display:inline-flex;align-items:center;justify-content:center;padding:.4rem 1.1rem;border:2px solid var(--accent);background:var(--accent);color:var(--accent-ink);font-weight:600;text-decoration:none;cursor:pointer}
.btn.alt,button.alt{background:transparent;color:var(--accent)}label{font-weight:600;display:block;margin-bottom:.2rem}
main{padding-block:1.5rem 3rem;display:block}h1,h2,h3{font-family:var(--serif);line-height:1.2;margin:0}h1{font-size:clamp(1.8rem,4.5vw,2.6rem);margin:.4rem 0 .6rem}
h2{font-size:1.5rem;margin:2.2rem 0 .6rem;scroll-margin-top:1rem}h3{font-size:1.15rem;margin:1.2rem 0 .3rem}p{margin:.5em 0}.lede{font-size:1.2rem;color:var(--ink);max-width:var(--read)}.m{color:var(--mut)}.s{font-size:.9rem}
.crumbs ol{display:flex;flex-wrap:wrap;gap:.1rem .5rem;list-style:none;margin:0 0 .4rem;padding:0;font-size:.92rem;color:var(--mut)}.crumbs li+li::before{content:"/";margin-right:.5rem}
.hero{padding:2.2rem 0 1.2rem}.hero .lede{margin-bottom:1.2rem}.hero form{display:flex;gap:.5rem;max-width:34rem;margin:0 0 1rem}.hero input{flex:1;min-width:0;min-height:52px}.acts{display:flex;flex-wrap:wrap;gap:.6rem}
.grid{display:grid;gap:1rem;grid-template-columns:repeat(auto-fill,minmax(16rem,1fr));margin:.8rem 0;padding:0;list-style:none}
.card{background:var(--surface);border:1px solid var(--line);border-top:4px solid hsl(var(--h,210) 55% 42%);border-radius:var(--r);padding:1rem 1.1rem;display:flex;flex-direction:column;gap:.35rem}
.card h2,.card h3{margin:0}.card p{font-size:.97rem}.card label{display:flex;gap:.5rem;align-items:center;font-weight:400;margin:.4rem 0 0;min-height:32px}input[type=checkbox]{width:1.4rem;height:1.4rem;min-height:0}.card h2,.card h3{font-size:1.1rem}.card h2 a,.card h3 a{color:var(--ink);text-decoration:none}.card h2 a:hover,.card h3 a:hover{text-decoration:underline}.card p{margin:0}.card .badges{margin-top:auto;padding-top:.4rem}
.badge{display:inline-flex;gap:.3rem;align-items:center;padding:.05rem .6rem;border-radius:99px;border:1px solid currentColor;font-size:.82rem;font-weight:600;line-height:1.5;margin:0 .3rem .3rem 0;color:var(--mut)}
.badge.ok{color:var(--ok);background:var(--ok-bg)}.badge.warn{color:var(--warn);background:var(--warn-bg)}.badge.info{color:var(--info);background:var(--info-bg)}
.stats{display:grid;gap:.8rem;grid-template-columns:repeat(auto-fit,minmax(8.5rem,1fr));margin:1rem 0;padding:0;list-style:none}.stats li{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:.7rem 1rem}
.stats b{display:block;font:700 1.8rem var(--serif);line-height:1.1}.stats span{color:var(--mut);font-size:.9rem}
.callout{border-left:6px solid var(--accent);background:var(--info-bg);padding:.8rem 1.1rem;border-radius:0 var(--r) var(--r) 0;margin:1rem 0}.callout.warn{border-color:var(--warn);background:var(--warn-bg)}.callout.ok{border-color:var(--ok);background:var(--ok-bg)}
.callout h2,.callout h3{font:700 1rem var(--sans);margin:0 0 .3rem}.callout ul{margin:.2rem 0;padding-left:1.2rem}
.cols{display:grid;gap:2rem;grid-template-columns:minmax(0,1fr)}@media(min-width:60rem){.cols{grid-template-columns:minmax(0,1fr) 20rem}.aside{position:sticky;top:1rem;align-self:start}}
.cols2g{display:grid;gap:1rem;grid-template-columns:repeat(auto-fit,minmax(14rem,1fr))}.aside{display:flex;flex-direction:column;gap:1rem}.box{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:.9rem 1.1rem}.box h2{font:700 1rem var(--sans);margin:0 0 .5rem}
.toc ol{margin:0;padding-left:1.1rem}.toc li{margin:.2rem 0}
dl.sl{margin:0;display:grid;grid-template-columns:minmax(6rem,.9fr) 1.4fr;gap:.45rem .8rem}.sl dt{color:var(--mut);font-size:.92rem}.sl dd{margin:0}
.tablewrap{overflow-x:auto;margin:.8rem 0}table{border-collapse:collapse;width:100%;background:var(--surface)}caption{text-align:left;font-weight:600;padding:.4rem 0}
th,td{border:1px solid var(--line);padding:.55rem .75rem;text-align:left;vertical-align:top}thead th{background:var(--sunk)}tbody th{font-weight:600;background:var(--sunk)}
.meter{display:inline-flex;gap:3px;vertical-align:middle;margin-right:.4rem}.meter i{width:.7rem;height:.9rem;border-radius:2px;background:var(--line);border:1px solid var(--mut)}.meter i.on{background:var(--ok);border-color:var(--ok)}
.bar{height:.7rem;background:var(--sunk);border:1px solid var(--mut);border-radius:99px;overflow:hidden;margin:.25rem 0}.bar i{display:block;height:100%;background:var(--warn)}
.facets>div{min-width:0}.facets{display:flex;flex-wrap:wrap;gap:.8rem;align-items:flex-end;background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:.9rem 1rem;margin:1rem 0}
.pager{display:flex;gap:.4rem;flex-wrap:wrap;list-style:none;padding:0;margin:1.2rem 0}.pager a,.pager span{display:inline-block;min-width:44px;min-height:44px;line-height:44px;text-align:center;border:1px solid var(--line);border-radius:8px;text-decoration:none;padding:0 .6rem;background:var(--surface)}.pager [aria-current]{background:var(--accent);color:var(--accent-ink);border-color:var(--accent)}
.list{list-style:none;margin:0;padding:0}.list>li{padding:.7rem 0;border-top:1px solid var(--line)}.list>li:first-child{border-top:0}
details{border:1px solid var(--line);border-radius:var(--r);background:var(--surface);margin:.6rem 0}summary{cursor:pointer;padding:.7rem 1rem;font-weight:600;min-height:44px}details>div{padding:0 1rem 1rem}
.cite{font:.92rem ui-monospace,Menlo,monospace;background:var(--sunk);padding:.7rem .9rem;border-radius:8px;overflow-wrap:anywhere}
.site-f{border-top:1px solid var(--line);background:var(--surface);color:var(--mut);font-size:.92rem;padding:1.6rem 0}.site-f .cols2{display:grid;gap:1.2rem;grid-template-columns:repeat(auto-fit,minmax(11rem,1fr))}.site-f h2{font:700 .95rem var(--sans);color:var(--ink);margin:0 0 .4rem}.site-f ul{list-style:none;margin:0;padding:0}.site-f li{margin:.2rem 0}
.vh{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
@media(prefers-reduced-motion:no-preference){a,button,.btn{transition:background-color .15s,border-color .15s}}
@media print{.site-h,.site-f,.skip,.facets,.pager,.hero form,.acts{display:none}body{background:#fff;color:#000;font-size:11pt}a{color:#000}a[href^="http"]::after{content:" (" attr(href) ")";font-size:.85em}.card,.box{break-inside:avoid}}`;
}
