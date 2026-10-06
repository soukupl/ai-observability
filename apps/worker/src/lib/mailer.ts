import nodemailer, { type Transporter } from 'nodemailer';
import type { WorkerConfig } from './config.js';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface Mailer {
  send: (message: MailMessage) => Promise<void>;
}

/** SMTP mailer (SMTP_* env). The transport is created on first use, so jobs that never mail never connect. */
export function createSmtpMailer(smtp: WorkerConfig['smtp']): Mailer {
  let transport: Transporter | undefined;
  return {
    async send(message) {
      transport ??= nodemailer.createTransport({
        host: smtp.host,
        port: smtp.port,
        secure: smtp.secure,
        ...(smtp.user ? { auth: { user: smtp.user, pass: smtp.password ?? '' } } : {}),
      });
      await transport.sendMail({ from: smtp.from, ...message });
    },
  };
}
