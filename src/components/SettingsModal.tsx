import { useEffect, useState } from 'react';

import type { AppearanceMode } from '../types';

interface SettingsModalProps {
  open: boolean;
  initialCliPath: string;
  initialAppearanceMode: AppearanceMode;
  initialDefaultNewThreadFullAccess: boolean;
  initialTaskCompletionAlerts: boolean;
  detectedCliPath?: string | null;
  copyEnvDiagnosticsDisabled?: boolean;
  onClose: () => void;
  onSave: (settings: {
    cliPath: string;
    appearanceMode: AppearanceMode;
    defaultNewThreadFullAccess: boolean;
    taskCompletionAlerts: boolean;
  }) => void;
  onCopyEnvDiagnostics?: () => void | Promise<void>;
  onSendTestAlert?: () => void | Promise<void>;
  testAlertDisabled?: boolean;
}

const APPEARANCE_OPTIONS: Array<{ value: AppearanceMode; label: string; description: string }> = [
  {
    value: 'system',
    label: 'System',
    description: 'Default. Follow the current macOS appearance automatically.'
  },
  {
    value: 'light',
    label: 'Light',
    description: 'Brighter chrome while keeping terminal contrast readable.'
  },
  {
    value: 'dark',
    label: 'Dark',
    description: 'Calm, low-glare shell surfaces built for long terminal sessions.'
  }
];

export function SettingsModal({
  open,
  initialCliPath,
  initialAppearanceMode,
  initialDefaultNewThreadFullAccess,
  initialTaskCompletionAlerts,
  detectedCliPath,
  copyEnvDiagnosticsDisabled = false,
  onClose,
  onSave,
  onCopyEnvDiagnostics,
  onSendTestAlert,
  testAlertDisabled = false
}: SettingsModalProps) {
  const [cliPath, setCliPath] = useState(initialCliPath);
  const [appearanceMode, setAppearanceMode] = useState<AppearanceMode>(initialAppearanceMode);
  const [defaultNewThreadFullAccess, setDefaultNewThreadFullAccess] = useState(initialDefaultNewThreadFullAccess);
  const [taskCompletionAlerts, setTaskCompletionAlerts] = useState(initialTaskCompletionAlerts);

  useEffect(() => {
    if (!open) {
      return;
    }
    setCliPath(initialCliPath);
    setAppearanceMode(initialAppearanceMode);
    setDefaultNewThreadFullAccess(initialDefaultNewThreadFullAccess);
    setTaskCompletionAlerts(initialTaskCompletionAlerts);
  }, [initialAppearanceMode, initialCliPath, initialDefaultNewThreadFullAccess, initialTaskCompletionAlerts, open]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const handleWindowKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) {
        return;
      }
      event.preventDefault();
      onClose();
    };

    window.addEventListener('keydown', handleWindowKeyDown);
    return () => {
      window.removeEventListener('keydown', handleWindowKeyDown);
    };
  }, [onClose, open]);

  if (!open) {
    return null;
  }

  return (
    <div className="modal-backdrop">
      <section className="modal settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header className="settings-modal-header">
          <div>
            <h2 id="settings-title">Settings</h2>
            <p>Keep appearance and Claude CLI configuration in one place.</p>
          </div>
        </header>

        <div className="settings-sections">
          <section className="settings-section">
            <div className="settings-section-copy">
              <h3>Display</h3>
              <p>Choose how Claude Desk appears. System appearance is the default.</p>
            </div>

            <div className="appearance-toggle-group" role="radiogroup" aria-label="Appearance mode">
              {APPEARANCE_OPTIONS.map((option) => {
                const active = appearanceMode === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    className={active ? 'appearance-toggle-option active' : 'appearance-toggle-option'}
                    onClick={() => setAppearanceMode(option.value)}
                  >
                    <span className="appearance-toggle-label">{option.label}</span>
                    <span className="appearance-toggle-description">{option.description}</span>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="settings-section">
            <div className="settings-section-copy">
              <h3>Claude</h3>
              <p>Set the Claude CLI binary path Claude Desk should launch.</p>
            </div>

            <div className="settings-field-group">
              <label htmlFor="cli-path">Claude path</label>
              <input
                id="cli-path"
                type="text"
                placeholder="/opt/homebrew/bin/claude"
                value={cliPath}
                onChange={(event) => setCliPath(event.target.value)}
              />

              <div className="settings-field-hint-row">
                {detectedCliPath ? <p className="muted">Detected path: {detectedCliPath}</p> : <span />}
                {detectedCliPath && detectedCliPath !== cliPath.trim() ? (
                  <button type="button" className="ghost-button settings-inline-button" onClick={() => setCliPath(detectedCliPath)}>
                    Use detected path
                  </button>
                ) : null}
              </div>
            </div>

            <div className="settings-toggle-row">
              <div className="settings-toggle-copy">
                <span id="settings-default-full-access-title" className="settings-toggle-title">
                  Start new threads with Full access
                </span>
                <span id="settings-default-full-access-description" className="settings-toggle-description">
                  When enabled, the main new-thread action creates a full-access thread by default.
                </span>
              </div>
              <button
                type="button"
                role="switch"
                aria-labelledby="settings-default-full-access-title"
                aria-describedby="settings-default-full-access-description"
                aria-checked={defaultNewThreadFullAccess}
                className={defaultNewThreadFullAccess ? 'settings-switch active' : 'settings-switch'}
                onClick={() => setDefaultNewThreadFullAccess((current) => !current)}
              >
                <span className="settings-switch-track">
                  <span className="settings-switch-thumb" />
                </span>
                <span className="settings-switch-label">{defaultNewThreadFullAccess ? 'On' : 'Off'}</span>
              </button>
            </div>
          </section>

          <section className="settings-section">
            <div className="settings-section-copy">
              <h3>Alerts</h3>
              <p>Opt in to completion alerts for long-running tasks.</p>
            </div>

            <div className="settings-toggle-row">
              <div className="settings-toggle-copy">
                <span id="settings-task-completion-alerts-title" className="settings-toggle-title">
                  Task completion alerts
                </span>
                <span id="settings-task-completion-alerts-description" className="settings-toggle-description">
                  Show a desktop notification and play a sound when Claude finishes a task.
                </span>
              </div>
              <button
                type="button"
                role="switch"
                aria-labelledby="settings-task-completion-alerts-title"
                aria-describedby="settings-task-completion-alerts-description"
                aria-checked={taskCompletionAlerts}
                className={taskCompletionAlerts ? 'settings-switch active' : 'settings-switch'}
                onClick={() => setTaskCompletionAlerts((current) => !current)}
              >
                <span className="settings-switch-track">
                  <span className="settings-switch-thumb" />
                </span>
                <span className="settings-switch-label">{taskCompletionAlerts ? 'On' : 'Off'}</span>
              </button>
            </div>
          </section>
        </div>

        <footer className="modal-actions settings-modal-actions">
          <button
            type="button"
            className="ghost-button"
            onClick={() => void onCopyEnvDiagnostics?.()}
            disabled={copyEnvDiagnosticsDisabled}
          >
            Copy terminal env diagnostics
          </button>
          <button
            type="button"
            className="ghost-button"
            onClick={() => void onSendTestAlert?.()}
            disabled={!initialTaskCompletionAlerts || !taskCompletionAlerts || testAlertDisabled}
          >
            Send test alert
          </button>
          <div className="settings-modal-actions-right">
            <button type="button" className="ghost-button" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="primary-button"
              onClick={() =>
                onSave({
                  cliPath: cliPath.trim(),
                  appearanceMode,
                  defaultNewThreadFullAccess,
                  taskCompletionAlerts
                })
              }
            >
              Save
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}
