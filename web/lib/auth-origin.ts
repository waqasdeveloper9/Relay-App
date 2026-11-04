export function authWorkspaceRedirect(
  appUrl: string,
  currentOrigin: string,
  localLoginAllowed: boolean,
): string {
  if (localLoginAllowed) return '';
  try {
    const configured = new URL(appUrl);
    return configured.protocol === 'https:' && configured.origin !== new URL(currentOrigin).origin
      ? configured.origin
      : '';
  } catch {
    return '';
  }
}
