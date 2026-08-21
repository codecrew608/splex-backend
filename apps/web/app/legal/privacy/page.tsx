import { LegalShell, Section } from "@/components/legal/LegalShell";

export const metadata = { title: "Privacy Policy — SPLEX" };

export default function PrivacyPage() {
  return (
    <LegalShell title="Privacy Policy" updated="August 21, 2026">
      <p className="text-muted-foreground">
        This Privacy Policy explains what information SPLEX (&quot;we&quot;, &quot;us&quot;) collects, how it is used,
        and the choices you have.
      </p>
      <p className="rounded-lg border border-border bg-surface px-4 py-3 text-[13px] text-muted-foreground">
        This document is a product/legal draft intended to accurately describe how SPLEX actually works. It is not a
        substitute for review by a qualified lawyer in your jurisdiction, and should be reviewed by counsel before
        being relied on as a binding legal agreement, including for jurisdiction-specific requirements (such as
        GDPR, CCPA, or India's DPDP Act) that may apply to you.
      </p>

      <Section heading="1. Information we collect">
        <p>We collect the following categories of information:</p>
        <ul>
          <li>
            <strong>Account information:</strong> email address and authentication details (including, if you sign
            in with Google, the identifiers Google provides for that purpose).
          </li>
          <li>
            <strong>Content you provide:</strong> messages, prompts, uploaded files, and any other content you submit
            to the Service.
          </li>
          <li>
            <strong>Usage and billing data:</strong> plan tier, SPLEX Credit consumption, and feature usage (such as
            how many images, audio clips, videos, presentations, web searches, or deep research reports you've
            generated in a given period). SPLEX does not store your raw payment card details; card processing, when
            applicable, is handled by a payment processor.
          </li>
          <li>
            <strong>Technical data:</strong> log data such as request timestamps, error information, and rate-limit
            events, used for security, abuse prevention, and diagnosing problems.
          </li>
        </ul>
      </Section>

      <Section heading="2. How we use information">
        <p>We use the information above to:</p>
        <ul>
          <li>Provide, operate, and maintain the Service, including routing your requests to the AI capability best suited to them.</li>
          <li>Enforce plan limits, quotas, and credit balances, and prevent abuse of the Service.</li>
          <li>Maintain a limited memory of context you've shared, to make future responses more relevant, where that feature is enabled.</li>
          <li>Diagnose and fix problems, and monitor the security and reliability of the Service.</li>
          <li>Communicate with you about your account or material changes to the Service.</li>
          <li>Comply with legal obligations.</li>
        </ul>
      </Section>

      <Section heading="3. Sharing with third parties">
        <p>
          To generate a response, SPLEX sends relevant parts of your request to third-party AI model providers over
          a secure connection. For web search, real-time news, and deep research requests, those providers may in
          turn retrieve information from public websites on your behalf. We do not sell your personal information.
          We use Supabase for authentication, database, and file storage infrastructure, and rely on their security
          controls (including row-level access restrictions that keep your data scoped to your own account) as part
          of how the Service is built. We may also disclose information where required by law or to protect the
          rights, safety, or property of SPLEX, our users, or others.
        </p>
      </Section>

      <Section heading="4. Data retention and deletion">
        <p>
          We retain account data, conversation history, and uploaded files for as long as your account is active, so
          the Service can function (for example, so past conversations and memory remain available to you). You may
          delete individual conversations, files, or your entire account from within the Service; deleting your
          account removes your personal data from active systems within a reasonable period, except where we are
          required or permitted to retain limited records (such as billing history) for legal, security, or
          legitimate operational purposes.
        </p>
      </Section>

      <Section heading="5. Security">
        <p>
          Access to your data is scoped to your own account through database-level access controls, and sensitive
          operations (such as credit and billing changes) are restricted to trusted backend systems, never performed
          directly from the browser. No system is perfectly secure, and we cannot guarantee the absolute security of
          information transmitted to or stored by the Service.
        </p>
      </Section>

      <Section heading="6. Your choices">
        <p>
          You can access, update, or delete much of your information directly within the Service (account settings,
          conversation history, uploaded files, and memory). Depending on your location, you may have additional
          rights under applicable law, such as the right to request a copy of your data, object to certain
          processing, or lodge a complaint with a data protection authority.
        </p>
      </Section>

      <Section heading="7. Children">
        <p>SPLEX is not directed to children and is not intended for use by anyone below the age required to enter into a binding agreement in their jurisdiction.</p>
      </Section>

      <Section heading="8. Changes to this policy">
        <p>
          We may update this Privacy Policy from time to time. We will update the &quot;Last updated&quot; date above
          and, for material changes, make reasonable efforts to notify you.
        </p>
      </Section>

      <Section heading="9. Contact">
        <p>Questions about this Privacy Policy, or requests to access or delete your data, can be directed to the contact information provided within the Service.</p>
      </Section>
    </LegalShell>
  );
}
