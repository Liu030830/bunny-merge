(function () {
  var ready = false;
  function showRetry() {
    if (ready) return;
    var button = document.getElementById('start-button');
    if (!button) return;
    button.disabled = false;
    button.textContent = '加载未完成，点我重试';
    button.onclick = function () { window.location.reload(); };
    var status = document.getElementById('load-status');
    if (status) status.textContent = '连接有点慢，请重试。';
  }
  var timer = window.setTimeout(showRetry, 15000);
  window.__bunnyReady = function () {
    ready = true;
    window.clearTimeout(timer);
  };
  window.__bunnyBootFailed = function (error) {
    if (window.console && console.error) console.error('Rabbit game startup failed', error);
    showRetry();
  };
  window.addEventListener('error', function (event) {
    if (!ready) window.__bunnyBootFailed(event.error || event.message);
  });
  window.addEventListener('unhandledrejection', function (event) {
    if (!ready) window.__bunnyBootFailed(event.reason);
  });
}());
