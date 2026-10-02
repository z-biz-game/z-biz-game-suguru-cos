'use strict';

// 注册 service worker。单独一个文件、classic script：它得能在模块图之外先跑起来，而且不能
// 因为一句 import 把 Electron 的 file:// 加载路径拖下水。
//
// 三条边界：
//   * file://（Electron 直接 loadFile、以及玩家双击 index.html）不注册，且**不留下未捕获异常**——
//     register() 在非安全上下文里 reject，一个没人接的 Promise 就是一条红错误。
//   * 路径全相对：Pages 把仓库挂在 /<repo>/ 前缀下，`/sw.js` 会注册到域名根，别的仓就被这份缓存接管了。
//   * 只在 load 之后注册：首屏的模块请求不该被一个刚 install 的 worker 拦。
(function () {
  var p = location.protocol;
  if (p !== 'https:' && p !== 'http:') return;
  if (!('serviceWorker' in navigator)) return;
  var register = function () {
    try {
      var reg = navigator.serviceWorker.register('sw.js', { scope: './' });
      // 断网 / 不支持 SW 的内嵌浏览器都会走到这里；离线能力是加分项，不该冒泡成页面错误。
      if (reg && typeof reg.catch === 'function') reg.catch(function () {});
    } catch (e) {
      /* 注册不了就算了，游戏本身不依赖它 */
    }
  };
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
})();
