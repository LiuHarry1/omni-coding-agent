/**
 * One conformance suite, run against every backend.
 *
 * The claim phase 2 rests on is that the extension backend is interchangeable
 * with the isolated one. Asserting that in prose is worthless; running the same
 * tool suite through both is the proof. Any behaviour that only works on
 * one backend shows up here as a failure.
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as http from 'node:http'
import {
  closeBrowser,
  getBrowser,
  getCurrentTabId,
  setBrowserBackendFactory,
} from '../browser/manager.js'
import type { BrowserBackend } from '../browser/types.js'
import {
  cdpTool,
  clickTool,
  consoleTool,
  dragTool,
  getBoundingBoxTool,
  networkTool,
  getTextTool,
  highlightTool,
  hoverTool,
  fillFormTool,
  lockTool,
  navigateTool,
  pressKeyTool,
  resizeTool,
  screenshotTool,
  scrollTool,
  selectOptionTool,
  snapshotTool,
  tabsTool,
  typeTool,
  waitForDownloadTool,
  waitForTool,
} from '../tools/BrowserTool/BrowserTool.js'
import type {
  AnyTool,
  DualChannelToolResult,
  ToolContext,
  ToolDefinition,
} from '../core/types.js'

const PAGE = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Verify Loop Fixture</title></head>
<body>
  <h1>Dashboard</h1>
  <p>Signed out.</p>

  <button id="counter">Clicked 0 times</button>
  <button id="single-activation">Single activation 0</button>

  <!-- A fixed box past the viewport edge stays in the accessibility tree
       (only negative-coordinate parking is pruned) but must never be
       click-targeted, including through the explicit force option. -->
  <p id="ghost-state">Ghost untouched</p>
  <button id="ghost-yes" style="position:fixed;left:10000px;top:10000px">Ghost Yes</button>

  <form id="login" onsubmit="event.preventDefault(); document.getElementById('status').textContent = 'Submitted ' + document.getElementById('email').value;">
    <label for="email">Email address</label>
    <input id="email" name="email" type="email" placeholder="you@example.com">
    <button type="submit">Sign in</button>
  </form>
  <p id="status">Not submitted</p>

  <label for="env">Environment</label>
  <select id="env">
    <option value="dev">Development</option>
    <option value="prod">Production</option>
    <option value="prod-preview">Production Preview</option>
    <option value="staging">Staging</option>
    <option value="qa">QA</option>
    <option value="canary">Canary</option>
    <option value="beta">Beta</option>
    <option value="demo">Demo</option>
    <option value="local">Local</option>
    <option value="testing">Testing</option>
    <option value="legacy" disabled>Legacy</option>
    <option value="sandbox">Sandbox</option>
  </select>

  <button id="hover-target">Hover me</button>
  <p id="hover-state">Not hovered</p>

  <p id="last-key">Last key: none</p>

  <ul id="rows">
    <li><button class="del" data-id="1">Delete Alice</button></li>
  </ul>
  <button id="recycle">Recycle row</button>

  <!-- Replaced wholesale by an identical node: the old ref detaches, but the
       thing it meant still exists, so a fresh snapshot should recover it. -->
  <div id="apply-host"><button class="apply">Apply changes</button></div>
  <button id="rebuild-apply">Rebuild apply</button>
  <p id="applied">not applied</p>

  <!-- A real modal sitting on top of a live button: the click must be refused
       with the blocker named, not dispatched into the void. -->
  <span style="position:relative;display:inline-block">
    <button id="under">Confirm order</button>
    <div role="dialog" aria-modal="true"
         style="position:absolute;inset:0;background:rgba(0,0,0,.5);color:#fff">Please wait…</div>
  </span>

  <button id="call-ok">Call ok</button>
  <button id="call-boom">Call boom</button>
  <button id="call-dead">Call dead host</button>
  <button id="call-xhr">Call xhr</button>

  <a href="/other">Go to other page</a>
  <a href="/other?popup=1" target="_blank">Open popup</a>
  <a href="/other?popup=noopener" target="_blank" rel="noopener">Open noopener popup</a>

  <!-- Role-less clickable nodes. Playwright emits these as generic + ref +
       [cursor=pointer], not as forged buttons. -->
  <p id="fab-state">fab closed</p>
  <div id="fab-direct" style="position:fixed;bottom:16px;right:16px;cursor:pointer;padding:8px 12px;background:#08f;color:#fff;z-index:20">有新消息</div>
  <div id="fab-wrap" style="position:fixed;bottom:16px;right:140px;cursor:pointer;padding:8px 12px;background:#08f;color:#fff;z-index:20"><span>我的沟通</span></div>
  <p>Inbox: <span id="fab-inline" style="cursor:pointer;color:#08f">打开消息</span></p>

  <!-- CSS pointer on a child, label on a sibling. The grouping parent is the
       click target (Playwright keeps the group; we put the ref on it). -->
  <p id="launcher-state">launcher closed</p>
  <p id="silent-state">silent closed</p>
  <div id="silent-dock" style="position:fixed;bottom:16px;left:280px;z-index:30;background:#333;color:#fff;padding:8px 12px">Alerts</div>
  <div id="launcher" style="position:fixed;bottom:16px;left:16px;z-index:30">
    <svg width="16" height="16" style="cursor:pointer" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="#fff"/></svg>
    <div id="launcher-chip" style="cursor:pointer;display:inline-block;padding:4px 8px;background:#f44;color:#fff">1</div>
    <span>Messages</span>
  </div>

  <!-- Wrapper roles must not quote the concatenated subtree as their name. -->
  <ul id="jobs">
    <li aria-label="Staff Engineer Remote $200k Long preview text that must stay a child and not become the listitem accessible name because that truncates the rest of the snapshot">
      <a href="/jobs/1">Staff Engineer</a>
      <span>Remote · $200k</span>
      <span>Long preview text that must stay a child and not become the listitem accessible name because that truncates the rest of the snapshot</span>
    </li>
  </ul>

  <div style="height: 2000px"></div>
  <div id="bottom">Bottom marker</div>

  <script>
    let n = 0;
    document.getElementById('counter').addEventListener('click', () => {
      n += 1;
      document.getElementById('counter').textContent = 'Clicked ' + n + ' times';
    });
    let singleActivationCount = 0;
    document.getElementById('single-activation').addEventListener('click', event => {
      singleActivationCount += 1;
      document.getElementById('single-activation').textContent =
        'Single activation ' + singleActivationCount;
      event.stopImmediatePropagation();
    }, { capture: true });
    document.getElementById('ghost-yes').addEventListener('click', () => {
      document.getElementById('ghost-state').textContent = 'Ghost clicked';
    });
    document.addEventListener('keydown', e => {
      const mods = [e.ctrlKey && 'Control', e.shiftKey && 'Shift'].filter(Boolean);
      document.getElementById('last-key').textContent =
        'Last key: ' + [...mods, e.key].join('+');
    });
    document.getElementById('hover-target').addEventListener('mouseover', () => {
      document.getElementById('hover-state').textContent = 'Hovered';
    });
    // Reuses the same DOM node for a different record -- the exact situation a
    // ref must not silently follow.
    document.getElementById('recycle').addEventListener('click', () => {
      const btn = document.querySelector('.del');
      btn.dataset.id = '2';
      btn.textContent = 'Delete Bob';
    });
    function wireApply() {
      document.querySelector('.apply').addEventListener('click', () => {
        document.getElementById('applied').textContent = 'applied';
      });
    }
    wireApply();
    document.getElementById('rebuild-apply').addEventListener('click', () => {
      // Same label, brand-new DOM node -> old ref is now detached.
      document.getElementById('apply-host').innerHTML =
        '<button class="apply">Apply changes</button>';
      wireApply();
    });
    document.getElementById('fab-direct').addEventListener('click', () => {
      document.getElementById('fab-state').textContent = 'fab opened';
    });
    document.getElementById('fab-wrap').addEventListener('click', () => {
      document.getElementById('fab-state').textContent = 'chat opened';
    });
    document.getElementById('fab-inline').addEventListener('click', () => {
      document.getElementById('fab-state').textContent = 'inline opened';
    });
    document.getElementById('launcher').addEventListener('click', () => {
      document.getElementById('launcher-state').textContent = 'launcher opened';
    });
    document.getElementById('silent-dock').addEventListener('click', () => {
      document.getElementById('silent-state').textContent = 'silent opened';
    });
    // Three shapes the network tool has to tell apart: a request that worked,
    // one the server rejected, and one that never reached a server at all.
    document.getElementById('call-ok').addEventListener('click', () => {
      fetch('/api/ok').catch(() => {});
    });
    document.getElementById('call-boom').addEventListener('click', () => {
      fetch('/api/boom', { method: 'POST' }).catch(() => {});
    });
    document.getElementById('call-dead').addEventListener('click', () => {
      // Port 1 refuses instantly, so the fetch rejects without a response.
      fetch('http://127.0.0.1:1/never').catch(() => {});
    });
    document.getElementById('call-xhr').addEventListener('click', () => {
      const x = new XMLHttpRequest();
      x.open('GET', '/api/ok?via=xhr');
      x.send();
    });
    console.error('boot failure: widget service unreachable');
  </script>
</body>
</html>`

const OTHER_PAGE = `<!doctype html>
<html><head><title>Other</title></head><body><h1>Other page</h1></body></html>`

const BEFOREUNLOAD_PAGE = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Before unload</title></head>
<body>
  <h1>Before unload</h1>
  <button id="arm">Arm before unload</button>
  <p id="state">not armed</p>
  <script>
    document.getElementById('arm').addEventListener('click', function () {
      window.addEventListener('beforeunload', function (event) {
        event.preventDefault();
        event.returnValue = '';
      });
      document.getElementById('state').textContent = 'armed';
    });
  </script>
</body>
</html>`

const COORDINATE_PAGE = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Coordinate Click</title></head>
<body>
  <p id="state">Canvas untouched</p>
  <canvas id="surface" width="300" height="160" style="position:fixed;left:40px;top:80px;border:1px solid #333"></canvas>
  <script>
    document.getElementById('surface').addEventListener('click', event => {
      document.getElementById('state').textContent = 'Canvas clicked detail=' + event.detail;
    });
    document.getElementById('surface').addEventListener('dblclick', event => {
      document.getElementById('state').textContent = 'Canvas double detail=' + event.detail;
    });
    document.getElementById('surface').addEventListener('contextmenu', event => {
      event.preventDefault();
      document.getElementById('state').textContent = 'Canvas context button=' + event.button;
    });
  </script>
</body>
</html>`

function nestedRows(count: number): string {
  const rows: string[] = []
  for (let i = 0; i < count; i++) {
    rows.push(
      `<div class="row" style="cursor:pointer;padding:8px">` +
        `<div><div><div><div>` +
        `<img alt="avatar ${i}" width="24" height="24">` +
        `<span>Candidate ${i} hello this is a long preview that used to become the generic name</span>` +
        `<span>删除</span>` +
        `</div></div></div></div></div>`,
    )
  }
  return rows.join('')
}

const NESTED_PAGE = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Nested Wrappers</title></head>
<body>
  <h1>Inbox</h1>
  <div id="chat-panel">
    <div id="msg-a" style="cursor:pointer;padding:8px">Alice: latest note</div>
    <div id="msg-b" style="cursor:pointer;padding:8px">Bob: another note</div>
  </div>
  <div id="noise">
    <p>Sidebar clutter that selector must not include.</p>
    <button id="noise-btn">Ignore me</button>
  </div>
  <div id="thread">${nestedRows(50)}</div>
</body>
</html>`

function overflowCopy(): string {
  const paras: string[] = []
  for (let i = 0; i < 400; i++) {
    paras.push(
      `<p>Filler paragraph ${i} so a document-order char budget would drop the fixed dock at the end of the body.</p>`,
    )
  }
  return paras.join('')
}

const OVERFLOW_PAGE = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Overflow Chrome</title></head>
<body>
  <h1>Feed</h1>
  <div id="feed">${overflowCopy()}</div>
  <div id="chat-dock" style="position:fixed;bottom:12px;right:12px;z-index:40;background:#08f;color:#fff;padding:8px">
    <svg width="14" height="14" style="cursor:pointer" viewBox="0 0 14 14"><circle cx="7" cy="7" r="5" fill="#fff"/></svg>
    <span style="cursor:pointer">1</span>
    <span>Chat dock</span>
  </div>
</body>
</html>`

function dialogLazyRows(): string {
  const rows: string[] = []
  for (let i = 1; i <= 20; i++) {
    rows.push(`<li>蒋先生 8月${i}日 不错过TA的回复 ${i}</li>`)
  }
  return rows.join('')
}

const DIALOG_NESTED_PAGE = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Nested Dialogs</title></head>
<body>
  <h1>Inbox home</h1>
  <p id="state">closed</p>
  <button id="open-list" type="button">Open inbox</button>
  <script>
    document.getElementById('open-list').addEventListener('click', function () {
      var list = document.createElement('div');
      list.setAttribute('role', 'dialog');
      list.setAttribute('aria-label', 'Conversations');
      list.style.cssText = 'position:fixed;inset:24px auto 16px 16px;width:280px;background:#fff;z-index:40;border:1px solid #ccc;padding:12px';
      var rows = '<li><button type="button" class="row">Ada Reed</button></li>';
      for (var i = 2; i <= 24; i++) rows += '<li><button type="button" class="row">Person ' + i + '</button></li>';
      list.innerHTML = '<h2>Conversations</h2><ul>' + rows + '</ul>';
      document.body.appendChild(list);
      list.addEventListener('click', function (ev) {
        var btn = ev.target.closest('.row');
        if (!btn) return;
        var existing = document.getElementById('thread');
        if (existing) existing.remove();
        var thread = document.createElement('div');
        thread.id = 'thread';
        thread.setAttribute('role', 'dialog');
        thread.setAttribute('aria-label', 'Thread');
        thread.style.cssText = 'position:fixed;inset:24px 16px 16px auto;width:360px;background:#fff;z-index:50;border:1px solid #ccc;padding:12px';
        thread.innerHTML = '<h2>' + btn.textContent + '</h2><p>Earlier message</p><textarea placeholder="Type a message"></textarea><button type="button">Send</button>';
        setTimeout(function () {
          document.body.appendChild(thread);
          document.getElementById('state').textContent = 'thread open';
        }, 400);
      });
    });
  </script>
</body>
</html>`

const DIALOG_LAZY_PAGE = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Dialog Lazy</title></head>
<body>
  <h1>Hiring home</h1>
  <div id="feed">${overflowCopy()}</div>
  <p id="inbox-state">inbox closed</p>
  <div id="open-inbox" style="position:fixed;bottom:16px;right:16px;cursor:pointer;z-index:20;background:#08f;color:#fff;padding:8px 12px">有新消息</div>
  <script>
    document.getElementById('open-inbox').addEventListener('click', function () {
      setTimeout(function () {
        var d = document.createElement('div');
        d.setAttribute('role', 'dialog');
        d.setAttribute('aria-modal', 'true');
        d.style.cssText = 'position:fixed;inset:24px 16px 16px auto;width:360px;overflow:auto;background:#fff;z-index:50;border:1px solid #ccc;padding:12px';
        d.innerHTML = '<h2>我的沟通</h2><button type="button">Close</button><ul>${dialogLazyRows()}</ul>';
        document.body.appendChild(d);
        document.getElementById('inbox-state').textContent = 'inbox open';
      }, 350);
    });
  </script>
</body>
</html>`

const ERROR_MODAL_PAGE = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Error Modal</title></head>
<body>
  <h1>Expense form</h1>
  <p>Merchant Name field</p>
  <button type="button" id="save">Save Expense</button>
  <script>
    document.getElementById('save').addEventListener('click', function () {
      var d = document.createElement('div');
      d.setAttribute('role', 'alertdialog');
      d.setAttribute('aria-modal', 'true');
      d.innerHTML = '<h2>Error</h2><p>This expense has been saved, but it is missing required information. Would you like to make corrections now?</p><button type="button">Yes</button><button type="button">No</button>';
      document.body.appendChild(d);
    });
  </script>
</body>
</html>`

const STALE_MODAL_PAGE = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Stale Modal</title></head>
<body>
  <h1>Expense form remains usable</h1>
  <label>Departure Date <input type="text" value="09/23/2026"></label>
  <button type="button">Continue Expense</button>
  <div role="dialog" aria-modal="true" style="position:absolute;left:-10000px;top:-10000px;width:300px;height:160px">
    <h2>Please Confirm</h2>
    <button type="button">Yes</button>
    <button type="button">No</button>
  </div>
</body>
</html>`

/** Concur Travel Allowance in miniature: document Escape = "cancel edit". */
const ESCAPE_TRAP_PAGE = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Escape Trap</title></head>
<body>
  <h1>Itinerary stop</h1>
  <label>Departure City <input id="dep" type="text" style="position:absolute;left:20px;top:80px;width:200px"></label>
  <label>Arrival City <input id="arr" type="text" style="position:absolute;left:20px;top:140px;width:200px"></label>
  <ul id="dep-list" class="x-boundlist" style="position:absolute;left:20px;top:104px;width:220px;height:80px;margin:0;padding:0;background:#eee;z-index:50;list-style:none">
    <li>Shanghai, Shanghai</li><li>Shenzhen, Guangdong</li>
  </ul>
  <p id="arr-state">arrival untouched</p>
  <p id="cancel-state">no cancel prompt</p>
  <script>
    var list = document.getElementById('dep-list');
    document.addEventListener('mousedown', function (e) {
      if (!list.contains(e.target)) { list.style.left = '-10000px'; list.style.top = '-10000px'; }
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') document.getElementById('cancel-state').textContent = 'Your changes may be lost';
    });
    document.getElementById('arr').addEventListener('click', function () {
      document.getElementById('arr-state').textContent = 'arrival clicked';
    });
  </script>
</body>
</html>`

const WAIT_TEXT_PAGE = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Wait Text</title></head>
<body>
  <h1>Wait fixture</h1>
  <p id="status">waiting</p>
  <p id="banner">Loading now</p>
  <p id="later" hidden>Selector appeared</p>
  <button id="reveal" type="button">Reveal</button>
  <button id="navigate-later" type="button">Navigate later</button>
  <script>
    document.getElementById('reveal').addEventListener('click', function () {
      setTimeout(function () {
        document.getElementById('status').textContent = 'Message delivered';
        document.getElementById('banner').remove();
        document.getElementById('later').hidden = false;
      }, 2000);
    });
    document.getElementById('navigate-later').addEventListener('click', function () {
      setTimeout(function () {
        location.href = '/other?waited=url';
      }, 1000);
    });
  </script>
</body>
</html>`

const TEXT_REGIONS_PAGE = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Text regions</title></head>
<body>
  <p>Body-only navigation chrome</p>
  <main>Main fallback text</main>
  <article>Primary article text</article>
</body>
</html>`

const SPA_PAGE = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>SPA fixture</title></head>
<body>
  <main id="app">
    <h1>SPA route one</h1>
    <button id="route">Go SPA two</button>
  </main>
  <script>
    document.getElementById('route').addEventListener('click', function () {
      history.pushState({ route: 2 }, '', '/spa?route=two');
      document.getElementById('app').innerHTML =
        '<h1>SPA route two</h1><button id="action">SPA action</button><p id="state">idle</p>';
      document.getElementById('action').addEventListener('click', function () {
        document.getElementById('state').textContent = 'spa action complete';
      });
    });
  </script>
</body>
</html>`

/** Every control kind browser_fill_form claims to handle, plus one it must refuse. */
const FORM_PAGE = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Form</title></head>
<body>
  <h1>Expense form</h1>
  <form id="expense">
    <label>Merchant <input id="merchant" name="merchant" type="text" value="old merchant"></label>
    <label>Total <input id="total" name="total" type="text"></label>
    <label>Computed tax <input id="tax" name="tax" type="text" value="0.00" readonly></label>
    <label>Billable <input id="billable" name="billable" type="checkbox"></label>
    <label>Personal <input id="personal" type="radio" name="kind" value="personal"></label>
    <label>Currency
      <select id="currency" name="currency">
        <option value="cny">CNY</option>
        <option value="usd">USD</option>
      </select>
    </label>
    <label>Tags
      <select id="tags" name="tags" multiple>
        <option value="urgent">Urgent</option>
        <option value="travel">Travel</option>
        <option value="client">Client</option>
      </select>
    </label>
  </form>
  <p id="tax-state">tax untouched</p>
  <script>
    // Stands in for an app that computes a readonly field from the others.
    document.getElementById('total').addEventListener('change', function (e) {
      var n = parseFloat(e.target.value || '0');
      document.getElementById('tax').value = (n * 0.06).toFixed(2);
      document.getElementById('tax-state').textContent = 'tax computed';
    });
  </script>
</body>
</html>`

const COMBOBOX_PAGE = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Combobox</title></head>
<body>
  <h1>Pickers</h1>
  <label>Fruit
    <div id="fruit-combo" role="combobox" aria-label="Fruit" aria-expanded="false">
      <input id="fruit" type="text" aria-label="Fruit">
    </div>
  </label>
  <ul id="fruit-list" role="listbox" hidden></ul>
  <p id="fruit-state">none</p>
  <button id="ask" type="button">Confirm me</button>
  <p id="dialog-state">waiting</p>
  <button id="prompt" type="button">Prompt me</button>
  <p id="prompt-state">prompt waiting</p>
  <button id="alert" type="button">Alert me</button>
  <p id="alert-state">alert waiting</p>
  <input id="receipt" type="file" multiple aria-label="Receipt upload">
  <p id="file-state">none</p>
  <script>
    var fruits = ['Apple', 'Banana', 'Cherry'];
    var combo = document.getElementById('fruit-combo');
    var input = document.getElementById('fruit');
    var list = document.getElementById('fruit-list');
    function render(filter) {
      list.innerHTML = '';
      var q = (filter || '').toLowerCase();
      fruits.filter(function (r) { return !q || r.toLowerCase().indexOf(q) !== -1; }).forEach(function (r) {
        var li = document.createElement('li');
        li.setAttribute('role', 'option');
        li.textContent = r;
        li.addEventListener('click', function () {
          input.value = r;
          document.getElementById('fruit-state').textContent = r;
          list.hidden = true;
          combo.setAttribute('aria-expanded', 'false');
        });
        list.appendChild(li);
      });
    }
    function open() {
      combo.setAttribute('aria-expanded', 'true');
      list.hidden = false;
      render(input.value);
    }
    combo.addEventListener('click', open);
    input.addEventListener('focus', open);
    input.addEventListener('input', function () { render(input.value); });
    document.getElementById('ask').addEventListener('click', function () {
      var ok = window.confirm('Delete this expense?');
      document.getElementById('dialog-state').textContent = ok ? 'accepted' : 'dismissed';
    });
    document.getElementById('prompt').addEventListener('click', function () {
      var answer = window.prompt('Enter approval code', '');
      document.getElementById('prompt-state').textContent =
        answer === null ? 'prompt dismissed' : 'prompt:' + answer;
    });
    document.getElementById('alert').addEventListener('click', function () {
      window.alert('Read this notice');
      document.getElementById('alert-state').textContent = 'alert closed';
    });
    document.getElementById('receipt').addEventListener('change', function () {
      document.getElementById('file-state').textContent =
        this.files.length ? Array.from(this.files).map(function (file) {
          return file.name;
        }).join(', ') : 'none';
    });
  </script>
</body>
</html>`

const HIDDEN_UPLOAD_PAGE = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Hidden upload</title></head>
<body>
  <h1>Sources</h1>
  <div class="widget">
    <button type="button" id="choose">Choose files</button>
    <input id="widget-file" type="file" hidden>
    <p id="widget-state">none</p>
  </div>
  <button type="button" id="clip" aria-label="Add and manage sources">clip</button>
  <input id="global-file" type="file" style="display:none;position:absolute;left:-9999px">
  <p id="global-state">none</p>
  <script>
    document.getElementById('widget-file').addEventListener('change', function () {
      document.getElementById('widget-state').textContent = this.files[0] ? this.files[0].name : 'none';
    });
    document.getElementById('global-file').addEventListener('change', function () {
      document.getElementById('global-state').textContent = this.files[0] ? this.files[0].name : 'none';
    });
  </script>
</body>
</html>`

const PDF_PREVIEW_PAGE = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>PDF Preview</title></head>
<body>
  <h1>Expense form</h1>
  <button type="button" id="save">Save</button>
  <input id="receipt" type="file" aria-label="Receipt upload">
  <iframe src="/hang-frame" title="Document preview" width="400" height="300"></iframe>
</body>
</html>`

const ITEMIZATION_PAGE = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Itemization</title></head>
<body>
  <span>Room Rate</span>
  <input id="room-rate" type="text">
  <p id="out"></p>
  <script>
    document.getElementById('room-rate').addEventListener('input', function () {
      document.getElementById('out').textContent = this.value;
    });
  </script>
</body>
</html>`

const INTERACTIONS_PAGE = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Interaction matrix</title></head>
<body>
  <h1>Interaction matrix</h1>
  <button id="click-box" style="width:160px;height:80px">Click matrix</button>
  <p id="click-state">no clicks</p>
  <label>Editable <input id="editable" type="text"></label>
  <label>Readonly <input id="readonly" type="text" value="locked" readonly></label>
  <label>Disabled <input id="disabled" type="text" value="disabled" disabled></label>
  <p id="key-state">no key</p>
  <div id="drag-source" draggable="true" role="button" tabindex="0">Drag source</div>
  <div id="drop-target" role="button" tabindex="0" style="width:180px;height:80px;border:1px solid">Drop target</div>
  <p id="drag-state">not dropped</p>
  <script>
    document.getElementById('click-box').addEventListener('click', function (e) {
      document.getElementById('click-state').textContent =
        'detail=' + e.detail + ' button=' + e.button +
        ' ctrl=' + e.ctrlKey + ' meta=' + e.metaKey +
        ' shift=' + e.shiftKey + ' alt=' + e.altKey +
        ' offset=' + e.offsetX + ',' + e.offsetY;
    });
    document.getElementById('click-box').addEventListener('contextmenu', function (e) {
      e.preventDefault();
      document.getElementById('click-state').textContent = 'context button=' + e.button;
    });
    document.addEventListener('keydown', function (e) {
      document.getElementById('key-state').textContent =
        'key=' + e.key + ' ctrl=' + e.ctrlKey + ' meta=' + e.metaKey +
        ' shift=' + e.shiftKey + ' alt=' + e.altKey +
        ' target=' + (e.target.id || e.target.tagName);
    });
    document.getElementById('drop-target').addEventListener('dragover', function (e) {
      e.preventDefault();
    });
    document.getElementById('drop-target').addEventListener('drop', function (e) {
      e.preventDefault();
      document.getElementById('drag-state').textContent = 'dropped';
    });
  </script>
</body>
</html>`

function interactionRacesPage(port: number): string {
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Interaction race matrix</title></head>
<body>
  <h1>Interaction race matrix</h1>
  <div id="frame-source" draggable="true" role="button" tabindex="0">Cross frame source</div>
  <iframe title="Cross frame drop area" src="http://localhost:${port}/frame-drag-target"></iframe>

  <div id="drag-scroller" style="width:260px;height:120px;overflow:auto;border:1px solid">
    <div id="scroll-source" draggable="true" role="button" tabindex="0">Scroll drag source</div>
    <div style="height:500px"></div>
    <div id="scroll-target" role="button" tabindex="0" style="height:60px">Scroll drag target</div>
  </div>
  <p id="scroll-drag-state">scroll drag idle</p>

  <div id="detach-source" draggable="true" role="button" tabindex="0">Detach drag source</div>
  <div id="detach-target" role="button" tabindex="0">Detach drag target</div>
  <p id="detach-state">detach idle</p>

  <button id="delayed-hover">Delayed hover menu</button>
  <p id="hover-menu-state">menu hidden</p>
  <button id="moving-hover" style="position:relative;animation:move 400ms linear">Moving hover target</button>
  <p id="moving-hover-state">moving idle</p>
  <button id="vanishing-hover">Vanishing hover target</button>
  <p id="vanishing-hover-state">vanishing idle</p>
  <style>@keyframes move { from { left: 0 } to { left: 80px } }</style>
  <script>
    document.getElementById('scroll-target').addEventListener('dragover', event => event.preventDefault());
    document.getElementById('scroll-target').addEventListener('drop', event => {
      event.preventDefault();
      document.getElementById('scroll-drag-state').textContent = 'scroll drag dropped';
    });
    document.getElementById('detach-source').addEventListener('dragstart', () => {
      document.getElementById('detach-target').remove();
      document.getElementById('detach-state').textContent = 'detach target removed';
    });
    document.getElementById('delayed-hover').addEventListener('mouseover', () => {
      setTimeout(() => {
        document.getElementById('hover-menu-state').textContent = 'delayed menu visible';
      }, 250);
    });
    document.getElementById('moving-hover').addEventListener('mouseover', () => {
      document.getElementById('moving-hover-state').textContent = 'moving hovered';
    });
    document.getElementById('vanishing-hover').addEventListener('mouseover', event => {
      document.getElementById('vanishing-hover-state').textContent = 'vanishing hovered and removed';
      event.currentTarget.remove();
    });
  </script>
</body>
</html>`
}

const FRAME_DRAG_TARGET_PAGE = `<!doctype html>
<html>
<body>
  <div id="frame-drop-target" role="button" tabindex="0" style="width:180px;height:80px;border:1px solid">Cross frame target</div>
  <p id="frame-drop-state">cross frame idle</p>
  <script>
    document.getElementById('frame-drop-target').addEventListener('dragover', event => event.preventDefault());
    document.getElementById('frame-drop-target').addEventListener('drop', event => {
      event.preventDefault();
      document.getElementById('frame-drop-state').textContent = 'cross frame dropped';
    });
  </script>
</body>
</html>`

const FORM_RACES_PAGE = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Form race matrix</title></head>
<body>
  <h1>Form race matrix</h1>
  <label>Rerender trigger <input id="rerender-first" type="text"></label>
  <label id="second-label">Rerendered field <input id="rerender-second" type="text"></label>
  <p id="form-race-state">form idle</p>
  <input id="race-upload" type="file" multiple aria-label="Race upload">
  <p id="upload-race-state">upload idle</p>
  <script>
    document.getElementById('rerender-first').addEventListener('input', () => {
      const old = document.getElementById('rerender-second');
      const replacement = old.cloneNode();
      old.replaceWith(replacement);
      document.getElementById('form-race-state').textContent = 'second field replaced';
    }, { once: true });
    function wireUpload(input) {
      input.addEventListener('change', function () {
        document.getElementById('upload-race-state').textContent =
          Array.from(this.files).map(file => file.name + ':' + file.size).join(', ');
      });
    }
    wireUpload(document.getElementById('race-upload'));
    window.replaceUploadSoon = function () {
      setTimeout(() => {
        const old = document.getElementById('race-upload');
        const replacement = old.cloneNode();
        old.replaceWith(replacement);
        wireUpload(replacement);
        document.getElementById('upload-race-state').textContent = 'upload input replaced';
      }, 0);
    };
  </script>
</body>
</html>`

const VISUAL_STRESS_PAGE = `<!doctype html>
<html>
<head>
  <meta charset="utf-8"><title>Visual stress matrix</title>
  <style>
    body { margin: 0; min-height: 14000px; }
    #fixed { position: fixed; z-index: 20; top: 0; left: 0; right: 0; height: 36px; background: rgba(20, 40, 80, .85); color: white; }
    #sticky { position: sticky; top: 36px; height: 32px; background: #ddd; }
    #animated { width: 100px; height: 50px; background: orange; animation: pulse 120ms infinite alternate; }
    #transparent { position: absolute; top: 180px; left: 20px; width: 180px; height: 90px; background: rgba(0, 120, 255, .2); }
    #scaled { position: absolute; top: 320px; left: 80px; width: 120px; height: 60px; transform: scale(2); transform-origin: top left; background: green; color: white; }
    #bottom { position: absolute; top: 13800px; height: 100px; }
    @keyframes pulse { from { transform: translateX(0) } to { transform: translateX(20px) } }
  </style>
</head>
<body>
  <header id="fixed">Fixed visual header</header>
  <section style="height:800px;padding-top:50px">
    <div id="sticky">Sticky visual bar</div>
    <div id="animated" role="img" aria-label="Animated visual"></div>
    <div id="transparent">Transparent visual layer</div>
    <button id="scaled">Scaled visual target</button>
  </section>
  <div id="bottom">Visual bottom marker</div>
</body>
</html>`

const SCROLL_MATRIX_PAGE = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Scroll matrix</title></head>
<body>
  <h1>Scroll matrix</h1>
  <div id="scroller" aria-label="Results scroller" style="width:320px;height:180px;overflow:auto;border:1px solid">
    <div style="width:900px">
      ${Array.from(
        { length: 30 },
        (_, i) =>
          `<p>Container row ${i + 1}${i === 24 ? ' <button id="container-target">Container target</button>' : ''}</p>`,
      ).join('')}
    </div>
  </div>
  <div id="flat"><button id="flat-target">Flat target</button></div>
  <div style="height:1800px"></div>
  <button id="page-bottom">Page bottom</button>
</body>
</html>`

const DIAGNOSTICS_PAGE = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Diagnostics matrix</title></head>
<body>
  <h1>Diagnostics matrix</h1>
  <button id="emit">Emit console levels</button>
  <button id="requests">Make requests</button>
  <p id="diag-state">idle</p>
  <script>
    console.info('diagnostics boot info');
    fetch('/api/ok?request=boot');
    document.getElementById('emit').addEventListener('click', function () {
      console.log('diagnostics log');
      console.warn('diagnostics warn');
      console.error('diagnostics error');
      document.getElementById('diag-state').textContent = 'console emitted';
    });
    document.getElementById('requests').addEventListener('click', function () {
      Promise.allSettled([
        fetch('/api/ok?request=first'),
        fetch('/api/ok?request=second'),
        fetch('/api/boom?request=failed')
      ]).then(function () {
        document.getElementById('diag-state').textContent = 'requests done';
      });
    });
  </script>
</body>
</html>`

const DOWNLOAD_PAGE = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Download matrix</title></head>
<body>
  <h1>Download matrix</h1>
  <a id="download" href="/files/report.csv" download>Download report</a>
  <a id="scripted-download" href="/files/report.csv" download>Download scripted report</a>
  <a id="large-download" href="/files/large.bin" download>Download large file</a>
  <a id="interrupted-download" href="/files/interrupted.bin" download>Download interrupted file</a>
  <a id="removable-download" href="/files/removable.csv" download>Download removable report</a>
  <a id="slow-download" href="/files/slow.csv" download>Download slow report</a>
  <a id="delayed-download" href="/files/delayed.csv" download hidden>Delayed report file</a>
  <button id="delayed">Download after 5 seconds</button>
  <button id="ordinary">Ordinary button</button>
  <p id="download-state">idle</p>
  <script>
    document.getElementById('download').addEventListener('click', function () {
      document.getElementById('download-state').textContent = 'direct clicked';
    });
    document.getElementById('scripted-download').addEventListener('click', function (event) {
      event.preventDefault();
      const href = URL.createObjectURL(
        new Blob(['id,name\\n9,Scripted\\n'], { type: 'text/csv' }),
      );
      const link = document.createElement('a');
      link.href = href;
      link.download = 'scripted.csv';
      link.click();
      setTimeout(() => URL.revokeObjectURL(href), 1000);
      document.getElementById('download-state').textContent = 'scripted clicked';
    });
    document.getElementById('ordinary').addEventListener('click', function () {
      document.getElementById('download-state').textContent = 'ordinary clicked';
    });
    document.getElementById('delayed').addEventListener('click', function () {
      document.getElementById('download-state').textContent = 'download scheduled';
      setTimeout(function () {
        document.getElementById('delayed-download').click();
      }, 5000);
    });
  </script>
</body>
</html>`

const FRAME_INNER_PAGE = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Cross-origin inner frame</title></head>
<body>
  <button id="inner-action">Inner frame action</button>
  <p id="inner-state">inner untouched</p>
  <script>
    document.getElementById('inner-action').addEventListener('click', function () {
      document.getElementById('inner-state').textContent = 'inner clicked';
    });
  </script>
</body>
</html>`

const FRAME_NESTED_PAGE = `<!doctype html>
<html>
<body>
  <button id="nested-action">Nested frame action</button>
  <p id="nested-state">nested untouched</p>
  <script>
    document.getElementById('nested-action').addEventListener('click', function () {
      document.getElementById('nested-state').textContent = 'nested clicked';
    });
  </script>
</body>
</html>`

const FRAME_SANDBOX_PAGE = `<!doctype html>
<html>
<body>
  <button id="sandbox-action">Sandbox frame action</button>
  <p id="sandbox-state">sandbox untouched</p>
  <script>
    document.getElementById('sandbox-action').addEventListener('click', function (event) {
      document.getElementById('sandbox-state').textContent =
        'sandbox clicked detail=' + event.detail;
    });
  </script>
</body>
</html>`

function frameMidPage(port: number): string {
  return `<!doctype html>
<html>
<body>
  <h2>Middle frame</h2>
  <iframe title="Nested controls" src="http://127.0.0.1:${port}/frame-nested"></iframe>
</body>
</html>`
}

function crossOriginPage(port: number): string {
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Frame and shadow matrix</title></head>
<body>
  <h1>Frame and shadow matrix</h1>
  <div id="shadow-host"></div>
  <p id="shadow-state">shadow untouched</p>
  <button id="remove-frame">Remove inner frame</button>
  <iframe id="inner-frame" title="Cross origin controls" src="http://localhost:${port}/frame-inner"></iframe>
  <iframe title="Nested cross origin controls" src="http://localhost:${port}/frame-mid"></iframe>
  <iframe title="Sandbox controls" sandbox="allow-scripts" src="/frame-sandbox"></iframe>
  <script>
    const root = document.getElementById('shadow-host').attachShadow({ mode: 'open' });
    root.innerHTML = '<button id="shadow-action">Shadow action</button>';
    root.getElementById('shadow-action').addEventListener('click', function () {
      document.getElementById('shadow-state').textContent = 'shadow clicked';
    });
    document.getElementById('remove-frame').addEventListener('click', function () {
      document.getElementById('inner-frame').remove();
    });
  </script>
</body>
</html>`
}

function dynamicDomPage(port: number): string {
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Dynamic DOM matrix</title></head>
<body>
  <h1>Dynamic DOM matrix</h1>
  <div id="dynamic-frame"></div>
  <div id="slot-host"></div>
  <button id="slot-first" slot="first">Slotted first</button>
  <button id="slot-second" slot="second">Slotted second</button>
  <p id="churn-state">churn idle</p>
  <div id="churn-root"></div>
  <script>
    const frameRoot = document.getElementById('dynamic-frame');
    window.installDynamicFrame = function () {
      frameRoot.innerHTML =
        '<iframe title="Dynamic cross origin frame" src="http://localhost:${port}/frame-inner?dynamic=1"></iframe>';
    };
    window.churnDynamicFrame = function () {
      let generation = 0;
      const timer = setInterval(function () {
        generation += 1;
        if (generation % 2 === 0) {
          frameRoot.innerHTML = '';
        } else {
          window.installDynamicFrame();
        }
        if (generation >= 30) {
          clearInterval(timer);
          window.installDynamicFrame();
        }
      }, 20);
    };
    window.installDynamicFrame();

    const shadow = document.getElementById('slot-host').attachShadow({ mode: 'open' });
    shadow.innerHTML =
      '<section><slot name="first"></slot><div id="nested-host"></div><slot name="second"></slot></section>';
    const nested = shadow.getElementById('nested-host').attachShadow({ mode: 'open' });
    nested.innerHTML = '<p>Nested shadow marker</p>';
    window.reorderSlots = function () {
      document.getElementById('slot-first').slot = 'second';
      document.getElementById('slot-second').slot = 'first';
    };

    window.startDomChurn = function () {
      let generation = 0;
      const root = document.getElementById('churn-root');
      const state = document.getElementById('churn-state');
      const timer = setInterval(function () {
        generation += 1;
        root.innerHTML =
          '<button>Churn action ' + generation + '</button>' +
          '<ul>' + Array.from({ length: 40 }, function (_, index) {
            return '<li>generation ' + generation + ' row ' + index + '</li>';
          }).join('') + '</ul>';
        state.textContent = 'churn generation ' + generation;
        if (generation >= 400) {
          clearInterval(timer);
          state.textContent = 'churn complete';
        }
      }, 5);
    };
  </script>
</body>
</html>`
}

export function startFixtureServer(): Promise<{
  url: string
  close: () => Promise<void>
}> {
  const server = http.createServer((req, res) => {
    const route = (req.url ?? '/').split('?')[0]
    if (route === '/api/ok') {
      res.setHeader('content-type', 'application/json')
      res.end('{"ok":true}')
      return
    }
    if (route === '/api/boom') {
      res.statusCode = 500
      res.setHeader('content-type', 'application/json')
      res.end('{"error":"kaboom"}')
      return
    }
    if (route === '/slow-navigation') {
      setTimeout(() => {
        if (res.writableEnded) return
        res.setHeader('content-type', 'text/html; charset=utf-8')
        res.end(
          '<!doctype html><title>Slow navigation</title><h1>Slow navigation finished</h1>',
        )
      }, 20_000)
      return
    }
    if (route === '/redirect/start') {
      res.writeHead(302, { location: '/redirect/middle' })
      res.end()
      return
    }
    if (route === '/redirect/middle') {
      res.writeHead(302, { location: '/other?redirect=same-origin' })
      res.end()
      return
    }
    if (route === '/redirect/cross-origin') {
      const address = server.address() as { port: number }
      res.writeHead(302, {
        location: `http://localhost:${address.port}/other?redirect=cross-origin`,
      })
      res.end()
      return
    }
    if (route === '/redirect/loop-a') {
      res.writeHead(302, { location: '/redirect/loop-b' })
      res.end()
      return
    }
    if (route === '/redirect/loop-b') {
      res.writeHead(302, { location: '/redirect/loop-a' })
      res.end()
      return
    }
    if (route === '/files/report.csv') {
      res.setHeader('content-type', 'text/csv')
      res.setHeader('content-disposition', 'attachment; filename="report.csv"')
      res.end('id,name\n1,Alice\n2,Bob\n')
      return
    }
    if (route === '/files/delayed.csv') {
      res.setHeader('content-type', 'text/csv')
      res.setHeader('content-disposition', 'attachment; filename="delayed.csv"')
      res.end('id,name\n3,Delayed\n')
      return
    }
    if (route === '/files/slow.csv') {
      res.setHeader('content-type', 'text/csv')
      res.setHeader('content-disposition', 'attachment; filename="slow.csv"')
      res.write('id,name\n4,')
      setTimeout(() => {
        if (!res.writableEnded) res.end('Slow\n')
      }, 5_000)
      return
    }
    if (route === '/files/large.bin') {
      const body = Buffer.alloc(8 * 1024 * 1024, 0x5a)
      res.setHeader('content-type', 'application/octet-stream')
      res.setHeader('content-disposition', 'attachment; filename="large.bin"')
      res.setHeader('content-length', String(body.length))
      res.end(body)
      return
    }
    if (route === '/files/interrupted.bin') {
      res.setHeader('content-type', 'application/octet-stream')
      res.setHeader(
        'content-disposition',
        'attachment; filename="interrupted.bin"',
      )
      res.setHeader('content-length', String(1024 * 1024))
      res.write(Buffer.alloc(32 * 1024, 0x49))
      setTimeout(() => res.destroy(), 200)
      return
    }
    if (route === '/files/removable.csv') {
      res.setHeader('content-type', 'text/csv')
      res.setHeader(
        'content-disposition',
        'attachment; filename="removable.csv"',
      )
      res.write('id,name\n5,')
      setTimeout(() => {
        if (!res.writableEnded) res.end('Removed\n')
      }, 5_000)
      return
    }
    res.setHeader('content-type', 'text/html; charset=utf-8')
    if (route === '/other') {
      res.end(OTHER_PAGE)
      return
    }
    if (route === '/beforeunload') {
      res.end(BEFOREUNLOAD_PAGE)
      return
    }
    if (route === '/coordinate') {
      res.end(COORDINATE_PAGE)
      return
    }
    if (route === '/nested') {
      res.end(NESTED_PAGE)
      return
    }
    if (route === '/overflow') {
      res.end(OVERFLOW_PAGE)
      return
    }
    if (route === '/dialog-lazy') {
      res.end(DIALOG_LAZY_PAGE)
      return
    }
    if (route === '/dialog-nested') {
      res.end(DIALOG_NESTED_PAGE)
      return
    }
    if (route === '/wait-text') {
      res.end(WAIT_TEXT_PAGE)
      return
    }
    if (route === '/text-regions') {
      res.end(TEXT_REGIONS_PAGE)
      return
    }
    if (route === '/spa') {
      res.end(SPA_PAGE)
      return
    }
    if (route === '/error-modal') {
      res.end(ERROR_MODAL_PAGE)
      return
    }
    if (route === '/stale-modal') {
      res.end(STALE_MODAL_PAGE)
      return
    }
    if (route === '/escape-trap') {
      res.end(ESCAPE_TRAP_PAGE)
      return
    }
    if (route === '/form') {
      res.end(FORM_PAGE)
      return
    }
    if (route === '/widgets') {
      res.end(COMBOBOX_PAGE)
      return
    }
    if (route === '/hidden-upload') {
      res.end(HIDDEN_UPLOAD_PAGE)
      return
    }
    if (route === '/pdf-preview') {
      res.end(PDF_PREVIEW_PAGE)
      return
    }
    if (route === '/itemization') {
      res.end(ITEMIZATION_PAGE)
      return
    }
    if (route === '/interactions') {
      res.end(INTERACTIONS_PAGE)
      return
    }
    if (route === '/scroll-matrix') {
      res.end(SCROLL_MATRIX_PAGE)
      return
    }
    if (route === '/diagnostics') {
      res.end(DIAGNOSTICS_PAGE)
      return
    }
    if (route === '/download') {
      res.end(DOWNLOAD_PAGE)
      return
    }
    if (route === '/cross-frame') {
      const address = server.address() as { port: number }
      res.end(crossOriginPage(address.port))
      return
    }
    if (route === '/dynamic-dom') {
      const address = server.address() as { port: number }
      res.end(dynamicDomPage(address.port))
      return
    }
    if (route === '/interaction-races') {
      const address = server.address() as { port: number }
      res.end(interactionRacesPage(address.port))
      return
    }
    if (route === '/frame-drag-target') {
      res.end(FRAME_DRAG_TARGET_PAGE)
      return
    }
    if (route === '/form-races') {
      res.end(FORM_RACES_PAGE)
      return
    }
    if (route === '/visual-stress') {
      res.end(VISUAL_STRESS_PAGE)
      return
    }
    if (route === '/frame-inner') {
      res.end(FRAME_INNER_PAGE)
      return
    }
    if (route === '/frame-mid') {
      const address = server.address() as { port: number }
      res.end(frameMidPage(address.port))
      return
    }
    if (route === '/frame-nested') {
      res.end(FRAME_NESTED_PAGE)
      return
    }
    if (route === '/frame-sandbox') {
      res.end(FRAME_SANDBOX_PAGE)
      return
    }
    if (route === '/hang-frame') {
      return
    }
    res.end(PAGE)
  })
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number }
      resolve({
        url: `http://127.0.0.1:${addr.port}/`,
        close: () =>
          new Promise<void>(done => {
            // Chrome holds keep-alive sockets; without this, close() waits for
            // them and the test process never exits.
            server.closeAllConnections()
            server.close(() => done())
          }),
      })
    })
  })
}

function toolContext(sessionId: string): ToolContext {
  return {
    eventBus: {
      emit() {},
      on() {},
      off() {},
    } as unknown as ToolContext['eventBus'],
    wire: { emit() {} } as unknown as ToolContext['wire'],
    cwd: process.cwd(),
    sessionId,
  }
}

async function run(
  def: ToolDefinition,
  args: Record<string, unknown>,
  sessionId: string,
  toolCallId = `call-${Math.random().toString(36).slice(2, 8)}`,
): Promise<DualChannelToolResult<Record<string, unknown>> | string> {
  const instance = def.create(
    process.cwd(),
    toolContext(sessionId),
  ) as AnyTool & {
    execute: (
      a: unknown,
      o: { toolCallId: string },
    ) => Promise<DualChannelToolResult<Record<string, unknown>> | string>
  }
  return instance.execute(args, { toolCallId })
}

function expectData(
  result: DualChannelToolResult<Record<string, unknown>> | string,
): Record<string, unknown> {
  assert.ok(typeof result !== 'string', `expected success, got: ${result}`)
  return result.data
}

/** Complete YAML: spilled artifact if present, else the inline snapshot. */
function yamlFromObserve(out: Record<string, unknown>): string {
  const artifact = out.snapshotArtifactPath
  if (typeof artifact === 'string' && artifact && fs.existsSync(artifact)) {
    return fs.readFileSync(artifact, 'utf8')
  }
  return String(out.snapshot ?? '')
}

/** Pull the ref for a snapshot line matching `role "name"`. */
function refFor(snapshot: string, role: string, name: string): string {
  const line = snapshot
    .split('\n')
    .find(l => l.includes(`${role} "${name}"`) && l.includes('[ref='))
  assert.ok(
    line,
    `no ref found for ${role} "${name}" in snapshot:\n${snapshot}`,
  )
  return /\[ref=([^\]]+)\]/.exec(line)![1]
}

function refNear(snapshot: string, needle: string): string {
  const line = snapshot
    .split('\n')
    .find(l => l.includes(needle) && l.includes('[ref='))
  assert.ok(line, `no ref near "${needle}" in snapshot:\n${snapshot}`)
  return /\[ref=([^\]]+)\]/.exec(line)![1]
}

/**
 * Clickable generics do not quote their subtree as an accessible name. Playwright
 * attaches the label inline on the node's own line
 * (`generic [ref=e30] [cursor=pointer]: Messages`), so look for that, for a
 * quoted name, or for a `text:` child that mentions `label`.
 */
function refForGeneric(snapshot: string, label: string): string {
  const lines = snapshot.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.includes('generic') || !line.includes('[ref=')) continue
    if (line.includes(`"${label}"`) || line.includes(`: ${label}`)) {
      return /\[ref=([^\]]+)\]/.exec(line)![1]
    }
    const indent = /^\s*/.exec(line)![0].length
    for (let j = i + 1; j < lines.length; j++) {
      const child = lines[j]
      const childIndent = /^\s*/.exec(child)![0].length
      if (childIndent <= indent) break
      if (child.includes('text:') && child.includes(label)) {
        return /\[ref=([^\]]+)\]/.exec(line)![1]
      }
    }
  }
  assert.ok(false, `no generic ref for "${label}" in snapshot:\n${snapshot}`)
  return ''
}

export interface SuiteOptions {
  label: string
  backendFactory: () => Promise<BrowserBackend>
  baseUrl: string
  sessionId: string
  /** Print the first snapshot; useful when eyeballing a new backend. */
  showSnapshot?: boolean
  /** Fake relay cannot route flattened OOPIF child sessions; real extension E2E covers them. */
  crossOriginFrames?: boolean
  /** Fake relay has no chrome.downloads API; real extension E2E covers that path. */
  downloads?: boolean
}

export async function runBrowserToolSuite(opts: SuiteOptions): Promise<void> {
  const { label, baseUrl, sessionId } = opts
  const ok = (msg: string) => console.log(`ok [${label}] ${msg}`)

  setBrowserBackendFactory(opts.backendFactory)

  try {
    // ── navigate ──────────────────────────────────────────
    const nav = expectData(await run(navigateTool, { url: baseUrl }, sessionId))
    assert.equal(nav.title, 'Verify Loop Fixture')
    const snapshot = String(nav.snapshot)
    assert.ok(snapshot.includes('heading "Dashboard"'), snapshot)
    assert.ok(snapshot.includes('[level=1]'), snapshot)
    assert.ok(snapshot.includes('link "Go to other page"'), snapshot)
    assert.ok(snapshot.includes('/url: /other'), snapshot)
    ok('navigate + accessibility snapshot')
    if (opts.showSnapshot) {
      console.log('\n--- snapshot ---\n' + snapshot + '\n----------------\n')
    }

    // ── console capture starts before page scripts run ────
    const bootErrors = nav.consoleErrors as Array<{ text: string }> | undefined
    assert.ok(
      bootErrors?.some(e => e.text.includes('widget service unreachable')),
      'console errors logged during page load must be captured',
    )
    ok('console capture survives navigation')

    // ── role-less clickable nodes: Playwright generic + cursor=pointer ──
    assert.ok(
      !snapshot.includes('button "有新消息"'),
      'must not forge a button role for a pointer div',
    )
    assert.ok(
      !/generic "有新消息"/.test(snapshot),
      'generic must not take its name from subtree text',
    )
    assert.ok(
      /- generic \[ref=\S+\] \[cursor=pointer\]: 有新消息/.test(snapshot),
      `pointer FAB must carry its label on the clickable node's own line:\n${snapshot}`,
    )
    const fabDirect = refForGeneric(snapshot, '有新消息')
    const fabWrap = refForGeneric(snapshot, '我的沟通')
    /**
     * Known boundary: an inline `<span style="cursor:pointer">` has no ARIA
     * role, so Playwright folds it into the paragraph's text and never mints a
     * ref for it. That tree cannot click the span as its own control.
     *
     * Written as a branch rather than skipped, so that if a future Playwright
     * starts surfacing these, the ref still has to be clickable.
     */
    const fabInline = /- generic \[ref=\S+\][^\n]*打开消息/.test(snapshot)
      ? refForGeneric(snapshot, '打开消息')
      : ''
    const fabDirectLine = snapshot
      .split('\n')
      .find(l => l.includes(`[ref=${fabDirect}]`))
    assert.ok(
      fabDirectLine && fabDirectLine.includes('[cursor=pointer]'),
      `pointer FAB must be generic with cursor=pointer:\n${snapshot}`,
    )
    const fabWrapLine = snapshot
      .split('\n')
      .find(l => l.includes(`[ref=${fabWrap}]`))
    assert.ok(
      fabWrapLine && fabWrapLine.includes('[cursor=pointer]'),
      `wrapped FAB must be generic with cursor=pointer:\n${snapshot}`,
    )
    assert.equal(
      snapshot.split('\n').filter(l => l.includes(`[ref=${fabWrap}]`)).length,
      1,
      'must not nest a second generic on the inner span',
    )
    if (fabInline) {
      const inlineLines = snapshot.split('\n')
      const inlineIdx = inlineLines.findIndex(l =>
        l.includes(`[ref=${fabInline}]`),
      )
      const inlineIndent = /^\s*/.exec(inlineLines[inlineIdx])![0].length
      const inlineChildren: string[] = []
      for (let j = inlineIdx + 1; j < inlineLines.length; j++) {
        const ind = /^\s*/.exec(inlineLines[j])![0].length
        if (ind <= inlineIndent) break
        inlineChildren.push(inlineLines[j])
      }
      assert.ok(
        !inlineChildren.some(l => l.includes('Inbox:')),
        `an inline pointer must not absorb the surrounding sentence:\n${snapshot}`,
      )
    }
    const openedFab = expectData(
      await run(clickTool, { ref: fabDirect }, sessionId),
    )
    assert.ok(
      String(openedFab.snapshot).includes('fab opened'),
      `clicking the role-less FAB must fire its handler:\n${openedFab.snapshot}`,
    )
    const openedChat = expectData(
      await run(clickTool, { ref: fabWrap }, sessionId),
    )
    assert.ok(
      String(openedChat.snapshot).includes('chat opened'),
      `clicking the wrapped FAB must fire its handler:\n${openedChat.snapshot}`,
    )
    if (fabInline) {
      const openedInline = expectData(
        await run(clickTool, { ref: fabInline }, sessionId),
      )
      assert.ok(
        String(openedInline.snapshot).includes('inline opened'),
        `clicking an inline pointer span must fire its handler:\n${openedInline.snapshot}`,
      )
    } else {
      assert.ok(
        snapshot.includes('打开消息'),
        `inline pointer span has no ref; label must still appear in snapshot:\n${snapshot}`,
      )
    }
    ok('role-less clickable generic gets a ref and is clickable')

    // ── pointer child + sibling label: ref belongs to the group ──
    const launcherRef = refForGeneric(snapshot, 'Messages')
    const launcherLine = snapshot
      .split('\n')
      .find(l => l.includes(`[ref=${launcherRef}]`))
    assert.ok(
      launcherLine && launcherLine.includes('[cursor=pointer]'),
      `label-group must be a clickable generic:\n${snapshot}`,
    )
    assert.ok(
      launcherLine.includes(': Messages'),
      `the group's label must be on the clickable line, not only on a child:\n${snapshot}`,
    )
    // No extra snapshot here: the refs below come from `snapshot`, and a
    // mode=efficient capture would replace the remembered tree with a filtered
    // one. mode=efficient is covered in the distiller section instead.
    const openedLauncher = expectData(
      await run(clickTool, { ref: launcherRef }, sessionId),
    )
    assert.ok(
      String(openedLauncher.snapshot).includes('launcher opened'),
      `clicking the grouping generic must fire the parent handler:\n${openedLauncher.snapshot}`,
    )
    ok('pointer+label group puts the ref on the parent')

    const silentRef = refForGeneric(snapshot, 'Alerts')
    const openedSilent = expectData(
      await run(clickTool, { ref: silentRef }, sessionId),
    )
    assert.ok(
      String(openedSilent.snapshot).includes('silent opened'),
      `fixed overlay without cursor:pointer must still be clickable:\n${openedSilent.snapshot}`,
    )
    ok('overlay widget without pointer cursor gets a ref')

    // ── wrapper roles do not swallow child names ──
    assert.ok(
      snapshot.includes('link "Staff Engineer"'),
      `job-card link must keep its own name:\n${snapshot}`,
    )
    assert.ok(
      !/listitem "[^"]{80,}/.test(snapshot),
      `listitem must not quote the concatenated card:\n${snapshot}`,
    )
    ok('listitem name does not swallow children')

    // ── click mutates the page and the snapshot reflects it ──
    const counterRef = refFor(snapshot, 'button', 'Clicked 0 times')
    const clicked = expectData(
      await run(clickTool, { ref: counterRef }, sessionId),
    )
    assert.equal(clicked.message, 'Clicked button "Clicked 0 times"')
    assert.ok(
      String(clicked.snapshot).includes('Clicked 1 times'),
      'post-action snapshot must show the result of the click',
    )
    ok('click dispatches trusted input')

    const singleActivationRef = refFor(
      String(clicked.snapshot),
      'button',
      'Single activation 0',
    )
    const singleActivation = expectData(
      await run(clickTool, { ref: singleActivationRef }, sessionId),
    )
    assert.match(String(singleActivation.snapshot), /Single activation 1/)
    assert.doesNotMatch(
      String(singleActivation.snapshot),
      /Single activation 2/,
    )
    ok('click probe never retries an already delivered activation')

    const ghostRef = refFor(
      String(singleActivation.snapshot),
      'button',
      'Ghost Yes',
    )
    for (const force of [false, true]) {
      const ghostClick = await run(
        clickTool,
        { ref: ghostRef, ...(force ? { force: true } : {}) },
        sessionId,
      )
      assert.ok(
        typeof ghostClick === 'string' &&
          /outside the visible viewport|offscreen/i.test(ghostClick),
        `${force ? 'force' : 'normal'} click must reject an offscreen ref:\n${String(ghostClick)}`,
      )
    }
    const afterGhost = String(
      expectData(await run(snapshotTool, {}, sessionId)).snapshot,
    )
    assert.ok(
      afterGhost.includes('Ghost untouched') &&
        !afterGhost.includes('Ghost clicked'),
      `offscreen ref must not receive normal or force clicks:\n${afterGhost}`,
    )
    ok('offscreen refs are rejected even with force=true')

    // ── a changed label rotates the ref, old one stops working ──
    const staleCounter = await run(clickTool, { ref: counterRef }, sessionId)
    assert.ok(
      typeof staleCounter === 'string',
      'a ref captured before the label changed must not resolve',
    )
    assert.ok(
      staleCounter.includes(`Element not found: ${counterRef}`),
      staleCounter,
    )
    assert.ok(
      staleCounter.includes('Recovery action: browser_snapshot'),
      staleCounter,
    )
    const newCounterRef = refFor(
      String(clicked.snapshot),
      'button',
      'Clicked 1 times',
    )
    assert.notEqual(newCounterRef, counterRef)
    assert.ok(
      String(
        expectData(await run(clickTool, { ref: newCounterRef }, sessionId))
          .snapshot,
      ).includes('Clicked 2 times'),
    )
    ok('ref rotates when an element changes meaning')

    // ── refs stay stable for elements that did not change ──
    const fresh = String(
      expectData(await run(snapshotTool, {}, sessionId)).snapshot,
    )
    assert.equal(
      refFor(fresh, 'textbox', 'Email address'),
      refFor(snapshot, 'textbox', 'Email address'),
      'an untouched element must keep its ref across snapshots',
    )
    ok('ref stable across snapshots for unchanged elements')

    // ── type + submit ─────────────────────────────────────
    const emailRef = refFor(fresh, 'textbox', 'Email address')
    const typed = expectData(
      await run(
        typeTool,
        { ref: emailRef, text: 'harry@example.com', submit: true },
        sessionId,
      ),
    )
    assert.ok(
      String(typed.snapshot).includes('Submitted harry@example.com'),
      `form submit did not take effect:\n${typed.snapshot}`,
    )
    ok('type + submit')

    // ── select ────────────────────────────────────────────
    const selectRef = refFor(fresh, 'combobox', 'Environment')
    const selected = expectData(
      await run(
        selectOptionTool,
        { ref: selectRef, values: ['Production'] },
        sessionId,
      ),
    )
    assert.equal(selected.message, 'Selected "Production"')
    assert.match(
      String(selected.snapshot),
      /Production/,
      `select_option must update page state:\n${selected.snapshot}`,
    )
    const selectedSnap = String(
      expectData(await run(snapshotTool, {}, sessionId)).snapshot,
    )
    const partialOption = expectData(
      await run(
        selectOptionTool,
        {
          ref: refFor(selectedSnap, 'combobox', 'Environment'),
          values: ['Develop'],
        },
        sessionId,
      ),
    )
    assert.match(String(partialOption.snapshot), /Development.*selected/)
    const partialSnap = String(
      expectData(await run(snapshotTool, {}, sessionId)).snapshot,
    )
    const ambiguousOption = await run(
      selectOptionTool,
      {
        ref: refFor(partialSnap, 'combobox', 'Environment'),
        values: ['Prod'],
      },
      sessionId,
    )
    assert.equal(typeof ambiguousOption, 'string')
    assert.match(String(ambiguousOption), /matches multiple options/)
    assert.match(String(ambiguousOption), /"Production", "Production Preview"/)
    const disabledOption = await run(
      selectOptionTool,
      {
        ref: refFor(partialSnap, 'combobox', 'Environment'),
        values: ['Legacy'],
      },
      sessionId,
    )
    assert.equal(typeof disabledOption, 'string')
    assert.match(String(disabledOption), /Option "Legacy" is disabled/)
    const invalidOption = await run(
      selectOptionTool,
      {
        ref: refFor(partialSnap, 'combobox', 'Environment'),
        values: ['Mars'],
      },
      sessionId,
    )
    assert.equal(typeof invalidOption, 'string')
    assert.match(String(invalidOption), /Option not found: "Mars"/)
    assert.match(String(invalidOption), /"Development", "Production"/)
    assert.match(String(invalidOption), /and 4 more/)
    assert.doesNotMatch(String(invalidOption), /"Sandbox"/)
    assert.doesNotMatch(String(invalidOption), /not found or not visible/)
    ok('select_option')

    // ── visual grounding + viewport + CDP ───────────────
    const resized = expectData(
      await run(
        resizeTool,
        { width: 640, height: 480, screenshotAfterwards: true },
        sessionId,
      ),
    )
    assert.ok(
      resized.screenshotPath,
      'resize screenshotAfterwards must capture',
    )
    const viewportResult = expectData(
      await run(
        cdpTool,
        {
          method: 'Runtime.evaluate',
          params: {
            expression: '({ width: innerWidth, height: innerHeight })',
            returnByValue: true,
          },
        },
        sessionId,
      ),
    )
    const viewport = (
      viewportResult.value as {
        result?: { value?: { width?: number; height?: number } }
      }
    ).result?.value
    assert.deepEqual(viewport, { width: 640, height: 480 })

    const oversized = await run(
      resizeTool,
      { width: 9000, height: 480 },
      sessionId,
    )
    assert.equal(typeof oversized, 'string')
    assert.match(String(oversized), /exceeds maximum of 8192/)

    const visualSnap = String(
      expectData(await run(snapshotTool, {}, sessionId)).snapshot,
    )
    const environmentRef = refFor(visualSnap, 'combobox', 'Environment')
    const bounds = expectData(
      await run(
        getBoundingBoxTool,
        { ref: environmentRef, element: 'Environment select' },
        sessionId,
      ),
    ).value as { x: number; y: number; width: number; height: number }
    assert.ok(bounds.width > 0 && bounds.height > 0)
    assert.ok(bounds.x >= 0 && bounds.y >= 0)
    assert.ok(bounds.x < 640 && bounds.y < 480)

    const highlighted = expectData(
      await run(
        highlightTool,
        {
          ref: environmentRef,
          element: 'Environment select',
          durationMs: 1500,
        },
        sessionId,
      ),
    )
    assert.match(
      String(highlighted.message),
      /Highlighted select "Environment"/,
    )
    const outlineResult = expectData(
      await run(
        cdpTool,
        {
          method: 'Runtime.evaluate',
          params: {
            expression: 'document.querySelector("#env").style.outline',
            returnByValue: true,
          },
        },
        sessionId,
      ),
    )
    const outline = (outlineResult.value as { result?: { value?: string } })
      .result?.value
    assert.match(String(outline), /solid/)
    assert.match(String(outline), /3px/)
    expectData(await run(waitForTool, { time: 1.7 }, sessionId))
    const clearedOutlineResult = expectData(
      await run(
        cdpTool,
        {
          method: 'Runtime.evaluate',
          params: {
            expression: 'document.querySelector("#env").style.outline',
            returnByValue: true,
          },
        },
        sessionId,
      ),
    )
    const clearedOutline = (
      clearedOutlineResult.value as { result?: { value?: string } }
    ).result?.value
    assert.equal(clearedOutline, '')

    expectData(await run(resizeTool, { width: 1280, height: 800 }, sessionId))
    ok('resize, highlight, get_bounding_box and browser_cdp')

    for (const popup of [
      { name: 'Open popup', query: 'popup=1' },
      { name: 'Open noopener popup', query: 'popup=noopener' },
    ]) {
      const beforePopup = expectData(
        await run(tabsTool, { action: 'list' }, sessionId),
      ).tabs as TabRow[]
      expectData(
        await run(
          clickTool,
          { ref: refFor(visualSnap, 'link', popup.name) },
          sessionId,
        ),
      )
      expectData(await run(waitForTool, { time: 0.3 }, sessionId))
      const afterPopup = expectData(
        await run(tabsTool, { action: 'list' }, sessionId),
      ).tabs as TabRow[]
      assert.equal(
        afterPopup.length,
        beforePopup.length + 1,
        `a popup opened by an owned tab must become agent-owned: ${JSON.stringify(afterPopup)}`,
      )
      const popupTab = afterPopup.find(tab => tab.url.includes(popup.query))
      assert.ok(
        popupTab,
        `opened popup must be listed: ${JSON.stringify(afterPopup)}`,
      )
      expectData(
        await run(
          tabsTool,
          { action: 'close', tabId: popupTab.targetId },
          sessionId,
        ),
      )
      const afterClose = expectData(
        await run(tabsTool, { action: 'list' }, sessionId),
      ).tabs as TabRow[]
      assert.equal(afterClose.length, beforePopup.length)
    }
    ok('popup and noopener popup tabs inherit agent ownership')

    const complexDom = expectData(
      await run(
        navigateTool,
        { url: `${baseUrl}cross-frame?case=${Date.now()}` },
        sessionId,
      ),
    )
    const complexSnapshot = String(complexDom.snapshot)
    const shadowClicked = expectData(
      await run(
        clickTool,
        { ref: refFor(complexSnapshot, 'button', 'Shadow action') },
        sessionId,
      ),
    )
    assert.match(String(shadowClicked.snapshot), /shadow clicked/)
    if (opts.crossOriginFrames !== false) {
      const afterShadow = String(
        expectData(await run(snapshotTool, {}, sessionId)).snapshot,
      )
      const innerClicked = expectData(
        await run(
          clickTool,
          { ref: refFor(afterShadow, 'button', 'Inner frame action') },
          sessionId,
        ),
      )
      assert.match(String(innerClicked.snapshot), /inner clicked/)
      const afterInner = String(
        expectData(await run(snapshotTool, {}, sessionId)).snapshot,
      )
      const nestedClicked = expectData(
        await run(
          clickTool,
          {
            ref: refFor(afterInner, 'button', 'Nested frame action'),
          },
          sessionId,
        ),
      )
      assert.match(String(nestedClicked.snapshot), /nested clicked/)
      const afterNested = String(
        expectData(await run(snapshotTool, {}, sessionId)).snapshot,
      )
      const sandboxClicked = expectData(
        await run(
          clickTool,
          {
            ref: refFor(afterNested, 'button', 'Sandbox frame action'),
          },
          sessionId,
        ),
      )
      assert.match(String(sandboxClicked.snapshot), /sandbox clicked/)
      const beforeDetach = String(
        expectData(await run(snapshotTool, {}, sessionId)).snapshot,
      )
      const detachedRef = refFor(beforeDetach, 'button', 'Inner frame action')
      expectData(
        await run(
          clickTool,
          {
            ref: refFor(beforeDetach, 'button', 'Remove inner frame'),
          },
          sessionId,
        ),
      )
      const detachedClick = await run(
        clickTool,
        { ref: detachedRef },
        sessionId,
      )
      assert.equal(typeof detachedClick, 'string')
      assert.match(String(detachedClick), /stale|not found|snapshot/i)
      ok('shadow, nested/sandbox OOPIF and detached refs behave correctly')
    } else {
      ok('shadow DOM refs remain actionable')
    }

    // ── fill_form ─────
    const formNav = expectData(
      await run(navigateTool, { url: `${baseUrl}form` }, sessionId),
    )
    const formSnap = String(formNav.snapshot)
    const formFilled = expectData(
      await run(
        fillFormTool,
        {
          fields: [
            { ref: refNear(formSnap, 'Merchant'), value: 'Suzhou Hotel' },
            { ref: refNear(formSnap, 'Total'), value: '100.00' },
            {
              ref: refNear(formSnap, 'Billable'),
              value: 'true',
              kind: 'checkbox',
            },
            {
              ref: refNear(formSnap, 'Personal'),
              value: 'true',
              kind: 'radio',
            },
            {
              ref: refNear(formSnap, 'Currency'),
              value: 'USD',
              kind: 'combobox',
            },
          ],
        },
        sessionId,
      ),
    )
    assert.ok(
      String(formFilled.message).startsWith('Filled 5/5 fields'),
      `fill_form must write every control kind in one call:\n${formFilled.message}`,
    )
    assert.ok(
      String(formFilled.message).includes('Suzhou Hotel') &&
        String(formFilled.message).includes('100.00'),
      `fill_form must report written values:\n${formFilled.message}`,
    )
    assert.ok(
      String(formFilled.snapshot).includes('6.00'),
      `readonly tax must still update from the app handler:\n${formFilled.snapshot}`,
    )
    assert.match(String(formFilled.snapshot), /radio "Personal" \[checked\]/)
    const afterFormFill = String(
      expectData(await run(snapshotTool, {}, sessionId)).snapshot,
    )
    const multiSelected = expectData(
      await run(
        selectOptionTool,
        {
          ref: refNear(afterFormFill, 'Tags'),
          values: ['Urgent', 'Client'],
        },
        sessionId,
      ),
    )
    assert.match(String(multiSelected.message), /Selected "Urgent", "Client"/)
    assert.match(String(multiSelected.snapshot), /option "Urgent" \[selected\]/)
    assert.match(String(multiSelected.snapshot), /option "Client" \[selected\]/)
    const readonlyField = expectData(
      await run(
        fillFormTool,
        { fields: [{ ref: refNear(formSnap, 'Computed tax'), value: '9.99' }] },
        sessionId,
      ),
    )
    assert.ok(
      /failed|skipped/.test(String(readonlyField.message)),
      `a readonly field must be reported, not silently dropped:\n${readonlyField.message}`,
    )
    ok('fill_form writes text, checkbox and select in one call')

    const interactionNav = expectData(
      await run(navigateTool, { url: `${baseUrl}interactions` }, sessionId),
    )
    const interactionSnap = String(interactionNav.snapshot)
    const doubleClicked = expectData(
      await run(
        clickTool,
        {
          ref: refFor(interactionSnap, 'button', 'Click matrix'),
          doubleClick: true,
        },
        sessionId,
      ),
    )
    assert.match(String(doubleClicked.snapshot), /detail=2 button=0/)

    const rightClickSnap = String(
      expectData(await run(snapshotTool, {}, sessionId)).snapshot,
    )
    const rightClicked = expectData(
      await run(
        clickTool,
        {
          ref: refFor(rightClickSnap, 'button', 'Click matrix'),
          button: 'right',
        },
        sessionId,
      ),
    )
    assert.match(String(rightClicked.snapshot), /context button=2/)

    const offsetClickSnap = String(
      expectData(await run(snapshotTool, {}, sessionId)).snapshot,
    )
    const offsetClicked = expectData(
      await run(
        clickTool,
        {
          ref: refFor(offsetClickSnap, 'button', 'Click matrix'),
          modifiers: ['Alt', 'Shift'],
          offsetX: 12,
          offsetY: 15,
        },
        sessionId,
      ),
    )
    assert.match(
      String(offsetClicked.snapshot),
      /ctrl=false meta=false shift=true alt=true offset=12,15/,
    )

    const interactionFresh = String(
      expectData(await run(snapshotTool, {}, sessionId)).snapshot,
    )
    const slowlyTyped = expectData(
      await run(
        typeTool,
        {
          ref: refFor(interactionFresh, 'textbox', 'Editable'),
          text: 'abc',
          slowly: true,
        },
        sessionId,
      ),
    )
    assert.match(String(slowlyTyped.message), /value: "abc"/)
    const focusedKey = expectData(
      await run(
        pressKeyTool,
        { key: 'x', modifiers: ['Alt', 'Shift'] },
        sessionId,
      ),
    )
    assert.match(
      String(focusedKey.snapshot),
      /key=x ctrl=false meta=false shift=true alt=true target=editable/,
    )

    const afterSlowType = String(
      expectData(await run(snapshotTool, {}, sessionId)).snapshot,
    )
    const disabledTyped = expectData(
      await run(
        typeTool,
        {
          ref: refFor(afterSlowType, 'textbox', 'Disabled'),
          text: 'overwrite',
        },
        sessionId,
      ),
    )
    assert.match(
      String(disabledTyped.message),
      /nothing typed: the field is disabled/,
    )
    const beforeReadonly = String(
      expectData(await run(snapshotTool, {}, sessionId)).snapshot,
    )
    const readonlyTyped = expectData(
      await run(
        typeTool,
        {
          ref: refFor(beforeReadonly, 'textbox', 'Readonly'),
          text: 'overwrite',
        },
        sessionId,
      ),
    )
    assert.match(
      String(readonlyTyped.message),
      /nothing typed: the field is readonly/,
    )
    const dragged = expectData(
      await run(
        dragTool,
        {
          startRef: refFor(beforeReadonly, 'button', 'Drag source'),
          endRef: refFor(beforeReadonly, 'button', 'Drop target'),
        },
        sessionId,
      ),
    )
    assert.match(String(dragged.snapshot), /dropped/)
    ok('click buttons/modifiers/offsets, slow type, disabled/readonly and drag')

    await run(navigateTool, { url: baseUrl }, sessionId)

    // ── stale ref detection ───────────────────────────────
    const withRow = String(
      expectData(await run(snapshotTool, {}, sessionId)).snapshot,
    )
    const deleteRef = refFor(withRow, 'button', 'Delete Alice')
    const recycleRef = refFor(withRow, 'button', 'Recycle row')
    await run(clickTool, { ref: recycleRef }, sessionId)

    const staleClick = await run(clickTool, { ref: deleteRef }, sessionId)
    assert.ok(
      typeof staleClick === 'string',
      'clicking a recycled row must fail rather than delete the wrong record',
    )
    assert.ok(/not found|stale|snapshot/i.test(staleClick), staleClick)
    assert.ok(
      /Recovery action:\s*browser_snapshot/i.test(staleClick),
      `stale ref must tell the model to snapshot, not dump the tree:\n${staleClick}`,
    )
    assert.ok(
      !staleClick.includes('- button "Delete Bob"'),
      `error must not attach a YAML snapshot:\n${staleClick}`,
    )
    ok('stale ref caught after DOM recycling')

    const rebuilt = String(
      expectData(await run(snapshotTool, {}, sessionId)).snapshot,
    )
    const bobRef = refFor(rebuilt, 'button', 'Delete Bob')
    assert.ok(expectData(await run(clickTool, { ref: bobRef }, sessionId)))
    ok('re-snapshot recovers the ref')

    // Playwright MCP: stale ref fails fast; model re-snapshots for a new ref.
    const applyHost = String(
      expectData(await run(snapshotTool, {}, sessionId)).snapshot,
    )
    await run(
      clickTool,
      { ref: refFor(applyHost, 'button', 'Rebuild apply') },
      sessionId,
    )
    const staleApply = await run(
      clickTool,
      { ref: refFor(applyHost, 'button', 'Apply changes') },
      sessionId,
    )
    assert.ok(
      typeof staleApply === 'string',
      'stale ref after DOM rebuild must fail rather than click the wrong node',
    )
    assert.ok(
      /snapshot|not found/i.test(staleApply),
      `stale ref error should point at a new snapshot:\n${staleApply}`,
    )
    const afterRebuild = String(
      expectData(await run(snapshotTool, {}, sessionId)).snapshot,
    )
    const newApplyRef = refFor(afterRebuild, 'button', 'Apply changes')
    const applied = expectData(
      await run(clickTool, { ref: newApplyRef }, sessionId),
    )
    assert.ok(
      /applied/i.test(String(applied.snapshot)) ||
        /applied/i.test(String(applied.message)),
      `fresh ref should click rebuilt Apply:\n${applied.message}\n${applied.snapshot}`,
    )
    ok('stale ref fails then fresh snapshot recovers')

    // ── occlusion: a click under a modal is refused, not lost ──
    const afterApply = String(
      expectData(await run(snapshotTool, {}, sessionId)).snapshot,
    )
    const underRef = refFor(afterApply, 'button', 'Confirm order')
    const covered = await run(clickTool, { ref: underRef }, sessionId)
    assert.ok(
      typeof covered === 'string',
      'a click blocked by a modal must come back as a recoverable error',
    )
    assert.ok(
      /modal|intercept|timeout|not visible|obscur|interactable|covered/i.test(
        covered,
      ),
      `blocker must be visible in the error:\n${covered}`,
    )
    ok('occluded click is refused with the blocker named')

    // ── hover ─────────────────────────────────────────────
    const hovered = expectData(
      await run(
        hoverTool,
        { ref: refFor(rebuilt, 'button', 'Hover me') },
        sessionId,
      ),
    )
    assert.equal(hovered.message, 'Hovered button "Hover me"')
    assert.ok(
      String(hovered.snapshot).includes('Hovered'),
      `mouseover did not fire:\n${hovered.snapshot}`,
    )
    ok('hover')

    // ── press_key ─────────────────────────────────────────
    const escaped = expectData(
      await run(pressKeyTool, { key: 'Escape' }, sessionId),
    )
    assert.equal(escaped.message, 'Pressed Escape')
    assert.ok(
      String(escaped.snapshot).includes('Last key: Escape'),
      `keydown did not reach the page:\n${escaped.snapshot}`,
    )
    const combo = expectData(
      await run(pressKeyTool, { key: 'k', modifiers: ['Control'] }, sessionId),
    )
    assert.equal(combo.message, 'Pressed Control+k')
    assert.ok(
      String(combo.snapshot).includes('Last key: Control+k'),
      `modifier was not applied:\n${combo.snapshot}`,
    )
    ok('press_key, with and without modifiers')

    // ── scroll ────────────────────────────────────────────
    const beforeScroll = String(
      expectData(await run(snapshotTool, {}, sessionId)).snapshot,
    )
    const bottomRef = refNear(beforeScroll, 'Bottom marker')
    const intoView = expectData(
      await run(
        scrollTool,
        { ref: bottomRef, scrollIntoView: true },
        sessionId,
      ),
    )
    assert.match(String(intoView.message), /into view\. Page position: /)
    const afterScroll = String(
      expectData(await run(snapshotTool, {}, sessionId)).snapshot,
    )
    assert.ok(
      afterScroll.includes('Bottom marker'),
      `scrollIntoView must bring the bottom marker into the tree:\n${afterScroll}`,
    )
    const up = expectData(await run(scrollTool, { deltaY: -100000 }, sessionId))
    assert.match(
      String(up.message),
      /(reached the top of the page|already at the top of the page).*\[Top of page\]/,
    )
    const again = expectData(
      await run(scrollTool, { direction: 'up' }, sessionId),
    )
    assert.match(String(again.message), /^Warning: no scroll occurred/)
    ok('scroll reports the actual delta, position and the top edge')

    // ── screenshot ────────────────────────────────────────
    const shot = expectData(
      await run(screenshotTool, {}, sessionId, `${sessionId}-shot`),
    )
    assert.ok(shot.screenshotBase64, 'model must receive image data')
    const shotPath = String(shot.screenshotPath)
    assert.ok(fs.existsSync(shotPath), `screenshot not written to ${shotPath}`)
    assert.ok(fs.statSync(shotPath).size > 1000, 'screenshot looks empty')
    ok(`screenshot (${fs.statSync(shotPath).size} bytes)`)

    const jpegFullPage = expectData(
      await run(
        screenshotTool,
        { format: 'jpeg', fullPage: true },
        sessionId,
        `${sessionId}-shot-jpeg`,
      ),
    )
    assert.ok(jpegFullPage.screenshotBase64)
    assert.match(String(jpegFullPage.screenshotPath), /\.jpe?g$/)
    assert.ok(
      fs.statSync(String(jpegFullPage.screenshotPath)).size > 1000,
      'full-page JPEG screenshot looks empty',
    )

    const elementShot = expectData(
      await run(
        screenshotTool,
        { ref: refFor(rebuilt, 'button', 'Recycle row') },
        sessionId,
        `${sessionId}-shot-el`,
      ),
    )
    assert.ok(elementShot.screenshotBase64)
    const incompatibleShot = await run(
      screenshotTool,
      {
        ref: refFor(rebuilt, 'button', 'Recycle row'),
        fullPage: true,
      },
      sessionId,
    )
    assert.equal(typeof incompatibleShot, 'string')
    assert.match(
      String(incompatibleShot),
      /Recovery action: retry browser_screenshot and remove either ref or fullPage/,
    )
    assert.doesNotMatch(String(incompatibleShot), /browser_snapshot/)
    ok('viewport, full-page JPEG and element screenshots')

    // ── console tool ──────────────────────────────────────
    const logs = expectData(
      await run(consoleTool, { level: 'error' }, sessionId),
    )
    const entries = logs.consoleErrors as Array<{ text: string }>
    assert.ok(entries.some(e => e.text.includes('widget service unreachable')))
    ok('console tool')

    // ── network ───────────────────────────────────────────
    // The distinction that matters when debugging: reached the server and was
    // rejected, versus never left the browser.
    const netSnap = expectData(await run(snapshotTool, {}, sessionId))
    const page = String(netSnap.snapshot)

    await run(clickTool, { ref: refFor(page, 'button', 'Call ok') }, sessionId)
    await run(clickTool, { ref: refFor(page, 'button', 'Call xhr') }, sessionId)

    const all = expectData(await run(networkTool, {}, sessionId))
    const rows = all.network as Array<{
      method: string
      url: string
      status: number
      failed: boolean
      pending: boolean
    }>
    const okRow = rows.find(
      r => r.url.includes('/api/ok') && !r.url.includes('xhr'),
    )
    assert.ok(okRow, `no fetch row for /api/ok in ${JSON.stringify(rows)}`)
    assert.equal(okRow.status, 200)
    assert.equal(okRow.method, 'GET')
    const xhrRow = rows.find(r => r.url.includes('via=xhr'))
    assert.ok(xhrRow, 'XHR requests must be captured too')
    assert.equal(xhrRow.status, 200)
    ok('network: fetch and XHR captured with status')

    // A 500 surfaces on the click that caused it, without asking separately.
    const boomClick = expectData(
      await run(
        clickTool,
        { ref: refFor(page, 'button', 'Call boom') },
        sessionId,
      ),
    )
    const onClick = (boomClick.network ?? []) as Array<{
      status: number
      method: string
      url: string
    }>
    assert.ok(
      onClick.some(r => r.status === 500 && r.method === 'POST'),
      `click should report the 500 it caused, got ${JSON.stringify(onClick)}`,
    )
    ok('network: failed request surfaces on the action that caused it')

    const deadClick = expectData(
      await run(
        clickTool,
        { ref: refFor(page, 'button', 'Call dead host') },
        sessionId,
      ),
    )
    const dead = (
      (deadClick.network ?? []) as Array<{
        failed: boolean
        status: number
        error: string
        url: string
      }>
    ).find(r => r.url.includes('127.0.0.1:1'))
    assert.ok(dead, 'a request to a dead host must be reported')
    assert.equal(dead.failed, true)
    assert.equal(dead.status, 0, 'never-sent requests have no status')
    assert.ok(dead.error.length > 0, 'a failure needs a reason')
    ok('network: never-sent is distinguished from a server error')

    const onlyBad = expectData(
      await run(networkTool, { failedOnly: true }, sessionId),
    )
    const bad = onlyBad.network as Array<{ status: number; failed: boolean }>
    assert.ok(
      bad.length >= 2,
      'failedOnly should keep the 500 and the dead host',
    )
    assert.ok(
      bad.every(r => r.failed || r.status >= 400),
      'failedOnly must not return successful requests',
    )
    const filtered = expectData(
      await run(networkTool, { urlContains: 'via=xhr' }, sessionId),
    )
    assert.equal((filtered.network as unknown[]).length, 1)
    ok('network: failedOnly and urlContains filters')

    const diagnostics = expectData(
      await run(navigateTool, { url: `${baseUrl}diagnostics` }, sessionId),
    )
    const diagnosticsSnapshot = String(diagnostics.snapshot)
    expectData(
      await run(
        clickTool,
        { ref: refFor(diagnosticsSnapshot, 'button', 'Emit console levels') },
        sessionId,
      ),
    )
    for (const [level, text] of [
      ['log', 'diagnostics log'],
      ['warn', 'diagnostics warn'],
      ['error', 'diagnostics error'],
    ] as const) {
      const levelOutput = expectData(
        await run(consoleTool, { level }, sessionId),
      )
      assert.ok(
        (
          levelOutput.consoleErrors as Array<{ level: string; text: string }>
        ).some(entry => entry.level === level && entry.text.includes(text)),
        JSON.stringify(levelOutput.consoleErrors),
      )
    }
    const limitedConsole = expectData(
      await run(consoleTool, { limit: 2 }, sessionId),
    )
    assert.equal((limitedConsole.consoleErrors as unknown[]).length, 2)

    const beforeRequests = String(
      expectData(await run(snapshotTool, {}, sessionId)).snapshot,
    )
    expectData(
      await run(
        clickTool,
        { ref: refFor(beforeRequests, 'button', 'Make requests') },
        sessionId,
      ),
    )
    const limitedNetwork = expectData(
      await run(networkTool, { limit: 2 }, sessionId),
    )
    assert.equal((limitedNetwork.network as unknown[]).length, 2)
    assert.ok(Number(limitedNetwork.networkTotal) >= 4)
    ok('console levels and console/network limits use real page diagnostics')

    const scrollMatrix = expectData(
      await run(navigateTool, { url: `${baseUrl}scroll-matrix` }, sessionId),
    )
    const containerTarget = refFor(
      String(scrollMatrix.snapshot),
      'button',
      'Container target',
    )
    expectData(
      await run(
        scrollTool,
        { ref: containerTarget, deltaY: 600, deltaX: 240 },
        sessionId,
      ),
    )
    const containerPosition = expectData(
      await run(
        cdpTool,
        {
          method: 'Runtime.evaluate',
          params: {
            expression:
              '({ top: document.querySelector("#scroller").scrollTop, left: document.querySelector("#scroller").scrollLeft, page: scrollY })',
            returnByValue: true,
          },
        },
        sessionId,
      ),
    )
    const scrolled = (
      containerPosition.value as {
        result?: { value?: { top?: number; left?: number; page?: number } }
      }
    ).result?.value
    assert.ok((scrolled?.top ?? 0) > 0, JSON.stringify(scrolled))
    assert.ok((scrolled?.left ?? 0) > 0, JSON.stringify(scrolled))
    assert.equal(scrolled?.page, 0)
    expectData(
      await run(
        scrollTool,
        { ref: containerTarget, direction: 'left', amount: 100 },
        sessionId,
      ),
    )
    ok('scroll targets vertical and horizontal nested containers')
    expectData(await run(navigateTool, { url: baseUrl }, sessionId))

    // ── navigating away resets refs ───────────────────────
    const other = expectData(
      await run(navigateTool, { url: `${baseUrl}other` }, sessionId),
    )
    assert.equal(other.title, 'Other')
    assert.ok(String(other.snapshot).includes('heading "Other page"'))
    const afterNav = await run(clickTool, { ref: counterRef }, sessionId)
    assert.ok(
      typeof afterNav === 'string' && afterNav.includes('snapshot'),
      'refs from the previous page must not resolve after navigation',
    )
    ok('navigation invalidates old refs')

    // ── distiller: wrappers collapse, selector, compact, scale ──
    const nested = expectData(
      await run(navigateTool, { url: `${baseUrl}nested` }, sessionId),
    )
    const nestedSnap = String(nested.snapshot)
    assert.ok(nestedSnap.includes('heading "Inbox"'), nestedSnap)
    assert.ok(
      !/generic "[^"]{80,}/.test(nestedSnap),
      `generic must not quote a long subtree name:\n${nestedSnap.slice(0, 1500)}`,
    )
    const genericRefs = nestedSnap
      .split('\n')
      .filter(l => l.includes('generic') && l.includes('[ref='))
    assert.ok(
      genericRefs.length <= 60,
      `wrapper chain must collapse; got ${genericRefs.length} generic refs`,
    )
    const alice = refForGeneric(nestedSnap, 'Alice: latest note')
    expectData(await run(clickTool, { ref: alice }, sessionId))
    ok('wrapper chain collapses to one generic ref per row')

    const panel = expectData(
      await run(snapshotTool, { selector: '#chat-panel' }, sessionId),
    )
    const panelText = String(panel.snapshot)
    assert.ok(panelText.includes('Alice: latest note'), panelText)
    assert.ok(
      !panelText.includes('Ignore me'),
      `selector must not include the sidebar:\n${panelText}`,
    )
    assert.ok(
      !panelText.includes('heading "Inbox"'),
      `selector must start at the panel, not the page:\n${panelText}`,
    )
    ok('selector snapshots a subtree')

    const efficient = expectData(
      await run(snapshotTool, { mode: 'efficient' }, sessionId),
    )
    const efficientText = String(efficient.snapshot)
    const efficientLines = efficientText.split('\n').filter(Boolean)
    const fullLines = nestedSnap.split('\n').filter(Boolean)
    assert.ok(
      efficientLines.length <= fullLines.length,
      `efficient should not grow the tree (${efficientLines.length} vs ${fullLines.length})`,
    )
    assert.ok(
      efficientText.includes('[ref=') &&
        efficientText.includes('Alice: latest note'),
      `efficient must keep the clickable row:\n${efficientText.slice(0, 800)}`,
    )
    ok('mode=efficient clips the tree but keeps clickable rows')

    const interactiveOnly = expectData(
      await run(snapshotTool, { mode: 'full', interactive: true }, sessionId),
    )
    const interactiveText = String(interactiveOnly.snapshot)
    assert.match(interactiveText, /Alice: latest note/)
    assert.doesNotMatch(interactiveText, /heading "Inbox"/)

    const boundedSnapshot = expectData(
      await run(
        snapshotTool,
        { mode: 'efficient', maxChars: 300, maxNodes: 1 },
        sessionId,
      ),
    )
    const boundedSnapshotText = String(boundedSnapshot.snapshot)
    assert.equal(boundedSnapshot.snapshotTruncated, true)
    assert.ok(
      boundedSnapshotText.split('\n').filter(line => line.includes('[ref='))
        .length <= 1,
      boundedSnapshotText,
    )
    ok('snapshot honors interactive, maxChars and maxNodes options')

    assert.ok(
      nestedSnap.length < 25_000,
      `50 nested rows must stay well under the char budget, got ${nestedSnap.length}`,
    )
    ok('distiller keeps a 50-row nested list small')

    const overflow = expectData(
      await run(navigateTool, { url: `${baseUrl}overflow` }, sessionId),
    )
    const overflowSnap = yamlFromObserve(overflow)
    assert.ok(
      overflow.snapshotTruncated === true || overflowSnap.length >= 15_000,
      `overflow page should fill the budget, got ${overflowSnap.length} truncated=${overflow.snapshotTruncated}`,
    )
    const dockRef = refForGeneric(overflowSnap, 'Chat dock')
    assert.ok(
      dockRef,
      `fixed chrome must survive in the complete YAML:\n${overflowSnap.slice(-800)}`,
    )
    ok(
      'fixed overlay chrome is kept in the complete snapshot (inline or spilled file)',
    )

    const boundedText = expectData(
      await run(getTextTool, { maxChars: 120 }, sessionId),
    )
    assert.equal(boundedText.snapshotMode, 'text')
    assert.equal(boundedText.snapshotTruncated, true)
    assert.equal(String(boundedText.snapshot).length, 120)
    const feedText = expectData(
      await run(getTextTool, { selector: '#feed', maxChars: 1000 }, sessionId),
    )
    assert.match(String(feedText.snapshot), /^Filler paragraph 0/)
    assert.doesNotMatch(String(feedText.snapshot), /^Feed/)
    const missingText = await run(
      getTextTool,
      { selector: '#does-not-exist' },
      sessionId,
    )
    assert.equal(typeof missingText, 'string')
    assert.match(String(missingText), /No visible text matched selector/)
    assert.match(String(missingText), /Recovery action: browser_snapshot/)
    assert.doesNotMatch(String(missingText), /Filler paragraph/)
    ok('get_text bounds and honors explicit selectors')

    expectData(
      await run(navigateTool, { url: `${baseUrl}text-regions` }, sessionId),
    )
    const defaultText = expectData(await run(getTextTool, {}, sessionId))
    assert.equal(String(defaultText.snapshot).trim(), 'Primary article text')
    assert.match(String(defaultText.message), /article/)
    ok('get_text prefers article over main and body')

    expectData(await run(navigateTool, { url: baseUrl }, sessionId))
    const snapshotWithUrls = expectData(
      await run(snapshotTool, { urls: true }, sessionId),
    )
    const linkedSnapshot = String(snapshotWithUrls.snapshot)
    assert.match(linkedSnapshot, /\nLinks:\n/)
    assert.match(linkedSnapshot, /Go to other page -> http:\/\/127\.0\.0\.1:/)
    ok('snapshot appends resolved link URLs')

    const escapedDownload = await run(
      waitForDownloadTool,
      { path: '../outside.csv' },
      sessionId,
    )
    assert.equal(typeof escapedDownload, 'string')
    assert.match(String(escapedDownload), /Downloads can only be saved under/)

    if (opts.downloads !== false) {
      const downloadNav = expectData(
        await run(navigateTool, { url: `${baseUrl}download` }, sessionId),
      )
      const savedFiles: string[] = []
      try {
        const noDownloadStarted = Date.now()
        const noDownload = await run(
          waitForDownloadTool,
          {
            ref: refFor(
              String(downloadNav.snapshot),
              'button',
              'Ordinary button',
            ),
            timeoutMs: 150,
          },
          sessionId,
        )
        assert.equal(typeof noDownload, 'string')
        assert.match(String(noDownload), /No download started/i)
        assert.ok(
          Date.now() - noDownloadStarted < 2_000,
          'tool-level download timeout must not fall back to 25s',
        )

        const direct = expectData(
          await run(
            waitForDownloadTool,
            {
              ref: refFor(
                String(downloadNav.snapshot),
                'link',
                'Download report',
              ),
              path: `agent-browser-${sessionId}-direct.csv`,
            },
            sessionId,
          ),
        )
        savedFiles.push(String(direct.downloadPath))
        assert.equal(
          fs.readFileSync(String(direct.downloadPath), 'utf8'),
          'id,name\n1,Alice\n2,Bob\n',
        )

        const afterDirect = String(
          expectData(await run(snapshotTool, {}, sessionId)).snapshot,
        )
        const delayed = expectData(
          await run(
            waitForDownloadTool,
            {
              ref: refFor(afterDirect, 'button', 'Download after 5 seconds'),
              path: `agent-browser-${sessionId}-delayed.csv`,
            },
            sessionId,
          ),
        )
        savedFiles.push(String(delayed.downloadPath))
        assert.equal(
          fs.readFileSync(String(delayed.downloadPath), 'utf8'),
          'id,name\n3,Delayed\n',
        )
        ok('wait_for_download honors timeout and captures direct/delayed files')
      } finally {
        for (const file of savedFiles) fs.rmSync(file, { force: true })
      }
      expectData(await run(navigateTool, { url: baseUrl }, sessionId))
    }

    // ── tab lifecycle ─────────────────────────────────────
    // On the extension backend this is the path that creates and destroys tabs
    // in the user's real browser, so open/select/close all need to round-trip.
    type TabRow = { targetId: string; url: string; current?: boolean }
    const listed = expectData(
      await run(tabsTool, { action: 'list' }, sessionId),
    )
    const firstTabs = listed.tabs as TabRow[]
    assert.equal(firstTabs.length, 1, JSON.stringify(firstTabs))
    assert.ok(firstTabs[0].current, 'the only tab should be the current one')
    const originalId = firstTabs[0].targetId

    const opened = expectData(
      await run(
        tabsTool,
        { action: 'new', url: `${baseUrl}?cdp-background=1` },
        sessionId,
      ),
    )
    const afterOpen = opened.tabs as TabRow[]
    assert.equal(afterOpen.length, 2, JSON.stringify(afterOpen))
    const newTab = afterOpen.find(t => t.targetId !== originalId)!
    assert.ok(newTab.current, 'a newly opened tab should become current')
    assert.ok(
      String(
        expectData(await run(snapshotTool, {}, sessionId)).snapshot,
      ).includes('heading "Dashboard"'),
      'snapshot should come from the newly opened tab',
    )
    const newTabLogs = expectData(
      await run(consoleTool, { level: 'error' }, sessionId),
    )
    assert.ok(
      (newTabLogs.consoleErrors as Array<{ text: string }>).some(entry =>
        entry.text.includes('widget service unreachable'),
      ),
      'tabs new with a URL must capture console output from the first page script',
    )
    ok('tabs: open a new tab and switch to it')

    const reselected = expectData(
      await run(tabsTool, { action: 'select', tabId: originalId }, sessionId),
    )
    assert.equal(reselected.message, `Selected tab ${originalId}`)
    assert.ok(
      (reselected.tabs as TabRow[]).find(t => t.targetId === originalId)
        ?.current,
    )
    const backgroundLocation = expectData(
      await run(
        cdpTool,
        {
          viewId: newTab.targetId,
          method: 'Runtime.evaluate',
          params: {
            expression: 'location.href',
            returnByValue: true,
          },
        },
        sessionId,
      ),
    )
    assert.match(
      String(
        (backgroundLocation.value as { result?: { value?: string } }).result
          ?.value,
      ),
      /cdp-background=1/,
    )
    const currentLocation = expectData(
      await run(
        cdpTool,
        {
          method: 'Runtime.evaluate',
          params: {
            expression: 'location.href',
            returnByValue: true,
          },
        },
        sessionId,
      ),
    )
    assert.match(
      String(
        (currentLocation.value as { result?: { value?: string } }).result
          ?.value,
      ),
      /cdp-background=1/,
    )
    ok('tabs: select and explicit CDP view becomes last interacted')

    const cdpVictim = expectData(
      await run(
        tabsTool,
        { action: 'new', url: `${baseUrl}other?closed-cdp=1` },
        sessionId,
      ),
    )
    const cdpVictimId = (cdpVictim.tabs as TabRow[]).find(
      tab => tab.current,
    )!.targetId
    expectData(
      await run(tabsTool, { action: 'close', tabId: cdpVictimId }, sessionId),
    )
    const cdpOnClosedTab = await run(
      cdpTool,
      {
        viewId: cdpVictimId,
        method: 'Runtime.evaluate',
        params: { expression: 'location.href', returnByValue: true },
      },
      sessionId,
    )
    assert.equal(typeof cdpOnClosedTab, 'string')
    assert.match(String(cdpOnClosedTab), /No open tab with id/)
    expectData(
      await run(tabsTool, { action: 'select', tabId: originalId }, sessionId),
    )
    ok('cdp rejects an explicitly closed viewId')

    const temporary = expectData(
      await run(
        tabsTool,
        { action: 'new', url: `${baseUrl}other?temporary=1` },
        sessionId,
      ),
    )
    const temporaryTabs = temporary.tabs as TabRow[]
    const temporaryTab = temporaryTabs.find(
      tab => tab.targetId !== originalId && tab.targetId !== newTab.targetId,
    )
    assert.ok(temporaryTab?.current)
    const afterCurrentClose = expectData(
      await run(
        tabsTool,
        { action: 'close', tabId: temporaryTab.targetId },
        sessionId,
      ),
    ).tabs as TabRow[]
    assert.equal(afterCurrentClose.length, 2)
    assert.equal(afterCurrentClose.filter(tab => tab.current).length, 1)
    assert.ok(
      afterCurrentClose.every(tab => tab.targetId !== temporaryTab.targetId),
    )
    expectData(
      await run(tabsTool, { action: 'select', tabId: originalId }, sessionId),
    )
    ok('tabs: closing the current tab adopts a live neighbour')

    const externallyClosed = expectData(
      await run(
        tabsTool,
        { action: 'new', url: `${baseUrl}other?external-close=1` },
        sessionId,
      ),
    )
    const externallyClosedId = (externallyClosed.tabs as TabRow[]).find(
      tab => tab.current,
    )!.targetId
    const directBackend = await getBrowser(process.cwd(), sessionId)
    await directBackend.closeTab(externallyClosedId)
    // The extension delivers targetGone asynchronously. Give it time to reach
    // manager state so this catches accidental clearing of the tombstone.
    await new Promise(resolve => setTimeout(resolve, 300))
    const afterExternalClose = await run(snapshotTool, {}, sessionId)
    assert.equal(typeof afterExternalClose, 'string')
    assert.match(
      String(afterExternalClose),
      /was closed or is no longer shared/,
    )
    assert.match(String(afterExternalClose), /Recovery action: browser_tabs/)
    assert.equal(
      getCurrentTabId(sessionId),
      externallyClosedId,
      'a dead current tab must not silently switch to a neighbour',
    )
    const recoveredFromExternalClose = expectData(
      await run(navigateTool, { url: baseUrl }, sessionId),
    )
    assert.match(String(recoveredFromExternalClose.snapshot), /Dashboard/)
    const recoveredId = getCurrentTabId(sessionId)
    assert.ok(recoveredId && recoveredId !== externallyClosedId)
    expectData(
      await run(tabsTool, { action: 'close', tabId: recoveredId }, sessionId),
    )
    expectData(
      await run(tabsTool, { action: 'select', tabId: originalId }, sessionId),
    )
    ok('externally closed current tab fails explicitly and navigate recovers')

    // ── input still lands after the tab has been backgrounded ──
    // Chrome drops Input.* aimed at a hidden tab, and opening the tab above
    // pushed this one behind it. That is also the state the extension backend
    // leaves every tab in, so this is the shape of the real-world failure: the
    // dispatch reports success and the page never hears about it.
    const revisited = expectData(
      await run(navigateTool, { url: baseUrl }, sessionId),
    )
    const bgRef = refFor(
      String(revisited.snapshot),
      'button',
      'Clicked 0 times',
    )
    const bgClicked = expectData(
      await run(clickTool, { ref: bgRef }, sessionId),
    )
    assert.ok(
      String(bgClicked.snapshot).includes('Clicked 1 times'),
      'a click on a backgrounded tab must still reach the page',
    )
    ok('input reaches a backgrounded tab')

    const beforeHandoff = String(bgClicked.snapshot)
    expectData(await run(lockTool, { action: 'unlock' }, sessionId))
    const blockedDuringHandoff = await run(
      clickTool,
      {
        ref: refFor(beforeHandoff, 'button', 'Clicked 1 times'),
      },
      sessionId,
    )
    assert.equal(typeof blockedDuringHandoff, 'string')
    assert.match(String(blockedDuringHandoff), /user.*control|control.*user/i)
    const blockedNavigate = await run(
      navigateTool,
      { url: `${baseUrl}other?during-handoff=1` },
      sessionId,
    )
    assert.equal(typeof blockedNavigate, 'string')
    assert.match(String(blockedNavigate), /user.*control|control.*user/i)
    const blockedType = await run(
      typeTool,
      {
        ref: refFor(beforeHandoff, 'textbox', 'Email address'),
        text: 'must-not-be-typed@example.com',
      },
      sessionId,
    )
    assert.equal(typeof blockedType, 'string')
    assert.match(String(blockedType), /user.*control|control.*user/i)
    const observedDuringHandoff = expectData(
      await run(snapshotTool, {}, sessionId),
    )
    assert.match(String(observedDuringHandoff.snapshot), /Dashboard/)
    assert.doesNotMatch(
      String(observedDuringHandoff.snapshot),
      /must-not-be-typed@example\.com/,
    )
    expectData(await run(tabsTool, { action: 'list' }, sessionId))
    expectData(await run(lockTool, { action: 'lock' }, sessionId))
    const afterRelock = String(
      expectData(await run(snapshotTool, {}, sessionId)).snapshot,
    )
    const resumedClick = expectData(
      await run(
        clickTool,
        { ref: refFor(afterRelock, 'button', 'Clicked 1 times') },
        sessionId,
      ),
    )
    assert.match(String(resumedClick.snapshot), /Clicked 2 times/)
    ok('lock handoff blocks mutations, permits tab listing and resumes')

    // ── wait_for (time / text / textGone) ──
    const waitNav = expectData(
      await run(navigateTool, { url: `${baseUrl}wait-text` }, sessionId),
    )
    const revealRef = refFor(String(waitNav.snapshot), 'button', 'Reveal')
    const afterReveal = expectData(
      await run(clickTool, { ref: revealRef }, sessionId),
    )
    assert.ok(
      !String(afterReveal.snapshot).includes('Message delivered'),
      `click settle (~500ms) must not wait out a 2s string:\n${afterReveal.snapshot}`,
    )
    const waited = expectData(
      await run(waitForTool, { text: 'Message delivered' }, sessionId),
    )
    assert.ok(
      String(waited.snapshot).includes('Message delivered'),
      `browser_wait_for text must snapshot once the string is visible:\n${waited.snapshot}`,
    )
    ok('wait_for text appears after click settle')

    const goneNav = expectData(
      await run(navigateTool, { url: `${baseUrl}wait-text` }, sessionId),
    )
    const goneRef = refFor(String(goneNav.snapshot), 'button', 'Reveal')
    await run(clickTool, { ref: goneRef }, sessionId)
    const gone = expectData(
      await run(waitForTool, { textGone: 'Loading now' }, sessionId),
    )
    assert.ok(
      !String(gone.snapshot).includes('Loading now'),
      `browser_wait_for textGone must snapshot after the string leaves:\n${gone.snapshot}`,
    )
    ok('wait_for textGone')

    const timed = expectData(await run(waitForTool, { time: 0.2 }, sessionId))
    assert.ok(
      String(timed.snapshot).includes('Wait fixture'),
      `time-only wait_for must still return a snapshot:\n${timed.snapshot}`,
    )
    ok('wait_for time')

    const selectorWaitNav = expectData(
      await run(
        navigateTool,
        {
          url: `${baseUrl}wait-text?selector-wait=${encodeURIComponent(label)}`,
        },
        sessionId,
      ),
    )
    await run(
      clickTool,
      {
        ref: refFor(String(selectorWaitNav.snapshot), 'button', 'Reveal'),
      },
      sessionId,
    )
    const selectorWaited = expectData(
      await run(waitForTool, { selector: '#later' }, sessionId),
    )
    assert.match(String(selectorWaited.snapshot), /Selector appeared/)
    ok('wait_for selector becomes visible')

    const navigateLaterRef = refFor(
      String(selectorWaited.snapshot),
      'button',
      'Navigate later',
    )
    await run(clickTool, { ref: navigateLaterRef }, sessionId)
    const urlWaited = expectData(
      await run(waitForTool, { url: '**/other?waited=url' }, sessionId),
    )
    assert.match(String(urlWaited.url), /\/other\?waited=url$/)
    assert.match(String(urlWaited.snapshot), /heading "Other page"/)
    ok('wait_for URL glob observes delayed navigation')

    const emptyWait = await run(waitForTool, {}, sessionId)
    assert.equal(typeof emptyWait, 'string')
    assert.match(
      String(emptyWait),
      /Recovery action: retry browser_wait_for with at least one wait condition/,
    )
    assert.doesNotMatch(String(emptyWait), /browser_snapshot/)
    ok('wait_for rejects an empty condition with the right recovery')

    const ambiguousWait = await run(
      waitForTool,
      { time: 0.1, text: 'Never appears' },
      sessionId,
    )
    assert.equal(typeof ambiguousWait, 'string')
    assert.match(String(ambiguousWait), /exactly one|one wait condition/i)

    const timeoutStarted = Date.now()
    const shortTimeout = await run(
      waitForTool,
      { text: 'Never appears', timeoutMs: 150 },
      sessionId,
    )
    assert.equal(typeof shortTimeout, 'string')
    assert.match(String(shortTimeout), /timed out/i)
    assert.ok(
      Date.now() - timeoutStarted < 2_000,
      'custom wait timeout must not fall back to the 20s default',
    )
    ok('wait_for rejects combined conditions and honors timeoutMs')

    const spaStart = expectData(
      await run(navigateTool, { url: `${baseUrl}spa?route=one` }, sessionId),
    )
    const routeRef = refFor(String(spaStart.snapshot), 'button', 'Go SPA two')
    const spaChanged = expectData(
      await run(clickTool, { ref: routeRef }, sessionId),
    )
    assert.match(String(spaChanged.url), /\/spa\?route=two$/)
    assert.match(String(spaChanged.snapshot), /heading "SPA route two"/)
    const staleSpaRef = await run(clickTool, { ref: routeRef }, sessionId)
    assert.equal(typeof staleSpaRef, 'string')
    assert.match(String(staleSpaRef), /stale|not found|snapshot/i)
    const spaFresh = String(
      expectData(await run(snapshotTool, {}, sessionId)).snapshot,
    )
    const spaAction = expectData(
      await run(
        clickTool,
        { ref: refFor(spaFresh, 'button', 'SPA action') },
        sessionId,
      ),
    )
    assert.match(String(spaAction.snapshot), /spa action complete/)
    ok('SPA history route replaces refs and remains actionable')

    const closed = expectData(
      await run(
        tabsTool,
        { action: 'close', tabId: newTab.targetId },
        sessionId,
      ),
    )
    const afterClose = closed.tabs as TabRow[]
    assert.equal(afterClose.length, 1, JSON.stringify(afterClose))
    assert.equal(afterClose[0].targetId, originalId)
    ok('tabs: close')

    const closeMissing = await run(
      tabsTool,
      { action: 'close', tabId: newTab.targetId },
      sessionId,
    )
    assert.ok(
      typeof closeMissing === 'string',
      'closing an already-closed tab must report an error, not succeed silently',
    )
    assert.match(
      String(closeMissing),
      new RegExp(`No open tab with id "${newTab.targetId}"`),
    )
    ok('tabs: closing a dead tab fails cleanly')
  } finally {
    setBrowserBackendFactory(null)
    await closeBrowser()
  }
}
