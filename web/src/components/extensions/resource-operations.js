/**
 * Create a config file after ensuring its parent directory exists.
 *
 * The user-config API creates directories recursively, so this works for both
 * top-level resources (agents/example.md) and nested skill files
 * (skills/example/scripts/check.sh).
 */
export async function createConfigFile(userConfig, path, content = '') {
  const parent = String(path).split('/').slice(0, -1).join('/')
  if (parent) await userConfig.mkdir(parent)
  await userConfig.create(path, content)
  return path
}
