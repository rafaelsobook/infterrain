const _queue = []

export function registerPreload(fn) {
  _queue.push(fn)
}

export async function runPreloads(scene) {
  await Promise.all(_queue.map(fn => fn(scene)))
}
