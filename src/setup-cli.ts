import { setupFromCli } from "./setup.js"

setupFromCli()
  .then((result) => {
    process.exitCode = result.ok ? 0 : 1
  })
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err)
    process.exitCode = 1
  })
