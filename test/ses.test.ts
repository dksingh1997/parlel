import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  SESClient,
  // Identities / verification
  VerifyEmailAddressCommand,
  VerifyEmailIdentityCommand,
  VerifyDomainIdentityCommand,
  VerifyDomainDkimCommand,
  DeleteIdentityCommand,
  DeleteVerifiedEmailAddressCommand,
  ListIdentitiesCommand,
  ListVerifiedEmailAddressesCommand,
  GetIdentityVerificationAttributesCommand,
  GetIdentityDkimAttributesCommand,
  SetIdentityDkimEnabledCommand,
  GetIdentityMailFromDomainAttributesCommand,
  SetIdentityMailFromDomainCommand,
  GetIdentityNotificationAttributesCommand,
  SetIdentityNotificationTopicCommand,
  SetIdentityFeedbackForwardingEnabledCommand,
  SetIdentityHeadersInNotificationsEnabledCommand,
  // Identity policies
  PutIdentityPolicyCommand,
  GetIdentityPoliciesCommand,
  ListIdentityPoliciesCommand,
  DeleteIdentityPolicyCommand,
  // Sending
  SendEmailCommand,
  SendRawEmailCommand,
  SendTemplatedEmailCommand,
  SendBulkTemplatedEmailCommand,
  SendCustomVerificationEmailCommand,
  SendBounceCommand,
  // Account / stats
  GetSendQuotaCommand,
  GetSendStatisticsCommand,
  GetAccountSendingEnabledCommand,
  UpdateAccountSendingEnabledCommand,
  // Templates
  CreateTemplateCommand,
  GetTemplateCommand,
  UpdateTemplateCommand,
  DeleteTemplateCommand,
  ListTemplatesCommand,
  TestRenderTemplateCommand,
  // Custom verification email templates
  CreateCustomVerificationEmailTemplateCommand,
  GetCustomVerificationEmailTemplateCommand,
  UpdateCustomVerificationEmailTemplateCommand,
  DeleteCustomVerificationEmailTemplateCommand,
  ListCustomVerificationEmailTemplatesCommand,
  // Configuration sets
  CreateConfigurationSetCommand,
  DescribeConfigurationSetCommand,
  DeleteConfigurationSetCommand,
  ListConfigurationSetsCommand,
  PutConfigurationSetDeliveryOptionsCommand,
  UpdateConfigurationSetReputationMetricsEnabledCommand,
  UpdateConfigurationSetSendingEnabledCommand,
  // Configuration set event destinations
  CreateConfigurationSetEventDestinationCommand,
  UpdateConfigurationSetEventDestinationCommand,
  DeleteConfigurationSetEventDestinationCommand,
  // Configuration set tracking options
  CreateConfigurationSetTrackingOptionsCommand,
  UpdateConfigurationSetTrackingOptionsCommand,
  DeleteConfigurationSetTrackingOptionsCommand,
  // Receipt rule sets
  CreateReceiptRuleSetCommand,
  DeleteReceiptRuleSetCommand,
  DescribeReceiptRuleSetCommand,
  ListReceiptRuleSetsCommand,
  CloneReceiptRuleSetCommand,
  DescribeActiveReceiptRuleSetCommand,
  SetActiveReceiptRuleSetCommand,
  ReorderReceiptRuleSetCommand,
  // Receipt rules
  CreateReceiptRuleCommand,
  UpdateReceiptRuleCommand,
  DeleteReceiptRuleCommand,
  DescribeReceiptRuleCommand,
  SetReceiptRulePositionCommand,
  // Receipt filters
  CreateReceiptFilterCommand,
  DeleteReceiptFilterCommand,
  ListReceiptFiltersCommand,
} from "@aws-sdk/client-ses";
import { SesServer } from "../services/ses/src/server.js";

const PORT = 14570;
const ENDPOINT = `http://127.0.0.1:${PORT}`;

function makeClient() {
  return new SESClient({
    region: "us-east-1",
    endpoint: ENDPOINT,
    credentials: { accessKeyId: "parlel", secretAccessKey: "parlel" },
  });
}

async function expectError(promise: Promise<unknown>, code: string) {
  try {
    await promise;
    throw new Error(`expected error ${code} but call succeeded`);
  } catch (err: any) {
    const name = err?.name || err?.Code || err?.code || "";
    const combined = `${name} ${err?.message || ""}`;
    expect(combined).toContain(code);
    return err;
  }
}

describe("SES Service", () => {
  let server: SesServer;
  let ses: SESClient;

  beforeAll(async () => {
    server = new SesServer(PORT);
    await server.start();
    ses = makeClient();
    await new Promise((r) => setTimeout(r, 100));
  }, 15000);

  afterAll(async () => {
    ses.destroy();
    await server.stop();
  });

  beforeEach(() => {
    server.reset();
  });

  async function verifyEmail(addr: string) {
    await ses.send(new VerifyEmailIdentityCommand({ EmailAddress: addr }));
  }

  async function verifyDomain(domain: string) {
    await ses.send(new VerifyDomainIdentityCommand({ Domain: domain }));
  }

  // -----------------------------------------------------------------------
  describe("Server lifecycle", () => {
    it("listens on the configured port", () => {
      expect(server.port).toBe(PORT);
    });

    it("defaults to port 4570", () => {
      const s = new SesServer();
      expect(s.port).toBe(4570);
    });

    it("exposes a health endpoint", async () => {
      const res = await fetch(`${ENDPOINT}/_parlel/health`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("ok");
      expect(body.service).toBe("ses");
    });

    it("supports reset via POST /_parlel/reset", async () => {
      await verifyEmail("a@example.com");
      const res = await fetch(`${ENDPOINT}/_parlel/reset`, { method: "POST" });
      expect(res.status).toBe(200);
      const list = await ses.send(new ListIdentitiesCommand({}));
      expect(list.Identities).toEqual([]);
    });

    it("returns an error for an unknown action", async () => {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "Action=NotARealAction&Version=2010-12-01",
      });
      expect(res.status).toBe(400);
      const text = await res.text();
      expect(text).toContain("InvalidAction");
    });
  });

  // -----------------------------------------------------------------------
  describe("Identity verification", () => {
    it("verifies an email identity", async () => {
      await ses.send(new VerifyEmailIdentityCommand({ EmailAddress: "user@example.com" }));
      const list = await ses.send(new ListIdentitiesCommand({ IdentityType: "EmailAddress" }));
      expect(list.Identities).toContain("user@example.com");
    });

    it("verifies a legacy email address", async () => {
      await ses.send(new VerifyEmailAddressCommand({ EmailAddress: "legacy@example.com" }));
      const list = await ses.send(new ListVerifiedEmailAddressesCommand({}));
      expect(list.VerifiedEmailAddresses).toContain("legacy@example.com");
    });

    it("rejects an invalid email address", async () => {
      await expectError(
        ses.send(new VerifyEmailIdentityCommand({ EmailAddress: "not-an-email" })),
        "InvalidParameterValue",
      );
    });

    it("verifies a domain identity and returns a token", async () => {
      const res = await ses.send(new VerifyDomainIdentityCommand({ Domain: "example.com" }));
      expect(res.VerificationToken).toBeTruthy();
      const list = await ses.send(new ListIdentitiesCommand({ IdentityType: "Domain" }));
      expect(list.Identities).toContain("example.com");
    });

    it("verifies domain DKIM and returns 3 tokens", async () => {
      await verifyDomain("example.com");
      const res = await ses.send(new VerifyDomainDkimCommand({ Domain: "example.com" }));
      expect(res.DkimTokens).toHaveLength(3);
    });

    it("gets identity verification attributes", async () => {
      await verifyEmail("user@example.com");
      await verifyDomain("example.com");
      const res = await ses.send(
        new GetIdentityVerificationAttributesCommand({
          Identities: ["user@example.com", "example.com"],
        }),
      );
      expect(res.VerificationAttributes?.["user@example.com"]?.VerificationStatus).toBe("Success");
      expect(res.VerificationAttributes?.["example.com"]?.VerificationStatus).toBe("Success");
    });

    it("gets DKIM attributes for a domain", async () => {
      await verifyDomain("example.com");
      await ses.send(new VerifyDomainDkimCommand({ Domain: "example.com" }));
      const res = await ses.send(
        new GetIdentityDkimAttributesCommand({ Identities: ["example.com"] }),
      );
      expect(res.DkimAttributes?.["example.com"]?.DkimEnabled).toBe(true);
      expect(res.DkimAttributes?.["example.com"]?.DkimTokens).toHaveLength(3);
    });

    it("sets DKIM enabled", async () => {
      await verifyDomain("example.com");
      await ses.send(
        new SetIdentityDkimEnabledCommand({ Identity: "example.com", DkimEnabled: false }),
      );
      const res = await ses.send(
        new GetIdentityDkimAttributesCommand({ Identities: ["example.com"] }),
      );
      expect(res.DkimAttributes?.["example.com"]?.DkimEnabled).toBe(false);
    });

    it("deletes an identity", async () => {
      await verifyEmail("user@example.com");
      await ses.send(new DeleteIdentityCommand({ Identity: "user@example.com" }));
      const list = await ses.send(new ListIdentitiesCommand({}));
      expect(list.Identities).not.toContain("user@example.com");
    });

    it("deletes a verified email address (legacy)", async () => {
      await ses.send(new VerifyEmailAddressCommand({ EmailAddress: "legacy@example.com" }));
      await ses.send(
        new DeleteVerifiedEmailAddressCommand({ EmailAddress: "legacy@example.com" }),
      );
      const list = await ses.send(new ListVerifiedEmailAddressesCommand({}));
      expect(list.VerifiedEmailAddresses).not.toContain("legacy@example.com");
    });

    it("filters ListIdentities by type", async () => {
      await verifyEmail("user@example.com");
      await verifyDomain("example.com");
      const emails = await ses.send(new ListIdentitiesCommand({ IdentityType: "EmailAddress" }));
      const domains = await ses.send(new ListIdentitiesCommand({ IdentityType: "Domain" }));
      expect(emails.Identities).toEqual(["user@example.com"]);
      expect(domains.Identities).toEqual(["example.com"]);
    });
  });

  // -----------------------------------------------------------------------
  describe("MAIL FROM and notifications", () => {
    it("sets and gets a MAIL FROM domain", async () => {
      await verifyDomain("example.com");
      await ses.send(
        new SetIdentityMailFromDomainCommand({
          Identity: "example.com",
          MailFromDomain: "mail.example.com",
          BehaviorOnMXFailure: "UseDefaultValue",
        }),
      );
      const res = await ses.send(
        new GetIdentityMailFromDomainAttributesCommand({ Identities: ["example.com"] }),
      );
      expect(res.MailFromDomainAttributes?.["example.com"]?.MailFromDomain).toBe(
        "mail.example.com",
      );
    });

    it("sets a notification topic and reads it back", async () => {
      await verifyDomain("example.com");
      const topicArn = "arn:aws:sns:us-east-1:000000000000:bounces";
      await ses.send(
        new SetIdentityNotificationTopicCommand({
          Identity: "example.com",
          NotificationType: "Bounce",
          SnsTopic: topicArn,
        }),
      );
      const res = await ses.send(
        new GetIdentityNotificationAttributesCommand({ Identities: ["example.com"] }),
      );
      expect(res.NotificationAttributes?.["example.com"]?.BounceTopic).toBe(topicArn);
    });

    it("toggles feedback forwarding", async () => {
      await verifyDomain("example.com");
      await ses.send(
        new SetIdentityFeedbackForwardingEnabledCommand({
          Identity: "example.com",
          ForwardingEnabled: false,
        }),
      );
      const res = await ses.send(
        new GetIdentityNotificationAttributesCommand({ Identities: ["example.com"] }),
      );
      expect(res.NotificationAttributes?.["example.com"]?.ForwardingEnabled).toBe(false);
    });

    it("toggles headers in notifications", async () => {
      await verifyDomain("example.com");
      await ses.send(
        new SetIdentityHeadersInNotificationsEnabledCommand({
          Identity: "example.com",
          NotificationType: "Bounce",
          Enabled: true,
        }),
      );
      const res = await ses.send(
        new GetIdentityNotificationAttributesCommand({ Identities: ["example.com"] }),
      );
      expect(
        res.NotificationAttributes?.["example.com"]?.HeadersInBounceNotificationsEnabled,
      ).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  describe("Identity policies", () => {
    const policy = JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        { Effect: "Allow", Principal: { AWS: "*" }, Action: "ses:SendEmail", Resource: "*" },
      ],
    });

    it("puts, gets, lists and deletes an identity policy", async () => {
      await verifyDomain("example.com");
      await ses.send(
        new PutIdentityPolicyCommand({
          Identity: "example.com",
          PolicyName: "p1",
          Policy: policy,
        }),
      );
      const listed = await ses.send(
        new ListIdentityPoliciesCommand({ Identity: "example.com" }),
      );
      expect(listed.PolicyNames).toContain("p1");

      const got = await ses.send(
        new GetIdentityPoliciesCommand({ Identity: "example.com", PolicyNames: ["p1"] }),
      );
      expect(got.Policies?.p1).toBe(policy);

      await ses.send(
        new DeleteIdentityPolicyCommand({ Identity: "example.com", PolicyName: "p1" }),
      );
      const after = await ses.send(
        new ListIdentityPoliciesCommand({ Identity: "example.com" }),
      );
      expect(after.PolicyNames).not.toContain("p1");
    });
  });

  // -----------------------------------------------------------------------
  describe("Sending email", () => {
    it("sends a simple email from a verified address", async () => {
      await verifyEmail("sender@example.com");
      const res = await ses.send(
        new SendEmailCommand({
          Source: "sender@example.com",
          Destination: { ToAddresses: ["dest@example.com"] },
          Message: {
            Subject: { Data: "Hello" },
            Body: { Text: { Data: "World" } },
          },
        }),
      );
      expect(res.MessageId).toBeTruthy();
    });

    it("rejects sending from an unverified address", async () => {
      await expectError(
        ses.send(
          new SendEmailCommand({
            Source: "nobody@example.com",
            Destination: { ToAddresses: ["dest@example.com"] },
            Message: { Subject: { Data: "Hi" }, Body: { Text: { Data: "x" } } },
          }),
        ),
        "MessageRejected",
      );
    });

    it("allows sending from any address on a verified domain", async () => {
      await verifyDomain("example.com");
      const res = await ses.send(
        new SendEmailCommand({
          Source: "anything@example.com",
          Destination: { ToAddresses: ["dest@other.com"] },
          Message: { Subject: { Data: "Hi" }, Body: { Html: { Data: "<p>x</p>" } } },
        }),
      );
      expect(res.MessageId).toBeTruthy();
    });

    it("rejects when no recipients are present", async () => {
      await verifyEmail("sender@example.com");
      await expectError(
        ses.send(
          new SendEmailCommand({
            Source: "sender@example.com",
            Destination: {},
            Message: { Subject: { Data: "Hi" }, Body: { Text: { Data: "x" } } },
          }),
        ),
        "InvalidParameterValue",
      );
    });

    it("sends a raw email", async () => {
      await verifyEmail("sender@example.com");
      const raw = [
        "From: sender@example.com",
        "To: dest@example.com",
        "Subject: Raw",
        "",
        "Body here",
      ].join("\r\n");
      const res = await ses.send(
        new SendRawEmailCommand({
          RawMessage: { Data: new TextEncoder().encode(raw) },
        }),
      );
      expect(res.MessageId).toBeTruthy();
    });

    it("increments the send quota counter", async () => {
      await verifyEmail("sender@example.com");
      await ses.send(
        new SendEmailCommand({
          Source: "sender@example.com",
          Destination: { ToAddresses: ["dest@example.com"] },
          Message: { Subject: { Data: "Hi" }, Body: { Text: { Data: "x" } } },
        }),
      );
      const quota = await ses.send(new GetSendQuotaCommand({}));
      expect(quota.SentLast24Hours).toBe(1);
    });

    it("blocks sending when account sending is disabled", async () => {
      await verifyEmail("sender@example.com");
      await ses.send(new UpdateAccountSendingEnabledCommand({ Enabled: false }));
      await expectError(
        ses.send(
          new SendEmailCommand({
            Source: "sender@example.com",
            Destination: { ToAddresses: ["dest@example.com"] },
            Message: { Subject: { Data: "Hi" }, Body: { Text: { Data: "x" } } },
          }),
        ),
        "AccountSendingPausedException",
      );
      await ses.send(new UpdateAccountSendingEnabledCommand({ Enabled: true }));
    });
  });

  // -----------------------------------------------------------------------
  describe("Templated sending", () => {
    async function createTemplate(name: string) {
      await ses.send(
        new CreateTemplateCommand({
          Template: {
            TemplateName: name,
            SubjectPart: "Hi {{name}}",
            TextPart: "Hello {{name}}, welcome!",
            HtmlPart: "<h1>Hello {{name}}</h1>",
          },
        }),
      );
    }

    it("sends a templated email", async () => {
      await verifyEmail("sender@example.com");
      await createTemplate("welcome");
      const res = await ses.send(
        new SendTemplatedEmailCommand({
          Source: "sender@example.com",
          Destination: { ToAddresses: ["dest@example.com"] },
          Template: "welcome",
          TemplateData: JSON.stringify({ name: "Sam" }),
        }),
      );
      expect(res.MessageId).toBeTruthy();
    });

    it("rejects a templated email for a missing template", async () => {
      await verifyEmail("sender@example.com");
      await expectError(
        ses.send(
          new SendTemplatedEmailCommand({
            Source: "sender@example.com",
            Destination: { ToAddresses: ["dest@example.com"] },
            Template: "nope",
            TemplateData: "{}",
          }),
        ),
        "TemplateDoesNotExist",
      );
    });

    it("sends a bulk templated email and returns per-destination status", async () => {
      await verifyEmail("sender@example.com");
      await createTemplate("welcome");
      const res = await ses.send(
        new SendBulkTemplatedEmailCommand({
          Source: "sender@example.com",
          Template: "welcome",
          DefaultTemplateData: JSON.stringify({ name: "x" }),
          Destinations: [
            {
              Destination: { ToAddresses: ["a@example.com"] },
              ReplacementTemplateData: JSON.stringify({ name: "A" }),
            },
            {
              Destination: { ToAddresses: ["b@example.com"] },
              ReplacementTemplateData: JSON.stringify({ name: "B" }),
            },
          ],
        }),
      );
      expect(res.Status).toHaveLength(2);
      expect(res.Status?.[0]?.Status).toBe("Success");
      expect(res.Status?.[0]?.MessageId).toBeTruthy();
    });
  });

  // -----------------------------------------------------------------------
  describe("Email templates", () => {
    it("creates, gets, updates, lists and deletes a template", async () => {
      await ses.send(
        new CreateTemplateCommand({
          Template: { TemplateName: "t1", SubjectPart: "S", TextPart: "T" },
        }),
      );
      const got = await ses.send(new GetTemplateCommand({ TemplateName: "t1" }));
      expect(got.Template?.SubjectPart).toBe("S");

      await ses.send(
        new UpdateTemplateCommand({
          Template: { TemplateName: "t1", SubjectPart: "S2", TextPart: "T2" },
        }),
      );
      const got2 = await ses.send(new GetTemplateCommand({ TemplateName: "t1" }));
      expect(got2.Template?.SubjectPart).toBe("S2");

      const list = await ses.send(new ListTemplatesCommand({}));
      expect(list.TemplatesMetadata?.some((t) => t.Name === "t1")).toBe(true);

      await ses.send(new DeleteTemplateCommand({ TemplateName: "t1" }));
      await expectError(
        ses.send(new GetTemplateCommand({ TemplateName: "t1" })),
        "TemplateDoesNotExist",
      );
    });

    it("rejects a duplicate template", async () => {
      await ses.send(
        new CreateTemplateCommand({ Template: { TemplateName: "dup", TextPart: "x" } }),
      );
      await expectError(
        ses.send(
          new CreateTemplateCommand({ Template: { TemplateName: "dup", TextPart: "x" } }),
        ),
        "AlreadyExists",
      );
    });

    it("rejects a template with no parts", async () => {
      await expectError(
        ses.send(new CreateTemplateCommand({ Template: { TemplateName: "empty" } })),
        "InvalidParameterValue",
      );
    });

    it("renders a template with TestRenderTemplate", async () => {
      await ses.send(
        new CreateTemplateCommand({
          Template: {
            TemplateName: "render",
            SubjectPart: "Hi {{name}}",
            TextPart: "Hello {{name}}",
          },
        }),
      );
      const res = await ses.send(
        new TestRenderTemplateCommand({
          TemplateName: "render",
          TemplateData: JSON.stringify({ name: "Sam" }),
        }),
      );
      expect(res.RenderedTemplate).toContain("Hi Sam");
    });

    it("fails to render when a placeholder value is missing", async () => {
      await ses.send(
        new CreateTemplateCommand({
          Template: { TemplateName: "render2", SubjectPart: "Hi {{name}}", TextPart: "x" },
        }),
      );
      await expectError(
        ses.send(
          new TestRenderTemplateCommand({ TemplateName: "render2", TemplateData: "{}" }),
        ),
        "MissingRenderingAttribute",
      );
    });
  });

  // -----------------------------------------------------------------------
  describe("Custom verification email templates", () => {
    async function createCustom(name: string) {
      await ses.send(
        new CreateCustomVerificationEmailTemplateCommand({
          TemplateName: name,
          FromEmailAddress: "verify@example.com",
          TemplateSubject: "Verify",
          TemplateContent: "<p>Click to verify</p>",
          SuccessRedirectionURL: "https://example.com/ok",
          FailureRedirectionURL: "https://example.com/fail",
        }),
      );
    }

    it("creates, gets, updates, lists and deletes a custom template", async () => {
      await createCustom("cv1");
      const got = await ses.send(
        new GetCustomVerificationEmailTemplateCommand({ TemplateName: "cv1" }),
      );
      expect(got.TemplateSubject).toBe("Verify");

      await ses.send(
        new UpdateCustomVerificationEmailTemplateCommand({
          TemplateName: "cv1",
          TemplateSubject: "Verify Now",
        }),
      );
      const got2 = await ses.send(
        new GetCustomVerificationEmailTemplateCommand({ TemplateName: "cv1" }),
      );
      expect(got2.TemplateSubject).toBe("Verify Now");

      const list = await ses.send(new ListCustomVerificationEmailTemplatesCommand({}));
      expect(
        list.CustomVerificationEmailTemplates?.some((t) => t.TemplateName === "cv1"),
      ).toBe(true);

      await ses.send(
        new DeleteCustomVerificationEmailTemplateCommand({ TemplateName: "cv1" }),
      );
      await expectError(
        ses.send(new GetCustomVerificationEmailTemplateCommand({ TemplateName: "cv1" })),
        "CustomVerificationEmailTemplateDoesNotExist",
      );
    });

    it("sends a custom verification email", async () => {
      await createCustom("cv2");
      const res = await ses.send(
        new SendCustomVerificationEmailCommand({
          EmailAddress: "newuser@example.com",
          TemplateName: "cv2",
        }),
      );
      expect(res.MessageId).toBeTruthy();
    });
  });

  // -----------------------------------------------------------------------
  describe("Configuration sets", () => {
    it("creates, describes, lists and deletes a configuration set", async () => {
      await ses.send(
        new CreateConfigurationSetCommand({ ConfigurationSet: { Name: "cs1" } }),
      );
      const desc = await ses.send(
        new DescribeConfigurationSetCommand({ ConfigurationSetName: "cs1" }),
      );
      expect(desc.ConfigurationSet?.Name).toBe("cs1");

      const list = await ses.send(new ListConfigurationSetsCommand({}));
      expect(list.ConfigurationSets?.some((c) => c.Name === "cs1")).toBe(true);

      await ses.send(new DeleteConfigurationSetCommand({ ConfigurationSetName: "cs1" }));
      await expectError(
        ses.send(new DescribeConfigurationSetCommand({ ConfigurationSetName: "cs1" })),
        "ConfigurationSetDoesNotExist",
      );
    });

    it("rejects a duplicate configuration set", async () => {
      await ses.send(
        new CreateConfigurationSetCommand({ ConfigurationSet: { Name: "dupcs" } }),
      );
      await expectError(
        ses.send(new CreateConfigurationSetCommand({ ConfigurationSet: { Name: "dupcs" } })),
        "ConfigurationSetAlreadyExists",
      );
    });

    it("updates reputation metrics and sending enabled", async () => {
      await ses.send(
        new CreateConfigurationSetCommand({ ConfigurationSet: { Name: "cs2" } }),
      );
      await ses.send(
        new UpdateConfigurationSetReputationMetricsEnabledCommand({
          ConfigurationSetName: "cs2",
          Enabled: true,
        }),
      );
      await ses.send(
        new UpdateConfigurationSetSendingEnabledCommand({
          ConfigurationSetName: "cs2",
          Enabled: false,
        }),
      );
      const desc = await ses.send(
        new DescribeConfigurationSetCommand({
          ConfigurationSetName: "cs2",
          ConfigurationSetAttributeNames: ["reputationOptions"],
        }),
      );
      expect(desc.ReputationOptions?.ReputationMetricsEnabled).toBe(true);
      expect(desc.ReputationOptions?.SendingEnabled).toBe(false);
    });

    it("puts delivery options", async () => {
      await ses.send(
        new CreateConfigurationSetCommand({ ConfigurationSet: { Name: "cs3" } }),
      );
      await ses.send(
        new PutConfigurationSetDeliveryOptionsCommand({
          ConfigurationSetName: "cs3",
          DeliveryOptions: { TlsPolicy: "Require" },
        }),
      );
      const desc = await ses.send(
        new DescribeConfigurationSetCommand({
          ConfigurationSetName: "cs3",
          ConfigurationSetAttributeNames: ["deliveryOptions"],
        }),
      );
      expect(desc.DeliveryOptions?.TlsPolicy).toBe("Require");
    });
  });

  // -----------------------------------------------------------------------
  describe("Configuration set event destinations", () => {
    it("creates, updates and deletes an event destination", async () => {
      await ses.send(
        new CreateConfigurationSetCommand({ ConfigurationSet: { Name: "evt" } }),
      );
      await ses.send(
        new CreateConfigurationSetEventDestinationCommand({
          ConfigurationSetName: "evt",
          EventDestination: {
            Name: "ed1",
            Enabled: true,
            MatchingEventTypes: ["send", "bounce"],
            SNSDestination: { TopicARN: "arn:aws:sns:us-east-1:000000000000:t" },
          },
        }),
      );
      let desc = await ses.send(
        new DescribeConfigurationSetCommand({
          ConfigurationSetName: "evt",
          ConfigurationSetAttributeNames: ["eventDestinations"],
        }),
      );
      expect(desc.EventDestinations?.[0]?.Name).toBe("ed1");
      expect(desc.EventDestinations?.[0]?.MatchingEventTypes).toContain("bounce");

      await ses.send(
        new UpdateConfigurationSetEventDestinationCommand({
          ConfigurationSetName: "evt",
          EventDestination: {
            Name: "ed1",
            Enabled: false,
            MatchingEventTypes: ["complaint"],
            SNSDestination: { TopicARN: "arn:aws:sns:us-east-1:000000000000:t" },
          },
        }),
      );
      desc = await ses.send(
        new DescribeConfigurationSetCommand({
          ConfigurationSetName: "evt",
          ConfigurationSetAttributeNames: ["eventDestinations"],
        }),
      );
      expect(desc.EventDestinations?.[0]?.Enabled).toBe(false);

      await ses.send(
        new DeleteConfigurationSetEventDestinationCommand({
          ConfigurationSetName: "evt",
          EventDestinationName: "ed1",
        }),
      );
      desc = await ses.send(
        new DescribeConfigurationSetCommand({
          ConfigurationSetName: "evt",
          ConfigurationSetAttributeNames: ["eventDestinations"],
        }),
      );
      expect(desc.EventDestinations ?? []).toHaveLength(0);
    });

    it("rejects a duplicate event destination", async () => {
      await ses.send(
        new CreateConfigurationSetCommand({ ConfigurationSet: { Name: "evt2" } }),
      );
      await ses.send(
        new CreateConfigurationSetEventDestinationCommand({
          ConfigurationSetName: "evt2",
          EventDestination: {
            Name: "edx",
            Enabled: true,
            MatchingEventTypes: ["send"],
            SNSDestination: { TopicARN: "arn:aws:sns:us-east-1:000000000000:t" },
          },
        }),
      );
      await expectError(
        ses.send(
          new CreateConfigurationSetEventDestinationCommand({
            ConfigurationSetName: "evt2",
            EventDestination: {
              Name: "edx",
              Enabled: true,
              MatchingEventTypes: ["send"],
              SNSDestination: { TopicARN: "arn:aws:sns:us-east-1:000000000000:t" },
            },
          }),
        ),
        "EventDestinationAlreadyExists",
      );
    });
  });

  // -----------------------------------------------------------------------
  describe("Configuration set tracking options", () => {
    it("creates, updates and deletes tracking options", async () => {
      await ses.send(
        new CreateConfigurationSetCommand({ ConfigurationSet: { Name: "trk" } }),
      );
      await ses.send(
        new CreateConfigurationSetTrackingOptionsCommand({
          ConfigurationSetName: "trk",
          TrackingOptions: { CustomRedirectDomain: "click.example.com" },
        }),
      );
      let desc = await ses.send(
        new DescribeConfigurationSetCommand({
          ConfigurationSetName: "trk",
          ConfigurationSetAttributeNames: ["trackingOptions"],
        }),
      );
      expect(desc.TrackingOptions?.CustomRedirectDomain).toBe("click.example.com");

      await ses.send(
        new UpdateConfigurationSetTrackingOptionsCommand({
          ConfigurationSetName: "trk",
          TrackingOptions: { CustomRedirectDomain: "track.example.com" },
        }),
      );
      desc = await ses.send(
        new DescribeConfigurationSetCommand({
          ConfigurationSetName: "trk",
          ConfigurationSetAttributeNames: ["trackingOptions"],
        }),
      );
      expect(desc.TrackingOptions?.CustomRedirectDomain).toBe("track.example.com");

      await ses.send(
        new DeleteConfigurationSetTrackingOptionsCommand({ ConfigurationSetName: "trk" }),
      );
      desc = await ses.send(
        new DescribeConfigurationSetCommand({
          ConfigurationSetName: "trk",
          ConfigurationSetAttributeNames: ["trackingOptions"],
        }),
      );
      expect(desc.TrackingOptions).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  describe("Account and statistics", () => {
    it("gets the send quota", async () => {
      const res = await ses.send(new GetSendQuotaCommand({}));
      expect(res.Max24HourSend).toBe(200);
      expect(res.MaxSendRate).toBe(1);
    });

    it("gets send statistics", async () => {
      const res = await ses.send(new GetSendStatisticsCommand({}));
      expect(Array.isArray(res.SendDataPoints)).toBe(true);
    });

    it("gets and updates account sending enabled", async () => {
      const before = await ses.send(new GetAccountSendingEnabledCommand({}));
      expect(before.Enabled).toBe(true);
      await ses.send(new UpdateAccountSendingEnabledCommand({ Enabled: false }));
      const after = await ses.send(new GetAccountSendingEnabledCommand({}));
      expect(after.Enabled).toBe(false);
      await ses.send(new UpdateAccountSendingEnabledCommand({ Enabled: true }));
    });
  });

  // -----------------------------------------------------------------------
  describe("Bounce", () => {
    it("sends a bounce", async () => {
      const res = await ses.send(
        new SendBounceCommand({
          OriginalMessageId: "0000abc",
          BounceSender: "mailer-daemon@example.com",
          BouncedRecipientInfoList: [
            { Recipient: "dest@example.com", BounceType: "ContentRejected" },
          ],
        }),
      );
      expect(res.MessageId).toBeTruthy();
    });
  });

  // -----------------------------------------------------------------------
  describe("Receipt rule sets and rules", () => {
    it("creates, describes, lists and deletes a rule set", async () => {
      await ses.send(new CreateReceiptRuleSetCommand({ RuleSetName: "rs1" }));
      const desc = await ses.send(
        new DescribeReceiptRuleSetCommand({ RuleSetName: "rs1" }),
      );
      expect(desc.Metadata?.Name).toBe("rs1");
      const list = await ses.send(new ListReceiptRuleSetsCommand({}));
      expect(list.RuleSets?.some((r) => r.Name === "rs1")).toBe(true);
      await ses.send(new DeleteReceiptRuleSetCommand({ RuleSetName: "rs1" }));
    });

    it("creates, describes, updates, reorders and deletes rules", async () => {
      await ses.send(new CreateReceiptRuleSetCommand({ RuleSetName: "rs2" }));
      await ses.send(
        new CreateReceiptRuleCommand({
          RuleSetName: "rs2",
          Rule: { Name: "r1", Enabled: true, Recipients: ["a@example.com"] },
        }),
      );
      await ses.send(
        new CreateReceiptRuleCommand({
          RuleSetName: "rs2",
          After: "r1",
          Rule: { Name: "r2", Enabled: true, Recipients: ["b@example.com"] },
        }),
      );
      const desc = await ses.send(
        new DescribeReceiptRuleCommand({ RuleSetName: "rs2", RuleName: "r1" }),
      );
      expect(desc.Rule?.Name).toBe("r1");

      await ses.send(
        new UpdateReceiptRuleCommand({
          RuleSetName: "rs2",
          Rule: { Name: "r1", Enabled: false, Recipients: ["a@example.com"] },
        }),
      );

      await ses.send(
        new ReorderReceiptRuleSetCommand({ RuleSetName: "rs2", RuleNames: ["r2", "r1"] }),
      );
      const set = await ses.send(new DescribeReceiptRuleSetCommand({ RuleSetName: "rs2" }));
      expect(set.Rules?.map((r) => r.Name)).toEqual(["r2", "r1"]);

      await ses.send(
        new SetReceiptRulePositionCommand({ RuleSetName: "rs2", RuleName: "r1", After: "r2" }),
      );

      await ses.send(new DeleteReceiptRuleCommand({ RuleSetName: "rs2", RuleName: "r1" }));
      const after = await ses.send(new DescribeReceiptRuleSetCommand({ RuleSetName: "rs2" }));
      expect(after.Rules?.some((r) => r.Name === "r1")).toBe(false);
    });

    it("activates a rule set and reads the active one", async () => {
      await ses.send(new CreateReceiptRuleSetCommand({ RuleSetName: "active-rs" }));
      await ses.send(new SetActiveReceiptRuleSetCommand({ RuleSetName: "active-rs" }));
      const desc = await ses.send(new DescribeActiveReceiptRuleSetCommand({}));
      expect(desc.Metadata?.Name).toBe("active-rs");
    });

    it("refuses to delete the active rule set", async () => {
      await ses.send(new CreateReceiptRuleSetCommand({ RuleSetName: "active-rs2" }));
      await ses.send(new SetActiveReceiptRuleSetCommand({ RuleSetName: "active-rs2" }));
      await expectError(
        ses.send(new DeleteReceiptRuleSetCommand({ RuleSetName: "active-rs2" })),
        "CannotDelete",
      );
    });

    it("clones a rule set", async () => {
      await ses.send(new CreateReceiptRuleSetCommand({ RuleSetName: "orig" }));
      await ses.send(
        new CreateReceiptRuleCommand({
          RuleSetName: "orig",
          Rule: { Name: "ra", Enabled: true, Recipients: ["a@example.com"] },
        }),
      );
      await ses.send(
        new CloneReceiptRuleSetCommand({ RuleSetName: "clone", OriginalRuleSetName: "orig" }),
      );
      const desc = await ses.send(new DescribeReceiptRuleSetCommand({ RuleSetName: "clone" }));
      expect(desc.Rules?.[0]?.Name).toBe("ra");
    });
  });

  // -----------------------------------------------------------------------
  describe("Receipt filters", () => {
    it("creates, lists and deletes a receipt filter", async () => {
      await ses.send(
        new CreateReceiptFilterCommand({
          Filter: {
            Name: "block-bad",
            IpFilter: { Policy: "Block", Cidr: "10.0.0.0/24" },
          },
        }),
      );
      const list = await ses.send(new ListReceiptFiltersCommand({}));
      expect(list.Filters?.some((f) => f.Name === "block-bad")).toBe(true);
      expect(list.Filters?.[0]?.IpFilter?.Policy).toBe("Block");

      await ses.send(new DeleteReceiptFilterCommand({ FilterName: "block-bad" }));
      const after = await ses.send(new ListReceiptFiltersCommand({}));
      expect(after.Filters?.some((f) => f.Name === "block-bad")).toBe(false);
    });

    it("rejects a duplicate filter", async () => {
      await ses.send(
        new CreateReceiptFilterCommand({
          Filter: { Name: "dupf", IpFilter: { Policy: "Allow", Cidr: "1.2.3.4" } },
        }),
      );
      await expectError(
        ses.send(
          new CreateReceiptFilterCommand({
            Filter: { Name: "dupf", IpFilter: { Policy: "Allow", Cidr: "1.2.3.4" } },
          }),
        ),
        "AlreadyExists",
      );
    });
  });
});
