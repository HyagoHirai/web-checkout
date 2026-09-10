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
  const value = env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function intOr(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = env[name];
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer, got ${JSON.stringify(value)}`);
  return parsed;
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
