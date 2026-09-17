"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { AuthUser, UserRole } from "@/types";
import { useState } from "react";

interface SidebarProps {
  user: AuthUser;
}

interface NavChild {
  label: string;
  href: string;
}

interface NavItem {
  label: string;
  href: string;
  icon: React.ReactNode;
  roles?: UserRole[];
  // When present the row becomes a collapsible group: it no longer links
  // anywhere itself, it expands to reveal these sub-routes.
  children?: NavChild[];
}

const navItems: NavItem[] = [
  {
    label: "Command Center",
    href: "/head",
    roles: ["OPS_HEAD"],
    icon: (
      <svg className="w-4.5 h-4.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
      </svg>
    ),
  },
  {
    label: "Analytics",
    href: "/head/analytics",
    roles: ["OPS_HEAD"],
    icon: (
      <svg className="w-4.5 h-4.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
      </svg>
    ),
  },
  {
    label: "Smart View",
    href: "/agent/smart-view",
    roles: ["OPS_AGENT"],
    icon: (
      // Same inbox-checkmark glyph the Lead's Smart View uses, so agents
      // and Leads recognise it as the same surface across roles.
      <svg className="w-4.5 h-4.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
      </svg>
    ),
  },
  {
    label: "All Tasks",
    href: "/agent",
    roles: ["OPS_AGENT"],
    icon: (
      // Older single-task list view, kept alongside Smart View as the
      // full-list lens. Same label as the Head's "All Tasks" — different
      // route per role, no collision since the sidebar filters by role.
      <svg className="w-4.5 h-4.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 10h16M4 14h16M4 18h16" />
      </svg>
    ),
  },
  {
    label: "Store Overview",
    href: "/store",
    roles: ["OPS_HEAD", "STORE_ADMIN"],
    icon: (
      <svg className="w-4.5 h-4.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
      </svg>
    ),
  },
  {
    label: "Smart View",
    href: "/head/my-work",
    roles: ["OPS_HEAD"],
    icon: (
      // Inbox / focused-work glyph: tray with check mark
      <svg className="w-4.5 h-4.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
      </svg>
    ),
  },
  {
    label: "All Tasks",
    href: "/head/tasks",
    roles: ["OPS_HEAD"],
    icon: (
      // Archive box glyph: drawer with bar
      <svg className="w-4.5 h-4.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M5 8h14M5 8a2 2 0 01-2-2V5a2 2 0 012-2h14a2 2 0 012 2v1a2 2 0 01-2 2M5 8v11a2 2 0 002 2h10a2 2 0 002-2V8M10 12h4" />
      </svg>
    ),
  },
  {
    label: "Team",
    href: "/head/team",
    roles: ["OPS_HEAD"],
    icon: (
      <svg className="w-4.5 h-4.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
      </svg>
    ),
  },
  {
    label: "Task Rules",
    href: "/head/rules",
    roles: ["OPS_HEAD"],
    icon: (
      <svg className="w-4.5 h-4.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
      </svg>
    ),
  },
  {
    label: "Escalations",
    href: "/head/escalations",
    roles: ["OPS_HEAD"],
    icon: (
      <svg className="w-4.5 h-4.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
      </svg>
    ),
  },
  {
    label: "Data Sources",
    href: "/head/data-sources",
    roles: ["OPS_HEAD"],
    icon: (
      <svg className="w-4.5 h-4.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M4 7a2 2 0 012-2h12a2 2 0 012 2v1a2 2 0 01-2 2H6a2 2 0 01-2-2V7zm0 6a2 2 0 012-2h12a2 2 0 012 2v1a2 2 0 01-2 2H6a2 2 0 01-2-2v-1zm0 6a2 2 0 012-2h12a2 2 0 012 2v1a2 2 0 01-2 2H6a2 2 0 01-2-2v-1z" />
      </svg>
    ),
  },
  {
    label: "Provider Communication",
    href: "/head/non-api-labs",
    roles: ["OPS_HEAD"],
    children: [
      // First because it is the "what is happening right now" screen; the rest
      // are configuration you visit when something on this board is wrong.
      { label: "Today & Tomorrow", href: "/head/non-api-labs/board" },
      { label: "Lab Config", href: "/head/non-api-labs/lab-config" },
      { label: "Task Rules", href: "/head/non-api-labs/task-rules" },
      { label: "Templates", href: "/head/non-api-labs/templates" },
      { label: "SLA Breaches", href: "/head/non-api-labs/breaches" },
    ],
    icon: (
      <svg className="w-4.5 h-4.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 21h18M5 21V7l7-4 7 4v14M9 21v-5h6v5M9 9h.01M15 9h.01M9 12h.01M15 12h.01" />
      </svg>
    ),
  },
  {
    label: "Engine",
    href: "/head/engine",
    roles: ["OPS_HEAD"],
    icon: (
      <svg className="w-4.5 h-4.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01" />
      </svg>
    ),
  },
  {
    label: "WhatsApp",
    href: "/head/whatsapp",
    roles: ["OPS_HEAD"],
    icon: (
      <svg className="w-4.5 h-4.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M20 12a8 8 0 01-11.6 7.1L4 20l.9-4.3A8 8 0 1120 12z" />
      </svg>
    ),
  },
  {
    // Same shared loop queue for agents — different route per role, matching the
    // Smart View / All Tasks pattern above.
    label: "WhatsApp",
    href: "/agent/whatsapp",
    roles: ["OPS_AGENT"],
    icon: (
      <svg className="w-4.5 h-4.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M20 12a8 8 0 01-11.6 7.1L4 20l.9-4.3A8 8 0 1120 12z" />
      </svg>
    ),
  },
];

export default function Sidebar({ user }: SidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [loggingOut, setLoggingOut] = useState(false);
  // Groups the user has explicitly toggled. Absent means "follow the route":
  // a group opens on its own while one of its children is the active page.
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});

  const visibleNav = navItems.filter(
    (item) => !item.roles || item.roles.includes(user.role as UserRole)
  );

  // Exact-match the role-root routes ("/head", "/agent") so they don't also
  // light up when the user is on a child route like /head/tasks or
  // /agent/smart-view. Everything else uses prefix match so deep sub-pages
  // still highlight their parent nav.
  const EXACT_MATCH_ROUTES = new Set(["/head", "/agent"]);
  const isActive = (href: string) =>
    EXACT_MATCH_ROUTES.has(href)
      ? pathname === href
      : pathname === href || pathname.startsWith(href + "/");

  async function handleLogout() {
    setLoggingOut(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
      router.push("/login");
    } finally {
      setLoggingOut(false);
    }
  }

  const roleLabel: Record<string, string> = {
    OPS_HEAD: "Ops Head",
    OPS_ADMIN: "Ops Admin",
    OPS_AGENT: "Ops Agent",
    STORE_ADMIN: "Store Admin",
  };
  // OPS_ADMIN is coerced to OPS_HEAD for permissions; show its true label.
  const displayRole = user.realRole ?? user.role;

  return (
    <aside className="w-56 shrink-0 bg-zinc-900 border-r border-zinc-800 flex flex-col">
      {/* Brand */}
      <div className="px-4 py-4 border-b border-zinc-800">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-md bg-blue-600 flex items-center justify-center shrink-0">
            <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <div>
            <div className="text-sm font-semibold text-white leading-none">OpsFlow</div>
            <div className="text-[10px] text-zinc-500 mt-0.5 leading-none">LabStack Ops</div>
          </div>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-2 py-3 space-y-0.5 overflow-y-auto">
        {visibleNav.map((item) => {
          const active = isActive(item.href);

          if (item.children) {
            const expanded = openGroups[item.href] ?? active;
            return (
              <div key={item.href}>
                <button
                  type="button"
                  onClick={() => setOpenGroups((prev) => ({ ...prev, [item.href]: !expanded }))}
                  aria-expanded={expanded}
                  className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                    active
                      ? "bg-blue-600/15 text-blue-400"
                      : "text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800"
                  }`}
                >
                  <span className={active ? "text-blue-400" : "text-zinc-500"}>{item.icon}</span>
                  <span className="flex-1 text-left">{item.label}</span>
                  <svg
                    className={`w-3.5 h-3.5 shrink-0 transition-transform ${expanded ? "rotate-180" : ""}`}
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
                {expanded && (
                  <div className="mt-0.5 ml-5 pl-2.5 border-l border-zinc-800 space-y-0.5">
                    {item.children.map((child) => {
                      const childActive = isActive(child.href);
                      return (
                        <Link
                          key={child.href}
                          href={child.href}
                          className={`block px-3 py-1.5 rounded-lg text-[13px] font-medium transition-colors ${
                            childActive
                              ? "bg-blue-600/15 text-blue-400"
                              : "text-zinc-500 hover:text-zinc-100 hover:bg-zinc-800"
                          }`}
                        >
                          {child.label}
                        </Link>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          }

          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                active
                  ? "bg-blue-600/15 text-blue-400"
                  : "text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800"
              }`}
            >
              <span className={active ? "text-blue-400" : "text-zinc-500"}>{item.icon}</span>
              {item.label}
            </Link>
          );
        })}
      </nav>

      {/* User */}
      <div className="px-3 py-3 border-t border-zinc-800">
        <Link
          href="/profile"
          className="flex items-center gap-2.5 px-2 py-1.5 rounded-lg mb-2 hover:bg-zinc-800 transition-colors group"
        >
          <div className="w-7 h-7 rounded-full bg-zinc-700 flex items-center justify-center shrink-0 text-xs font-semibold text-zinc-300">
            {user.name.charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-xs font-medium text-zinc-200 truncate group-hover:text-white transition-colors">
              {user.name}
            </div>
            <div className="text-[10px] text-zinc-500">{roleLabel[displayRole] ?? displayRole}</div>
          </div>
          <svg className="w-3 h-3 text-zinc-600 opacity-0 group-hover:opacity-100 transition-opacity shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
        </Link>
        <button
          onClick={handleLogout}
          disabled={loggingOut}
          className="w-full flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
          </svg>
          {loggingOut ? "Signing out..." : "Sign out"}
        </button>
      </div>
    </aside>
  );
}
