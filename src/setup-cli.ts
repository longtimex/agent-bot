import { setupFromCli } from "./setup.js"

setupFromCli()
  .then((result) => {
    process.exitCode = result.ok ? 0 : 1
  })
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  })
