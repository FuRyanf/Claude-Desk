export type ContextPack = 'Minimal' | 'Git Diff' | 'Debug';

export interface Workspace {
  id: string;
  name: string;
  path: string;
  createdAt: string;
  updatedAt: string;
}

export interface ThreadMetadata {
  id: string;
  workspaceId: string;
  agentId: string;
  fullAccess: boolean;
  enabledSkills: string[];
  createdAt: string;
  updatedAt: string;
  title: string;
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

export interface Settings {
  claudeCliPath?: string | null;
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
}

export interface TerminalDataEvent {
  sessionId: string;
  data: string;
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
