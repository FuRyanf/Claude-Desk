export type RunStatus = 'Idle' | 'Running' | 'Succeeded' | 'Failed' | 'Canceled';
export type ContextPack = 'Minimal' | 'Git Diff' | 'Debug';
export type TerminalSessionMode = 'resumed' | 'new';
export type WorkspaceKind = 'local' | 'rdev' | 'ssh';

export interface Workspace {
  id: string;
  name: string;
  path: string;
  kind?: WorkspaceKind;
  rdevSshCommand?: string | null;
  sshCommand?: string | null;
  remotePath?: string | null;
  gitPullOnMasterForNewThreads: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ThreadMetadata {
  id: string;
  workspaceId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  isArchived: boolean;
  lastRunStatus: RunStatus;
  lastRunStartedAt?: string | null;
  lastRunEndedAt?: string | null;
  agentId: string;
  fullAccess: boolean;
  enabledSkills: string[];
  claudeSessionId?: string | null;
  lastResumeAt?: string | null;
  lastNewSessionAt?: string | null;
}

export interface TranscriptEntry {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
  runId?: string | null;
}

export interface GitInfo {
  branch: string;
  shortHash: string;
  isDirty: boolean;
  ahead: number;
  behind: number;
}

export interface GitBranchEntry {
  name: string;
  isCurrent: boolean;
  lastCommitUnix: number;
}

export interface GitWorkspaceStatus {
  isDirty: boolean;
  uncommittedFiles: number;
  insertions: number;
  deletions: number;
}

export interface GitPullForNewThreadResult {
  outcome: 'pulled' | 'skipped' | 'failed';
  message: string;
}

export interface Settings {
  claudeCliPath?: string | null;
}

export interface AppUpdateInfo {
  currentVersion: string;
  latestVersion?: string | null;
  updateAvailable: boolean;
  releaseUrl?: string | null;
}

export interface SkillInfo {
  id: string;
  name: string;
  description: string;
  entryPoints: string[];
  path: string;
}

export interface ContextFilePreview {
  path: string;
  size: number;
}

export interface ContextPreview {
  files: ContextFilePreview[];
  totalSize: number;
  contextText: string;
}

export interface RunClaudeRequest {
  workspacePath: string;
  threadId: string;
  message: string;
  enabledSkills: string[];
  fullAccess: boolean;
  contextPack: ContextPack;
}

export interface RunClaudeResponse {
  runId: string;
}

export interface TerminalStartResponse {
  sessionId: string;
  sessionMode: TerminalSessionMode;
  resumeSessionId?: string | null;
  thread: ThreadMetadata;
}

export interface TerminalDataEvent {
  sessionId: string;
  threadId?: string;
  data: string;
  sequence?: number;
}

export interface TerminalExitEvent {
  sessionId: string;
  code?: number | null;
  signal?: string | null;
}

export interface RunStreamEvent {
  runId: string;
  threadId: string;
  stream: 'stdout' | 'stderr';
  chunk: string;
}

export interface RunExitEvent {
  runId: string;
  threadId: string;
  exitCode?: number;
  durationMs: number;
}

export interface GitDiffSummary {
  stat: string;
  diffExcerpt: string;
}
