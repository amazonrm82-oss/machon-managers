/* Microsoft 365 sign-in for the learning system.
 *
 * Fill in the two values below from the app registration in Microsoft Entra ID.
 * Nothing here is secret — a SPA client id and tenant id are public by design;
 * the security comes from the redirect URI allow-list in the app registration.
 *
 * Setup instructions: learn-src/README.md
 *
 * While these are empty the learning system shows a clearly-marked demo entry
 * instead of a Microsoft sign-in.
 */

window.MS_AUTH_CONFIG = {
  // Application (client) ID — e.g. "11111111-2222-3333-4444-555555555555"
  clientId: '',

  // Directory (tenant) ID of the institute's Microsoft 365 tenant.
  // Use the tenant id so only institute accounts can sign in.
  tenantId: '',

  // Leave empty to use this page's own address. Whatever is used here must be
  // registered as a "Single-page application" redirect URI in Entra ID.
  redirectUri: '',

  // The temporary way in while the Entra registration is still pending.
  // Set to false and the learning system has no entrance at all until
  // clientId and tenantId above are filled in — including for you.
  // Once they are filled in this setting is ignored: Microsoft is the only
  // way in, and the demo entrance disappears by itself.
  allowDemo: true
};
