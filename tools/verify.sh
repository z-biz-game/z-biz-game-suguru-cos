#!/usr/bin/env bash
# One-shot browser verification: real Chrome, real DOM, scripted scenarios.
#
#   ./tools/verify.sh                       # engine gen play hint conflict save resume layout a11y pause
#   SCENARIOS="play hint" ./tools/verify.sh
#   SHOTS=1 ./tools/verify.sh               # 顺手截 menu/board/win 三张图到 tools/shots/
#   BASE_URL=https://z-biz-game.github.io/z-biz-game-suguru-cos/ ./tools/verify.sh
#
# 还要跑第二遍，形态和生产一致：Pages 把仓库挂在 /<repo>/ 下面，本机 server.cjs 把仓库当文档根，
# 这两种形状解相对说明符的方式不一样，只测后者得出的绿不算对已部署站点的证明。
#   mkdir -p /tmp/sgp && ln -sfn "$PWD" /tmp/sgp/z-biz-game-suguru-cos
#   (cd /tmp/sgp && python3 -m http.server 5273 --bind 127.0.0.1 >/dev/null 2>&1 &)
#   HTTP_PORT=5273 BASE_URL=http://127.0.0.1:5273/z-biz-game-suguru-cos/ ./tools/verify.sh
#
# Do NOT add --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader: software
# rasterisation saturates every core and, with no CDP client attached, Chrome will not exit
# on its own.
set -u
HERE=$(cd "$(dirname "$0")/.." && pwd)
# 9374：DevTools 端口。9371/9372/9373 已经被海战推演/ulam/loshu 占了，撞号等于两个 verify.sh
# 连到同一个 Chrome 上，把"验收"变成"看了一个陌生页面"。
PORT=${CDP_PORT:-9374}
if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then echo ":$PORT is already LISTENING — a sibling gate or an orphan Chrome holds it; attaching there reads someone else's browser. Wait for it to finish, or rerun with CDP_PORT=<a free port>." >&2; lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >&2 || true; exit 6; fi  # 一机一台：撞在同一个默认口上时不报错的是 Chrome，报错的是绿——先让路再开闸
# 5272：本仓在 z-biz-game 端口表里占的号（5271 是海战推演的）。
HTTP=${HTTP_PORT:-5272}
BASE=${BASE_URL:-http://127.0.0.1:$HTTP/}
CHROME=${CHROME_BIN:-}
if [ -z "$CHROME" ]; then
  for c in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
           "/Applications/Chromium.app/Contents/MacOS/Chromium" \
           google-chrome chromium chromium-browser; do
    if command -v "$c" >/dev/null 2>&1 || [ -x "$c" ]; then CHROME=$c; break; fi
  done
fi
[ -x "$CHROME" ] || { echo "no Chrome found; set CHROME_BIN" >&2; exit 2; }

LOCAL=0
case "$BASE" in "http://127.0.0.1:$HTTP/"*) LOCAL=1 ;; esac
SPID=0
if [ "$LOCAL" = 1 ]; then
  node "$HERE/server.cjs" "$HTTP" >/tmp/suguru-server.log 2>&1 &
  SPID=$!
  for i in $(seq 1 40); do
    curl -fsS -m 1 "http://127.0.0.1:$HTTP/" >/dev/null 2>&1 && break
    sleep 0.25
  done
fi
# Pre-flight: prove the bytes we are about to test are this app's, not some other repo's
# index.html served on the same port. 5271 和 5272 只差一个字符，所以这一步不能省。
SERVED=$(curl -fsS -m 3 "$BASE" 2>/dev/null || true)
case "$SERVED" in *js/main.js*) ;; *) echo "nothing served at $BASE (see /tmp/suguru-server.log)" >&2; exit 2 ;; esac
echo "$SERVED" | grep -qi suguru || { echo "port serving a different app, not 数方/suguru" >&2; exit 2; }
echo "$SERVED" | grep -q '数方' || { echo "served page has no 数方 title, wrong app at $BASE" >&2; exit 2; }

UDD=$(mktemp -d)
"$CHROME" --headless=new --remote-debugging-port=$PORT --user-data-dir=$UDD \
  --window-size=1000,940 --no-first-run --no-default-browser-check about:blank >/tmp/suguru-chrome.log 2>&1 &
CPID=$!
cleanup() {
  [ "$SPID" != 0 ] && kill $SPID 2>/dev/null
  kill -9 $CPID 2>/dev/null
  rm -rf $UDD
}
trap cleanup EXIT
# The watchdog redirects its fds: a background subshell inherits this script's stdout, and
# inside a pipeline it would hold the write end open long after the tests finished.
( sleep ${WD_TIMEOUT:-600}; cleanup ) </dev/null >/dev/null 2>&1 & WD=$!

# A fresh --user-data-dir binds DevTools later than a warm profile: wait on the endpoint.
for i in $(seq 1 120); do
  curl -fsS -m 1 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fsS -m 2 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1 || {
  echo "devtools never bound on :$PORT" >&2; exit 3; }

export CDP_PORT=$PORT
export BASE_URL=$BASE
cd "$HERE"
node tools/playtest.cjs open "$BASE" | head -5

BOOT=""
for i in $(seq 1 60); do
  BOOT=$(node tools/playtest.cjs eval "window.suguru?window.suguru.version:'nope'" nonav 2>/dev/null | tr -d '\n" ')
  case "$BOOT" in *nope*|"") sleep 0.5 ;; *) break ;; esac
done
echo "boot: suguru $BOOT at $BASE"
[ "$BOOT" = "nope" ] && { echo "window.suguru never appeared at $BASE" >&2; exit 4; }

FAILED=0
for s in ${SCENARIOS:-engine gen play hint conflict save resume layout a11y pause}; do
  echo "=== $s ==="
  node tools/playtest.cjs scenario "$s" 2>/tmp/suguru-$s.console.log | tail -1 | sed 's/^RESULT //' | python3 -c "
import sys, json
raw = sys.stdin.read().strip()
if not raw:
    print('  NO RESULT (see /tmp/suguru-$s.console.log)'); sys.exit(1)
try:
    d = json.loads(raw)
except Exception as e:
    print('  UNPARSED:', raw[:300]); sys.exit(1)
for r in d['rows']:
    if not r['pass']: print('  FAIL %-52s %s' % (r['test'], r['detail']))
extra = {k: v for k, v in d.items() if k not in ('rows', 'fail')}
if not d['rows']:
    print('  NO CHECKS RUN — a scenario that asserts nothing cannot be green'); sys.exit(1)
print('  %d checks, %d failed  %s' % (len(d['rows']), d['fail'], extra if extra else ''))
sys.exit(1 if d['fail'] else 0)
" || FAILED=1
  if [ -s /tmp/suguru-$s.console.log ]; then
    echo "  --- console ---"
    sed 's/^/  /' /tmp/suguru-$s.console.log | tail -12
  fi
done

if [ -n "${SHOTS:-}" ]; then
  mkdir -p tools/shots
  for shot in menu board win; do
    case $shot in
      menu) node tools/playtest.cjs eval "window.suguru.show('menu');'ok'" nonav >/dev/null 2>&1 ;;
      board) node tools/playtest.cjs eval "window.suguru.begin({tier:'expert',seed:'shot-board'});for(let i=0;i<12;i++)window.suguru.useHint();'ok'" nonav >/dev/null 2>&1 ;;
      win) node tools/playtest.cjs eval "window.suguru.begin({tier:'regular',seed:'shot-win'});window.suguru.solveWithLogic();'ok'" nonav >/dev/null 2>&1 ;;
    esac
    sleep 1.4
    node tools/playtest.cjs shot tools/shots/$shot-$SHOTS.png >/dev/null
  done
  echo "shots: $(ls tools/shots/*-$SHOTS.png | tr '\n' ' ')"
fi

kill $WD 2>/dev/null
# 部署集闸：ci.yml 跑这两步、本地整闸以前一次都不跑。缺这一步就是「本地全绿、线上 404 自己的
# manifest / sw.js / 图标」这一整类坏法。它不碰 Chrome，也不读页面，纯查产物。
echo "=== deploy-set ==="
node tools/deploy-set.mjs || FAILED=1
node tools/deploy-set-selftest.mjs || FAILED=1
[ $FAILED -eq 0 ] && echo "=== ALL GREEN ===" || echo "=== FAILURES ABOVE ==="
exit $FAILED
