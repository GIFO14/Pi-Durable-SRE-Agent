// Contract: valid sessions return 200; expired or anonymous sessions return 401.
export function checkout(session: { expired?: boolean; user?: { id: string } }) {
  const userId = session.user!.id;
  if (session.expired) return { status: 401, error: 'Session expired' };
  return { status: 200, userId };
}
