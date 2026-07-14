export function padockEnv(name: string): string | undefined {
  return process.env[`PADOCK_${name}`] ?? process.env[`PANELMC_${name}`];
}
