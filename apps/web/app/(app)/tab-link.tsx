"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// A nav link that knows whether it is the current page: aria-current="page" plus the active classes (the
// colour classes are split so two text colours never compete).

export function TabLink({ href, className, active: activeClass, idle, children }: { href: string; className: string; active: string; idle: string; children: React.ReactNode }) {
  const path = usePathname() ?? "";
  const active = href === "/" ? path === "/" : path === href || path.startsWith(`${href}/`);
  return (
    <Link href={href} aria-current={active ? "page" : undefined} className={`${className} ${active ? activeClass : idle}`}>
      {children}
    </Link>
  );
}
