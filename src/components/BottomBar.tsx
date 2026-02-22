import * as React from 'react';

import type { GitBranchEntry, GitInfo, GitWorkspaceStatus, ThreadMetadata, Workspace } from '../types';

interface BranchSwitcherSnapshot {
  branches: GitBranchEntry[];
  status: GitWorkspaceStatus | null;
}

interface BottomBarProps {
  workspace?: Workspace;
  selectedThread?: ThreadMetadata;
  fullAccessUpdating?: boolean;
  devMode?: boolean;
  terminalDemoMode?: boolean;
  terminalDebugLogging?: boolean;
  gitInfo: GitInfo | null;
  onToggleFullAccess: () => Promise<void>;
  onToggleTerminalDemoMode: () => Promise<void>;
  onToggleTerminalDebugLogging: () => void;
  onLoadBranchSwitcher: () => Promise<BranchSwitcherSnapshot>;
  onCheckoutBranch: (branchName: string) => Promise<boolean>;
  onCreateAndCheckoutBranch: (branchName: string) => Promise<boolean>;
}

function BranchGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="6" cy="5" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.7" />
      <circle cx="6" cy="19" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.7" />
      <circle cx="18" cy="12" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.7" />
      <path
        d="M8.2 5h2.5c2.5 0 3.8 1.3 3.8 3.8v.4M8.2 19h2.5c2.5 0 3.8-1.3 3.8-3.8v-.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function BottomBar({
  workspace,
  selectedThread,
  fullAccessUpdating = false,
  devMode = false,
  terminalDemoMode = false,
  terminalDebugLogging = false,
  gitInfo,
  onToggleFullAccess,
  onToggleTerminalDemoMode,
  onToggleTerminalDebugLogging,
  onLoadBranchSwitcher,
  onCheckoutBranch,
  onCreateAndCheckoutBranch
}: BottomBarProps) {
  const [branchPopoverOpen, setBranchPopoverOpen] = React.useState(false);
  const [branchSearch, setBranchSearch] = React.useState('');
  const [branches, setBranches] = React.useState<GitBranchEntry[]>([]);
  const [branchStatus, setBranchStatus] = React.useState<GitWorkspaceStatus | null>(null);
  const [isLoadingBranches, setIsLoadingBranches] = React.useState(false);
  const [isSwitchingBranch, setIsSwitchingBranch] = React.useState(false);
  const [highlightedIndex, setHighlightedIndex] = React.useState(0);

  const popoverRef = React.useRef<HTMLDivElement | null>(null);
  const searchInputRef = React.useRef<HTMLInputElement | null>(null);

  const filteredBranches = React.useMemo(() => {
    const query = branchSearch.trim().toLowerCase();
    if (!query) {
      return branches;
    }
    return branches.filter((branch) => branch.name.toLowerCase().includes(query));
  }, [branchSearch, branches]);

  React.useEffect(() => {
    if (!branchPopoverOpen) {
      return;
    }

    const onPointerDown = (event: MouseEvent) => {
      if (!popoverRef.current) {
        return;
      }
      if (!popoverRef.current.contains(event.target as Node)) {
        setBranchPopoverOpen(false);
      }
    };

    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setBranchPopoverOpen(false);
      }
    };

    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onEscape);
    return () => {
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onEscape);
    };
  }, [branchPopoverOpen]);

  React.useEffect(() => {
    if (!branchPopoverOpen) {
      return;
    }
    if (filteredBranches.length === 0) {
      setHighlightedIndex(0);
      return;
    }
    if (highlightedIndex >= filteredBranches.length) {
      setHighlightedIndex(filteredBranches.length - 1);
    }
  }, [branchPopoverOpen, filteredBranches, highlightedIndex]);

  React.useEffect(() => {
    if (!branchPopoverOpen) {
      return;
    }
    window.setTimeout(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    }, 0);
  }, [branchPopoverOpen]);

  const openBranchPopover = React.useCallback(async () => {
    if (!workspace || !gitInfo) {
      return;
    }
    setBranchPopoverOpen(true);
    setBranchSearch('');
    setIsLoadingBranches(true);
    try {
      const snapshot = await onLoadBranchSwitcher();
      setBranches(snapshot.branches);
      setBranchStatus(snapshot.status);
      const currentIndex = snapshot.branches.findIndex((branch) => branch.isCurrent);
      setHighlightedIndex(currentIndex >= 0 ? currentIndex : 0);
    } finally {
      setIsLoadingBranches(false);
    }
  }, [gitInfo, onLoadBranchSwitcher, workspace]);

  const runCheckout = React.useCallback(
    async (branchName: string) => {
      setIsSwitchingBranch(true);
      try {
        const changed = await onCheckoutBranch(branchName);
        if (!changed) {
          return;
        }
        setBranchPopoverOpen(false);
      } catch {
        // Toast is emitted by the caller; keep popover open for retries.
      } finally {
        setIsSwitchingBranch(false);
      }
    },
    [onCheckoutBranch]
  );

  const runCreateAndCheckout = React.useCallback(async () => {
    const branchName = window.prompt('Enter new branch name');
    if (!branchName) {
      return;
    }
    const trimmed = branchName.trim();
    if (!trimmed) {
      return;
    }

    setIsSwitchingBranch(true);
    try {
      const changed = await onCreateAndCheckoutBranch(trimmed);
      if (!changed) {
        return;
      }
      setBranchPopoverOpen(false);
    } catch {
      // Toast is emitted by the caller; keep popover open for retries.
    } finally {
      setIsSwitchingBranch(false);
    }
  }, [onCreateAndCheckoutBranch]);

  const onBranchSearchKeyDown = React.useCallback(
    async (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        if (filteredBranches.length > 0) {
          setHighlightedIndex((current) => Math.min(filteredBranches.length - 1, current + 1));
        }
        return;
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        if (filteredBranches.length > 0) {
          setHighlightedIndex((current) => Math.max(0, current - 1));
        }
        return;
      }

      if (event.key === 'Enter') {
        event.preventDefault();
        const target = filteredBranches[highlightedIndex];
        if (target) {
          await runCheckout(target.name);
        }
        return;
      }

      if (event.key === 'Escape') {
        event.preventDefault();
        setBranchPopoverOpen(false);
      }
    },
    [filteredBranches, highlightedIndex, runCheckout]
  );

  return (
    <footer className="bottom-bar" data-testid="bottom-bar">
      <div className="bottom-bar-left">
        <span className="bottom-bar-label">Local</span>
        <div className="branch-switcher" ref={popoverRef}>
          <button
            type="button"
            className="ghost-button branch-trigger"
            onClick={() => void (branchPopoverOpen ? setBranchPopoverOpen(false) : openBranchPopover())}
            disabled={!workspace || !gitInfo}
            aria-expanded={branchPopoverOpen}
            aria-haspopup="dialog"
            title={gitInfo ? `Current branch: ${gitInfo.branch}` : 'Workspace is not a git repository'}
          >
            <span className="branch-trigger-label">{gitInfo?.branch ?? 'No git repo'}</span>
            <span className="branch-trigger-chevron" aria-hidden="true">
              <svg viewBox="0 0 24 24">
                <path d="M7 10.5 12 15l5-4.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
              </svg>
            </span>
          </button>

          {branchPopoverOpen ? (
            <section className="branch-popover" role="dialog" aria-label="Branch switcher">
              <div className="branch-search-row">
                <input
                  ref={searchInputRef}
                  type="text"
                  className="branch-search-input"
                  placeholder="Search branches"
                  value={branchSearch}
                  onChange={(event) => {
                    setBranchSearch(event.target.value);
                    setHighlightedIndex(0);
                  }}
                  onKeyDown={(event) => void onBranchSearchKeyDown(event)}
                />
              </div>

              <p className="branch-section-label">Branches</p>

              <div className="branch-list">
                {isLoadingBranches ? (
                  <p className="branch-empty">Loading...</p>
                ) : filteredBranches.length === 0 ? (
                  <p className="branch-empty">No branches found.</p>
                ) : (
                  filteredBranches.map((branch, index) => {
                    const isHighlighted = index === highlightedIndex;
                    return (
                      <button
                        key={branch.name}
                        type="button"
                        className={isHighlighted ? 'branch-row highlighted' : 'branch-row'}
                        onMouseEnter={() => setHighlightedIndex(index)}
                        onClick={() => void runCheckout(branch.name)}
                        disabled={isSwitchingBranch}
                      >
                        <div className="branch-row-top">
                          <span className="branch-icon">
                            <BranchGlyph />
                          </span>
                          <span className="branch-name">{branch.name}</span>
                          {branch.isCurrent ? <span className="branch-check">✓</span> : null}
                        </div>
                        {branch.isCurrent ? (
                          <p className="branch-current-status">
                            <span>Uncommitted: {branchStatus?.uncommittedFiles ?? 0} files</span>
                            <span className="branch-ins">+{branchStatus?.insertions ?? 0}</span>
                            <span className="branch-del">-{branchStatus?.deletions ?? 0}</span>
                          </p>
                        ) : null}
                      </button>
                    );
                  })
                )}
              </div>

              <div className="branch-popover-footer">
                <button
                  type="button"
                  className="branch-create-button"
                  onClick={() => void runCreateAndCheckout()}
                  disabled={isSwitchingBranch}
                >
                  <span className="branch-plus">+</span>
                  <span>Create and checkout new branch...</span>
                </button>
              </div>
            </section>
          ) : null}
        </div>
      </div>

      <div className="bottom-bar-right">
        {devMode ? (
          <>
            <button
              type="button"
              className={terminalDemoMode ? 'dev-toggle-button enabled' : 'dev-toggle-button'}
              data-testid="terminal-demo-toggle"
              aria-pressed={terminalDemoMode}
              onClick={() => void onToggleTerminalDemoMode()}
              title="Run PTY terminal demo command instead of Claude (dev only)"
            >
              Demo PTY
            </button>
            <button
              type="button"
              className={terminalDebugLogging ? 'dev-toggle-button enabled' : 'dev-toggle-button'}
              data-testid="terminal-debug-toggle"
              aria-pressed={terminalDebugLogging}
              onClick={onToggleTerminalDebugLogging}
              title="Log PTY and xterm queue diagnostics in dev tools"
            >
              Term Logs
            </button>
          </>
        ) : null}
        <button
          type="button"
          className={selectedThread?.fullAccess ? 'full-access-toggle enabled' : 'full-access-toggle'}
          data-testid="full-access-toggle"
          aria-label="Toggle full access"
          aria-pressed={selectedThread?.fullAccess ?? false}
          disabled={!selectedThread || fullAccessUpdating}
          onClick={() => void onToggleFullAccess()}
          title={!selectedThread ? 'Select a thread' : selectedThread.fullAccess ? 'Disable full access' : 'Enable full access'}
        >
          <span className="full-access-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path
                d="M12 3.8A8.2 8.2 0 1 0 20.2 12 8.2 8.2 0 0 0 12 3.8Zm0 4.4v6.1M12 17.4h.01"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.9"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <span className="full-access-label">{fullAccessUpdating ? 'Updating...' : 'Full access'}</span>
          <span className="full-access-chevron" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M7 10.5 12 15l5-4.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
            </svg>
          </span>
        </button>
      </div>
    </footer>
  );
}
