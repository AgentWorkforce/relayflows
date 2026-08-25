import { describe, expect, it, vi } from 'vitest';
import {
  HarnessBrokerTransport,
  resolveBrokerTransportMode,
  type BrokerTransportPort,
} from '../broker-transport.js';
import { WorkflowRunner } from '../runner.js';

describe('broker transport selection', () => {
  it('defaults to legacy mode', () => {
    expect(resolveBrokerTransportMode(undefined, {})).toBe('legacy');
    const runner = new WorkflowRunner();
    expect((runner as any).brokerTransport).toBeInstanceOf(HarnessBrokerTransport);
    expect((runner as any).brokerTransport.mode).toBe('legacy');
  });

  it('prefers the per-run selector over the environment selector', () => {
    const runner = new WorkflowRunner({
      brokerTransportMode: 'shadow',
      relay: { env: { RELAYFLOWS_INTEGRATION_TRANSPORT: 'adapter' } },
    });
    expect((runner as any).brokerTransport.mode).toBe('shadow');
  });

  it('uses the rollout environment selector when no per-run selector is supplied', () => {
    const runner = new WorkflowRunner({
      relay: { env: { RELAYFLOWS_INTEGRATION_TRANSPORT: 'adapter' } },
    });
    expect((runner as any).brokerTransport.mode).toBe('adapter');
  });

  it('prefers an explicitly injected port over both selectors', () => {
    const explicit = { mode: 'legacy', shutdown: vi.fn() } as unknown as BrokerTransportPort;
    const runner = new WorkflowRunner({
      brokerTransport: explicit,
      brokerTransportMode: 'shadow',
      relay: { env: { RELAYFLOWS_INTEGRATION_TRANSPORT: 'adapter' } },
    });
    expect((runner as any).brokerTransport).toBe(explicit);
  });

  it('rejects an invalid rollout selector', () => {
    expect(() =>
      resolveBrokerTransportMode(undefined, { RELAYFLOWS_INTEGRATION_TRANSPORT: 'invalid' })
    ).toThrow('Invalid broker transport mode');
  });
});
