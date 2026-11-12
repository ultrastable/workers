// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// The whole console UI: one static page, no dependencies, no third-party requests.
// All dynamic text is inserted with textContent, never innerHTML (titles are written by agents).
// NOTE: no backticks and no dollar-brace sequences inside the script below, because this file is a template literal.
export const CONSOLE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ultrastable</title>
<style>
:root{--bg:#f7f7f5;--fg:#1c1c1a;--mut:#66665f;--card:#fff;--line:#e2e2dc;--ok:#1f7a4d;--warn:#b45309;--btn:#1c1c1a}
@media(prefers-color-scheme:dark){:root{--bg:#161614;--fg:#eeeee9;--mut:#9a9a92;--card:#1f1f1c;--line:#34342f;--ok:#4cc38a;--warn:#f0a04b;--btn:#eeeee9}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:17px/1.45 system-ui,sans-serif}
main{max-width:34rem;margin:0 auto;padding:1rem 1rem 6rem}
h1{font-size:1.25rem;margin:.2rem 0 .1rem}h2{font-size:1rem;margin:1.4rem 0 .5rem;color:var(--mut);font-weight:600;text-transform:uppercase;letter-spacing:.04em}
.head{padding:1rem;border-radius:12px;background:var(--card);border:1px solid var(--line)}.head p{margin:.2rem 0 0;color:var(--mut);font-size:.9rem}
.dot{display:inline-block;width:.7rem;height:.7rem;border-radius:50%;margin-right:.45rem;background:var(--ok)}.dot.bad{background:var(--warn)}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:.9rem;margin:.6rem 0}.card p{margin:.25rem 0}.mut{color:var(--mut);font-size:.9rem}
.nums{display:flex;gap:.6rem}.nums div{flex:1;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:.7rem;text-align:center}.nums b{display:block;font-size:1.6rem}
button{font:inherit;border:1px solid var(--btn);background:var(--btn);color:var(--bg);border-radius:10px;padding:.6rem .9rem;margin:.35rem .35rem 0 0;min-height:2.75rem;cursor:pointer}
button.alt{background:transparent;color:var(--fg);border-color:var(--line)}
nav{position:fixed;bottom:0;left:0;right:0;display:flex;background:var(--card);border-top:1px solid var(--line)}nav button{flex:1;margin:0;border:0;border-radius:0;background:transparent;color:var(--mut);min-height:3.4rem}nav button[aria-selected=true]{color:var(--fg);font-weight:700;box-shadow:inset 0 -3px var(--fg)}
.ask{display:flex;gap:.4rem;margin-top:.6rem}.ask input{flex:1;font:inherit;padding:.65rem;border-radius:10px;border:1px solid var(--line);background:var(--card);color:var(--fg)}
.chips button{font-size:.9rem;padding:.4rem .7rem;min-height:2.2rem}
.say{margin:.6rem 0;padding:.7rem;border-left:3px solid var(--ok);background:var(--card)}
[hidden]{display:none}
</style></head><body><main>
<div class="head"><h1><span class="dot" id="dot"></span><span id="headline">Loading</span></h1><p id="sub"></p></div>
<div id="say" class="say" hidden></div>
<section id="s-now"></section><section id="s-needs" hidden></section><section id="s-prog" hidden></section><section id="s-connect" hidden></section><section id="s-help" hidden></section>
<h2>Ask for something</h2>
<div class="chips" id="chips"></div>
<form class="ask" id="askform"><input id="asktext" maxlength="500" placeholder="Say what you want, in your own words" aria-label="Say what you want"><button>Send</button></form>
</main>
<nav role="tablist"><button role="tab" data-t="now" aria-selected="true">Now</button><button role="tab" data-t="needs" aria-selected="false">Needs you</button><button role="tab" data-t="prog" aria-selected="false">Progress</button><button role="tab" data-t="connect" aria-selected="false">Connect</button><button role="tab" data-t="help" aria-selected="false">Help</button></nav>
<script>
var D=null,TAB='now';
function el(t,c,x){var e=document.createElement(t);if(c)e.className=c;if(x!==undefined)e.textContent=x;return e}
function say(m){var s=document.getElementById('say');s.textContent=m;s.hidden=!m}
function post(u,b){if(!window.confirm('Please confirm.'))return Promise.resolve({ok:false,j:{error:'Cancelled.'}});b.confirm=true;return fetch(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)}).then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j}})})}
function list(sec,title,items,fmt){sec.appendChild(el('h2','',title));if(!items.length){sec.appendChild(el('p','mut','Nothing here.'));return}items.forEach(function(i){var c=el('div','card');fmt(c,i);sec.appendChild(c)})}
function render(){
 document.getElementById('headline').textContent=D.headline;document.getElementById('dot').className='dot'+(D.ok?'':' bad');
 document.getElementById('sub').textContent=D.last_check?('Last check: '+D.last_check):'';
 var n=document.getElementById('s-now');n.textContent='';
 var nums=el('div','nums');[['Open',D.now.open],['Done',D.now.done],['Stuck',D.now.blocked]].forEach(function(p){var d=el('div');d.appendChild(el('b','',String(p[1])));d.appendChild(el('span','mut',p[0]));nums.appendChild(d)});n.appendChild(nums);
 list(n,'Working on',D.now.working_on,function(c,i){c.appendChild(el('p','',i.title));c.appendChild(el('p','mut',i.owner_role))});
 if(D.now.stuck.length)list(n,'Stuck',D.now.stuck,function(c,i){c.appendChild(el('p','',i.title));c.appendChild(el('p','mut',i.blocker||''))});
 var s=document.getElementById('s-needs');s.textContent='';
 list(s,'Needs you',D.needs_you.cards,function(c,i){
  c.appendChild(el('p','',i.what));c.appendChild(el('p','mut','If you do nothing: '+i.default_in_effect));
  if(i.kind==='manual'){var b1=el('button','','I did it');b1.onclick=function(){act(i.id,'done')};var b2=el('button','alt','Use the default');b2.onclick=function(){act(i.id,'default')};c.appendChild(b1);c.appendChild(b2)}
  if(i.kind==='secret'){var b4=el('button','','Add it in Connect');b4.onclick=function(){show('connect')};c.appendChild(b4)}
  var b3=el('button','alt','What does this mean?');b3.onclick=function(){act(i.id,'explain')};c.appendChild(b3)});
 if(D.needs_you.more)s.appendChild(el('p','mut','And '+D.needs_you.more+' more after these.'));
 var p=document.getElementById('s-prog');p.textContent='';
 list(p,'Finished lately',D.progress.done_lately,function(c,i){c.appendChild(el('p','',i.title));c.appendChild(el('p','mut',i.updated_at))});
 p.appendChild(el('h2','','How well it predicts'));var pr=D.progress.predictions;var c1=el('div','card');c1.appendChild(el('p','',pr.scored?('It called '+pr.hit+' of '+pr.scored+' outcomes right.'):'Nothing scored yet.'));p.appendChild(c1);
 list(p,'Where it acts on its own',D.progress.autonomy,function(c,i){c.appendChild(el('p','',i.surface+': '+i.action_class));c.appendChild(el('p','mut','Level: '+i.rung))});
 renderConnect();renderHelp();
 var ch=document.getElementById('chips');ch.textContent='';D.suggestions.forEach(function(q){var b=el('button','alt',q);b.onclick=function(){chip(q)};ch.appendChild(b)});
 show(TAB)}
var HELP={ANTHROPIC_API_KEY:'This lets the system ask a language model to write and review work. You get the key from the account page of your model provider, under API keys. Paste it here once; it is kept private and never shown again.',VCS_TOKEN:'This lets the system open draft pull requests on your code host. Create a fine-grained access token limited to your repositories, with permission to read and write contents and pull requests, then paste it here once. It is never shown again.',OPENAI_API_KEY:'A key from your model provider account.'};
function renderHelp(){var s=document.getElementById('s-help');s.textContent='';s.appendChild(el('h2','','Help'));(D.help||[]).forEach(function(h){var c=el('div','card');c.appendChild(el('p','',h.title));h.text.split(String.fromCharCode(10,10)).forEach(function(t){c.appendChild(el('p','mut',t))});s.appendChild(c)})}
function renderConnect(){var s=document.getElementById('s-connect');s.textContent='';s.appendChild(el('h2','','Connect'));var L=D.connections||[];if(!L.length)s.appendChild(el('p','mut','Nothing to connect here.'));
 L.forEach(function(k){var c=el('div','card');c.appendChild(el('p','',k.label));c.appendChild(el('p','mut',k.present?('Connected'+(k.set_at?' ('+k.set_at+')':'')+'. Paste a new value to replace it.'):'Not connected yet.'));c.appendChild(el('p','mut',k.help||HELP[k.name]||''));
  var f=el('form');var inp=el('input');inp.type='password';inp.autocomplete='off';inp.setAttribute('aria-label',k.label);inp.style.cssText='width:100%;padding:.6rem;margin:.4rem 0;font:inherit';var b=el('button','','Save');f.appendChild(inp);f.appendChild(b);
  f.onsubmit=function(e){e.preventDefault();var v=inp.value.trim();if(!v)return;post('/api/console/secret',{name:k.name,value:v}).then(function(r){inp.value='';say(r.ok?'Saved. It is stored privately and will not be shown again.':(r.j.error||'Could not save.'));load()})};
  c.appendChild(f);if(k.source==='console'){var rm=el('button','alt','Disconnect');rm.type='button';rm.onclick=function(){post('/api/console/secret/remove',{name:k.name}).then(function(r){say(r.ok?'Disconnected.':(r.j.error||'Could not disconnect.'));load()})};c.appendChild(rm)}s.appendChild(c)})}
function show(t){TAB=t;['now','needs','prog','connect','help'].forEach(function(k){document.getElementById('s-'+k).hidden=(k!==t)});document.querySelectorAll('nav button').forEach(function(b){b.setAttribute('aria-selected',String(b.dataset.t===t))})}
function chip(q){if(q.indexOf('need from me')>-1)show('needs');else if(q.indexOf('stuck')>-1)show('now');else show('prog');window.scrollTo(0,0)}
function act(id,choice){post('/api/console/card',{id:id,choice:choice}).then(function(r){if(r.j.explain)say(r.j.explain);else if(!r.ok)say(r.j.error||'Something went wrong.');else say('Done.');load()})}
function load(){fetch('/api/console').then(function(r){if(r.status===401){location.href='/console';return null}return r.json()}).then(function(j){if(j){D=j;render()}})}
document.querySelectorAll('nav button').forEach(function(b){b.onclick=function(){show(b.dataset.t)}});
document.getElementById('askform').onsubmit=function(e){e.preventDefault();var i=document.getElementById('asktext');var t=i.value.trim();if(!t)return;post('/api/console/ask',{text:t}).then(function(r){say(r.j.message||r.j.error);i.value='';load()})};
load();setInterval(load,60000);
</script></body></html>`;
