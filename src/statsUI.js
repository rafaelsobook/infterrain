const HAS_RAM = typeof performance !== 'undefined' && performance.memory != null

export function createStatsUI(engine, scene, chunks, verts) {
  const style = document.createElement('style')
  style.textContent = `
    #inf-stats{position:fixed;top:12px;right:12px;background:rgba(0,0,0,.65);color:#bbb;font:11px/1.8 monospace;padding:8px 14px;border-radius:4px;pointer-events:none;z-index:9999;min-width:160px}
    #inf-stats .s-title{color:#666;font-size:10px;letter-spacing:2px;margin-bottom:2px}
    #inf-stats .s-row{display:flex;justify-content:space-between;gap:24px}
    .inf-ok{color:#4f4}.inf-warn{color:#fa4}.inf-bad{color:#f44}
  `
  document.head.appendChild(style)

  const panel = document.createElement('div')
  panel.id = 'inf-stats'
  panel.innerHTML = `
    <div class="s-title">PERF</div>
    <div class="s-row"><span>FPS</span>      <span id="inf-fps">—</span></div>
    <div class="s-row"><span>VERTICES</span> <span id="inf-verts">—</span></div>
    <div class="s-row"><span>CHUNKS</span>   <span id="inf-chunks">—</span></div>
    <div class="s-row"><span>RAM</span>      <span id="inf-ram">${HAS_RAM ? '—' : 'N/A'}</span></div>
  `
  document.body.appendChild(panel)

  const $fps    = document.getElementById('inf-fps')
  const $verts  = document.getElementById('inf-verts')
  const $chunks = document.getElementById('inf-chunks')
  const $ram    = document.getElementById('inf-ram')

  function fmt(n) {
    return n >= 1_000_000 ? (n / 1_000_000).toFixed(2) + 'M'
         : n >= 1_000     ? (n / 1_000).toFixed(0)     + 'K'
         : String(n)
  }

  let frame = 0
  scene.onAfterRenderObservable.add(() => {
    if (++frame % 20 !== 0) return
    const fps = engine.getFps()
    $fps.textContent = fps.toFixed(0)
    $fps.className   = fps >= 50 ? 'inf-ok' : fps >= 30 ? 'inf-warn' : 'inf-bad'

    $verts.textContent  = fmt(chunks.size * verts * verts)
    $chunks.textContent = chunks.size

    if (HAS_RAM)
      $ram.textContent = (performance.memory.usedJSHeapSize / 1048576).toFixed(0) + ' MB'
  })
}
