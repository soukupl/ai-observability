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

export function magicLinkEmail(to: string, link: string, ttlMinutes: number): MailMessage {
  return {
    to,
    subject: 'Your ai-obs sign-in link',
    text: `Sign in to ai-obs:\n\n${link}\n\nThe link works once and expires in ${ttlMinutes} minutes. If you did not ask for it, ignore this e-mail.\n`,
    html:
      `<p>Sign in to ai-obs:</p><p><a href="${escapeHtml(link)}">Sign in</a></p>` +
      `<p>The link works once and expires in ${ttlMinutes} minutes. If you did not ask for it, ignore this e-mail.</p>`,
  };
}
