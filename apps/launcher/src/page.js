// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// The launcher page: plain words, no terminal, no jargon. All dynamic text is inserted with textContent.
// No backticks and no dollar-brace sequences inside the script: this file is a template literal.
import { powWorkerSource } from './pow.js';

export function launcherPage({ bundleSha256 = 'unreleased', turnstileSiteKey = null } = {}) {
  const tsKey = typeof turnstileSiteKey === 'string' && /^[0-9A-Za-z_-]{1,64}$/.test(turnstileSiteKey) ? turnstileSiteKey : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ultrastable: say what you want</title>
<style>
:root{--bg:#f7f7f5;--fg:#1c1c1a;--mut:#66665f;--card:#fff;--line:#e2e2dc;--ok:#1f7a4d;--warn:#b45309;--btn:#1c1c1a}
@media(prefers-color-scheme:dark){:root{--bg:#161614;--fg:#eeeee9;--mut:#9a9a92;--card:#1f1f1c;--line:#34342f;--ok:#4cc38a;--warn:#f0a04b;--btn:#eeeee9}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:18px/1.5 system-ui,sans-serif}
main{max-width:36rem;margin:0 auto;padding:1.2rem 1rem 4rem}h1{font-size:1.6rem;margin:.4rem 0}h2{font-size:1.1rem;margin:1.6rem 0 .4rem}
p{margin:.5rem 0}.mut{color:var(--mut);font-size:.92rem}.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:1rem;margin:.8rem 0}
textarea,input[type=text],input[type=number]{width:100%;font:inherit;padding:.7rem;border-radius:10px;border:1px solid var(--line);background:var(--card);color:var(--fg)}
textarea{min-height:7rem}label{display:block;margin:.7rem 0 .2rem;font-weight:600}.row{display:flex;gap:.6rem;align-items:flex-start;margin:.6rem 0}.row input{margin-top:.35rem;transform:scale(1.3)}
button{font:inherit;border:1px solid var(--btn);background:var(--btn);color:var(--bg);border-radius:10px;padding:.8rem 1.2rem;min-height:3rem;cursor:pointer;margin:.4rem .4rem 0 0}
button.alt{background:transparent;color:var(--fg);border-color:var(--line)}button:disabled{opacity:.5;cursor:default}
.key{font:1.1rem ui-monospace,monospace;word-break:break-all;background:var(--bg);border:1px dashed var(--line);padding:.6rem;border-radius:8px}
.err{border-color:var(--warn)}[hidden]{display:none}details{margin:.5rem 0}summary{cursor:pointer;color:var(--mut)}
</style></head><body><main>
<h1>Say what you want.</h1>
<p>Ultrastable works out what it needs to know, writes the plans, and builds and runs it. No code, no terminal. This page puts a live preview of your idea online so you can see it. It takes about two minutes.</p>
<p class="mut">It runs on Cloudflare, and a free preview needs no account. By default Ultrastable does not write business plans, file legal documents, give legal or financial advice, or run marketing.</p>

<section id="s1" class="card">
  <label for="idea">What do you want to exist, and who is it for?</label>
  <textarea id="idea" maxlength="2000" placeholder="For example: a neighbourhood tool library where people borrow tools instead of buying them, booked from a phone."></textarea>
  <label for="o1">What would you most like to see working first?</label>
  <input id="o1" type="text" maxlength="200" placeholder="For example: a page where neighbours can book a drill">
  <label for="o2">And second? (optional)</label>
  <input id="o2" type="text" maxlength="200">
  <label for="lim">How much are you comfortable spending a month on AI models?</label>
  <input id="lim" type="number" min="0" max="1000" value="0">
  <p class="mut">Zero is fine and is the default: only free models are used. Nothing is ever spent without you approving it.</p>
  <button id="next1">Continue</button>
</section>

<section id="s2" class="card" hidden>
  <h2 style="margin-top:0">Check what I understood</h2>
  <p id="readback"></p>
  <p class="mut">Anything you leave blank becomes a stated default you can change later. Nothing you type here is kept by this page after your preview is created.</p>
  <h2>Two things to agree to</h2>
  <div class="row"><input type="checkbox" id="tos"><label for="tos" style="margin:0;font-weight:400">I have read and accept <a href="https://www.cloudflare.com/terms/" target="_blank" rel="noopener">Cloudflare's terms</a> and <a href="https://www.cloudflare.com/privacypolicy/" target="_blank" rel="noopener">privacy policy</a>. A free preview account is created in my name for about an hour.</label></div>
  <div class="row"><input type="checkbox" id="lic"><label for="lic" style="margin:0;font-weight:400">I understand Ultrastable is <b>free for non-commercial use</b>. If I make money with it, a commercial license applies. <a href="https://github.com/ultrastable/license" target="_blank" rel="noopener">Read the license</a>.</label></div>
  ${tsKey ? '<div id="ts"></div>' : ''}
  <button id="go" disabled>Put my preview online</button><button class="alt" id="back">Change my answers</button>
</section>

<section id="s3" class="card" hidden><p id="status">Working</p><p class="mut" id="substatus"></p></section>

<section id="s4" class="card" hidden>
  <h2 style="margin-top:0">Your preview is online</h2>
  <p><a id="url" target="_blank" rel="noopener"></a></p>
  <p>To open it, use this key. <b>It is shown once. Copy it now.</b></p>
  <p class="key" id="key"></p>
  <button id="copykey" class="alt">Copy the key</button>
  <h2>Keep it</h2>
  <p>This preview disappears in about an hour. To keep it, open your private link, then sign in to Cloudflare or create a free account. That is your step: only you can do it.</p>
  <p><a id="claim" target="_blank" rel="noopener">Open my private link</a> <span class="mut">(do not share it: anyone with it can take your preview)</span></p>
  <h2>What this preview can and cannot do yet</h2>
  <ul id="notes"></ul>
  <details><summary>What was put online</summary><p class="mut">The released Ultrastable program with fingerprint <span id="sha"></span>, a small database holding what you said, and a three-screen console.</p></details>
</section>

<section id="s5" class="card err" hidden><p id="errmsg"></p><button id="retry" class="alt">Try again</button></section>

<p class="mut" style="margin-top:2rem">Prefer to use an AI assistant or a terminal? See the <a href="https://github.com/ultrastable/workers/blob/main/agent-setup/SKILL.md">paste-in prompt</a>. Launcher version fingerprint: <span id="bsha"></span>.</p>
</main>
<script>
var $=function(i){return document.getElementById(i)};var POW_SRC=${JSON.stringify(powWorkerSource())};document.getElementById('bsha').textContent=${JSON.stringify(bundleSha256.slice(0, 12))};
function show(n){['s1','s2','s3','s4','s5'].forEach(function(s){$(s).hidden=(s!=='s'+n)})}
function words(){return{idea:$('idea').value.trim(),outcomes:[$('o1').value.trim(),$('o2').value.trim()].filter(Boolean),limit:Number($('lim').value||0)}}
$('next1').onclick=function(){var a=words();if(a.idea.length<10){alert('Please say a little more about what you want.');return}
  $('readback').textContent='You want: '+a.idea+(a.outcomes.length?' First, you would like to see: '+a.outcomes.join('; ')+'.':'')+' Monthly AI spending limit: '+a.limit+' USD.';show(2)};
$('back').onclick=function(){show(1)};
var TS_KEY='${tsKey}',TS_TOKEN='';${tsKey ? "if(TS_KEY){var tsS=document.createElement('script');tsS.src='https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';tsS.onload=function(){window.turnstile.render('#ts',{sitekey:TS_KEY,action:'provision',callback:function(t){TS_TOKEN=t;ready()},'expired-callback':function(){TS_TOKEN='';ready()}})};document.head.appendChild(tsS)}" : ''}
function ready(){$('go').disabled=!($('tos').checked&&$('lic').checked&&(!TS_KEY||TS_TOKEN))}$('tos').onchange=ready;$('lic').onchange=ready;
function fail(m){$('errmsg').textContent=m;show(5)}
$('retry').onclick=function(){show(2)};
function solve(c){return new Promise(function(res,rej){var url=URL.createObjectURL(new Blob([POW_SRC],{type:'text/javascript'}));var w=new Worker(url);
  w.onmessage=function(e){w.terminate();URL.revokeObjectURL(url);e.data.error?rej(new Error(e.data.error)):res(e.data.checkpoints)};w.onerror=function(){rej(new Error('Your browser could not run the safety check.'))};w.postMessage({seed:c.seed,k:c.k,g:c.g})})}
$('go').onclick=function(){show(3);$('status').textContent='Asking Cloudflare for a safety check';$('substatus').textContent='';
  fetch('/api/challenge').then(function(r){return r.json()}).then(function(c){if(c.error)throw new Error(c.error);$('status').textContent='Doing the safety check on your device';$('substatus').textContent='This takes about ten seconds. Please keep this page open.';
    return solve(c).then(function(cp){return {challengeToken:c.challengeToken,solution:{checkpoints:cp}}})})
  .then(function(proof){$('status').textContent='Putting your preview online';$('substatus').textContent='Creating a small database, loading what you said, starting the console.';var a=words();
    return fetch('/api/provision',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({proof:proof,idea:a.idea,outcomes:a.outcomes,limit:a.limit,acceptedCloudflareTerms:$('tos').checked,acceptedLicense:$('lic').checked,turnstile:TS_TOKEN})}).then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.error||'Something went wrong.');return j})})})
  .then(function(r){$('url').textContent=r.url;$('url').href=r.url;$('key').textContent=r.consoleKey;$('claim').href=r.claimUrl;$('sha').textContent=String(r.bundleSha256||'').slice(0,12);
    $('notes').textContent='';(r.notes||[]).forEach(function(n){var li=document.createElement('li');li.textContent=n;$('notes').appendChild(li)});
    $('copykey').onclick=function(){navigator.clipboard&&navigator.clipboard.writeText(r.consoleKey);$('copykey').textContent='Copied'};show(4)})
  .catch(function(e){fail(e.message||'Something went wrong. Nothing was kept. You can try again.')})};
</script></body></html>`;
}
