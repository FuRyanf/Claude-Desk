import { useEffect, useState } from 'react';

import type { AppearanceMode } from '../types';

interface SettingsModalProps {
  open: boolean;
  initialCliPath: string;
  initialAppearanceMode: AppearanceMode;
  detectedCliPath?: string | null;
  onClose: () => void;
  onSave: (settings: { cliPath: string; appearanceMode: AppearanceMode }) => void;
  onCopyEnvDiagnostics?: () => void | Promise<void>;
}

const APPEARANCE_OPTIONS: Array<{ value: AppearanceMode; label: string; description: string }> = [
  {
    value: 'dark',
    label: 'Dark',
    description: 'Default. Calm, low-glare shell surfaces built for long terminal sessions.'
  },
  {
    value: 'light',
    label: 'Light',
    description: 'Brighter chrome while keeping terminal contrast readable.'
  },
  {
    value: 'system',
    label: 'System',
    description: 'Follow the current macOS appearance automatically.'
  }
];

export function SettingsModal({
  open,
  initialCliPath,
  initialAppearanceMode,
  detectedCliPath,
  onClose,
  onSave,
  onCopyEnvDiagnostics
}: SettingsModalProps) {
  const [cliPath, setCliPath] = useState(initialCliPath);
  const [appearanceMode, setAppearanceMode] = useState<AppearanceMode>(initialAppearanceMode);

  useEffect(() => {
    if (!open) {
      return;
    }
    setCliPath(initialCliPath);
    setAppearanceMode(initialAppearanceMode);
  }, [initialAppearanceMode, initialCliPath, open]);

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
              <p>Choose how Claude Desk appears. Dark mode is the default shell.</p>
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
          </section>
        </div>

        <footer className="modal-actions settings-modal-actions">
          <button type="button" className="ghost-button" onClick={() => void onCopyEnvDiagnostics?.()}>
            Copy terminal env diagnostics
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
                  appearanceMode
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
