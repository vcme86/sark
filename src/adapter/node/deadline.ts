/** Waits against one absolute deadline without extending the budget between phases. */
export async function waitUntil(work: Promise<unknown>, deadline: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), Math.max(0, deadline - performance.now()))
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
