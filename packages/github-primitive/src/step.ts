import type { GitHubActionName, GitHubActionParamsMap, GitHubRuntimeConfig, RepositoryRef } from './types.js';

type RepoParamKeys = 'owner' | 'repo';
type ParamsFor<TName extends GitHubActionName> = TName extends keyof GitHubActionParamsMap
  ? GitHubActionParamsMap[TName]
  : Record<string, unknown>;
type StripRepoParams<TParams> = Omit<TParams, Extract<keyof TParams, RepoParamKeys>> &
  Partial<Pick<TParams, Extract<keyof TParams, RepoParamKeys>>>;

export type GitHubStepOutputMode = 'data' | 'result' | 'summary' | 'raw' | 'none';
export type GitHubStepOutputFormat = 'json' | 'text';

export type GitHubStepParams<TName extends GitHubActionName = GitHubActionName> = [
  NonNullable<ParamsFor<TName>>,
] extends [never]
  ? Record<string, unknown>
  : StripRepoParams<NonNullable<ParamsFor<TName>>>;

export interface GitHubStepOutputConfig {
  mode?: GitHubStepOutputMode;
  format?: GitHubStepOutputFormat;
  path?: string;
  includeMetadata?: boolean;
  includeRuntime?: boolean;
  pretty?: boolean;
}

export interface GitHubStepConfig<TName extends GitHubActionName = GitHubActionName> {
  name: string;
  dependsOn?: string[];
  action: TName;
  repo?: string | RepositoryRef;
  params?: GitHubStepParams<TName>;
  config?: GitHubRuntimeConfig;
  output?: GitHubStepOutputConfig;
  timeoutMs?: number;
  retries?: number;
}

export interface GitHubWorkflowStep {
  name: string;
  type: 'integration';
  integration: 'github';
  action: string;
  params: Record<string, string>;
  dependsOn?: string[];
  timeoutMs?: number;
  retries?: number;
}

function repoToString(repo: string | RepositoryRef): string {
  return typeof repo === 'string' ? repo : `${repo.owner}/${repo.repo}`;
}

export function createGitHubStep<TName extends GitHubActionName>(
  config: GitHubStepConfig<TName>
): GitHubWorkflowStep {
  const params: Record<string, string> = {};

  if (config.repo !== undefined) params.repo = repoToString(config.repo);
  if (config.params !== undefined) params.params = JSON.stringify(config.params);
  if (config.config !== undefined) params.config = JSON.stringify(config.config);
  if (config.output !== undefined) params.output = JSON.stringify(config.output);

  const step: GitHubWorkflowStep = {
    name: config.name,
    type: 'integration',
    integration: 'github',
    action: config.action,
    params,
  };

  if (config.dependsOn !== undefined) step.dependsOn = config.dependsOn;
  if (config.timeoutMs !== undefined) step.timeoutMs = config.timeoutMs;
  if (config.retries !== undefined) step.retries = config.retries;

  return step;
}
