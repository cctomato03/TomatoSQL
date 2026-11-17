// 极简 CDP 客户端（WebView2 远程调试），供冒烟测试复用
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function check(name, cond, detail = "") {
  const ok = Boolean(cond);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` → ${detail}` : ""}`);
  if (!ok) process.exitCode = 1;
  return ok;
}

export async function connect(port = 9222, timeoutMs = 30000) {
  const base = `http://127.0.0.1:${port}`;
  const started = Date.now();
  let page = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const list = await (await fetch(`${base}/json`)).json();
      page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) break;
    } catch {
      /* 等待端口就绪 */
    }
    await sleep(400);
  }
  if (!page) throw new Error("未找到可调试页面（WebView2 远程调试端口未就绪）");
  const cdp = new CDP(page.webSocketDebuggerUrl);
  await cdp.ready;
  return cdp;
}

export class CDP {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    this.ready = new Promise((res, rej) => {
      this.ws.onopen = () => res();
      this.ws.onerror = (e) => rej(new Error(String(e?.message ?? e)));
    });
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      } else if (msg.method) this.events.push(msg);
    };
  }

  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时 ${method}`));
        }
      }, 30000);
    });
  }

  async eval(expression, awaitPromise = true) {
    const res = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise,
      returnByValue: true,
      allowUnsafeEvalBlockedByCSP: true,
    });
    if (res.exceptionDetails) {
      throw new Error(
        `页面异常: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`,
      );
    }
    return res.result?.value;
  }

  clickText(text) {
    return this.eval(
      `(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent && x.textContent.includes(${JSON.stringify(text)})); if(!b) return 'not-found'; b.click(); return 'ok'; })()`,
      false,
    );
  }

  clickTitle(title) {
    return this.eval(
      `(() => { const el=document.querySelector('[title=' + ${JSON.stringify(JSON.stringify(title))} + ']'); if(!el) return 'not-found'; el.click(); return 'ok'; })()`,
      false,
    );
  }

  setByPlaceholder(part, value) {
    return this.eval(
      `(() => {
        const el=[...document.querySelectorAll('input,textarea')].find(i => (i.placeholder||'').includes(${JSON.stringify(part)}));
        if(!el) return 'not-found';
        const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto,'value').set.call(el, ${JSON.stringify(value)});
        el.dispatchEvent(new Event('input',{bubbles:true}));
        return 'ok';
      })()`,
      false,
    );
  }

  /** 按索引设置输入框（用于没有 placeholder 的字段） */
  setByIndex(selector, index, value) {
    return this.eval(
      `(() => {
        const el=document.querySelectorAll(${JSON.stringify(selector)})[${index}];
        if(!el) return 'not-found';
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(el, ${JSON.stringify(value)});
        el.dispatchEvent(new Event('input',{bubbles:true}));
        return 'ok';
      })()`,
      false,
    );
  }

  text(selector) {
    return this.eval(
      `document.querySelector(${JSON.stringify(selector)})?.innerText.replace(/\\s+/g,' ') ?? ''`,
      false,
    );
  }

  count(selector) {
    return this.eval(`document.querySelectorAll(${JSON.stringify(selector)}).length`, false);
  }

  async waitFor(fn, timeout = 15000, label = "") {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      if (await fn()) return true;
      await sleep(250);
    }
    if (label) console.log(`  超时等待: ${label}`);
    return false;
  }

  errors() {
    const list = [];
    for (const ev of this.events) {
      if (ev.method === "Runtime.exceptionThrown") {
        list.push(ev.params?.exceptionDetails?.exception?.description ?? "exception");
      }
      if (ev.method === "Log.entryAdded" && ev.params?.entry?.level === "error") {
        list.push(ev.params.entry.text);
      }
    }
    return list.filter((e) => e && !String(e).includes("favicon"));
  }
}
