import type { MailMessage } from '../mail';

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * Admin invitation. The invitation row in the DB does the real work: signing in with this e-mail
 * address (magic link, Google or GitHub) lists it on the /signup step for a new address, or on
 * /invitations for an account that already belongs to another company, where the person explicitly
 * joins (auth_pending_invitations / auth_accept_invitation, SEC-1). The mail only points at the login
 * page (continuing to /invitations); it carries no secret.
 */
export function adminInvitationEmail(to: string, companyName: string, loginUrl: string, validDays: number): MailMessage {
  return {
    to,
    subject: `You are invited to administer ${companyName} on ai-obs`,
    text:
      `You have been invited as an administrator of "${companyName}" on ai-obs.\n\n` +
      `Sign in with this e-mail address (${to}) to accept:\n\n${loginUrl}\n\n` +
      `You can use an e-mailed sign-in link or Google / GitHub, as long as the address matches. ` +
      `Already using ai-obs with this address? Sign in and open Invitations. ` +
      `The invitation is valid for ${validDays} days. If you did not expect it, ignore this e-mail.\n`,
    html:
      `<p>You have been invited as an administrator of <strong>${escapeHtml(companyName)}</strong> on ai-obs.</p>` +
      `<p>Sign in with this e-mail address (${escapeHtml(to)}) to accept:</p>` +
      `<p><a href="${escapeHtml(loginUrl)}">Sign in to ai-obs</a></p>` +
      `<p>You can use an e-mailed sign-in link or Google / GitHub, as long as the address matches. ` +
      `Already using ai-obs with this address? Sign in and open Invitations. ` +
      `The invitation is valid for ${validDays} days. If you did not expect it, ignore this e-mail.</p>`,
  };
}
