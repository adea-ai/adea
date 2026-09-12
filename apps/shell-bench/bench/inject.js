// Ready + workspace-coverage beacon injected into the served client.
// Phase 1: NavigationTiming on load -> POST /__bench/ready
// Phase 2: wait for the guest workspace to boot -> click "Virtual view" ->
//          wait for the agent-sim engine element -> POST /__bench/workspace
// Pure browser JS, no dependencies.
;(function () {
  function post(path, payload) {
    try {
      return fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true,
      })
    } catch (e) {
      return Promise.resolve()
    }
  }

  function navPayload() {
    var nav = performance.getEntriesByType('navigation')[0]
    return {
      performanceNowMs: Math.round(performance.now()),
      domContentLoadedEventEndMs: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
      loadEventEndMs: nav ? Math.round(nav.loadEventEnd) : null,
      title: document.title,
      url: location.href,
    }
  }

  function sendReady() {
    post('/__bench/ready', navPayload())
  }

  function workspaceBooted() {
    var main = document.querySelector('main.conventional-workspace')
    return main && !main.classList.contains('conventional-workspace--loading')
  }

  function poll(predicate, intervalMs, timeoutMs) {
    return new Promise(function (resolve) {
      var started = performance.now()
      var timer = setInterval(function () {
        var value = predicate()
        if (value || performance.now() - started > timeoutMs) {
          clearInterval(timer)
          resolve(value)
        }
      }, intervalMs)
    })
  }

  function sendWorkspace() {
    var bootedMs = Math.round(performance.now())
    var toggle = document.querySelector('[aria-label="Virtual view"]')
    if (toggle) {
      try {
        toggle.click()
      } catch (e) {
        /* keep going */
      }
    }
    poll(
      function () {
        return document.querySelector('.virtual-view-engine')
      },
      250,
      15000
    ).then(function () {
      post('/__bench/workspace', {
        bootedMs: bootedMs,
        virtualMs: Math.round(performance.now()),
        virtualEnginePresent: !!document.querySelector('.virtual-view-engine'),
      })
    })
  }

  if (document.readyState === 'complete') {
    setTimeout(sendReady, 0)
  } else {
    window.addEventListener('load', function () {
      setTimeout(sendReady, 0)
    })
  }
  poll(workspaceBooted, 250, 60000).then(function (booted) {
    if (booted) sendWorkspace()
  })
})()
