import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { AcmServer } from "../services/acm/src/server.js";

const PORT = 14731;
const ENDPOINT = `http://127.0.0.1:${PORT}`;

async function call(op: string, body: Record<string, unknown> = {}) {
  const res = await fetch(`${ENDPOINT}/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Target": `CertificateManager.${op}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    /* ignore */
  }
  return { status: res.status, json };
}

describe("ACM Service", () => {
  let server: AcmServer;

  beforeAll(async () => {
    server = new AcmServer(PORT);
    await server.start();
    await new Promise((r) => setTimeout(r, 50));
  }, 15000);

  afterAll(async () => server.stop());
  beforeEach(() => server.reset());

  it("uses default port 4731", () => {
    expect(new AcmServer().port).toBe(4731);
  });

  it("exposes health", async () => {
    const res = await fetch(`${ENDPOINT}/_parlel/health`);
    expect((await res.json()).service).toBe("acm");
  });

  it("requests a certificate that auto-issues with DNS validation", async () => {
    const r = await call("RequestCertificate", { DomainName: "example.com", ValidationMethod: "DNS" });
    expect(r.status).toBe(200);
    const arn = r.json.CertificateArn;
    expect(arn).toContain(":certificate/");

    const d = await call("DescribeCertificate", { CertificateArn: arn });
    expect(d.json.Certificate.Status).toBe("ISSUED");
    const rec = d.json.Certificate.DomainValidationOptions[0].ResourceRecord;
    expect(rec.Type).toBe("CNAME");
    expect(rec.Value).toContain("acm-validations.aws");
  });

  it("includes SANs in validation options", async () => {
    const r = await call("RequestCertificate", {
      DomainName: "example.com",
      SubjectAlternativeNames: ["www.example.com"],
    });
    const d = await call("DescribeCertificate", { CertificateArn: r.json.CertificateArn });
    expect(d.json.Certificate.DomainValidationOptions.length).toBe(2);
  });

  it("lists certificates", async () => {
    await call("RequestCertificate", { DomainName: "a.com" });
    await call("RequestCertificate", { DomainName: "b.com" });
    const l = await call("ListCertificates");
    expect(l.json.CertificateSummaryList.length).toBe(2);
  });

  it("gets the certificate PEM", async () => {
    const r = await call("RequestCertificate", { DomainName: "pem.com" });
    const g = await call("GetCertificate", { CertificateArn: r.json.CertificateArn });
    expect(g.json.Certificate).toContain("BEGIN CERTIFICATE");
    expect(g.json.CertificateChain).toContain("BEGIN CERTIFICATE");
  });

  it("tags certificates", async () => {
    const r = await call("RequestCertificate", { DomainName: "tag.com" });
    const arn = r.json.CertificateArn;
    await call("AddTagsToCertificate", { CertificateArn: arn, Tags: [{ Key: "env", Value: "prod" }] });
    const t = await call("ListTagsForCertificate", { CertificateArn: arn });
    expect(t.json.Tags[0]).toEqual({ Key: "env", Value: "prod" });
  });

  it("deletes a certificate", async () => {
    const r = await call("RequestCertificate", { DomainName: "del.com" });
    await call("DeleteCertificate", { CertificateArn: r.json.CertificateArn });
    const d = await call("DescribeCertificate", { CertificateArn: r.json.CertificateArn });
    expect(d.status).toBe(400);
    expect(d.json.__type).toBe("ResourceNotFoundException");
  });

  // --- corrected failure-scenario parity (the trust-protecting tests) ---

  it("returns ValidationException (400) for a missing CertificateArn", async () => {
    const d = await call("DescribeCertificate", {});
    expect(d.status).toBe(400);
    expect(d.json.__type).toBe("ValidationException");
  });

  it("returns InvalidArnException (400) for a malformed ARN", async () => {
    const d = await call("DescribeCertificate", { CertificateArn: "not-an-arn" });
    expect(d.status).toBe(400);
    expect(d.json.__type).toBe("InvalidArnException");
  });

  it("returns ResourceNotFoundException (400) for a well-formed unknown ARN", async () => {
    const d = await call("DescribeCertificate", {
      CertificateArn: "arn:aws:acm:us-east-1:000000000000:certificate/does-not-exist",
    });
    expect(d.status).toBe(400);
    expect(d.json.__type).toBe("ResourceNotFoundException");
  });

  it("returns ValidationException (400) when RequestCertificate omits DomainName", async () => {
    const r = await call("RequestCertificate", {});
    expect(r.status).toBe(400);
    expect(r.json.__type).toBe("ValidationException");
  });

  it("returns UnknownOperationException (404) for an unknown action", async () => {
    const r = await call("DefinitelyNotARealOperation", {});
    expect(r.status).toBe(404);
    expect(r.json.__type).toBe("UnknownOperationException");
  });

  it("error envelope carries the x-amzn-errortype header", async () => {
    const res = await fetch(`${ENDPOINT}/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-amz-json-1.1",
        "X-Amz-Target": "CertificateManager.DescribeCertificate",
      },
      body: JSON.stringify({ CertificateArn: "not-an-arn" }),
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("x-amzn-errortype")).toBe("InvalidArnException");
  });

  // --- new operations ---

  it("imports a certificate (Type IMPORTED)", async () => {
    const i = await call("ImportCertificate", {
      Certificate: "-----BEGIN CERTIFICATE-----\nQUJD\n-----END CERTIFICATE-----\n",
      PrivateKey: "-----BEGIN PRIVATE KEY-----\nQUJD\n-----END PRIVATE KEY-----\n",
    });
    expect(i.status).toBe(200);
    const arn = i.json.CertificateArn;
    expect(arn).toContain(":certificate/");
    const d = await call("DescribeCertificate", { CertificateArn: arn });
    expect(d.json.Certificate.Type).toBe("IMPORTED");
    expect(d.json.Certificate.Status).toBe("ISSUED");
    expect(d.json.Certificate.DomainValidationOptions).toEqual([]);
  });

  it("rejects ImportCertificate missing PrivateKey", async () => {
    const i = await call("ImportCertificate", {
      Certificate: "-----BEGIN CERTIFICATE-----\nQUJD\n-----END CERTIFICATE-----\n",
    });
    expect(i.status).toBe(400);
    expect(i.json.__type).toBe("ValidationException");
  });

  it("paginates ListCertificates with MaxItems and NextToken", async () => {
    await call("RequestCertificate", { DomainName: "p1.com" });
    await call("RequestCertificate", { DomainName: "p2.com" });
    await call("RequestCertificate", { DomainName: "p3.com" });

    const page1 = await call("ListCertificates", { MaxItems: 2 });
    expect(page1.json.CertificateSummaryList.length).toBe(2);
    expect(page1.json.NextToken).toBeTruthy();

    const page2 = await call("ListCertificates", { MaxItems: 2, NextToken: page1.json.NextToken });
    expect(page2.json.CertificateSummaryList.length).toBe(1);
    expect(page2.json.NextToken).toBeUndefined();
  });

  it("updates certificate options (CT logging preference)", async () => {
    const r = await call("RequestCertificate", { DomainName: "opt.com" });
    const arn = r.json.CertificateArn;
    const u = await call("UpdateCertificateOptions", {
      CertificateArn: arn,
      Options: { CertificateTransparencyLoggingPreference: "DISABLED" },
    });
    expect(u.status).toBe(200);
    const d = await call("DescribeCertificate", { CertificateArn: arn });
    expect(d.json.Certificate.Options.CertificateTransparencyLoggingPreference).toBe("DISABLED");
  });

  it("resends validation email after validating required params", async () => {
    const r = await call("RequestCertificate", { DomainName: "rv.com" });
    const arn = r.json.CertificateArn;
    const ok = await call("ResendValidationEmail", {
      CertificateArn: arn,
      Domain: "rv.com",
      ValidationDomain: "rv.com",
    });
    expect(ok.status).toBe(200);
    const bad = await call("ResendValidationEmail", { CertificateArn: arn, Domain: "rv.com" });
    expect(bad.status).toBe(400);
    expect(bad.json.__type).toBe("ValidationException");
  });
});
