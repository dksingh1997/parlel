import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { CloudformationServer } from "../services/cloudformation/src/server.js";

const PORT = 14564;
const ENDPOINT = `http://127.0.0.1:${PORT}`;

function form(action: string, params: Record<string, string> = {}) {
  const body = new URLSearchParams();
  body.set("Action", action);
  body.set("Version", "2010-05-15");
  for (const [k, v] of Object.entries(params)) body.set(k, v);
  return body.toString();
}

async function call(action: string, params: Record<string, string> = {}) {
  const res = await fetch(ENDPOINT + "/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form(action, params),
  });
  const text = await res.text();
  return { status: res.status, text };
}

// Tiny XML extractor: returns first inner text of <tag>...</tag>.
function pick(xml: string, tag: string): string | undefined {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? m[1] : undefined;
}
function pickAll(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g");
  const out: string[] = [];
  let m;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}

const TEMPLATE = JSON.stringify({
  Description: "Test stack",
  Parameters: { Env: { Type: "String", Default: "dev" } },
  Resources: {
    MyBucket: { Type: "AWS::S3::Bucket", Properties: { BucketName: "x" } },
    MyTopic: { Type: "AWS::SNS::Topic" },
  },
  Outputs: {
    BucketName: { Value: { Ref: "Env" }, Description: "env", Export: { Name: "MyBucketExport" } },
  },
});

let server: CloudformationServer;

beforeAll(async () => {
  server = new CloudformationServer(PORT);
  await server.start();
});

afterAll(async () => {
  await server.stop();
});

beforeEach(async () => {
  await fetch(ENDPOINT + "/_parlel/reset", { method: "POST" });
});

describe("cloudformation", () => {
  it("health endpoint reports ok", async () => {
    const res = await fetch(ENDPOINT + "/_parlel/health");
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.service).toBe("cloudformation");
  });

  it("uses default port 4564", () => {
    const s = new CloudformationServer();
    expect(s.port).toBe(4564);
  });

  it("creates and describes a stack", async () => {
    const create = await call("CreateStack", { StackName: "st1", TemplateBody: TEMPLATE });
    expect(create.status).toBe(200);
    const arn = pick(create.text, "StackId");
    expect(arn).toContain("arn:aws:cloudformation");
    expect(arn).toContain("stack/st1/");

    const desc = await call("DescribeStacks", { StackName: "st1" });
    expect(desc.status).toBe(200);
    expect(desc.text).toContain("<StackName>st1</StackName>");
    expect(desc.text).toContain("CREATE_COMPLETE");
    // Output resolves Ref:Env -> default "dev".
    expect(desc.text).toContain("<OutputValue>dev</OutputValue>");
  });

  it("rejects duplicate stack create", async () => {
    await call("CreateStack", { StackName: "dup", TemplateBody: TEMPLATE });
    const again = await call("CreateStack", { StackName: "dup", TemplateBody: TEMPLATE });
    expect(again.status).toBe(400);
    expect(again.text).toContain("AlreadyExistsException");
  });

  it("describe missing stack errors", async () => {
    const res = await call("DescribeStacks", { StackName: "nope" });
    expect(res.status).toBe(400);
    expect(res.text).toContain("ValidationError");
  });

  it("updates a stack", async () => {
    await call("CreateStack", { StackName: "up1", TemplateBody: TEMPLATE });
    const upd = await call("UpdateStack", {
      StackName: "up1",
      TemplateBody: TEMPLATE,
      "Parameters.member.1.ParameterKey": "Env",
      "Parameters.member.1.ParameterValue": "prod",
    });
    expect(upd.status).toBe(200);
    const desc = await call("DescribeStacks", { StackName: "up1" });
    expect(desc.text).toContain("UPDATE_COMPLETE");
    expect(desc.text).toContain("<OutputValue>prod</OutputValue>");
  });

  it("lists stacks", async () => {
    await call("CreateStack", { StackName: "ls1", TemplateBody: TEMPLATE });
    await call("CreateStack", { StackName: "ls2", TemplateBody: TEMPLATE });
    const list = await call("ListStacks", {});
    expect(list.status).toBe(200);
    expect(list.text).toContain("ls1");
    expect(list.text).toContain("ls2");
  });

  it("gets the template", async () => {
    await call("CreateStack", { StackName: "tpl1", TemplateBody: TEMPLATE });
    const res = await call("GetTemplate", { StackName: "tpl1" });
    expect(res.status).toBe(200);
    expect(res.text).toContain("MyBucket");
  });

  it("deletes a stack idempotently", async () => {
    await call("CreateStack", { StackName: "del1", TemplateBody: TEMPLATE });
    const d1 = await call("DeleteStack", { StackName: "del1" });
    expect(d1.status).toBe(200);
    const d2 = await call("DeleteStack", { StackName: "del1" });
    expect(d2.status).toBe(200);
    const desc = await call("DescribeStacks", { StackName: "del1" });
    expect(desc.status).toBe(400);
  });

  it("lists stack resources", async () => {
    await call("CreateStack", { StackName: "res1", TemplateBody: TEMPLATE });
    const res = await call("ListStackResources", { StackName: "res1" });
    expect(res.status).toBe(200);
    expect(res.text).toContain("MyBucket");
    expect(res.text).toContain("AWS::S3::Bucket");
    const dres = await call("DescribeStackResources", { StackName: "res1" });
    expect(dres.text).toContain("MyTopic");
  });

  it("create + describe + execute change set", async () => {
    const cs = await call("CreateChangeSet", {
      StackName: "cs1",
      ChangeSetName: "init",
      ChangeSetType: "CREATE",
      TemplateBody: TEMPLATE,
    });
    expect(cs.status).toBe(200);
    const csId = pick(cs.text, "Id");
    expect(csId).toContain("changeSet/init/");

    const desc = await call("DescribeChangeSet", { ChangeSetName: csId!, StackName: "cs1" });
    expect(desc.status).toBe(200);
    expect(desc.text).toContain("CREATE_COMPLETE");
    expect(desc.text).toContain("MyBucket");

    const listCs = await call("ListChangeSets", { StackName: "cs1" });
    expect(listCs.text).toContain("init");

    const exec = await call("ExecuteChangeSet", { ChangeSetName: csId!, StackName: "cs1" });
    expect(exec.status).toBe(200);
    const stack = await call("DescribeStacks", { StackName: "cs1" });
    expect(stack.status).toBe(200);
    expect(stack.text).toContain("CREATE_COMPLETE");
  });

  it("lists exports", async () => {
    await call("CreateStack", { StackName: "exp1", TemplateBody: TEMPLATE });
    const res = await call("ListExports", {});
    expect(res.status).toBe(200);
    expect(res.text).toContain("MyBucketExport");
  });

  it("validates a template", async () => {
    const res = await call("ValidateTemplate", { TemplateBody: TEMPLATE });
    expect(res.status).toBe(200);
    expect(res.text).toContain("Env");
    expect(res.text).toContain("Test stack");
  });

  it("rejects unknown action", async () => {
    const res = await call("BogusAction", {});
    expect(res.status).toBe(400);
    expect(res.text).toContain("ValidationError");
  });
});
