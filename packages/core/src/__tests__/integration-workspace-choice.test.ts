/**
 * Which workspace a Slack human-assistance gate should address.
 *
 * Slack lives on a real OAuth connection owned by one of the operator's
 * registered workspaces. A run's provisioned workspace is a throwaway for agent
 * file scope and has no integrations, so asking it to post a Slack question can
 * never work — that was the actual cause of a gate that parked forever.
 */
import { describe, it, expect } from 'vitest';
import { chooseIntegrationWorkspace } from '../runner.js';

const REGISTRY = { defaultId: 'rw_7ccfea89', ids: ['rw_7ccfea89', 'rw_31684d8c', 'rw_fc7b534b'] };

describe('chooseIntegrationWorkspace', () => {
  it('redirects an unregistered (provisioned) workspace to the registered default', () => {
    // rw_84e3ff6b is the per-run workspace; it is absent from workspaces.json.
    const choice = chooseIntegrationWorkspace({
      resolvedWorkspaceId: 'rw_84e3ff6b',
      registry: REGISTRY,
    });
    expect(choice.workspaceId).toBe('rw_7ccfea89');
    expect(choice.reason).toContain('rw_84e3ff6b');
    expect(choice.reason).toContain('no Slack integration');
    // The operator needs to know how to override the decision.
    expect(choice.reason).toContain('integrations.relayfile.workspaceId');
  });

  it('keeps a workspace that is registered', () => {
    const choice = chooseIntegrationWorkspace({
      resolvedWorkspaceId: 'rw_31684d8c',
      registry: REGISTRY,
    });
    expect(choice.workspaceId).toBe('rw_31684d8c');
    expect(choice.reason).toBeUndefined();
  });

  it('an explicitly configured workspace always wins, even if unregistered', () => {
    // Naming a workspace is a decision, not a guess to second-guess.
    const choice = chooseIntegrationWorkspace({
      resolvedWorkspaceId: 'rw_84e3ff6b',
      configuredWorkspaceId: 'rw_deliberate',
      registry: REGISTRY,
    });
    expect(choice.workspaceId).toBe('rw_deliberate');
    expect(choice.reason).toBeUndefined();
  });

  it('is a no-op with no registry — headless and cloud runs keep their workspace', () => {
    // There is no ~/.relayfile/workspaces.json in cloud; the deploy's workspace
    // is the integration-owning one already.
    const choice = chooseIntegrationWorkspace({ resolvedWorkspaceId: 'rw_cloud_deploy' });
    expect(choice.workspaceId).toBe('rw_cloud_deploy');
    expect(choice.reason).toBeUndefined();
  });

  it('is a no-op when the registry records no default', () => {
    const choice = chooseIntegrationWorkspace({
      resolvedWorkspaceId: 'rw_84e3ff6b',
      registry: { ids: ['rw_a', 'rw_b'] },
    });
    expect(choice.workspaceId).toBe('rw_84e3ff6b');
    expect(choice.reason).toBeUndefined();
  });

  it('does not redirect a workspace that already IS the default but is missing from ids', () => {
    // Duplicate/absent id entries are common in workspaces.json; matching the
    // default is enough.
    const choice = chooseIntegrationWorkspace({
      resolvedWorkspaceId: 'rw_7ccfea89',
      registry: { defaultId: 'rw_7ccfea89', ids: [] },
    });
    expect(choice.workspaceId).toBe('rw_7ccfea89');
    expect(choice.reason).toBeUndefined();
  });

  it('ignores a blank configured workspace rather than treating it as a choice', () => {
    const choice = chooseIntegrationWorkspace({
      resolvedWorkspaceId: 'rw_84e3ff6b',
      configuredWorkspaceId: '   ',
      registry: REGISTRY,
    });
    expect(choice.workspaceId).toBe('rw_7ccfea89');
  });

  it('trims a configured workspace id', () => {
    const choice = chooseIntegrationWorkspace({
      resolvedWorkspaceId: 'rw_x',
      configuredWorkspaceId: '  rw_padded  ',
    });
    expect(choice.workspaceId).toBe('rw_padded');
  });
});
