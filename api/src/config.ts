import { SIMULATED_OUTCOMES, type SimulatedOutcome } from '../../shared/wire.ts';

export interface Config {
  databaseUrl: string;
  port: number;
  logLevel: string;
  simulatorDefaultOutcome: SimulatedOutcome;
  simulatorAcceptClientHint: boolean;
  simulatorLatencyMs: number;
}


function required(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}

function intOr(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const v = env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer, got ${JSON.stringify(v)}`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const outcome = (env.SIMULATOR_DEFAULT_OUTCOME ?? 'success') as SimulatedOutcome;
  if (!SIMULATED_OUTCOMES.includes(outcome)) {
    throw new Error(`SIMULATOR_DEFAULT_OUTCOME must be one of ${SIMULATED_OUTCOMES.join(', ')}, got ${JSON.stringify(outcome)}`);
  }
  const hint = env.SIMULATOR_CLIENT_HINT ?? 'allow';
  if (hint !== 'allow' && hint !== 'ignore') {
    throw new Error(`SIMULATOR_CLIENT_HINT must be "allow" or "ignore", got ${JSON.stringify(hint)}`);
  }
  return {
    databaseUrl: required(env, 'DATABASE_URL'),
    port: intOr(env, 'PORT', 3000),
    logLevel: env.LOG_LEVEL ?? 'info',
    simulatorDefaultOutcome: outcome,
    simulatorAcceptClientHint: hint === 'allow',
    simulatorLatencyMs: intOr(env, 'SIMULATOR_LATENCY_MS', 0),
  };
}
