import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';
import { NavLinks } from '@/components/AppNav';
import { api } from '@/lib/api';

export const metadata: Metadata = {
  title: { default: 'Operant control plane', template: '%s · Operant' },
  description: 'Operant: requests in, jobs out, with the tape, the queue and the fleet in one place.',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const health = await api.health();
  const state = health.ok ? health.data.state : 'unreachable';
  const pg = health.ok ? health.data.checks.find((check) => check.name === 'postgres') : undefined;

  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Chivo+Mono:wght@400;500;800&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <a className="skip-link" href="#main">
          Skip to the work
        </a>
        <div className="app-shell">
          <header className="app-nav">
            <div className="container app-nav__inner">
              <Link className="wordmark" href="/">
                Operant
              </Link>
              <NavLinks />
              <p className="nav-health">
                <span className={`state state--${state === 'healthy' ? 'live' : state === 'degraded' ? 'owed' : 'failed'}`}>
                  {state}
                </span>
                {pg?.detail ? <span className="nav-health__label">postgres {pg.detail}</span> : null}
              </p>
            </div>
          </header>
          <main className="app-main" id="main">
            {children}
          </main>
          <footer className="app-foot">
            <div className="container app-foot__inner">
              <span>
                Operant control plane. Every value here was read from <code>/v1</code> on the API at request
                time; the bearer token stays on this server.
              </span>
              <span>No mock data. Read-only where the API is read-only.</span>
            </div>
          </footer>
        </div>
      </body>
    </html>
  );
}
