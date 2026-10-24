import nodemailer from 'nodemailer';

/** Outgoing e-mail (magic links, invitations). SMTP_* env; Mailpit in dev (http://localhost:8025). */
export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

export function smtpMailer(env: NodeJS.ProcessEnv = process.env): Mailer {
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST || 'localhost',
    port: Number(env.SMTP_PORT || 1025),
    secure: env.SMTP_SECURE === 'true',
    ...(env.SMTP_USER ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD ?? '' } } : {}),
  });
  const from = env.SMTP_FROM || 'ai-obs <no-reply@localhost>';
  return {
    async send(m) {
      await transport.sendMail({ from, to: m.to, subject: m.subject, text: m.text, ...(m.html ? { html: m.html } : {}) });
    },
  };
}

let mailer: Mailer | undefined;

/** Process-wide mailer, created lazily (no SMTP connection at import / build time). */
export function getMailer(): Mailer {
  mailer ??= smtpMailer();
  return mailer;
}

/** Tests: swap in a fake mailer (null restores SMTP). */
export function setMailer(m: Mailer | null): void {
  mailer = m ?? undefined;
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** The sign-in link, naming the deployment (ADR-0028). */
export function magicLinkEmail(to: string, link: string, ttlMinutes: number, deploymentName: string): MailMessage {
  const name = deploymentName;
  return {
    to,
    subject: `Your ${name} sign-in link`,
    text: `Sign in to ${name}:\n\n${link}\n\nThe link works once and expires in ${ttlMinutes} minutes. If you did not ask for it, ignore this e-mail.\n`,
    html:
      `<p>Sign in to ${escapeHtml(name)}:</p><p><a href="${escapeHtml(link)}">Sign in</a></p>` +
      `<p>The link works once and expires in ${ttlMinutes} minutes. If you did not ask for it, ignore this e-mail.</p>`,
  };
}

/** An invitation to join the deployment (and a team), naming the deployment and the inviter. */
export function invitationEmail(
  to: string,
  opts: { deploymentName: string; inviter: string; teamName: string | null; loginUrl: string; expiresInDays: number },
): MailMessage {
  const team = opts.teamName ? ` (team ${opts.teamName})` : '';
  const what = `${opts.inviter} invited you to ${opts.deploymentName}${team} on ai-obs.`;
  const how = `Sign in with this e-mail address within ${opts.expiresInDays} days to join:`;
  return {
    to,
    subject: `You are invited to ${opts.deploymentName}`,
    text: `${what}\n\n${how}\n${opts.loginUrl}\n`,
    html: `<p>${escapeHtml(what)}</p><p>${escapeHtml(how)}</p><p><a href="${escapeHtml(opts.loginUrl)}">Sign in</a></p>`,
  };
}
