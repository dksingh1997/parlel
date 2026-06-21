// parlel/ecr — a lightweight, dependency-free fake of AWS ECR (Elastic Container
// Registry). Speaks the AWS JSON 1.1 wire protocol (target prefix
// AmazonEC2ContainerRegistry_V20150921) so the real `@aws-sdk/client-ecr` works
// against it. Pure Node.js, no external dependencies, in-memory state.

import { createServer } from "node:http";
import { randomUUID, createHash } from "node:crypto";

const JSON_CONTENT_TYPE = "application/x-amz-json-1.1";
const DEFAULT_ACCOUNT_ID = "000000000000";

const ERROR_STATUS = {
  RepositoryAlreadyExistsException: 400,
  RepositoryNotFoundException: 400,
  RepositoryNotEmptyException: 400,
  ImageNotFoundException: 400,
  ImageAlreadyExistsException: 400,
  InvalidParameterException: 400,
  LayerInaccessibleException: 400,
  ServerException: 500,
};

class EcrError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status || ERROR_STATUS[code] || 400;
  }
}

export class EcrServer {
  constructor(port = 4702, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.region = options.region || "us-east-1";
    this.accountId = options.accountId || DEFAULT_ACCOUNT_ID;
    this.server = null;
    this.reset();
  }

  reset() {
    // repositories: Map<name, repo>
    //   repo = { name, arn, uri, createdAt, registryId, imageTagMutability,
    //            images: Map<digest, image> }
    //   image = { digest, tags:Set, manifest, manifestMediaType, pushedAt, sizeInBytes }
    this.repositories = new Map();
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.sendError(res, new EcrError("ServerException", error.message, 500));
        });
      });
      this.server.once("error", reject);
      this.server.listen(this.port, this.host, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
  }

  stop() {
    return new Promise((resolve, reject) => {
      if (!this.server) return resolve();
      this.server.close((error) => {
        this.server = null;
        if (error) reject(error);
        else resolve();
      });
    });
  }

  requestId() {
    return randomUUID();
  }

  readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
  }

  registryUri() {
    return `${this.accountId}.dkr.ecr.${this.region}.amazonaws.com`;
  }

  async handle(req, res) {
    const url = new URL(req.url || "/", `http://${req.headers.host || this.host}`);
    const method = req.method || "GET";

    if (url.pathname === "/_parlel/health") {
      return this.sendJson(res, 200, {
        status: "ok",
        service: "ecr",
        repositories: this.repositories.size,
      });
    }
    if (url.pathname === "/_parlel/reset" && method === "POST") {
      this.reset();
      return this.sendJson(res, 200, { ok: true });
    }

    res.setHeader("x-amzn-RequestId", this.requestId());
    res.setHeader("Server", "parlel-ecr");

    if (method !== "POST") {
      return this.sendError(res, new EcrError("InvalidParameterException", "Only POST is supported.", 405));
    }

    const body = await this.readBody(req);
    const target = (req.headers["x-amz-target"] || "").toString();
    const operation = target.includes(".") ? target.split(".").pop() : target;

    let input;
    try {
      input = body.length ? JSON.parse(body.toString("utf8")) : {};
    } catch {
      return this.sendError(res, new EcrError("InvalidParameterException", "Body is not valid JSON.", 400));
    }

    try {
      const output = this.dispatch(operation, input);
      return this.sendJson(res, 200, output ?? {});
    } catch (error) {
      if (error instanceof EcrError) return this.sendError(res, error);
      throw error;
    }
  }

  dispatch(operation, input) {
    switch (operation) {
      case "CreateRepository":
        return this.createRepository(input);
      case "DescribeRepositories":
        return this.describeRepositories(input);
      case "DeleteRepository":
        return this.deleteRepository(input);
      case "ListImages":
        return this.listImages(input);
      case "BatchGetImage":
        return this.batchGetImage(input);
      case "PutImage":
        return this.putImage(input);
      case "GetAuthorizationToken":
        return this.getAuthorizationToken(input);
      case "DescribeImages":
        return this.describeImages(input);
      default:
        throw new EcrError("InvalidParameterException", `The action ${operation || "(none)"} is not valid.`, 400);
    }
  }

  repoArn(name) {
    return `arn:aws:ecr:${this.region}:${this.accountId}:repository/${name}`;
  }

  requireRepo(name) {
    if (!name) throw new EcrError("InvalidParameterException", "repositoryName is required.");
    const repo = this.repositories.get(name);
    if (!repo) {
      throw new EcrError("RepositoryNotFoundException", `The repository with name '${name}' does not exist in the registry with id '${this.accountId}'`);
    }
    return repo;
  }

  repoSummary(repo) {
    return {
      repositoryArn: repo.arn,
      registryId: this.accountId,
      repositoryName: repo.name,
      repositoryUri: repo.uri,
      createdAt: Math.floor(repo.createdAt / 1000),
      imageTagMutability: repo.imageTagMutability,
      imageScanningConfiguration: { scanOnPush: repo.scanOnPush },
      encryptionConfiguration: { encryptionType: "AES256" },
    };
  }

  createRepository(input) {
    const name = input.repositoryName;
    if (!name) throw new EcrError("InvalidParameterException", "repositoryName is required.");
    if (this.repositories.has(name)) {
      throw new EcrError("RepositoryAlreadyExistsException", `The repository with name '${name}' already exists in the registry with id '${this.accountId}'`);
    }
    const repo = {
      name,
      arn: this.repoArn(name),
      uri: `${this.registryUri()}/${name}`,
      createdAt: Date.now(),
      imageTagMutability: input.imageTagMutability || "MUTABLE",
      scanOnPush: input.imageScanningConfiguration ? Boolean(input.imageScanningConfiguration.scanOnPush) : false,
      images: new Map(),
    };
    this.repositories.set(name, repo);
    return { repository: this.repoSummary(repo) };
  }

  describeRepositories(input) {
    const names = input.repositoryNames;
    let repos = [...this.repositories.values()];
    if (Array.isArray(names) && names.length) {
      repos = [];
      for (const n of names) repos.push(this.requireRepo(n));
    }
    return { repositories: repos.map((r) => this.repoSummary(r)) };
  }

  deleteRepository(input) {
    const repo = this.requireRepo(input.repositoryName);
    if (repo.images.size > 0 && input.force !== true) {
      throw new EcrError("RepositoryNotEmptyException", `The repository with name '${repo.name}' in registry with id '${this.accountId}' cannot be deleted because it still contains images`);
    }
    this.repositories.delete(repo.name);
    return { repository: this.repoSummary(repo) };
  }

  listImages(input) {
    const repo = this.requireRepo(input.repositoryName);
    const ids = [];
    for (const image of repo.images.values()) {
      if (image.tags.size === 0) {
        ids.push({ imageDigest: image.digest });
      } else {
        for (const tag of image.tags) ids.push({ imageDigest: image.digest, imageTag: tag });
      }
    }
    return { imageIds: ids };
  }

  resolveImage(repo, id) {
    if (!id) return undefined;
    if (id.imageDigest && repo.images.has(id.imageDigest)) return repo.images.get(id.imageDigest);
    if (id.imageTag) {
      for (const image of repo.images.values()) {
        if (image.tags.has(id.imageTag)) return image;
      }
    }
    return undefined;
  }

  batchGetImage(input) {
    const repo = this.requireRepo(input.repositoryName);
    const ids = input.imageIds || [];
    const images = [];
    const failures = [];
    for (const id of ids) {
      const image = this.resolveImage(repo, id);
      if (!image) {
        failures.push({
          imageId: id,
          failureCode: "ImageNotFound",
          failureReason: "Requested image not found",
        });
        continue;
      }
      const tag = id.imageTag && image.tags.has(id.imageTag) ? id.imageTag : [...image.tags][0];
      images.push({
        registryId: this.accountId,
        repositoryName: repo.name,
        imageId: { imageDigest: image.digest, imageTag: tag },
        imageManifest: image.manifest,
        imageManifestMediaType: image.manifestMediaType,
      });
    }
    return { images, failures };
  }

  putImage(input) {
    const repo = this.requireRepo(input.repositoryName);
    const manifest = input.imageManifest;
    if (!manifest) throw new EcrError("InvalidParameterException", "imageManifest is required.");
    const digest = input.imageDigest || `sha256:${createHash("sha256").update(manifest).digest("hex")}`;
    const tag = input.imageTag;

    let image = repo.images.get(digest);
    if (!image) {
      image = {
        digest,
        tags: new Set(),
        manifest,
        manifestMediaType: input.imageManifestMediaType || "application/vnd.docker.distribution.manifest.v2+json",
        pushedAt: Date.now(),
        sizeInBytes: Buffer.byteLength(manifest),
      };
      repo.images.set(digest, image);
    }
    if (tag) {
      // Detach the tag from any other image (mutable tags).
      for (const other of repo.images.values()) other.tags.delete(tag);
      image.tags.add(tag);
    }
    return {
      image: {
        registryId: this.accountId,
        repositoryName: repo.name,
        imageId: { imageDigest: digest, imageTag: tag },
        imageManifest: manifest,
        imageManifestMediaType: image.manifestMediaType,
      },
    };
  }

  getAuthorizationToken() {
    const token = Buffer.from(`AWS:parlel-ecr-${randomUUID()}`).toString("base64");
    return {
      authorizationData: [
        {
          authorizationToken: token,
          expiresAt: Math.floor((Date.now() + 12 * 3600 * 1000) / 1000),
          proxyEndpoint: `https://${this.registryUri()}`,
        },
      ],
    };
  }

  describeImages(input) {
    const repo = this.requireRepo(input.repositoryName);
    const ids = input.imageIds;
    let images = [...repo.images.values()];
    if (Array.isArray(ids) && ids.length) {
      const resolved = ids.map((id) => this.resolveImage(repo, id)).filter(Boolean);
      const seen = new Set();
      images = resolved.filter((i) => (seen.has(i.digest) ? false : seen.add(i.digest)));
    }
    return {
      imageDetails: images.map((image) => ({
        registryId: this.accountId,
        repositoryName: repo.name,
        imageDigest: image.digest,
        imageTags: [...image.tags],
        imageSizeInBytes: image.sizeInBytes,
        imagePushedAt: Math.floor(image.pushedAt / 1000),
        imageManifestMediaType: image.manifestMediaType,
      })),
    };
  }

  sendJson(res, status, obj) {
    res.statusCode = status;
    res.setHeader("Content-Type", JSON_CONTENT_TYPE);
    res.end(JSON.stringify(obj));
  }

  sendError(res, error) {
    const code = error.code || "ServerException";
    const status = error.status || ERROR_STATUS[code] || 400;
    res.statusCode = status;
    res.setHeader("Content-Type", JSON_CONTENT_TYPE);
    res.setHeader("x-amzn-errortype", code);
    res.end(JSON.stringify({ __type: code, message: error.message || code, Message: error.message || code }));
  }
}

export default EcrServer;
