'use client';

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="container">
      <h1>This screen failed to render</h1>
      <p className="pending-block" role="alert">
        {error.message || 'The page threw before it could read the control plane.'}
        {error.digest ? ` Reference ${error.digest}.` : ''}
      </p>
      <button className="btn" type="button" onClick={reset}>
        Try again
      </button>
    </div>
  );
}