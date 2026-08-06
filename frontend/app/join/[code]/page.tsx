import { AppShell } from "@/components/AppShell";

/**
 * Invite landing page: /join/inv_<uuid>
 *
 * Replaces the old window.location.pathname sniffing in Auth.tsx with a real
 * route. The code is handed to the auth screen, which opens on the join tab.
 */
export default async function JoinPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  return <AppShell initialInviteCode={decodeURIComponent(code)} />;
}
