import type { Construct } from "constructs";

/**
 * Everything that changes between accounts or forks lives in cdk.json context,
 * so the stacks never carry an environment-specific literal.
 */
export interface AerosConfig {
  /**
   * The account's project Region. The AWS Free plan allows one Region per
   * project and no cross-Region features, so every Regional resource goes here.
   */
  readonly region: string;
  /** "owner/name" of the only repository allowed to assume the deploy role. */
  readonly githubRepository: string;
  /** Branch whose workflows may deploy. */
  readonly deployBranch: string;
  /** SSM Parameter Store SecureString (standard tier) holding the FIRMS MAP_KEY. */
  readonly firmsMapKeyParameter: string;
  /** FIRMS area as "west,south,east,north". */
  readonly firmsArea: string;
  /** Days raw FIRMS downloads are kept before S3 expires them. */
  readonly rawRetentionDays: number;
  /**
   * Concurrency reserved for the API function: caps how much it can ever run.
   * 0 = none, the default: Lambda always keeps 100 executions unreserved and a
   * new account starts with a quota of 10, so any reservation fails to deploy
   * until the quota is raised.
   */
  readonly apiReservedConcurrency: number;
  /** Same for the daily refresh. 0 = none. */
  readonly refreshReservedConcurrency: number;
  /** Monthly cost, in USD, at which the budget alert fires. */
  readonly budgetLimitUsd: number;
  /** Optional e-mail subscribed to the budget alert; pass it with -c, never commit it. */
  readonly budgetEmail?: string;
  /** False when the account already has the GitHub OIDC provider (one per account). */
  readonly createGithubOidcProvider: boolean;
  /** Optional custom domain served by CloudFront behind Cloudflare. */
  readonly webDomainName?: string;
  /** ACM certificate for webDomainName; CloudFront only accepts us-east-1 ones. */
  readonly webCertificateArn?: string;
  /** Public URL of the web app, linked from every alert. */
  readonly webUrl: string;
  /** Human name of the FIRMS area, used in alert messages. */
  readonly alertRegionName: string;
  /**
   * Verified SES identity (domain or address) alerts are sent from. Without it
   * the function gets no SES permission and the e-mail channel stays off.
   */
  readonly alertEmailIdentity?: string;
}

const PREFIX = "aeros:";

function read<T>(scope: Construct, key: string): T | undefined {
  return scope.node.tryGetContext(key) as T | undefined;
}

function required<T>(scope: Construct, key: string): T {
  const value = read<T>(scope, key);
  if (value === undefined || value === null || value === "") {
    throw new Error(`missing context value ${key}`);
  }
  return value;
}

/** `-c key=value` on the command line always passes strings. */
function integer(scope: Construct, key: string, fallback: number, min: number, max: number): number {
  const raw = read<number | string>(scope, key);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${key} must be an integer between ${min} and ${max}, got "${raw}"`);
  }
  return value;
}

export function loadConfig(scope: Construct): AerosConfig {
  const region = required<string>(scope, "region");
  if (!/^[a-z]{2}(-[a-z]+)+-\d$/.test(region)) {
    throw new Error(`region must be an AWS Region code, got "${region}"`);
  }
  const repository = required<string>(scope, PREFIX + "githubRepository");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) {
    throw new Error(`aeros:githubRepository must be "owner/name", got "${repository}"`);
  }
  const area = required<string>(scope, PREFIX + "firmsArea");
  const bounds = area.split(",").map(Number);
  if (bounds.length !== 4 || bounds.some((n) => !Number.isFinite(n))) {
    throw new Error(`aeros:firmsArea must be "west,south,east,north", got "${area}"`);
  }
  const parameter = required<string>(scope, PREFIX + "firmsMapKeyParameter");
  if (!/^\/[\w.\-/]+$/.test(parameter)) {
    throw new Error(`aeros:firmsMapKeyParameter must be a path like /aeros/firms/map-key`);
  }
  const domain = read<string>(scope, PREFIX + "webDomainName");
  const certificate = read<string>(scope, PREFIX + "webCertificateArn");
  if (Boolean(domain) !== Boolean(certificate)) {
    throw new Error("aeros:webDomainName and aeros:webCertificateArn go together");
  }
  const createProvider = read<boolean | string>(scope, PREFIX + "createGithubOidcProvider");
  const email = read<string>(scope, PREFIX + "budgetEmail");
  const webUrl = required<string>(scope, PREFIX + "webUrl");
  if (!/^https:\/\/[\w.-]+(:\d+)?(\/[\w./-]*)?$/.test(webUrl)) {
    throw new Error(`aeros:webUrl must be an https URL, got "${webUrl}"`);
  }
  const identity = read<string>(scope, PREFIX + "alertEmailIdentity");
  if (identity && !/^([\w.+-]+@)?[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(identity)) {
    throw new Error("aeros:alertEmailIdentity must be a domain or an e-mail address");
  }
  return {
    region,
    githubRepository: repository,
    deployBranch: required<string>(scope, PREFIX + "deployBranch"),
    firmsMapKeyParameter: parameter,
    firmsArea: area,
    rawRetentionDays: integer(scope, PREFIX + "rawRetentionDays", 90, 7, 3650),
    apiReservedConcurrency: integer(scope, PREFIX + "apiReservedConcurrency", 0, 0, 100),
    refreshReservedConcurrency: integer(scope, PREFIX + "refreshReservedConcurrency", 0, 0, 10),
    budgetLimitUsd: integer(scope, PREFIX + "budgetLimitUsd", 1, 1, 1000),
    budgetEmail: email || undefined,
    createGithubOidcProvider: createProvider !== false && createProvider !== "false",
    webDomainName: domain || undefined,
    webCertificateArn: certificate || undefined,
    webUrl,
    alertRegionName: read<string>(scope, PREFIX + "alertRegionName") || "the monitored region",
    alertEmailIdentity: identity || undefined,
  };
}
