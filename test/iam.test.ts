import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  IAMClient,
  CreateUserCommand,
  GetUserCommand,
  ListUsersCommand,
  DeleteUserCommand,
  UpdateUserCommand,
  CreateRoleCommand,
  GetRoleCommand,
  ListRolesCommand,
  DeleteRoleCommand,
  CreatePolicyCommand,
  GetPolicyCommand,
  ListPoliciesCommand,
  DeletePolicyCommand,
  CreatePolicyVersionCommand,
  AttachUserPolicyCommand,
  AttachRolePolicyCommand,
  DetachUserPolicyCommand,
  ListAttachedUserPoliciesCommand,
  ListAttachedRolePoliciesCommand,
  PutUserPolicyCommand,
  GetUserPolicyCommand,
  PutRolePolicyCommand,
  GetRolePolicyCommand,
  CreateAccessKeyCommand,
  ListAccessKeysCommand,
  DeleteAccessKeyCommand,
  UpdateAccessKeyCommand,
  CreateInstanceProfileCommand,
  GetInstanceProfileCommand,
  ListInstanceProfilesCommand,
  AddRoleToInstanceProfileCommand,
  CreateGroupCommand,
  GetGroupCommand,
  ListGroupsCommand,
  DeleteGroupCommand,
  AddUserToGroupCommand,
  RemoveUserFromGroupCommand,
  TagRoleCommand,
  TagUserCommand,
  ListRoleTagsCommand,
} from "@aws-sdk/client-iam";
import { IamServer } from "../services/iam/src/server.js";

const PORT = 14575;
const ENDPOINT = `http://127.0.0.1:${PORT}`;

function makeClient() {
  return new IAMClient({
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

const TRUST = JSON.stringify({
  Version: "2012-10-17",
  Statement: [{ Effect: "Allow", Principal: { Service: "ec2.amazonaws.com" }, Action: "sts:AssumeRole" }],
});

const POLICY_DOC = JSON.stringify({
  Version: "2012-10-17",
  Statement: [{ Effect: "Allow", Action: "s3:GetObject", Resource: "*" }],
});

describe("IAM Service", () => {
  let server: IamServer;
  let iam: IAMClient;

  beforeAll(async () => {
    server = new IamServer(PORT);
    await server.start();
    iam = makeClient();
    await new Promise((r) => setTimeout(r, 100));
  }, 15000);

  afterAll(async () => {
    iam.destroy();
    await server.stop();
  });

  beforeEach(() => {
    server.reset();
  });

  describe("Server lifecycle", () => {
    it("uses default port 4575", () => {
      const s = new IamServer();
      expect(s.port).toBe(4575);
    });

    it("exposes health endpoint", async () => {
      const res = await fetch(`${ENDPOINT}/_parlel/health`);
      const json = await res.json();
      expect(res.status).toBe(200);
      expect(json.service).toBe("iam");
    });
  });

  describe("Users", () => {
    it("creates and gets a user with a valid ARN and id", async () => {
      const created = await iam.send(new CreateUserCommand({ UserName: "alice" }));
      expect(created.User?.UserName).toBe("alice");
      expect(created.User?.Arn).toBe("arn:aws:iam::000000000000:user/alice");
      expect(created.User?.UserId?.startsWith("AIDA")).toBe(true);

      const got = await iam.send(new GetUserCommand({ UserName: "alice" }));
      expect(got.User?.UserName).toBe("alice");
    });

    it("lists users", async () => {
      await iam.send(new CreateUserCommand({ UserName: "u1" }));
      await iam.send(new CreateUserCommand({ UserName: "u2" }));
      const list = await iam.send(new ListUsersCommand({}));
      expect(list.Users?.map((u) => u.UserName).sort()).toEqual(["u1", "u2"]);
    });

    it("updates a user name", async () => {
      await iam.send(new CreateUserCommand({ UserName: "old" }));
      await iam.send(new UpdateUserCommand({ UserName: "old", NewUserName: "renamed" }));
      const got = await iam.send(new GetUserCommand({ UserName: "renamed" }));
      expect(got.User?.UserName).toBe("renamed");
    });

    it("deletes a user", async () => {
      await iam.send(new CreateUserCommand({ UserName: "temp" }));
      await iam.send(new DeleteUserCommand({ UserName: "temp" }));
      await expectError(iam.send(new GetUserCommand({ UserName: "temp" })), "NoSuchEntity");
    });

    it("rejects duplicate user", async () => {
      await iam.send(new CreateUserCommand({ UserName: "dup" }));
      await expectError(iam.send(new CreateUserCommand({ UserName: "dup" })), "EntityAlreadyExists");
    });
  });

  describe("Roles", () => {
    it("creates and gets a role", async () => {
      const created = await iam.send(
        new CreateRoleCommand({ RoleName: "r1", AssumeRolePolicyDocument: TRUST }),
      );
      expect(created.Role?.Arn).toBe("arn:aws:iam::000000000000:role/r1");
      expect(created.Role?.RoleId?.startsWith("AROA")).toBe(true);

      const got = await iam.send(new GetRoleCommand({ RoleName: "r1" }));
      expect(got.Role?.RoleName).toBe("r1");
      expect(decodeURIComponent(got.Role?.AssumeRolePolicyDocument || "")).toContain("ec2.amazonaws.com");
    });

    it("lists and deletes roles", async () => {
      await iam.send(new CreateRoleCommand({ RoleName: "ra", AssumeRolePolicyDocument: TRUST }));
      const list = await iam.send(new ListRolesCommand({}));
      expect(list.Roles?.length).toBe(1);
      await iam.send(new DeleteRoleCommand({ RoleName: "ra" }));
      await expectError(iam.send(new GetRoleCommand({ RoleName: "ra" })), "NoSuchEntity");
    });
  });

  describe("Managed policies", () => {
    it("creates, gets, versions and deletes a policy", async () => {
      const created = await iam.send(
        new CreatePolicyCommand({ PolicyName: "p1", PolicyDocument: POLICY_DOC }),
      );
      const arn = created.Policy?.Arn!;
      expect(arn).toContain(":policy/p1");

      const got = await iam.send(new GetPolicyCommand({ PolicyArn: arn }));
      expect(got.Policy?.PolicyName).toBe("p1");

      const ver = await iam.send(
        new CreatePolicyVersionCommand({ PolicyArn: arn, PolicyDocument: POLICY_DOC, SetAsDefault: true }),
      );
      expect(ver.PolicyVersion?.VersionId).toBe("v2");
      expect(ver.PolicyVersion?.IsDefaultVersion).toBe(true);

      const list = await iam.send(new ListPoliciesCommand({}));
      expect(list.Policies?.length).toBe(1);

      await iam.send(new DeletePolicyCommand({ PolicyArn: arn }));
      await expectError(iam.send(new GetPolicyCommand({ PolicyArn: arn })), "NoSuchEntity");
    });
  });

  describe("Policy attachment", () => {
    it("attaches and detaches managed policy to user", async () => {
      await iam.send(new CreateUserCommand({ UserName: "au" }));
      const p = await iam.send(new CreatePolicyCommand({ PolicyName: "ap", PolicyDocument: POLICY_DOC }));
      const arn = p.Policy?.Arn!;
      await iam.send(new AttachUserPolicyCommand({ UserName: "au", PolicyArn: arn }));
      let list = await iam.send(new ListAttachedUserPoliciesCommand({ UserName: "au" }));
      expect(list.AttachedPolicies?.[0].PolicyArn).toBe(arn);
      await iam.send(new DetachUserPolicyCommand({ UserName: "au", PolicyArn: arn }));
      list = await iam.send(new ListAttachedUserPoliciesCommand({ UserName: "au" }));
      expect(list.AttachedPolicies?.length).toBe(0);
    });

    it("attaches managed policy to role", async () => {
      await iam.send(new CreateRoleCommand({ RoleName: "ar", AssumeRolePolicyDocument: TRUST }));
      const p = await iam.send(new CreatePolicyCommand({ PolicyName: "rp", PolicyDocument: POLICY_DOC }));
      await iam.send(new AttachRolePolicyCommand({ RoleName: "ar", PolicyArn: p.Policy?.Arn }));
      const list = await iam.send(new ListAttachedRolePoliciesCommand({ RoleName: "ar" }));
      expect(list.AttachedPolicies?.length).toBe(1);
    });
  });

  describe("Inline policies", () => {
    it("puts and gets inline user policy", async () => {
      await iam.send(new CreateUserCommand({ UserName: "iu" }));
      await iam.send(new PutUserPolicyCommand({ UserName: "iu", PolicyName: "inl", PolicyDocument: POLICY_DOC }));
      const got = await iam.send(new GetUserPolicyCommand({ UserName: "iu", PolicyName: "inl" }));
      expect(decodeURIComponent(got.PolicyDocument || "")).toContain("s3:GetObject");
    });

    it("puts and gets inline role policy", async () => {
      await iam.send(new CreateRoleCommand({ RoleName: "ir", AssumeRolePolicyDocument: TRUST }));
      await iam.send(new PutRolePolicyCommand({ RoleName: "ir", PolicyName: "inl", PolicyDocument: POLICY_DOC }));
      const got = await iam.send(new GetRolePolicyCommand({ RoleName: "ir", PolicyName: "inl" }));
      expect(decodeURIComponent(got.PolicyDocument || "")).toContain("s3:GetObject");
    });
  });

  describe("Access keys", () => {
    it("creates, lists, updates, and deletes access keys", async () => {
      await iam.send(new CreateUserCommand({ UserName: "kuser" }));
      const created = await iam.send(new CreateAccessKeyCommand({ UserName: "kuser" }));
      const akid = created.AccessKey?.AccessKeyId!;
      expect(akid.startsWith("AKIA")).toBe(true);
      expect(created.AccessKey?.SecretAccessKey?.length).toBeGreaterThan(0);

      let list = await iam.send(new ListAccessKeysCommand({ UserName: "kuser" }));
      expect(list.AccessKeyMetadata?.length).toBe(1);

      await iam.send(new UpdateAccessKeyCommand({ UserName: "kuser", AccessKeyId: akid, Status: "Inactive" }));
      list = await iam.send(new ListAccessKeysCommand({ UserName: "kuser" }));
      expect(list.AccessKeyMetadata?.[0].Status).toBe("Inactive");

      await iam.send(new DeleteAccessKeyCommand({ UserName: "kuser", AccessKeyId: akid }));
      list = await iam.send(new ListAccessKeysCommand({ UserName: "kuser" }));
      expect(list.AccessKeyMetadata?.length).toBe(0);
    });
  });

  describe("Instance profiles", () => {
    it("creates and attaches a role to a profile", async () => {
      await iam.send(new CreateRoleCommand({ RoleName: "ipr", AssumeRolePolicyDocument: TRUST }));
      const created = await iam.send(new CreateInstanceProfileCommand({ InstanceProfileName: "ip1" }));
      expect(created.InstanceProfile?.Arn).toContain(":instance-profile/ip1");
      await iam.send(new AddRoleToInstanceProfileCommand({ InstanceProfileName: "ip1", RoleName: "ipr" }));
      const got = await iam.send(new GetInstanceProfileCommand({ InstanceProfileName: "ip1" }));
      expect(got.InstanceProfile?.Roles?.[0].RoleName).toBe("ipr");
      const list = await iam.send(new ListInstanceProfilesCommand({}));
      expect(list.InstanceProfiles?.length).toBe(1);
    });
  });

  describe("Groups", () => {
    it("creates groups and manages membership", async () => {
      await iam.send(new CreateGroupCommand({ GroupName: "g1" }));
      await iam.send(new CreateUserCommand({ UserName: "gm" }));
      await iam.send(new AddUserToGroupCommand({ GroupName: "g1", UserName: "gm" }));
      let got = await iam.send(new GetGroupCommand({ GroupName: "g1" }));
      expect(got.Users?.[0].UserName).toBe("gm");

      const list = await iam.send(new ListGroupsCommand({}));
      expect(list.Groups?.length).toBe(1);

      await iam.send(new RemoveUserFromGroupCommand({ GroupName: "g1", UserName: "gm" }));
      got = await iam.send(new GetGroupCommand({ GroupName: "g1" }));
      expect(got.Users?.length).toBe(0);

      await iam.send(new DeleteGroupCommand({ GroupName: "g1" }));
      await expectError(iam.send(new GetGroupCommand({ GroupName: "g1" })), "NoSuchEntity");
    });
  });

  describe("Tags", () => {
    it("tags roles and users and lists role tags", async () => {
      await iam.send(new CreateRoleCommand({ RoleName: "tr", AssumeRolePolicyDocument: TRUST }));
      await iam.send(new TagRoleCommand({ RoleName: "tr", Tags: [{ Key: "env", Value: "test" }] }));
      const tags = await iam.send(new ListRoleTagsCommand({ RoleName: "tr" }));
      expect(tags.Tags?.[0]).toEqual({ Key: "env", Value: "test" });

      await iam.send(new CreateUserCommand({ UserName: "tu" }));
      await iam.send(new TagUserCommand({ UserName: "tu", Tags: [{ Key: "team", Value: "infra" }] }));
      const got = await iam.send(new GetUserCommand({ UserName: "tu" }));
      expect(got.User?.Tags?.[0]).toEqual({ Key: "team", Value: "infra" });
    });
  });
});
