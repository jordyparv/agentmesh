/**
 * Builds the environment for agent and validation processes from an allow-list.
 * Worker secrets (DATABASE_URL, API tokens, unrelated provider keys) never leak.
 */
const BASE_ALLOW = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TZ", "SHELL"];

export interface EnvResult {
  env: Record<string, string>;
  /** Secret values injected, so the redactor can scrub them from logs. */
  secretValues: string[];
  missingSecrets: string[];
}

export function buildAgentEnv(opts: { source?: NodeJS.ProcessEnv; secretEnv?: string[]; extra?: Record<string, string> } = {}): EnvResult {
  const src = opts.source ?? process.env;
  const env: Record<string, string> = { TERM: "dumb", NO_COLOR: "1", CI: "1" };
  for (const k of BASE_ALLOW) {
    const v = src[k];
    if (v !== undefined) env[k] = v;
  }
  const secretValues: string[] = [];
  const missingSecrets: string[] = [];
  for (const k of opts.secretEnv ?? []) {
    const v = src[k];
    if (v === undefined) missingSecrets.push(k);
    else {
      env[k] = v;
      secretValues.push(v);
    }
  }
  Object.assign(env, opts.extra ?? {});
  return { env, secretValues, missingSecrets };
}
