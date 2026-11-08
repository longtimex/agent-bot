import { setupFromCli } from "./setup.js"

setupFromCli()
  .then((result) => {
    // Leaving the menu without changes is a valid no-op for an installer; other
    // failures still return non-zero so automation can report them.
    process.exitCode = result.ok || result.reason === "cancelled" ? 0 : 1
  })
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  })
