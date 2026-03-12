import { useEffect, useMemo } from 'react';

import type { ImportableClaudeProject, ImportableClaudeSession } from '../types';

interface BulkImportClaudeSessionsModalProps {
  open: boolean;
  loading?: boolean;
  importing?: boolean;
  projects: ImportableClaudeProject[];
  selectedSessionIds: string[];
  alreadyImportedSessionIds: string[];
  error?: string | null;
  onClose: () => void;
  onRefresh: () => void;
  onToggleSession: (sessionId: string, selected: boolean) => void;
  onToggleProject: (project: ImportableClaudeProject, selected: boolean) => void;
  onImport: () => void;
}

function projectStatusLabel(project: ImportableClaudeProject) {
  if (!project.pathExists) {
    return 'Folder missing';
  }
  if (project.workspaceId) {
    return 'Project already added';
  }
  return 'Will add project';
}

function sessionTitle(session: ImportableClaudeSession) {
  return session.summary?.trim() || session.firstPrompt?.trim() || 'Untitled Claude session';
}

function sessionSubtitle(session: ImportableClaudeSession) {
  const firstPrompt = session.firstPrompt?.trim();
  const summary = session.summary?.trim();
  if (!firstPrompt || firstPrompt === summary) {
    return null;
  }
  return firstPrompt;
}

function formatTimestamp(value?: string | null) {
  if (!value) {
    return null;
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return null;
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(timestamp);
}

export function BulkImportClaudeSessionsModal({
  open,
  loading = false,
  importing = false,
  projects,
  selectedSessionIds,
  alreadyImportedSessionIds,
  error,
  onClose,
  onRefresh,
  onToggleSession,
  onToggleProject,
  onImport
}: BulkImportClaudeSessionsModalProps) {
  const selectedSet = useMemo(() => new Set(selectedSessionIds), [selectedSessionIds]);
  const importedSet = useMemo(() => new Set(alreadyImportedSessionIds), [alreadyImportedSessionIds]);
  const selectedCount = selectedSessionIds.length;

  useEffect(() => {
    if (!open) {
      return;
    }

    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) {
        return;
      }
      event.preventDefault();
      onClose();
    };

    window.addEventListener('keydown', onWindowKeyDown);
    return () => window.removeEventListener('keydown', onWindowKeyDown);
  }, [onClose, open]);

  if (!open) {
    return null;
  }

  return (
    <div className="modal-backdrop">
      <section className="modal bulk-import-modal" role="dialog" aria-modal="true" aria-labelledby="bulk-import-title">
        <header className="bulk-import-modal-header">
          <div>
            <h2 id="bulk-import-title">Bulk Import Claude Sessions</h2>
            <p>Discover Claude’s local session history, pick the conversations you want, and import them as threads.</p>
          </div>
          <button type="button" className="ghost-button settings-inline-button" onClick={onRefresh} disabled={loading || importing}>
            Refresh
          </button>
        </header>

        <div className="bulk-import-toolbar">
          <p className="muted">
            {selectedCount === 0 ? 'No sessions selected.' : `${selectedCount} session${selectedCount === 1 ? '' : 's'} selected.`}
          </p>
        </div>

        {error ? <p className="modal-error">{error}</p> : null}

        {loading ? <div className="bulk-import-empty">Scanning Claude session history…</div> : null}

        {!loading && projects.length === 0 ? (
          <div className="bulk-import-empty">
            No Claude sessions were found under <code>~/.claude/projects</code>.
          </div>
        ) : null}

        {!loading && projects.length > 0 ? (
          <div className="bulk-import-project-list">
            {projects.map((project) => {
              const importableSessionIds = project.sessions
                .filter((session) => project.pathExists && !importedSet.has(session.sessionId))
                .map((session) => session.sessionId);
              const selectedInProject = importableSessionIds.filter((sessionId) => selectedSet.has(sessionId)).length;
              const allSelected = importableSessionIds.length > 0 && selectedInProject === importableSessionIds.length;

              return (
                <section key={project.path} className="bulk-import-project">
                  <header className="bulk-import-project-header">
                    <div className="bulk-import-project-copy">
                      <div className="bulk-import-project-title-row">
                        <h3>{project.name}</h3>
                        <span className={project.pathExists ? 'bulk-import-project-status' : 'bulk-import-project-status warning'}>
                          {projectStatusLabel(project)}
                        </span>
                      </div>
                      <p className="bulk-import-project-path">{project.path}</p>
                      {project.workspaceName ? (
                        <p className="bulk-import-project-helper">Imports into {project.workspaceName}.</p>
                      ) : (
                        <p className="bulk-import-project-helper">Imports will add this project first.</p>
                      )}
                    </div>
                    <button
                      type="button"
                      className="ghost-button settings-inline-button"
                      onClick={() => onToggleProject(project, !allSelected)}
                      disabled={importing || importableSessionIds.length === 0}
                    >
                      {allSelected ? 'Clear' : 'Select all'}
                    </button>
                  </header>

                  <div className="bulk-import-session-list">
                    {project.sessions.map((session) => {
                      const alreadyImported = importedSet.has(session.sessionId);
                      const disabled = importing || !project.pathExists || alreadyImported;
                      const subtitle = sessionSubtitle(session);
                      const timestamp = formatTimestamp(session.modifiedAt ?? session.createdAt);

                      return (
                        <label
                          key={session.sessionId}
                          className={
                            disabled
                              ? 'bulk-import-session-row disabled'
                              : selectedSet.has(session.sessionId)
                                ? 'bulk-import-session-row selected'
                                : 'bulk-import-session-row'
                          }
                        >
                          <input
                            type="checkbox"
                            checked={selectedSet.has(session.sessionId)}
                            disabled={disabled}
                            onChange={(event) => onToggleSession(session.sessionId, event.target.checked)}
                          />
                          <div className="bulk-import-session-copy">
                            <div className="bulk-import-session-heading">
                              <strong>{sessionTitle(session)}</strong>
                              {timestamp ? <span>{timestamp}</span> : null}
                            </div>
                            {subtitle ? <p className="bulk-import-session-subtitle">{subtitle}</p> : null}
                            <div className="bulk-import-session-meta">
                              <code>{session.sessionId}</code>
                              {session.gitBranch ? <span>{session.gitBranch}</span> : null}
                              {session.messageCount > 0 ? <span>{session.messageCount} msgs</span> : null}
                              {alreadyImported ? <span>Already imported</span> : null}
                            </div>
                          </div>
                        </label>
                      );
                    })}
                  </div>
                </section>
              );
            })}
          </div>
        ) : null}

        <footer className="modal-actions bulk-import-modal-actions">
          <button type="button" className="ghost-button" onClick={onClose} disabled={importing}>
            Cancel
          </button>
          <button
            type="button"
            className="primary-button"
            onClick={onImport}
            disabled={importing || selectedCount === 0}
          >
            {importing
              ? 'Importing…'
              : selectedCount === 0
                ? 'Import selected'
                : `Import selected (${selectedCount})`}
          </button>
        </footer>
      </section>
    </div>
  );
}
