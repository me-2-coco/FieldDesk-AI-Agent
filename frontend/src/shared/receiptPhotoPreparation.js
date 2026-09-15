// Start compression at selection time, but keep uploads and receipt confirmation
// behind the explicit submit action. Serial work bounds mobile canvas memory.
export function createReceiptPhotoPreparation(optimize) {
  const cache = new WeakMap()
  let tail = Promise.resolve()
  return {
    prepare(file) {
      if (!cache.has(file)) {
        const prepared = tail.then(() => optimize(file)).catch(() => file)
        cache.set(file, prepared)
        tail = prepared.then(() => undefined)
      }
      return cache.get(file)
    }
  }
}
