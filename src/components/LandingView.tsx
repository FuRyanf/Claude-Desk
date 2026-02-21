import type { GitInfo, Workspace } from '../types';

interface LandingViewProps {
  workspace?: Workspace;
  gitInfo: GitInfo | null;
  onSuggestion: (text: string) => void;
}

const suggestions = ['Create a new skill', 'Review current git diff', 'Debug with logs'];

export function LandingView({ workspace, gitInfo, onSuggestion }: LandingViewProps) {
  return (
    <section className="landing-view">
      <h1>Let&apos;s build</h1>
      <p className="landing-subtitle">
        {workspace?.name ?? 'Add a workspace to start'}
        {gitInfo ? <span title={`Commit ${gitInfo.shortHash}`}> · {gitInfo.branch}</span> : null}
      </p>

      <div className="suggestions-grid">
        {suggestions.map((suggestion) => (
          <button key={suggestion} type="button" onClick={() => onSuggestion(suggestion)}>
            {suggestion}
          </button>
        ))}
      </div>
    </section>
  );
}
