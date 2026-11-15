'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const DESTINATIONS = [
  { href: '/', label: 'Control' },
  { href: '/memory', label: 'Memory' },
  { href: '/approvals', label: 'Approvals' },
  { href: '/fleet', label: 'Fleet' },
];

export function NavLinks() {
  const pathname = usePathname() ?? '/';
  return (
    <nav aria-label="Operant">
      <ul className="nav-list">
        {DESTINATIONS.map((item) => {
          const current = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
          return (
            <li key={item.href}>
              <Link href={item.href} aria-current={current ? 'page' : undefined}>
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}