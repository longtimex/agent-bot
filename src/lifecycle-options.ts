export interface LifecycleOptions {
  systemd: boolean
  userSystemd: boolean
  docker: boolean
  setup: boolean
  skipDeps: boolean
  skipBuild: boolean
  opencode: boolean
  requireOpencode: boolean
  keepData: boolean
  purgeData: boolean
  yes: boolean
  dryRun: boolean
  apply: boolean
}

export function parseLifecycleOptions(argv: string[]): {
  command: string
  args: string[]
  options: LifecycleOptions
} {
  const args: string[] = []
  const options: LifecycleOptions = {
    systemd: false,
    userSystemd: false,
    docker: false,
    setup: false,
    skipDeps: false,
    skipBuild: false,
    opencode: true,
    requireOpencode: false,
    keepData: true,
    purgeData: false,
    yes: false,
    dryRun: false,
    apply: false,
  }
  for (const arg of argv) {
    if (arg === "--systemd") options.systemd = true
    else if (arg === "--user-systemd") options.userSystemd = true
    else if (arg === "--docker") options.docker = true
    else if (arg === "--setup") options.setup = true
    else if (arg === "--skip-deps") options.skipDeps = true
    else if (arg === "--skip-build") options.skipBuild = true
    else if (arg === "--no-opencode") options.opencode = false
    else if (arg === "--require-opencode") options.requireOpencode = true
    else if (arg === "--keep-data") {
      options.keepData = true
      options.purgeData = false
    }
    else if (arg === "--purge-data") {
      options.keepData = false
      options.purgeData = true
    } else if (arg === "--yes" || arg === "-y") options.yes = true
    else if (arg === "--dry-run") options.dryRun = true
    else if (arg === "--apply") options.apply = true
    // Keep unknown flags available to subcommands such as `setup --check-tools`.
    // Recognised lifecycle flags are consumed above and never reach the command.
    else args.push(arg)
  }
  return { command: args.shift() ?? "help", args, options }
}
