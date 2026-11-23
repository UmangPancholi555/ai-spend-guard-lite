import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

interface Props { children: ReactNode; /** change this value (e.g. the route) to clear a previous crash */ resetKey?: string; scope?: 'app' | 'page' }
interface State { error: Error | null; id: string }

const newId = () => `ERR-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
const isChunkError = (e: Error) => /dynamically imported module|Loading chunk|Importing a module script failed|ChunkLoadError/i.test(`${e.name} ${e.message}`);

/** Catches render crashes and shows a recovery card. Only the error id and error type are logged (never message, stack or props). */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, id: '' };

  static getDerivedStateFromError(error: Error): State { return { error, id: newId() }; }

  componentDidCatch(error: Error, _info: ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error(`[ui-crash ${this.state.id}] ${error.name}`);
  }

  componentDidUpdate(prev: Props) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null, id: '' });
  }

  render() {
    const { error, id } = this.state;
    if (!error) return this.props.children;
    const chunk = isChunkError(error);
    const page = this.props.scope === 'page';
    return (
      <div className={page ? 'mx-auto max-w-lg py-10' : 'grid min-h-screen place-items-center p-4'}>
        <div role="alert" data-testid="error-boundary" className="w-full max-w-lg rounded-lg border border-red-300 bg-white p-6 shadow dark:border-red-900 dark:bg-slate-900">
          <h1 className="text-lg font-semibold text-red-800 dark:text-red-200">{chunk ? 'A page failed to load' : 'Something went wrong'}</h1>
          <p className="mt-2 text-sm text-slate-700 dark:text-slate-300">
            {chunk
              ? 'The app could not load part of itself. This usually means a new version was installed while this tab was open. Reloading fixes it.'
              : 'This screen hit an unexpected problem. Your data is safe; nothing was changed by the crash. Reloading usually fixes it.'}
          </p>
          <p className="mt-2 text-xs text-slate-600 dark:text-slate-400">Error id: <span className="font-mono" data-testid="error-boundary-id">{id}</span></p>
          <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" data-testid="error-boundary-reload" onClick={() => window.location.reload()}
              className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700">Reload</button>
            {page && (
              <button type="button" data-testid="error-boundary-retry" onClick={() => this.setState({ error: null, id: '' })}
                className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800">Try again</button>
            )}
            <a href="/" data-testid="error-boundary-home"
              className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800">Go to dashboard</a>
          </div>
        </div>
      </div>
    );
  }
}
