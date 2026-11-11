const PORT_DEFAULT = 3488;

function fail(message, detail) {
  document.body.innerHTML = `
    <div style="max-width:560px;margin:12vh auto;padding:0 24px;font:13px/1.6 -apple-system,BlinkMacSystemFont,sans-serif;color:var(--magpie-fg,#1a1a1a)">
      <h1 style="font-size:16px;margin:0 0 8px">无法连接 OmO 设置服务</h1>
      <p style="margin:0 0 8px;color:var(--magpie-muted,#6b7280)">${message}</p>
      <pre style="margin:0 0 16px;padding:10px 12px;border-radius:8px;background:var(--magpie-card,#f9fafb);border:1px solid var(--magpie-line,#e5e7eb);white-space:pre-wrap;font:12px ui-monospace,Menlo,monospace">${detail}</pre>
      <button type="button" id="retry" style="font:inherit;padding:6px 14px;border-radius:6px;border:1px solid var(--magpie-line,#e5e7eb);background:var(--magpie-card,#f9fafb);color:inherit;cursor:pointer">重试</button>
    </div>`;
  document.getElementById("retry").onclick = () => location.reload();
}

(async () => {
  let theme;
  try {
    theme = await Promise.race([
      magpie.ready,
      new Promise((_, reject) => setTimeout(() => reject(new Error("窗口在 10 秒内没有回应")), 10000)),
    ]);
  } catch (err) {
    fail("这个页面没有和 magpie 窗口建立连接，通常是插件没有被窗口加载。", String(err && err.message || err));
    return;
  }

  let port = PORT_DEFAULT;
  try {
    const opts = await magpie.options.get();
    if (opts && opts.port) port = opts.port;
  } catch {
  }

  const target = magpie.service || `http://127.0.0.1:${port}/`;
  const url = new URL(target, location.href);
  url.searchParams.set('theme', theme && theme.dark ? 'dark' : 'light');
  if (theme && theme.lang) url.searchParams.set('lang', theme.lang);

  const stuck = setTimeout(() => {
    fail(
      "插件后台服务没有在这个端口上响应。页面插件需要一个正在运行的插件宿主（Bun）。",
      [
        `目标地址: ${target}`,
        "",
        "排查：",
        "1. 在 magpie 里关闭再打开这个插件，让它重启插件宿主；",
        "2. 确认 magpie 已经装有运行插件用的 Bun；",
        `3. 确认端口 ${port} 没有被其他程序占用。`,
      ].join("\n"),
    );
  }, 6000);

  addEventListener("pagehide", () => clearTimeout(stuck));
  location.replace(url.href);
})();
