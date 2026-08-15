/**
 * A WorkSource backed by the agent-ticket-system HTTP API.
 *
 * Claiming takes two calls upstream — one to win the work, one to fetch the sealed
 * version it won — and that seam is this adapter's problem, not the engine's. The
 * engine asked for a claim and gets a claim.
 */
import type {
  Checkpoint,
  Claim,
  Evidence,
  Verdict,
  WorkItemState,
  WorkSource,
} from '../../ports/work-source.ts';

import { parseContract } from './wire.ts';

export interface TicketSystemOptions {
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
}

interface ClaimResponse {
  runId: string;
  versionId: string;
  attempt: number;
}

class RequestFailed extends Error {
  constructor(method: string, path: string, status: number, body: string) {
    super(`${method} ${path} failed with ${status}: ${body.slice(0, 400)}`);
    this.name = 'RequestFailed';
  }
}

function join(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

export function ticketSystemSource(options: TicketSystemOptions): WorkSource {
  const http = options.fetch ?? globalThis.fetch;

  async function request(method: string, path: string, body?: unknown): Promise<unknown> {
    const init: RequestInit = { method, headers: { 'content-type': 'application/json' } };
    if (body !== undefined) init.body = JSON.stringify(body);
    const response = await http(join(options.baseUrl, path), init);
    const text = await response.text();
    if (!response.ok) throw new RequestFailed(method, path, response.status, text);
    return text ? JSON.parse(text) : undefined;
  }

  async function contractFor(versionId: string) {
    return parseContract(await request('GET', `/v1/contract-versions/${versionId}`));
  }

  return {
    async listReady(): Promise<string[]> {
      const body = (await request('GET', '/v1/work-items')) as { workItems?: { contractId: string }[] };
      return (body.workItems ?? []).map((item) => item.contractId);
    },

    async stateOf(contractId: string): Promise<WorkItemState | undefined> {
      try {
        const body = (await request('GET', `/v1/work-items/${contractId}`)) as { state?: WorkItemState };
        return body.state;
      } catch {
        return undefined;
      }
    },

    /**
     * A run is spent once it has an outcome. The live one, if there is a live
     * one, is the caller's own claim in progress and is not history yet.
     */
    async attemptsSpent(contractId: string): Promise<number> {
      const body = (await request('GET', `/v1/work-items/${contractId}`)) as { runs?: { outcome?: string }[] };
      return (body.runs ?? []).filter((run) => run.outcome !== undefined).length;
    },

    async claim(contractId: string, agent: string): Promise<Claim> {
      const claimed = (await request('POST', `/v1/work-items/${contractId}/claim`, { agent })) as ClaimResponse;
      return { runId: claimed.runId, contract: await contractFor(claimed.versionId) };
    },

    async heartbeat(runId: string): Promise<void> {
      await request('POST', `/v1/runs/${runId}/heartbeat`);
    },

    async checkpoint(runId: string, checkpoint: Checkpoint): Promise<void> {
      await request('POST', `/v1/runs/${runId}/checkpoints`, {
        step: checkpoint.step,
        summary: checkpoint.summary,
        payload: checkpoint.payload ?? {},
      });
    },

    async submit(runId: string, evidence: Evidence[]): Promise<Verdict> {
      return (await request('POST', `/v1/runs/${runId}/submit`, { evidence })) as Verdict;
    },

    async fail(runId: string): Promise<void> {
      await request('POST', `/v1/runs/${runId}/fail`);
    },
  };
}
