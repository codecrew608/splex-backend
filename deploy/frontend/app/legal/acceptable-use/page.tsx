import { LegalShell, Section } from "@/components/legal/LegalShell";

export const metadata = { title: "Acceptable Use Policy — SPLEX" };

export default function AcceptableUsePage() {
  return (
    <LegalShell title="Acceptable Use Policy" updated="August 21, 2026">
      <p className="text-muted-foreground">
        This Acceptable Use Policy applies to everyone who uses SPLEX and is incorporated into our{" "}
        <a href="/legal/terms">Terms of Service</a> by reference. It exists to keep the Service safe, reliable, and
        fair to use.
      </p>
      <p className="rounded-lg border border-border bg-surface px-4 py-3 text-[13px] text-muted-foreground">
        This document is a product/legal draft intended to accurately describe how SPLEX actually works. It is not a
        substitute for review by a qualified lawyer in your jurisdiction, and should be reviewed by counsel before
        being relied on as a binding legal agreement.
      </p>

      <Section heading="1. Prohibited content and requests">
        <p>You may not use SPLEX to generate, request, or distribute content that:</p>
        <ul>
          <li>Is illegal, or facilitates illegal activity, in your jurisdiction or ours.</li>
          <li>Sexually exploits or endangers minors, in any form.</li>
          <li>Constitutes credible threats of violence, harassment, or targeted abuse of an individual.</li>
          <li>Is intended to deceive others in a way that causes real-world harm — for example, generating content designed to impersonate a real person or organization to defraud someone, or fabricating official documents.</li>
          <li>Infringes another party's intellectual property or other legal rights.</li>
          <li>Attempts to develop weapons, malicious software, or other tools intended to cause damage or unauthorized access to systems.</li>
        </ul>
      </Section>

      <Section heading="2. Abuse of the platform">
        <p>You may not:</p>
        <ul>
          <li>Attempt to bypass, disable, or manipulate credit accounting, plan entitlements, quota limits, or rate limits.</li>
          <li>Access, or attempt to access, another user's account, conversations, files, or generated content without authorization.</li>
          <li>Use automated scripts, bots, or scrapers to interact with the Service outside of its intended interface, or in a way that places unreasonable load on SPLEX or the third-party providers it relies on.</li>
          <li>Attempt to extract, reconstruct, or reverse engineer the underlying system prompts, routing logic, model selection, or provider identities SPLEX uses internally.</li>
          <li>Probe, scan, or test the Service for security vulnerabilities without prior written authorization from SPLEX.</li>
          <li>Submit content specifically crafted to manipulate SPLEX's AI systems into ignoring their operating instructions or safety behavior (prompt injection), including embedding hidden instructions in uploaded files or in content intended to be retrieved via web search.</li>
        </ul>
      </Section>

      <Section heading="3. Fair use of shared infrastructure">
        <p>
          Plan limits (daily and monthly SPLEX Credits, and per-capability daily limits for images, audio, video,
          presentations, web searches, and deep research) exist so the Service remains available and affordable for
          everyone. Deliberately structuring usage to exhaust another user's shared resources, or coordinating
          multiple accounts to circumvent per-account limits, is prohibited.
        </p>
      </Section>

      <Section heading="4. Reliance on AI output">
        <p>
          SPLEX's AI-generated responses, including current-information answers grounded in web search or deep
          research, can be incomplete or inaccurate. You may not present SPLEX-generated content as independently
          verified fact, professional advice, or as coming from a human author, in contexts where that
          representation could cause real harm (for example, medical, legal, or financial advice presented to a
          third party as authoritative).
        </p>
      </Section>

      <Section heading="5. Enforcement">
        <p>
          Violating this policy may result in warnings, feature restrictions, suspension, or termination of your
          account, at SPLEX's discretion and depending on severity. We may also take these actions to comply with
          legal obligations or to protect the Service, our users, or third parties.
        </p>
      </Section>

      <Section heading="6. Reporting a concern">
        <p>
          If you believe someone is violating this policy, or you've found a security issue, please report it
          through the contact information provided within the Service rather than attempting to investigate or
          exploit it yourself.
        </p>
      </Section>
    </LegalShell>
  );
}
