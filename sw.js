'use strict';

// 离线可用，但**绝不用缓存挡住新版本**。
//
// 口径：同源 GET 一律 network-first —— 能联网就取网络并顺手回填 cache，断网才回落到上次成功
// 抓到的字节。cache-first 会把 js/css 永久钉死在第一次安装的那版：发一版新 index.html 配一版
// 旧 main.js，页面就处在任何本地测试都复现不了的鬼状态，而且玩家自己看不见。
//
// CACHE 名字带版本号：只在"改了这份 sw.js 里预取的清单"时才需要 +1，activate 会把其它名字的
// cache 全清掉。日常发布不需要动它——网络那一头本来就是最新的。
//
// 跨源请求（CDN 字体之类）不接管：本产物零外链，接了等于给一个不存在的东西开缓存口子。

const CACHE = 'suguru-cos-v1';
const SHELL = './';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then((hit) => {
          if (hit) return hit;
          // 导航请求断网时回落到缓存里的外壳，离线打开不白屏。
          return req.mode === 'navigate' ? caches.match(SHELL) : Response.error();
        })
      )
  );
});
