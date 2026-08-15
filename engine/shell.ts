/**
 * Running a declared command and reporting what happened.
 *
 * Every gate verdict in this engine ultimately comes from an exit code produced
 * here. Nothing interprets the output — a gate that passed is a process that
 * returned zero, which is the only claim about a codebase the engine makes
 * without asking a model.
 */
import { spawn } from 'node:child_process';

export interface CommandResult {
  exitCode: number;
  output: string;
}

export interface RunOptions {
  cwd: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

/** Enough tail to diagnose a failure without carrying a whole test run into a prompt. */
const OUTPUT_TAIL_LIMIT = 8_000;

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1_000;

function tail(text: string): string {
  if (text.length <= OUTPUT_TAIL_LIMIT) return text;
  return `…(${text.length - OUTPUT_TAIL_LIMIT} earlier characters omitted)\n${text.slice(-OUTPUT_TAIL_LIMIT)}`;
}

export interface CommandRunner {
  run(command: string, options: RunOptions): Promise<CommandResult>;
}

/**
 * SAFETY: a command that is killed on timeout reports a non-zero exit code rather
 * than whatever it had written so far. A hung gate is a gate that did not pass.
 */
export const shellRunner: CommandRunner = {
  run(command, options) {
    return new Promise((resolve) => {
      const child = spawn('bash', ['-c', command], {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let collected = '';
      const absorb = (chunk: Buffer): void => {
        collected = tail(collected + chunk.toString('utf8'));
      };
      child.stdout.on('data', absorb);
      child.stderr.on('data', absorb);

      const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      const settle = (exitCode: number): void => {
        clearTimeout(timer);
        resolve({ exitCode, output: tail(collected) });
      };
      // A command that could not start is a failure, not an absent result.
      child.on('error', () => settle(127));
      child.on('close', (code, signal) => settle(signal ? 137 : (code ?? 1)));
    });
  },
};

/** Whether the executable a command starts with can be found on this host. */
export async function canRun(command: string, runner: CommandRunner, cwd: string): Promise<boolean> {
  const first = command.trim().split(/\s+/)[0];
  if (!first) return false;
  const probe = await runner.run(`command -v ${JSON.stringify(first)} >/dev/null 2>&1`, { cwd, timeoutMs: 10_000 });
  return probe.exitCode === 0;
}
