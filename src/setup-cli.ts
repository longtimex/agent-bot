import { parseSetupToolMode, setupFromCli } from "./setup.js"

// `npm run clients` is a client-only maintenance entry point. `npm run setup`
// continues into the optional tool installer after the client configuration.
setupFromCli({ tools: parseSetupToolMode(process.argv.slice(2)) })
  .then((result) => {
    // Leaving the menu without changes is a valid no-op for an installer; other
    // failures still return non-zero so automation can report them.
    process.exitCode = result.ok || result.reason === "cancelled" ? 0 : 1
  })
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  })
