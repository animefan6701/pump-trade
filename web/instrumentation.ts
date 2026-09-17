export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startIngestScheduler } = await import("./lib/scheduler");
    startIngestScheduler();
  }
}
