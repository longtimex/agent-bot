import { runToolWizardCli } from "./install-tools-cli.js"

runToolWizardCli()
  .then((code) => {
    process.exitCode = code
  })
  .catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    process.exitCode = 1
  })
