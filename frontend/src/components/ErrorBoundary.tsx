import { Component, type ReactNode } from 'react'

export default class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="m-10 rounded-xl border border-severe/50 bg-severe/10 p-6">
        <div className="font-bold text-severe">Something broke on this screen.</div>
        <pre className="mt-2 text-sm whitespace-pre-wrap text-mute">{this.state.error.message}</pre>
        <button onClick={() => { this.setState({ error: null }); location.hash = '#/' }} className="mt-4 rounded border border-line px-3 py-1.5 text-sm">
          Back to start
        </button>
      </div>
    )
  }
}
