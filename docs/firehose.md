# Firehose (parlel emulator)

A zero-dependency, in-process fake of Amazon Data Firehose. Records are buffered
in memory keyed by delivery stream.

| Property    | Value                          |
| ----------- | ------------------------------ |
| Port        | 4725                           |
| Protocol    | AWS JSON 1.1 (`X-Amz-Target: Firehose_20150804.<Op>`) |
| Healthcheck | `GET /_parlel/health`          |
| Reset       | `POST /_parlel/reset`          |

## Default connection

```
AWS_REGION=us-east-1
AWS_ENDPOINT_URL=http://127.0.0.1:4725
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
```

## Supported operations

- `CreateDeliveryStream`, `DescribeDeliveryStream`, `ListDeliveryStreams`, `DeleteDeliveryStream`
- `PutRecord`, `PutRecordBatch`

S3 (`S3DestinationConfiguration` / `ExtendedS3DestinationConfiguration`) and
Elasticsearch/OpenSearch destination configs are accepted and echoed in
`DescribeDeliveryStream`. Record `Data` is a base64 blob on the wire.

## SDK example

```ts
import {
  FirehoseClient,
  CreateDeliveryStreamCommand,
  PutRecordCommand,
} from "@aws-sdk/client-firehose";

const fh = new FirehoseClient({
  region: "us-east-1",
  endpoint: "http://127.0.0.1:4725",
  credentials: { accessKeyId: "parlel", secretAccessKey: "parlel" },
});

await fh.send(new CreateDeliveryStreamCommand({
  DeliveryStreamName: "logs",
  S3DestinationConfiguration: { BucketARN: "arn:aws:s3:::my-bucket", RoleARN: "arn:aws:iam::000000000000:role/fh" },
}));
await fh.send(new PutRecordCommand({
  DeliveryStreamName: "logs",
  Record: { Data: Buffer.from("hello\n") },
}));
```

## Access via MCP / preview URL

Reachable through the parlel pool MCP bridge and preview URL. No auth setup
required.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Area        | Limitation                                                  |
| ----------- | ----------------------------------------------------------- |
| Delivery    | Records are buffered in memory; nothing is flushed to S3/ES.|
| Transforms  | Lambda transformation / format conversion is not applied.   |
| Buffering   | Buffering hints are stored but not enforced.                |
| Encryption  | `Encrypted` is always reported `false`.                     |

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
AWS_REGION=us-east-1
AWS_ENDPOINT_URL=http://localhost:4725
```

<!-- parlel:testenv:end -->
