# Mailchimp

Lightweight, dependency-free, in-memory fake of the **Mailchimp Marketing API (v3.0)** for testing code that uses the official `@mailchimp/mailchimp_marketing` Node.js client (and the language-agnostic Mailchimp Marketing REST API).

Default port: `4653`

## Quick start

Start the server:

```js
import { MailchimpServer } from "./services/mailchimp/src/server.js";

const server = new MailchimpServer(4653);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point the real `@mailchimp/mailchimp_marketing` client at it. The client builds its host from the `server` prefix (`https://<prefix>.api.mailchimp.com`). Because the client constructs that host internally, override `basePath` on the underlying API config (or run behind a proxy / hosts entry) to target the parlel fake at `http://127.0.0.1:4653/3.0`:

```js
const mailchimp = require("@mailchimp/mailchimp_marketing");

mailchimp.setConfig({
  apiKey: "parlel-us1",   // any non-empty key works (Basic auth)
  server: "us1",
});

// Point the generated client at the parlel fake:
mailchimp.config.basePath = "http://127.0.0.1:4653/3.0";

const pong = await mailchimp.ping.get();
// => { health_status: "Everything's Chimpy!" }

const list = await mailchimp.lists.createList({
  name: "Parlel Newsletter",
  permission_reminder: "You signed up at parlel.test",
  email_type_option: true,
  contact: { company: "parlel", address1: "1 Test St", city: "Testville", state: "CA", zip: "00000", country: "US" },
  campaign_defaults: { from_name: "parlel", from_email: "hello@parlel.test", subject: "", language: "en" },
});

await mailchimp.lists.addListMember(list.id, {
  email_address: "subscriber@parlel.test",
  status: "subscribed",
  merge_fields: { FNAME: "Test", LNAME: "User" },
});
```

### Authentication

The client prefixes every request with `/3.0`. The fake accepts paths **with or without** the `/3.0` prefix.

## Implemented operations

Grouped by client namespace. Every operation below is covered by `tests/mailchimp.test.ts`.

### Root + Ping
- `root.getRoot` — `GET /` (account info)
- `ping.get` — `GET /ping`

### Lists / Audiences (`lists.*`)
- `getAllLists`, `createList`, `getList`, `updateList`, `deleteList` — `/lists`, `/lists/{id}` (supports `offset`/`count` pagination)
- `batchListMembers` — `POST /lists/{id}` (bulk upsert)
- **Members:** `getListMembersInfo`, `addListMember`, `getListMember`, `setListMember` (PUT upsert), `updateListMember`, `deleteListMember`, `deleteListMemberPermanent` (`status` filter supported)
- **Member tags:** `getListMemberTags`, `updateListMemberTags`
- **Member notes:** `getListMemberNotes`, `createListMemberNote`, `getListMemberNote`, `updateListMemberNote`, `deleteListMemberNote`
- **Member sub-resources:** `events`, `activity`, `activity-feed`, `goals` (stubs returning empty collections)
- **Merge fields:** `getListMergeFields`, `addListMergeField`, `getListMergeField`, `updateListMergeField`, `deleteListMergeField`
- **Segments:** `listSegments`, `createSegment`, `getSegment`, `updateSegment`, `deleteSegment`, `batchSegmentMembers`, `getSegmentMembersList`, `createSegmentMember`, `removeSegmentMember`
- **Interest categories:** `getListInterestCategories`, `createListInterestCategory`, `getInterestCategory`, `updateInterestCategory`, `deleteInterestCategory`
- **Interests:** `listInterestCategoryInterests`, `createInterestCategoryInterest`, `getInterestCategoryInterest`, `updateInterestCategoryInterest`, `deleteInterestCategoryInterest`
- **Webhooks:** `getListWebhooks`, `createListWebhook`, `getListWebhook`, `updateListWebhook`, `deleteListWebhook`
- **Read-only:** `getListGrowthHistory`, `getListGrowthHistoryByMonth`, `getListActivity`, `getListClients`, `getListLocations`, `tagSearch`, `getListAbuseReports`, `getListSignupForms`, `updateListSignupForm`

### Campaigns (`campaigns.*`)
- `list`, `create`, `get`, `update`, `remove`
- `getContent`, `setContent` — `/campaigns/{id}/content`
- `getSendChecklist` — `/campaigns/{id}/send-checklist`
- **Actions:** `send`, `schedule`, `unschedule`, `pause`, `resume`, `cancelSend`, `sendTestEmail`, `replicate`, `createResend`
- **Feedback:** `getFeedback`, `addFeedback`, `getFeedbackMessage`, `updateFeedbackMessage`, `deleteFeedbackMessage`

### Campaign Folders (`campaignFolders.*`)
- `list`, `create`, `get`, `update`, `remove`

### Templates (`templates.*`)
- `list`, `create`, `getTemplate`, `updateTemplate`, `deleteTemplate`, `getDefaultContentForTemplate`

### Template Folders (`templateFolders.*`)
- `list`, `create`, `get`, `update`, `remove`

### Reports (`reports.*`, read-only)
- `getAllCampaignReports`, `getCampaignReport`
- Sub-reports: `getCampaignClickDetails`, `getEmailActivityForCampaign`, `getCampaignOpenDetails`, `getUnsubscribedListForCampaign`, `getCampaignAbuseReports`, `getCampaignAdvice`, `getDomainPerformanceForCampaign`, `getCampaignRecipients`, `getSubReportsForCampaign`, `getLocationsForCampaign`, `getEepurlActivityForCampaign`, `getEcommerceProductActivityForCampaign` (return empty collections)

### E-commerce (`ecommerce.*`)
- **Stores:** `stores`, `addStore`, `getStore`, `updateStore`, `deleteStore`, `orders` (account-wide)
- **Products:** `getAllStoreProducts`, `addStoreProduct`, `getStoreProduct`, `updateStoreProduct`, `deleteStoreProduct`
- **Customers:** `getAllStoreCustomers`, `addStoreCustomer`, `getStoreCustomer`, `setStoreCustomer` (PUT upsert), `deleteStoreCustomer`
- **Orders:** `getStoreOrders`, `addStoreOrder`, `getOrder`, `deleteOrder`
- **Carts:** `getStoreCarts`, `addStoreCart`, `getStoreCart`, `deleteStoreCart`, `getAllCartLineItems`, `addCartLineItem` (generic line sub-collections for carts/orders/products)

### File Manager (`fileManager.*`)
- **Files:** `files`, `upload`, `getFile`, `updateFile`, `deleteFile`
- **Folders:** `listFolders`, `createFolder`, `getFolder`, `updateFolder`, `deleteFolder`, files-in-folder listing

### Verified Domains (`verifiedDomains.*`)
- `getVerifiedDomainsAll`, `createVerifiedDomain`, `getDomain`, `submitDomainVerification`, `deleteDomain`

### Batch Operations (`batches.*`)
- `list`, `start`, `status`, `deleteRequest` (batches complete synchronously and report `finished`)

### Search
- `searchMembers.search` — `GET /search-members` (exact + partial match)
- `searchCampaigns.search` — `GET /search-campaigns` (empty result set)

### parlel control / inspection (not part of Mailchimp)
- `POST /__parlel/reset` — reset all in-memory state
- `GET /__parlel/state` — counts of lists / members / campaigns / templates / stores
- `GET /health` — `{ "status": "ok" }` (no auth required)

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status | Notes |
| --- | --- | --- |
| Root + Ping | ✅ Supported | |
| Lists/Audiences + members | ✅ Supported | Full CRUD, MD5 subscriber-hash addressing |
| Member tags / notes / merge fields | ✅ Supported | |
| Segments (static + saved) | ✅ Supported | Batch add/remove members |
| Interest categories + interests | ✅ Supported | |
| List webhooks | ✅ Supported | |
| Campaigns + content + actions | ✅ Supported | send/schedule/pause/replicate/test/etc. |
| Campaign feedback | ✅ Supported | |
| Campaign + template folders | ✅ Supported | |
| Templates | ✅ Supported | Classic templates |
| Reports + sub-reports | ✅ Supported (read-only) | Sub-reports return empty collections |
| E-commerce stores/products/customers/orders/carts | ✅ Supported | Cart/order line items via sub-routes |
| File Manager files + folders | ✅ Supported | |
| Verified Domains | ✅ Supported | |
| Batch operations | ✅ Supported | Complete synchronously |
| Search members / campaigns | ✅ Supported | |
| Member event metrics, activity feeds | ⚠️ Stubbed | Return empty collections |
| List growth/activity/clients/locations | ⚠️ Stubbed | Return empty collections |
| Automation flows (Customer Journeys) | ⟳ Roadmap |
| Classic Automations | ⟳ Roadmap |
| Connected Sites | ⟳ Roadmap |
| Conversations (deprecated) | ⟳ Roadmap |
| Facebook Ads | ⟳ Roadmap |
| Landing Pages | ⟳ Roadmap |
| Surveys + survey reporting | ⟳ Roadmap |
| Account Exports | ⟳ Roadmap |
| Authorized Apps | ⟳ Roadmap |
| Batch Webhooks | ⟳ Roadmap |
| Promo rules / promo codes / product images / variants | ⟳ Roadmap |

Unsupported endpoints return a Mailchimp-shaped `404 Resource Not Found`.

## Error codes / shapes

Errors follow Mailchimp's RFC 7807 `problem+json` envelope:

```json
{
  "type": "https://mailchimp.com/developer/marketing/docs/errors/",
  "title": "Invalid Resource",
  "status": 400,
  "detail": "The resource submitted could not be validated. For field-specific details, see the 'errors' array.",
  "instance": "<uuid>",
  "errors": [{ "field": "name", "message": "..." }]
}
```

| Status | Title | When |
| --- | --- | --- |
| 400 | Invalid Resource | Missing/invalid required fields (includes `errors` array) |
| 400 | Member Exists | `addListMember` for an email already on the list (use PUT) |
| 400 | Bad Request | Malformed JSON body, duplicate store/resource id |

| 404 | Resource Not Found | Unknown list/campaign/template/store/etc. or unknown endpoint |
| 405 | Method Not Allowed | Unsupported HTTP method on a known resource |
| 500 | Internal Server Error | Unexpected server error |

Successful mutations that return no body (member archive/delete, campaign actions, etc.) respond with `204 No Content`, matching the real API.

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
MAILCHIMP_API_KEY=parlel-us1
MAILCHIMP_SERVER_PREFIX=us1
MAILCHIMP_BASE_URL=http://localhost:4653
MAILCHIMP_API_BASE_URL=http://localhost:4653/3.0
```

<!-- parlel:testenv:end -->
