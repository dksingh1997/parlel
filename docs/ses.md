# SES

Lightweight, dependency-free fake of AWS SES (Simple Email Service, the classic v1 API) that speaks the real SES AWS Query wire protocol (form-encoded requests, XML responses, API version `2010-12-01`), so application code using `@aws-sdk/client-ses` can run against it with zero cost and zero side effects.

| Key | Value |
|-----|-------|
| Port | 4570 |
| Protocol | AWS Query (`application/x-www-form-urlencoded` request, XML response) over HTTP |
| API version | 2010-12-01 |
| Compatible client | `@aws-sdk/client-ses` (v3) |
| Size | ~80 KB |
| Startup | < 100ms |
| State | In-memory, ephemeral, resettable |

## Quick Start

Start the server:

```js
import { SesServer } from "./services/ses/src/server.js";

const server = new SesServer(4570);
await server.start();
// ... use it ...
await server.stop();
```

Connect with the real AWS SDK client:

```js
import {
  SESClient,
  VerifyEmailIdentityCommand,
  SendEmailCommand,
} from "@aws-sdk/client-ses";

const ses = new SESClient({
  region: "us-east-1",
  endpoint: "http://127.0.0.1:4570",
  credentials: { accessKeyId: "parlel", secretAccessKey: "parlel" },
});

// Verify a sender (auto-verified in the fake)
await ses.send(new VerifyEmailIdentityCommand({ EmailAddress: "sender@example.com" }));

// Send an email
const { MessageId } = await ses.send(
  new SendEmailCommand({
    Source: "sender@example.com",
    Destination: { ToAddresses: ["dest@example.com"] },
    Message: {
      Subject: { Data: "Hello" },
      Body: { Text: { Data: "World" } },
    },
  }),
);
```

## Implemented operations

All **71** operations exposed by `@aws-sdk/client-ses` are implemented.

### Identities & verification
- `VerifyEmailAddress` (legacy) — auto-verifies an email
- `VerifyEmailIdentity` — auto-verifies an email
- `VerifyDomainIdentity` — returns a `VerificationToken`
- `VerifyDomainDkim` — returns 3 deterministic `DkimTokens`
- `DeleteIdentity`
- `DeleteVerifiedEmailAddress` (legacy)
- `ListIdentities` — supports `IdentityType`, `MaxItems`, `NextToken`
- `ListVerifiedEmailAddresses` (legacy)
- `GetIdentityVerificationAttributes`
- `GetIdentityDkimAttributes`
- `SetIdentityDkimEnabled`
- `GetIdentityMailFromDomainAttributes`
- `SetIdentityMailFromDomain`
- `GetIdentityNotificationAttributes`
- `SetIdentityNotificationTopic`
- `SetIdentityFeedbackForwardingEnabled`
- `SetIdentityHeadersInNotificationsEnabled`

### Identity policies
- `PutIdentityPolicy`
- `GetIdentityPolicies`
- `ListIdentityPolicies`
- `DeleteIdentityPolicy`

### Sending
- `SendEmail` — enforces verified `Source`, requires recipients + subject/body
- `SendRawEmail` — extracts `From:` for verification when `Source` is omitted
- `SendTemplatedEmail` — requires an existing template, validates `TemplateData` JSON
- `SendBulkTemplatedEmail` — returns per-destination `Status`
- `SendCustomVerificationEmail`
- `SendBounce`

### Account & statistics
- `GetSendQuota` — `Max24HourSend`, `MaxSendRate`, `SentLast24Hours`
- `GetSendStatistics`
- `GetAccountSendingEnabled`
- `UpdateAccountSendingEnabled` — pausing blocks all `Send*` calls

### Email templates
- `CreateTemplate`
- `GetTemplate`
- `UpdateTemplate`
- `DeleteTemplate` (idempotent)
- `ListTemplates`
- `TestRenderTemplate` — `{{placeholder}}` substitution, errors on missing data

### Custom verification email templates
- `CreateCustomVerificationEmailTemplate`
- `GetCustomVerificationEmailTemplate`
- `UpdateCustomVerificationEmailTemplate`
- `DeleteCustomVerificationEmailTemplate`
- `ListCustomVerificationEmailTemplates`

### Configuration sets
- `CreateConfigurationSet`
- `DescribeConfigurationSet` — honors `ConfigurationSetAttributeNames`
- `DeleteConfigurationSet`
- `ListConfigurationSets`
- `PutConfigurationSetDeliveryOptions`
- `UpdateConfigurationSetReputationMetricsEnabled`
- `UpdateConfigurationSetSendingEnabled`

### Configuration set event destinations
- `CreateConfigurationSetEventDestination`
- `UpdateConfigurationSetEventDestination`
- `DeleteConfigurationSetEventDestination`

### Configuration set tracking options
- `CreateConfigurationSetTrackingOptions`
- `UpdateConfigurationSetTrackingOptions`
- `DeleteConfigurationSetTrackingOptions`

### Receipt rule sets & rules
- `CreateReceiptRuleSet`
- `DeleteReceiptRuleSet` — refuses to delete the active set
- `DescribeReceiptRuleSet`
- `ListReceiptRuleSets`
- `CloneReceiptRuleSet`
- `DescribeActiveReceiptRuleSet`
- `SetActiveReceiptRuleSet`
- `ReorderReceiptRuleSet`
- `CreateReceiptRule` — supports `After` positioning
- `UpdateReceiptRule`
- `DeleteReceiptRule`
- `DescribeReceiptRule`
- `SetReceiptRulePosition`

### Receipt filters
- `CreateReceiptFilter`
- `DeleteReceiptFilter`
- `ListReceiptFilters`

## Internal (non-SES) endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/_parlel/health` | Health probe — returns `{ status, service, identities, templates, configurationSets }` |
| POST | `/_parlel/reset` | Clears all in-memory state |
| GET | `/_parlel/sent` | Returns captured sent messages (for test assertions) |

`server.reset()` resets all state in-process as well.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Supported | Notes |
|---------|-----------|-------|
| Full SES v1 API surface (71 operations) | ✅ | Every `@aws-sdk/client-ses` command |
| AWS Query protocol (form request / XML response) | ✅ | API version `2010-12-01` |
| Identity verification | ✅ | Emails & domains auto-verify; DKIM tokens are deterministic |
| Identity policies, MAIL FROM, notifications | ✅ | Stored in-memory per identity |
| Email / raw / templated / bulk / custom verification sending | ✅ | Sender verification enforced |
| Template rendering (`{{placeholder}}`) | ✅ | Basic mustache-style substitution |
| Configuration sets, event destinations, tracking, delivery options | ✅ | Stored & described |
| Receipt rule sets, rules, filters | ✅ | Full CRUD + ordering + active set |
| Send quota / statistics | ✅ | Quota fixed at 200/day, rate 1/s; counter tracks sends |
| Real email delivery | ⟳ Roadmap |
| Real DKIM/SPF/DMARC validation | ✓ By design — Intentional for a local, zero-cost test emulator |
| Actual event/notification publishing to SNS/Firehose/CloudWatch | ✓ By design — Intentional for a local, zero-cost test emulator |
| Sandbox/production-access enforcement | ⟳ Roadmap |
| IAM / SigV4 signature verification | ✓ By design — Structurally faithful tokens; cryptographic verification is skipped for local use |
| SESv2 API (`@aws-sdk/client-sesv2`) | ⟳ Roadmap |

## Error codes & shapes

Errors are returned as standard AWS Query XML with a non-2xx status:

```xml
<?xml version="1.0"?>
<ErrorResponse xmlns="http://ses.amazonaws.com/doc/2010-12-01/">
  <Error>
    <Type>Sender</Type>
    <Code>MessageRejected</Code>
    <Message>Email address is not verified. ...</Message>
  </Error>
  <RequestId>...</RequestId>
</ErrorResponse>
```

`Type` is `Sender` for 4xx (client fault) and `Receiver` for 5xx (server fault). Common codes:

| Code | Status | When |
|------|--------|------|
| `InvalidParameterValue` | 400 | Bad / missing parameters, invalid email |
| `MessageRejected` | 400 | Sending from an unverified identity |
| `AccountSendingPausedException` | 400 | Account sending disabled |
| `TemplateDoesNotExistException` | 400 | Template not found |
| `AlreadyExistsException` | 400 | Duplicate template / rule / filter / rule set |
| `ConfigurationSetDoesNotExistException` | 400 | Config set not found |
| `ConfigurationSetAlreadyExistsException` | 400 | Duplicate config set |
| `EventDestinationAlreadyExistsException` | 400 | Duplicate event destination |
| `EventDestinationDoesNotExistException` | 400 | Event destination not found |
| `TrackingOptionsAlreadyExistsException` | 400 | Tracking options already set |
| `TrackingOptionsDoesNotExistException` | 400 | Tracking options not set |
| `CustomVerificationEmailTemplateAlreadyExistsException` | 400 | Duplicate custom template |
| `CustomVerificationEmailTemplateDoesNotExistException` | 400 | Custom template not found |
| `RuleSetDoesNotExistException` | 400 | Receipt rule set not found |
| `RuleDoesNotExistException` | 400 | Receipt rule not found |
| `CannotDeleteException` | 400 | Deleting the active receipt rule set |
| `MissingRenderingAttributeException` | 400 | `TestRenderTemplate` data missing a placeholder |
| `InvalidAction` | 400 | Unknown `Action` |
| `InternalError` | 500 | Unexpected server fault |

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
AWS_REGION=us-east-1
AWS_ENDPOINT_URL_SES=http://localhost:4570
AWS_ENDPOINT_URL=http://localhost:4570
```

<!-- parlel:testenv:end -->
