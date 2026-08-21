import { LegalShell, Section } from "@/components/legal/LegalShell";

export const metadata = { title: "Terms of Service — SPLEX" };

export default function TermsPage() {
  return (
    <LegalShell title="Terms of Service" updated="August 21, 2026">
      <p className="text-muted-foreground">
        These Terms of Service (&quot;Terms&quot;) govern access to and use of SPLEX (the &quot;Service&quot;). By creating an
        account or using the Service, you agree to these Terms. If you do not agree, do not use the Service.
      </p>
      <p className="rounded-lg border border-border bg-surface px-4 py-3 text-[13px] text-muted-foreground">
        This document is a product/legal draft intended to accurately describe how SPLEX actually works. It is not a
        substitute for review by a qualified lawyer in your jurisdiction, and should be reviewed by counsel before
        being relied on as a binding legal agreement.
      </p>

      <Section heading="1. Your account">
        <p>
          You must provide accurate information when creating an account and are responsible for all activity that
          occurs under it. Keep your credentials confidential. Notify us promptly if you believe your account has
          been compromised. You must be legally able to enter into a binding contract to use the Service.
        </p>
      </Section>

      <Section heading="2. Plans, SPLEX Credits, and billing">
        <p>
          SPLEX offers a Free plan and a paid Starter plan. Paid plans are billed in advance on a recurring monthly
          basis until cancelled. Usage of AI capabilities is measured in SPLEX Credits, a normalized unit that
          reflects the underlying cost of the AI models and services used to generate a response — not a literal
          count of tokens, since different requests and capabilities (chat, image, audio, video, presentations, web
          search, deep research) have different real costs. Each plan includes a monthly credit allowance and a daily
          credit allowance; unused credits do not roll over and expire at the end of their period. Specific plan
          limits, including credit amounts, daily/monthly resets, and per-capability limits (such as the number of
          images, audio clips, videos, presentations, web searches, or deep research reports available per day), are
          shown in the product and may be adjusted from time to time; we will make reasonable efforts to communicate
          material reductions in advance.
        </p>
        <p>
          You may cancel a paid plan at any time; cancellation takes effect at the end of the current billing cycle
          unless stated otherwise at the point of cancellation, and your account reverts to the Free plan's limits.
        </p>
      </Section>

      <Section heading="3. Refunds">
        <p>
          Fees are generally non-refundable except where required by applicable law or expressly stated at the time
          of purchase. If you believe you were charged in error, contact us and we will review the request in good
          faith.
        </p>
      </Section>

      <Section heading="4. Acceptable use">
        <p>
          You agree to use the Service only for lawful purposes and in accordance with our{" "}
          <a href="/legal/acceptable-use">Acceptable Use Policy</a>, which is incorporated into these Terms by
          reference. We may suspend or terminate access for conduct that violates these Terms, the Acceptable Use
          Policy, or applicable law.
        </p>
      </Section>

      <Section heading="5. AI-generated content and accuracy">
        <p>
          SPLEX uses third-party AI models and, for certain requests, live web search and research tools to generate
          responses, images, audio, video, presentations, and reports. AI-generated content can be incomplete,
          out of date, or simply wrong, including for requests seeking current information (such as prices, news,
          or recent events) where SPLEX attempts to ground its answer in retrieved sources but cannot guarantee
          those sources are accurate, complete, or fully up to date at the moment you read the response. You are
          responsible for independently verifying any output before relying on it for decisions with legal,
          financial, medical, safety, or other significant consequences. The Service is not a substitute for
          professional advice.
        </p>
      </Section>

      <Section heading="6. Your content and files">
        <p>
          You retain ownership of files, documents, images, and other content you upload or submit to SPLEX
          (&quot;Your Content&quot;). You grant SPLEX a limited license to store, process, and transmit Your Content
          solely as necessary to provide the Service to you — including sending relevant portions to third-party AI
          providers to generate a response, and extracting text via OCR or embeddings for retrieval-augmented
          responses. You represent that you have the rights necessary to upload Your Content and that doing so does
          not infringe any third party's rights.
        </p>
      </Section>

      <Section heading="7. Intellectual property">
        <p>
          SPLEX and its branding, design, and underlying software are owned by SPLEX or its licensors and are
          protected by intellectual property laws. Subject to your compliance with these Terms, output generated for
          you through the Service is yours to use, subject to the terms of the underlying third-party AI providers
          that generated it and any rights of third parties (for example, material found via web search). We claim
          no ownership over Your Content or the outputs generated from your own requests.
        </p>
      </Section>

      <Section heading="8. Prohibited abuse">
        <p>
          You may not attempt to circumvent plan limits, rate limits, or credit enforcement; access another user's
          account or data without authorization; probe, scan, or test the Service for vulnerabilities without
          authorization; use automated means (scripts, bots, scrapers) to access the Service outside of any
          officially supported interface, or in a manner that imposes an unreasonable load on our infrastructure or
          third-party providers; or reverse engineer the Service except to the extent such restriction is prohibited
          by applicable law. See the <a href="/legal/acceptable-use">Acceptable Use Policy</a> for the full list of
          prohibited conduct.
        </p>
      </Section>

      <Section heading="9. Third-party AI providers and information sources">
        <p>
          SPLEX routes requests to third-party AI model providers to generate responses, and, for web search,
          real-time news, and deep research requests, retrieves information from third-party websites and search
          services. We select which provider or model handles a given request based on the nature of the request,
          your plan, and operational factors such as cost and reliability; we do not guarantee the availability of
          any specific provider or model at any given time. Content retrieved from external websites reflects the
          views and accuracy of those third-party sources, not SPLEX, and is treated as reference material rather
          than as instructions to the underlying AI system.
        </p>
      </Section>

      <Section heading="10. Service availability">
        <p>
          We aim to keep the Service available and reliable but do not guarantee uninterrupted access. The Service
          may be unavailable due to maintenance, third-party provider outages, or circumstances outside our control.
        </p>
      </Section>

      <Section heading="11. Data retention and deletion">
        <p>
          We retain your account data, conversations, uploaded files, and usage records for as long as your account
          is active, and for a reasonable period afterward as needed for legitimate business, security, or legal
          purposes. You may request deletion of your account and associated data; see our{" "}
          <a href="/legal/privacy">Privacy Policy</a> for details on how we handle personal data and deletion
          requests.
        </p>
      </Section>

      <Section heading="12. Security">
        <p>
          We use reasonable administrative, technical, and organizational measures designed to protect your data,
          including access controls that restrict data to its owning account. No method of transmission or storage
          is perfectly secure, and we cannot guarantee absolute security.
        </p>
      </Section>

      <Section heading="13. Termination and suspension">
        <p>
          We may suspend or terminate your access to the Service if you violate these Terms or the Acceptable Use
          Policy, if required by law, or to protect the Service or other users. You may stop using the Service and
          close your account at any time. Provisions that by their nature should survive termination (including
          Sections 6, 7, and 15) will survive.
        </p>
      </Section>

      <Section heading="14. Limitation of liability">
        <p>
          To the maximum extent permitted by law, SPLEX and its providers are not liable for indirect, incidental,
          special, consequential, or punitive damages, or for loss of data, profits, or goodwill, arising from your
          use of the Service, including reliance on AI-generated content. The Service is provided &quot;as is&quot;
          and &quot;as available&quot; without warranties of any kind, express or implied, to the extent permitted by
          law.
        </p>
      </Section>

      <Section heading="15. Changes to these Terms">
        <p>
          We may update these Terms from time to time. We will update the &quot;Last updated&quot; date above and, for
          material changes, make reasonable efforts to notify you. Continued use of the Service after changes take
          effect constitutes acceptance of the revised Terms.
        </p>
      </Section>

      <Section heading="16. Contact">
        <p>Questions about these Terms can be directed to the contact information provided within the Service.</p>
      </Section>
    </LegalShell>
  );
}
