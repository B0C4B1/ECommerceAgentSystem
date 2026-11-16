// 用 headless Chrome + CDP 精确控制视口宽度，替代人工拖动窗口。
// 用法: node /tmp/arkops-cdp.mjs
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9333;
const BASE = 'http://localhost:5174';
const WIDTHS = [1440, 1024];
const THEMES = ['light', 'dark'];

const sleep = ms => new Promise(r => setTimeout(r, ms));

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    '--user-data-dir=/tmp/arkops-chrome-profile',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    'about:blank'
  ],
  { stdio: 'ignore' }
);

async function getTarget() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find(t => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* chrome not ready */
    }
    await sleep(250);
  }
  throw new Error('chrome devtools not reachable');
}

const wsUrl = await getTarget();
const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});

let seq = 0;
const pending = new Map();
const listeners = [];
ws.onmessage = ev => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  } else if (msg.method) {
    listeners.forEach(fn => fn(msg));
  }
};

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

const waitEvent = (method, timeout = 15000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout ${method}`)), timeout);
    const fn = msg => {
      if (msg.method === method) {
        clearTimeout(timer);
        listeners.splice(listeners.indexOf(fn), 1);
        resolve(msg.params);
      }
    };
    listeners.push(fn);
  });

const evaluate = async expression => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
};

const navigate = async url => {
  const loaded = waitEvent('Page.loadEventFired');
  await send('Page.navigate', { url });
  await loaded;
  await sleep(900);
};

await send('Page.enable');
await send('Runtime.enable');

// 登录：登录页表单已预填第一个账号，直接提交
await send('Emulation.setDeviceMetricsOverride', {
  width: WIDTHS[0],
  height: 900,
  deviceScaleFactor: 1,
  mobile: false
});
await navigate(`${BASE}/login`);
await evaluate(`(() => {
  const card = [...document.querySelectorAll('.login-account-card')].find(c => c.textContent.includes('完整经营数据'));
  if (card) card.click();
  return !!card;
})()`);
await sleep(400);
await evaluate(`(() => {
  const btn = [...document.querySelectorAll('button')].find(b => b.type === 'submit');
  if (btn) btn.click();
  return !!btn;
})()`);
for (let i = 0; i < 30; i += 1) {
  if (!(await evaluate('location.pathname')).includes('/login')) break;
  await sleep(300);
}
const afterLogin = await evaluate('location.pathname');

const measure = `(() => {
  const h = document.querySelector('.app-header');
  const hr = h ? h.getBoundingClientRect() : null;
  const kids = h ? [...h.children].map(c => {
    const r = c.getBoundingClientRect();
    return { tag: c.tagName, cls: (c.className || '').toString().slice(0, 40), top: Math.round(r.top), h: Math.round(r.height) };
  }) : [];
  const tab = document.querySelector('.ant-tabs-tab-active .ant-tabs-tab-btn');
  const ink = document.querySelector('.ant-tabs-ink-bar');
  const de = document.documentElement;
  return {
    vw: window.innerWidth,
    theme: de.dataset.theme,
    bodyBg: getComputedStyle(document.body).backgroundColor,
    header: hr ? { top: Math.round(hr.top), h: Math.round(hr.height), scrollH: h.scrollHeight, clientH: h.clientHeight } : null,
    headerChildren: kids,
    tabColor: tab ? getComputedStyle(tab).color : null,
    tabs: [...document.querySelectorAll('.ant-tabs-tab')].map(t => t.textContent.trim()),
    taskRows: document.querySelectorAll('.ant-list-item, .inbox-task-row').length,
    inkColor: ink ? getComputedStyle(ink).backgroundColor : null,
    narrowText: [...document.querySelectorAll('.app-content *')]
      .filter(el => {
        const r = el.getBoundingClientRect();
        return el.children.length === 0 && el.textContent.trim().length > 6 && r.width > 0 && r.width < 28 && r.height > 60;
      })
      .slice(0, 3)
      .map(el => ({ cls: (el.className || '').toString().slice(0, 40), w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height) })),
    overflowX: de.scrollWidth - de.clientWidth,
    docH: de.scrollHeight
  };
})()`;

const results = [];
for (const width of WIDTHS) {
  for (const theme of THEMES) {
    await send('Emulation.setDeviceMetricsOverride', {
      width,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false
    });
    await evaluate(
      `localStorage.setItem('allmall-portal-theme', '${theme}');` +
        `document.documentElement.dataset.theme = '${theme}';` +
        `document.documentElement.style.colorScheme = '${theme}';`
    );
    await navigate(`${BASE}/inbox`);
    for (let i = 0; i < 20; i += 1) {
      if (await evaluate("!!document.querySelector('.ant-tabs-tab')")) break;
      await sleep(250);
    }
    await sleep(600);
    const data = await evaluate(measure);
    results.push({ path: '/inbox', width, theme, ...data });
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(`/tmp/arkops-inbox-${width}-${theme}.png`, Buffer.from(shot.data, 'base64'));
  }
}

console.log(JSON.stringify({ afterLogin, results }, null, 2));
await send('Browser.close');
chrome.kill();
