import type { FastifyInstance } from "fastify";
import { describeError } from "../openrouter/client.js";

// Clean, single-provider email adapter. No email provider existed
// anywhere in this project before this — checked first (grepped for
// nodemailer/resend/sendgrid/postmark/mailgun/SMTP across the whole repo,
// nothing) rather than assumed. Resend was picked as the concrete
// implementation because its API is one plain HTTP POST with a bearer
// token — no SMTP (unavailable on Cloudflare Workers, which is where this
// backend actually runs — see DEPLOYMENT.md), no SDK dependency to keep
// Workers-bundle-compatible, nothing to configure beyond an API key.
//
// Swapping providers later means changing the body of sendEmail() below,
// not the call sites — every caller just awaits a boolean.
//
// No API key is invented here: RESEND_API_KEY is optional in both env
// schemas (plugins/env.ts, worker/env.ts) and unset by default. Every
// caller of sendEmail() treats a `false` return (or a thrown error, which
// this function never lets escape) as "notification skipped" — the
// action that triggered it (e.g. a feedback submission) has ALREADY
// succeeded and persisted by the time this runs; see
// routes/feedback.ts's own comment for why that ordering is load-bearing.
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export async function sendEmail(fastify: FastifyInstance, message: EmailMessage): Promise<boolean> {
  const apiKey = fastify.config.RESEND_API_KEY;
  if (!apiKey) {
    fastify.log.info({ to: message.to, subject: message.subject }, "email adapter: no provider configured (RESEND_API_KEY unset), skipping send");
    return false;
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: fastify.config.FEEDBACK_EMAIL_FROM,
        to: [message.to],
        subject: message.subject,
        text: message.text,
      }),
    });

    if (!res.ok) {
      // Never the response body verbatim — a provider error message could
      // in principle echo back something request-shaped; the status code
      // is enough to diagnose "misconfigured" vs "transient" from logs.
      fastify.log.warn({ status: res.status }, "email adapter: provider returned a non-2xx response");
      return false;
    }
    return true;
  } catch (err) {
    fastify.log.warn(describeError(err), "email adapter: send failed");
    return false;
  }
}
