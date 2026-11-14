import type { Construct } from "constructs";

/**
 * Everything that changes between accounts or forks lives in cdk.json context,
 * so the stacks never carry an environment-specific literal.
 */
export interface AerosConfig {
  /** "owner/name" of the only repository allowed to assume the deploy role. */
  readonly githubRepository: string;
  /** Branch whose workflows may deploy. */
  readonly deployBranch: string;
  /** Browser origins allowed to call the API (the web app and local dev). */
  readonly allowedOrigins: string[];
  /** Secrets Manager name holding the FIRMS MAP_KEY. Only the name is known here. */
  readonly firmsSecretName: string;
  /** FIRMS area as "west,south,east,north". */
  readonly firmsArea: string;
  /** False when the account already has the GitHub OIDC provider (one per account). */
  readonly createGithubOidcProvider: boolean;
  /** Optional custom domain served by CloudFront behind Cloudflare. */
  readonly webDomainName?: string;
  /** ACM certificate in us-east-1 for webDomainName. */
  readonly webCertificateArn?: string;
}

const PREFIX = "aeros:";

function read<T>(scope: Construct, key: string): T | undefined {
  return scope.node.tryGetContext(PREFIX + key) as T | undefined;
}

function required<T>(scope: Construct, key: string): T {
  const value = read<T>(scope, key);
  if (value === undefined || value === null || value === "") {
    throw new Error(`missing context value ${PREFIX}${key}`);
  }
  return value;
}

export function loadConfig(scope: Construct): AerosConfig {
  const repository = required<string>(scope, "githubRepository");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) {
    throw new Error(`aeros:githubRepository must be "owner/name", got "${repository}"`);
  }
  const area = required<string>(scope, "firmsArea");
  const bounds = area.split(",").map(Number);
  if (bounds.length !== 4 || bounds.some((n) => !Number.isFinite(n))) {
    throw new Error(`aeros:firmsArea must be "west,south,east,north", got "${area}"`);
  }
  const domain = read<string>(scope, "webDomainName");
  const certificate = read<string>(scope, "webCertificateArn");
  if (Boolean(domain) !== Boolean(certificate)) {
    throw new Error("aeros:webDomainName and aeros:webCertificateArn go together");
  }
  const createProvider = read<boolean | string>(scope, "createGithubOidcProvider");
  return {
    githubRepository: repository,
    deployBranch: required<string>(scope, "deployBranch"),
    allowedOrigins: required<string[]>(scope, "allowedOrigins"),
    firmsSecretName: required<string>(scope, "firmsSecretName"),
    firmsArea: area,
    // `-c` on the command line always passes strings.
    createGithubOidcProvider: createProvider !== false && createProvider !== "false",
    webDomainName: domain || undefined,
    webCertificateArn: certificate || undefined,
  };
}
